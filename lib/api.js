/**
 * lib/api.js — 同源 HTTP 路由 `/voice-stream-api/*`。
 *
 * 为什么走 HTTP 而不是 Remote：官方语音录入的 Remote 定义由
 * `@deepseek-ai/dsh-experimental-client-ui-voice-input` 在浏览器端挂载，
 * 本插件替换掉那个 UI 后 `ctx.remote.speech` 就不存在了；而 Host 侧的
 * `speechController` / `speechToText` 仍由 Voice Input bundle 的 Host 行提供。
 * 因此浏览器端用同源 fetch 调这里，Host 直接把请求转给这两个服务，
 * 与官方「停止后整段转写」走的是完全同一条识别链路，只是调用次数从
 * 1 次变成「每句话 1 次」。
 *
 * 返回约定：`{ ok: true, data }` / `{ ok: false, error: { code, message } }`。
 * 非 GET 请求做同源 Origin 校验（同一 profile 里其它插件的做法），
 * 插件路由不经 cookie 鉴权，靠它挡住跨站写请求。
 *
 * @module lib/api
 */

import { PolishError } from './polish.js'

/** 路由前缀（与 client.js 的 API 常量保持一致）。 */
export const API_PREFIX = '/voice-stream-api'

/** 诊断与错误里使用的插件标识。 */
export const PLUGIN_NAME = '@jichong/dsh-voice-stream'

/** JSON 请求体上限：单段 15 s 的 16 kHz PCM16 WAV 约 480 KB，base64 后约 640 KB。 */
const JSON_LIMIT = 8 * 1024 * 1024

/** 单段转写的等待上限。 */
const TRANSCRIBE_TIMEOUT_MS = 60_000

/** 停止后整理文字的等待上限。 */
const POLISH_TIMEOUT_MS = 30_000

/** 单次整理允许的原文长度。 */
const MAX_POLISH_CHARS = 20_000

/** 写 JSON 响应。 */
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 写错误响应。 */
function writeError(res, status, code, message) {
  writeJson(res, status, { ok: false, error: { code, message: String(message) } })
}

/** 读取 JSON 请求体；空体视为 `{}`。 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > JSON_LIMIT) throw new Error(`请求体过大（上限 ${Math.round(JSON_LIMIT / 1024 / 1024)} MB）`)
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

/** 同源校验：浏览器同源请求无 Origin，或 Origin.host === Host 才放行。 */
function isSameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    const parsed = new URL(origin)
    const host = req.headers?.host
    return typeof host === 'string' && host.length > 0 && parsed.host === host
  } catch {
    return false
  }
}

/** 解码一个路径段，坏编码退回原文。 */
function segment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 从错误对象上安全读取 RemoteError 的稳定 code。 */
function errorCode(error) {
  return typeof error?.code === 'string' && error.code !== '' ? error.code : 'voice-stream/failed'
}

