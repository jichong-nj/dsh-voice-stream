/**
 * index.js — dsh-voice-stream host 入口（Cordis 插件）。
 *
 * 本插件只做一件事：把浏览器端「流式语音输入」需要的 Host 能力以同源 HTTP
 * 路由暴露出来，并转发给 DSH 自带的语音服务：
 *   - `ctx.speechController`（api-speech-to-text）：catalog / prepare /
 *     cancelPreparation / configure / transcribe；
 *   - `ctx.speechToText`（speech-to-text）：准备状态与偏好写入；
 *   - `ctx.llm` + `ctx.agentDefaultModel`：停止录音后的文字整理。
 *
 * 前两个服务由官方 Voice Input bundle 的 Host 行提供；本 bundle 只把官方
 * 那个「录完整段才转写」的浏览器控件替换成自己的流式控件。
 *
 * 所有注册都经 ctx.effect / ctx.inject 管理，卸载时干净释放。
 *
 * @module index
 */

import { registerVoiceStreamRoutes, PLUGIN_NAME } from './lib/api.js'
import { createPolisher } from './lib/polish.js'

/** 插件名（与 cordis.patch.yml 的 id 对齐）。 */
const name = 'voice-stream'

/** webServer 由 web-app 提供；语音服务是可选的（Voice Input bundle 未启用时仍能挂载）。 */
const inject = ['webServer']

/**
 * 挂载插件。
 * @param {any} ctx cordis 上下文
 * @param {{ provider?: string, model?: string }} [config] 可选：指定整理用的模型
 */
export function apply(ctx, config = {}) {
  const refs = { controller: null, service: null, polisher: null }
  const llmRefs = { llm: null, defaultModel: null }

  // 停止后的文字整理复用 DSH 的 LLM 服务；模型缺失时整理不可用，录音照常。
  refs.polisher = createPolisher({
    getLlm: () => llmRefs.llm,
    getDefaultModel: () => llmRefs.defaultModel,
    logger: ctx.logger,
    config: {
      provider: typeof config.provider === 'string' && config.provider !== '' ? config.provider : undefined,
      model: typeof config.model === 'string' && config.model !== '' ? config.model : undefined,
    },
  })

  ctx.inject(['llm'], (child) => {
    child.effect(() => {
      llmRefs.llm = child.llm
      return () => {
        llmRefs.llm = null
      }
    }, 'voice-stream: llm')
  })

  ctx.inject(['agentDefaultModel'], (child) => {
    child.effect(() => {
      llmRefs.defaultModel = child.agentDefaultModel
      return () => {
        llmRefs.defaultModel = null
      }
    }, 'voice-stream: default model')
  })

  ctx.inject(['speechController'], (child) => {
    child.effect(() => {
      refs.controller = child.speechController
      return () => {
        refs.controller = null
      }
    }, 'voice-stream: speech controller')
  })

  ctx.inject(['speechToText'], (child) => {
    child.effect(() => {
      refs.service = child.speechToText
      return () => {
        refs.service = null
      }
    }, 'voice-stream: speech-to-text service')
  })

  ctx.effect(() => {
    const dispose = registerVoiceStreamRoutes(ctx, refs)
    ctx.logger?.info?.(`[voice-stream] ${PLUGIN_NAME} routes ready`)
    return dispose
  }, 'voice-stream: http routes')
}

export { name, inject }
