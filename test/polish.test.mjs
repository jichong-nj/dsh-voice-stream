/**
 * test/polish.test.mjs — 停止后整理：输出清理、回退规则、模型选择。
 * 运行：node test/polish.test.mjs
 */
import assert from 'node:assert/strict'
import {
  createPolisher,
  sanitizePolish,
  shouldFallback,
  polishRequest,
  PolishError,
  MAX_INPUT_CHARS,
} from '../lib/polish.js'

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

function fakeLlm({ text = '整理后的文字。', reason = { kind: 'stop' }, providers = [{ id: 'p1', name: 'P' }], models = [{ id: 'm1' }], failOnStream = null } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => providers,
    listModels: async () => models,
    stream: (options) => {
      calls.push(options)
      if (failOnStream !== null) throw failOnStream
      return (async function* () {
        if (text !== '') yield { type: 'text-delta', text }
        yield { type: 'finish', reason }
      })()
    },
  }
}

function makePolisher(llm, { defaultModel = { provider: 'p1', model: 'm1' }, config = {} } = {}) {
  return createPolisher({
    getLlm: () => llm,
    getDefaultModel: () => ({ currentSelection: () => defaultModel }),
    config,
  })
}

await test('sanitizePolish 去掉围栏、前缀标签与整体引号', () => {
  assert.equal(sanitizePolish('```text\n你好世界。\n```'), '你好世界。')
  assert.equal(sanitizePolish('整理后：你好世界。'), '你好世界。')
  assert.equal(sanitizePolish('“你好世界。”'), '你好世界。')
  assert.equal(sanitizePolish('  "hello world"  '), 'hello world')
  assert.equal(sanitizePolish('你好世界。'), '你好世界。')
  assert.equal(sanitizePolish('a\n\n\n\nb'), 'a\n\nb')
  assert.equal(sanitizePolish(''), '')
})

await test('shouldFallback 覆盖截断、空输出、异常变短', () => {
  assert.equal(shouldFallback('原文', '整理', 'max-tokens'), 'truncated')
  assert.equal(shouldFallback('原文', '', 'stop'), 'empty-output')
  assert.equal(shouldFallback('这是一段足够长的语音识别原文，用来触发压缩保护。', '太短', 'stop'), 'shortened')
  assert.equal(shouldFallback('短句', '短', 'stop'), null)
  assert.equal(shouldFallback('原文', '整理后', 'stop'), null)
})

await test('polishRequest 只在已知语言时附加提示', () => {
  const zh = polishRequest('你好', 'zh')
  assert.ok(zh.system.includes('语音输入的文字整理器'))
  assert.ok(zh.messages[0].content[0].text.includes('语音识别语言提示：zh'))
  const auto = polishRequest('你好', 'auto')
  assert.equal(auto.messages[0].content[0].text, '你好')
})

await test('polish 走默认模型并返回清理后的文本', async () => {
  const llm = fakeLlm({ text: '“整理后的文字。”' })
  const polisher = makePolisher(llm)
  const result = await polisher.polish('呃 那个 整理后的文字')
  assert.equal(result.text, '整理后的文字。')
  assert.equal(result.provider, 'p1')
  assert.equal(result.model, 'm1')
  assert.equal(result.fallback, null)
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'p1')
  assert.equal(llm.calls[0].model, 'm1')
})

await test('插件配置的 provider/model 优先', async () => {
  const llm = fakeLlm({ providers: [{ id: 'p1' }, { id: 'p2' }], models: [{ id: 'm1' }, { id: 'm2' }] })
  const polisher = makePolisher(llm, { config: { provider: 'p2', model: 'm2' } })
  const result = await polisher.polish('你好')
  assert.equal(result.provider, 'p2')
  assert.equal(result.model, 'm2')
})

