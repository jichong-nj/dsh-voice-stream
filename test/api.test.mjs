/**
 * test/api.test.mjs — 用假的 req/res 验证 Host 路由的分发、同源校验与错误映射。
 * 运行：node test/api.test.mjs
 */
import assert from 'node:assert/strict'
import { createApiHandler, API_PREFIX } from '../lib/api.js'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

function makeRequest(method, path, { body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url: `${API_PREFIX}${path}`,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse() {
  const state = { status: 0, headers: {}, raw: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(chunk) {
      state.raw = typeof chunk === 'string' ? chunk : chunk === undefined ? '' : String(chunk)
    },
    json() {
      return state.raw === '' ? null : JSON.parse(state.raw)
    },
  }
}

async function call(handler, method, path, options) {
  const response = makeResponse()
  await handler(makeRequest(method, path, options), response)
  return { status: response.state.status, body: response.json(), headers: response.state.headers }
}

function makeSpeech({ transcript = { text: '你好', audioSeconds: 1, inferenceSeconds: 0.2 }, failure = null, polishFailure = null } = {}) {
  const calls = { transcribe: 0, prepare: 0, cancel: 0, configure: 0, polish: 0 }
  const controller = {
    catalog: () => ({
      providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['auto', 'zh'], preparation: { phase: 'ready' } }],
      selection: { providerId: 'sensevoice-local', language: 'zh' },
      maxAudioBytes: 4 * 1024 * 1024,
      maxDurationSeconds: 120,
    }),
    transcribe: async (request) => {
      calls.transcribe += 1
      if (failure !== null) throw failure
      assert.equal(typeof request.audioBase64, 'string')
      return transcript
    },
  }
  const service = {
    snapshot: () => ({ selection: { providerId: 'sensevoice-local', language: 'zh' } }),
    prepare: (providerId, options) => {
      calls.prepare += 1
      assert.equal(providerId, 'sensevoice-local')
      assert.equal(options, undefined)
    },
    cancelPreparation: async () => {
      calls.cancel += 1
    },
    configure: async (patch) => {
      calls.configure += 1
      assert.equal(patch.language, 'en')
    },
  }
  const polisher = {
    available: () => true,
    info: async () => ({ available: true, provider: 'p1', model: 'm1' }),
    polish: async (text, options = {}) => {
      calls.polish += 1
      calls.provider = options.provider
      calls.model = options.model
      if (polishFailure !== null) throw polishFailure
      return { text: text.replace(/呃/g, ''), provider: 'p1', model: 'm1', elapsedMs: 0.01, fallback: null, changed: true }
    },
  }
  return {
    refs: {
      controller,
      service,
      polisher,
      polishStats: { calls: 0, changed: 0, unchanged: 0, fallback: 0, failed: 0, last: null, lastError: null },
    },
    calls,
  }
}

const silentLogger = { warn: () => {}, info: () => {} }

await test('GET /status 返回 provider、选择与上限', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'GET', '/status')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.data.available, true)
  assert.equal(result.body.data.catalog.selection.providerId, 'sensevoice-local')
  assert.equal(result.body.data.catalog.maxDurationSeconds, 120)
  assert.equal(result.body.data.polishAvailable, true)
})

await test('语音服务缺失时 polish 也不可用', async () => {
  const handler = createApiHandler({ controller: null, service: null, polisher: null }, { logger: silentLogger })
  const status = await call(handler, 'GET', '/status')
  assert.equal(status.body.data.polishAvailable, false)
  const polish = await call(handler, 'POST', '/polish', { body: { text: '你好' } })
  assert.equal(polish.status, 503)
})

await test('语音服务缺失时 /status 返回 available:false 而不是报错', async () => {
  const handler = createApiHandler({ controller: null, service: null }, { logger: silentLogger })
  const result = await call(handler, 'GET', '/status')
  assert.equal(result.status, 200)
  assert.equal(result.body.data.available, false)
  assert.equal(result.body.data.reason, 'speech-controller-missing')
})

await test('POST /transcribe 转给 controller 并原样返回文本', async () => {
  const { refs, calls } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/transcribe', {
    body: { audioBase64: 'UklGRg==', providerId: 'sensevoice-local', language: 'zh' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.data.text, '你好')
  assert.equal(calls.transcribe, 1)
})

