/**
 * test/run.mjs — 单元测试：WAV 编码、文本拼接、停顿分段器。
 * 运行：node test/run.mjs
 */
import assert from 'node:assert/strict'
import { loadClientModule, tone, silence, concat, feed } from './harness.mjs'

const module = await loadClientModule()
const { Segmenter, encodeWave, bytesToBase64, joinText, formatDuration, formatBytes, rmsOf } = module.__test

const results = []
function test(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error })
  }
}

function collect(options = {}) {
  const segments = []
  const segmenter = new Segmenter({ sampleRate: 16000, ...options, onSegment: (samples, meta) => segments.push({ samples, meta }) })
  return { segmenter, segments }
}

test('WAV 头与 PCM 数据符合 Host 契约', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1])
  const wav = encodeWave(samples)
  assert.equal(wav.byteLength, 44 + samples.length * 2)
  const view = new DataView(wav.buffer)
  const text = (at, length) => String.fromCharCode(...wav.subarray(at, at + length))
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(text(8, 4), 'WAVE')
  assert.equal(text(12, 4), 'fmt ')
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), samples.length * 2)
  assert.equal(view.getInt16(44, true), 0)
  assert.equal(view.getInt16(46, true), 16384)
  assert.equal(view.getInt16(48, true), -16384)
  assert.equal(view.getInt16(50, true), 32767)
  assert.equal(bytesToBase64(wav).length > 0, true)
  assert.equal(atob(bytesToBase64(wav)).length, wav.byteLength)
})

test('joinText：中文直接相连，英文补空格', () => {
  assert.equal(joinText('你好', '世界'), '你好世界')
  assert.equal(joinText('hello', 'world'), 'hello world')
  assert.equal(joinText('你好', 'world'), '你好world')
  assert.equal(joinText('', '世界'), '世界')
  assert.equal(joinText(' 你好 ', ' 世界 '), '你好世界')
})

test('时长与字节格式化', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(undefined), '0:00')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
})

test('rmsOf：静音为 0，满幅正弦约 0.707', () => {
  assert.equal(rmsOf(new Float32Array(160)), 0)
  const sine = tone(0.1, { amplitude: 1 })
  assert.ok(Math.abs(rmsOf(sine) - Math.SQRT1_2) < 0.02)
})

test('纯静音不产生分段', () => {
  const { segmenter, segments } = collect()
  feed(segmenter, silence(3))
  segmenter.flush()
  assert.equal(segments.length, 0)
})

test('一句话 + 停顿切出一个分段，且保留起音前预卷', () => {
  const { segmenter, segments } = collect()
  feed(segmenter, concat(silence(0.5), tone(0.6), silence(1.2)))
  assert.equal(segments.length, 1)
  const seconds = segments[0].samples.length / 16000
  assert.ok(seconds > 0.55 && seconds < 1.1, `segment length ${seconds}s`)
  assert.equal(segments[0].meta.forced, false)
})

test('太短的爆音被丢弃（低于 minSpeech）', () => {
  const { segmenter, segments } = collect()
  feed(segmenter, concat(silence(0.4), tone(0.08), silence(1.2)))
  assert.equal(segments.length, 0)
})

test('持续说话按 maxSegment 强制切分', () => {
  const { segmenter, segments } = collect({ maxSegmentMs: 3000 })
  feed(segmenter, tone(8))
  segmenter.flush()
  assert.ok(segments.length >= 2, `segments ${segments.length}`)
  for (const segment of segments) {
    const seconds = segment.samples.length / 16000
    assert.ok(seconds <= 3.2, `segment ${seconds}s exceeds the cap`)
  }
})

test('停止时把还没等到停顿的最后一句送出去', () => {
  const { segmenter, segments } = collect()
  feed(segmenter, concat(tone(0.8), silence(0.1)))
  assert.equal(segments.length, 0)
  segmenter.flush()
  assert.equal(segments.length, 1)
  assert.equal(segments[0].meta.forced, true)
})

test('任意分块大小结果一致', () => {
  const audio = concat(silence(0.4), tone(0.5), silence(0.9), tone(0.5), silence(0.9))
  const sizes = [100, 320, 1000, 2048, 4096]
  const counts = sizes.map((blockSize) => {
    const { segmenter, segments } = collect()
    feed(segmenter, audio, blockSize)
    segmenter.flush()
    return segments.length
  })
  assert.deepEqual(new Set(counts).size, 1, `segment counts differ: ${counts.join(',')}`)
  assert.equal(counts[0], 2)
})

test('apply 注册输入框麦克风插槽（无 DOM 环境也能挂载）', () => {
  const registered = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      const value = typeof fn === 'function' ? fn() : undefined
      if (typeof value === 'function') disposers.push(value)
      return value
    },
    inject: (names, callback) => callback({ effect: () => undefined }),
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'conversation.input.activity')
  assert.equal(typeof registered[0].component, 'function')
})

test('空闲态渲染出麦克风按钮（组件 smoke test）', () => {
  const registered = []
  const ctx = {
    get: () => undefined,
    effect: () => undefined,
    inject: (names, callback) => callback({ effect: () => undefined }),
    slots: { inject: (name, callback) => callback(), register: (options, component) => { registered.push(component); return () => {} } },
  }
  module.apply(ctx)
  const VoiceInput = registered[0]
  const tree = VoiceInput({
    sessionId: 'test-session',
    inputActions: { captureInsertion: () => ({}), insertText: () => true },
    locked: false,
    onActiveChange: () => {},
  })
  assert.ok(tree !== null && tree !== undefined)
  const flat = JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))
  assert.ok(flat.includes('vs-trigger'), 'mic trigger missing')
  assert.ok(flat.includes('流式语音输入') || flat.includes('语音服务未就绪'), `tooltip/label missing: ${flat.slice(0, 200)}`)
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