/**
 * 创建纯 Node 请求处理器（便于离线测试）。
 * @param {{ controller: any, service: any }} refs - 语音服务引用，由插件生命周期维护。
 * @param {{ logger?: { warn?: Function } }} [options]
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApiHandler(refs, { logger = null } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(API_PREFIX)) return writeError(res, 404, 'not-found', 'unknown route')
    const parts = url.pathname.slice(API_PREFIX.length).split('/').filter((part) => part !== '').map(segment)
    const method = req.method ?? 'GET'

    if (method !== 'GET' && method !== 'HEAD' && !isSameOrigin(req)) {
      return writeError(res, 403, 'forbidden', 'cross-origin requests are not allowed')
    }

    try {
      if (parts.length === 0) {
        if (method !== 'GET' && method !== 'HEAD') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        return writeJson(res, 200, {
          ok: true,
          data: {
            plugin: PLUGIN_NAME,
            routes: [
              'GET /status',
              'POST /prepare',
              'POST /prepare/cancel',
              'POST /configure',
              'POST /transcribe',
              'GET /polish/info',
              'POST /polish',
            ],
          },
        })
      }

      // 当前 provider 列表、默认选择、录音上限与准备进度。
      if (parts.length === 1 && parts[0] === 'status') {
        if (method !== 'GET' && method !== 'HEAD') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        const controller = refs.controller
        if (controller === null || controller === undefined || typeof controller.catalog !== 'function') {
          return writeJson(res, 200, {
            ok: true,
            data: {
              available: false,
              polishAvailable: refs.polisher !== undefined && refs.polisher !== null && refs.polisher.available() === true,
              reason: 'speech-controller-missing',
              message: '语音服务未加载：请确认已启用 Voice Input（语音输入）插件。',
              catalog: null,
            },
          })
        }
        const polishAvailable = refs.polisher !== undefined && refs.polisher !== null && refs.polisher.available() === true
        return writeJson(res, 200, { ok: true, data: { available: true, polishAvailable, catalog: controller.catalog() } })
      }

      // 开始（或加入）Host 拥有的模型准备任务；这里不阻塞等待，进度由 /status 轮询。
      if (parts.length === 1 && parts[0] === 'prepare') {
        if (method !== 'POST') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        const service = refs.service
        if (service === null || service === undefined || typeof service.prepare !== 'function') {
          return writeError(res, 409, 'speech-unavailable', '语音服务未加载：请确认已启用 Voice Input（语音输入）插件。')
        }
        const body = await readJsonBody(req)
        const snapshot = service.snapshot()
        const providerId = typeof body.providerId === 'string' && body.providerId !== '' ? body.providerId : snapshot?.selection?.providerId
        if (typeof providerId !== 'string' || providerId === '') {
          return writeError(res, 409, 'speech-unavailable', '没有可用的语音 provider')
        }
        const options = typeof body.downloadSource === 'string' && body.downloadSource !== '' ? { downloadSource: body.downloadSource } : undefined
        service.prepare(providerId, options)
        return writeJson(res, 200, { ok: true, data: { providerId, started: true } })
      }

      // 取消准备任务。
      if (parts.length === 2 && parts[0] === 'prepare' && parts[1] === 'cancel') {
        if (method !== 'POST') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        const service = refs.service
        if (service === null || service === undefined || typeof service.cancelPreparation !== 'function') {
          return writeError(res, 409, 'speech-unavailable', '语音服务未加载：请确认已启用 Voice Input（语音输入）插件。')
        }
        const body = await readJsonBody(req)
        const providerId = typeof body.providerId === 'string' && body.providerId !== '' ? body.providerId : service.snapshot()?.selection?.providerId
        if (typeof providerId !== 'string' || providerId === '') return writeError(res, 409, 'speech-unavailable', '没有可用的语音 provider')
        await service.cancelPreparation(providerId)
        return writeJson(res, 200, { ok: true, data: { providerId, cancelled: true } })
      }

      // 保存识别语言 / provider 偏好（与官方 bundle 详情页写的是同一份设置）。
      if (parts.length === 1 && parts[0] === 'configure') {
        if (method !== 'POST') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        const service = refs.service
        if (service === null || service === undefined || typeof service.configure !== 'function') {
          return writeError(res, 409, 'speech-unavailable', '语音服务未加载：请确认已启用 Voice Input（语音输入）插件。')
        }
        const body = await readJsonBody(req)
        const patch = {}
        if (typeof body.providerId === 'string' && body.providerId !== '') patch.providerId = body.providerId
        if (typeof body.language === 'string' && body.language !== '') patch.language = body.language
        if (Object.keys(patch).length === 0) return writeError(res, 400, 'bad-request', 'providerId 或 language 至少提供一个')
        await service.configure(patch)
        return writeJson(res, 200, { ok: true, data: { selection: service.snapshot()?.selection ?? null } })
      }

      // 整理模型的可用信息（设置对话框展示用；会解析一次模型目录）。
      if (parts.length === 2 && parts[0] === 'polish' && parts[1] === 'info') {
        if (method !== 'GET' && method !== 'HEAD') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        if (refs.polisher === undefined || refs.polisher === null) {
          return writeJson(res, 200, { ok: true, data: { available: false, provider: null, model: null, message: 'LLM 服务未加载' } })
        }
        return writeJson(res, 200, { ok: true, data: await refs.polisher.info() })
      }

      // 停止录音后的文字整理：去口头禅、补标点；失败时客户端回退到原文。
      if (parts.length === 1 && parts[0] === 'polish') {
        if (method !== 'POST') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        if (refs.polisher === undefined || refs.polisher === null) {
          return writeError(res, 503, 'polish-unavailable', 'LLM 服务未加载，无法整理文字')
        }
        const body = await readJsonBody(req)
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return writeError(res, 400, 'polish-invalid-text', 'text 不能为空')
        }
        if (body.text.length > MAX_POLISH_CHARS) {
          return writeError(res, 400, 'polish-too-long', `text 超过 ${MAX_POLISH_CHARS} 字上限`)
        }
        try {
          const result = await refs.polisher.polish(body.text, {
            language: typeof body.language === 'string' ? body.language : undefined,
            provider: typeof body.provider === 'string' ? body.provider : undefined,
            model: typeof body.model === 'string' ? body.model : undefined,
            signal: AbortSignal.timeout(POLISH_TIMEOUT_MS),
          })
          return writeJson(res, 200, { ok: true, data: result })
        } catch (error) {
          logger?.warn?.(`[voice-stream] polish failed: ${String(error?.stack ?? error)}`)
          const status = error instanceof PolishError && error.code === 'model-unavailable' ? 503 : 502
          return writeError(res, status, errorCode(error), String(error?.message ?? error))
        }
      }

      // 单段转写：与官方 UI 点 Stop 时调用的是同一个方法。
      if (parts.length === 1 && parts[0] === 'transcribe') {
        if (method !== 'POST') return writeError(res, 405, 'method-not-allowed', `method not allowed: ${method}`)
        const controller = refs.controller
        if (controller === null || controller === undefined || typeof controller.transcribe !== 'function') {
          return writeError(res, 409, 'speech-unavailable', '语音服务未加载：请确认已启用 Voice Input（语音输入）插件。')
        }
        const body = await readJsonBody(req)
        if (typeof body.audioBase64 !== 'string' || body.audioBase64 === '') {
          return writeError(res, 400, 'speech-invalid-audio', 'audioBase64 不能为空')
        }
        const request = { audioBase64: body.audioBase64 }
        if (typeof body.providerId === 'string' && body.providerId !== '') request.providerId = body.providerId
        if (typeof body.language === 'string' && body.language !== '') request.language = body.language
        try {
          const transcript = await controller.transcribe(request, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS))
          return writeJson(res, 200, { ok: true, data: transcript })
        } catch (error) {
          logger?.warn?.(`[voice-stream] transcribe failed: ${String(error?.stack ?? error)}`)
          return writeError(res, 502, errorCode(error), String(error?.message ?? error))
        }
      }

      return writeError(res, 404, 'not-found', `unknown route: ${method} ${url.pathname}`)
    } catch (error) {
      logger?.warn?.(`[voice-stream] request failed: ${String(error?.stack ?? error)}`)
      return writeError(res, 400, 'bad-request', String(error?.message ?? error))
    }
  }
}

/**
 * 把处理器挂到 DSH webServer 前缀。
 * @param {{ webServer: { register: Function }, logger?: object }} ctx
 * @param {{ controller: any, service: any }} refs
 * @returns {() => void} disposer
 */
export function registerVoiceStreamRoutes(ctx, refs) {
  const registration = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: createApiHandler(refs, { logger: ctx.logger }),
  })
  return () => {
    try {
      if (typeof registration === 'function') registration()
      else if (typeof registration?.dispose === 'function') registration.dispose()
    } catch (error) {
      ctx.logger?.warn?.(`[voice-stream] route disposal failed: ${String(error?.stack ?? error)}`)
    }
  }
}