await test('调用方指定输入框当前模型时优先使用', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'p1' }, { id: 'p2' }],
    models: [{ id: 'm1' }],
  })
  llm.listModels = async (provider) => (provider === 'p2' ? [{ id: 'm2' }] : [{ id: 'm1' }])
  const polisher = makePolisher(llm)
  const result = await polisher.polish('你好', { provider: 'p2', model: 'm2' })
  assert.equal(result.provider, 'p2')
  assert.equal(result.model, 'm2')
  assert.equal(llm.calls[0].provider, 'p2')
  assert.equal(llm.calls[0].model, 'm2')
})

await test('指定的 provider/model 不可用时退回默认模型', async () => {
  const llm = fakeLlm()
  const result = await makePolisher(llm).polish('你好', { provider: 'ghost', model: 'nope' })
  assert.equal(result.provider, 'p1')
  assert.equal(result.model, 'm1')
  const llm2 = fakeLlm()
  const result2 = await makePolisher(llm2).polish('你好', { provider: 'p1', model: 'nope' })
  assert.equal(result2.model, 'm1')
})

await test('输出预算被截断时翻倍重试一次', async () => {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    stream(options) {
      calls.push(options)
      const first = calls.length === 1
      return (async function* () {
        if (!first) yield { type: 'text-delta', text: '整理后的文字。' }
        yield { type: 'finish', reason: { kind: first ? 'max-tokens' : 'stop' } }
      })()
    },
  }
  const result = await makePolisher(llm).polish('这是一段需要整理的语音识别原文')
  assert.equal(result.text, '整理后的文字。')
  assert.equal(result.fallback, null)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].maxTokens >= 2048, `first budget ${calls[0].maxTokens}`)
  assert.ok(calls[1].maxTokens > calls[0].maxTokens)
})

await test('两次都截断时回退原文并带上部分输出长度', async () => {
  const llm = {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '只整理了一半' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })()
    },
  }
  const result = await makePolisher(llm).polish('原始识别文本')
  assert.equal(result.text, '原始识别文本')
  assert.equal(result.fallback, 'truncated')
  assert.equal(result.partialChars, 6)
})

await test('模型被 max-tokens 截断时回退原文', async () => {
  const llm = fakeLlm({ text: '被截断的整理', reason: { kind: 'max-tokens' } })
  const result = await makePolisher(llm).polish('原始识别文本')
  assert.equal(result.text, '原始识别文本')
  assert.equal(result.fallback, 'truncated')
})

await test('模型空输出时回退原文', async () => {
  const llm = fakeLlm({ text: '' })
  const result = await makePolisher(llm).polish('原始识别文本')
  assert.equal(result.text, '原始识别文本')
  assert.equal(result.fallback, 'empty-output')
})

await test('过长原文跳过模型直接返回', async () => {
  const llm = fakeLlm()
  const long = '字'.repeat(MAX_INPUT_CHARS + 1)
  const result = await makePolisher(llm).polish(long)
  assert.equal(result.text, long)
  assert.equal(result.fallback, 'too-long')
  assert.equal(llm.calls.length, 0)
})

await test('LLM 不可用时抛出 model-unavailable', async () => {
  const polisher = createPolisher({ getLlm: () => null, getDefaultModel: () => null })
  await assert.rejects(() => polisher.polish('你好'), (error) => error instanceof PolishError && error.code === 'model-unavailable')
  const info = await polisher.info()
  assert.equal(info.available, false)
})

await test('模型调用失败码透传', async () => {
  const llm = fakeLlm({ reason: { kind: 'error', failure: { message: '额度不足' } } })
  await assert.rejects(() => makePolisher(llm).polish('你好'), (error) => error instanceof PolishError && error.code === 'model-failed' && error.message.includes('额度不足'))
})

await test('available 只依赖提供方列表', () => {
  assert.equal(makePolisher(fakeLlm()).available(), true)
  assert.equal(makePolisher(fakeLlm({ providers: [] })).available(), false)
  assert.equal(createPolisher({ getLlm: () => null, getDefaultModel: () => null }).available(), false)
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