await test('POST /transcribe 缺少音频时 400', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/transcribe', { body: {} })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'speech-invalid-audio')
})

await test('跨站 POST 被同源校验拒绝', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/transcribe', {
    body: { audioBase64: 'UklGRg==' },
    headers: { origin: 'http://evil.example' },
  })
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'forbidden')
})

await test('同源 POST 带 Origin 放行', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/transcribe', {
    body: { audioBase64: 'UklGRg==' },
    headers: { origin: 'http://127.0.0.1:3080' },
  })
  assert.equal(result.status, 200)
})

await test('转写失败映射为 502 并保留错误信息', async () => {
  const failure = Object.assign(new Error('模型未就绪'), { code: 'speech/transcription-failed' })
  const { refs } = makeSpeech({ failure })
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/transcribe', { body: { audioBase64: 'UklGRg==' } })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'speech/transcription-failed')
  assert.equal(result.body.error.message, '模型未就绪')
})

await test('POST /prepare 立即返回并调用 speechToText.prepare', async () => {
  const { refs, calls } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/prepare', { body: {} })
  assert.equal(result.status, 200)
  assert.equal(result.body.data.started, true)
  assert.equal(result.body.data.providerId, 'sensevoice-local')
  assert.equal(calls.prepare, 1)
})

await test('POST /prepare/cancel 调用 cancelPreparation', async () => {
  const { refs, calls } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/prepare/cancel', { body: {} })
  assert.equal(result.status, 200)
  assert.equal(calls.cancel, 1)
})

await test('POST /configure 校验并写入语言', async () => {
  const { refs, calls } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/configure', { body: { language: 'en' } })
  assert.equal(result.status, 200)
  assert.equal(calls.configure, 1)
  const empty = await call(handler, 'POST', '/configure', { body: {} })
  assert.equal(empty.status, 400)
})

await test('GET /polish/info 返回整理模型', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'GET', '/polish/info')
  assert.equal(result.status, 200)
  assert.equal(result.body.data.available, true)
  assert.equal(result.body.data.model, 'm1')
})

await test('POST /polish 返回整理后的文本', async () => {
  const { refs, calls } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/polish', { body: { text: '呃 你好', language: 'zh' } })
  assert.equal(result.status, 200)
  assert.equal(result.body.data.text, ' 你好')
  assert.equal(calls.polish, 1)
})

await test('POST /polish 透传输入框当前模型', async () => {
  const { refs, calls } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/polish', { body: { text: '呃 你好', provider: 'p2', model: 'm2' } })
  assert.equal(result.status, 200)
  assert.equal(calls.provider, 'p2')
  assert.equal(calls.model, 'm2')
})

await test('整理统计写入 /status（含客户端版本）', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  await call(handler, 'POST', '/polish', { body: { text: '呃 你好', clientVersion: '0.1.1' } })
  const status = await call(handler, 'GET', '/status')
  assert.equal(status.body.data.polishStats.calls, 1)
  assert.equal(status.body.data.polishStats.changed, 1)
  assert.equal(status.body.data.polishStats.last.clientVersion, '0.1.1')
})

await test('POST /polish 空文本 400', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/polish', { body: { text: '   ' } })
  assert.equal(result.status, 400)
  assert.equal(result.body.error.code, 'polish-invalid-text')
})

await test('整理失败映射为 502 并保留错误信息', async () => {
  const { refs } = makeSpeech({ polishFailure: Object.assign(new Error('模型报错'), { code: 'model-failed' }) })
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/polish', { body: { text: '你好' } })
  assert.equal(result.status, 502)
  assert.equal(result.body.error.code, 'model-failed')
  assert.equal(result.body.error.message, '模型报错')
})

await test('未知路由 404', async () => {
  const { refs } = makeSpeech()
  const handler = createApiHandler(refs, { logger: silentLogger })
  const result = await call(handler, 'POST', '/nope', { body: {} })
  assert.equal(result.status, 404)
})

let failed = 0
for (const result of results) {
  if (result.ok) {
    console.log(`ok   ${result.name}`)
  } else {
    failed += 1
    console.log(`FAIL ${result.name}`)
    console.log(String(result.error?.stack ?? result.error))
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
