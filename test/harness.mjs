/**
 * test/harness.mjs — 在 Node 里加载浏览器端 client.js。
 *
 * client.js 是一个“注册进页面模块表”的脚本，不是 ESM：它调用
 * window.__ModuleLoader__.load({ id, factory })。这里用 vm 造一个最小的
 * window/React/浏览器环境，取出 factory 的返回值，从而直接单测分段器、
 * WAV 编码等纯逻辑，不需要浏览器。
 */
import { readFile } from 'node:fs/promises'

const CLIENT_PATH = new URL('../client.js', import.meta.url)

function reactStub() {
  return {
    createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/**
 * 加载 client.js 并返回其模块导出（含 __test）。
 * @returns {Promise<any>}
 */
export async function loadClientModule() {
  const code = await readFile(CLIENT_PATH, 'utf8')
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (value) => {
          definition = value
        },
      },
    },
    console,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    DOMException,
    navigator: { language: 'zh-CN' },
    fetch: () => {
      throw new Error('fetch is not available in unit tests')
    },
    AudioContext: class {
      constructor() {
        throw new Error('AudioContext is not available in unit tests')
      }
    },
    OfflineAudioContext: class {
      constructor() {
        throw new Error('OfflineAudioContext is not available in unit tests')
      }
    },
  }
  sandbox.globalThis = sandbox
  const { createContext, runInContext } = await import('node:vm')
  const context = createContext(sandbox)
  runInContext(code, context, { filename: 'client.js' })
  if (definition === null) throw new Error('client.js did not register a module definition')
  if (definition.id !== '@jichong/dsh-voice-stream') throw new Error(`unexpected module id: ${definition.id}`)
  return definition.factory((id) => {
    if (id === 'react') return reactStub()
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected module request: ${id}`)
  })
}

/** 生成一段正弦单音（Float32，16 kHz）。 */
export function tone(seconds, { frequency = 220, amplitude = 0.25, sampleRate = 16000 } = {}) {
  const length = Math.max(1, Math.round(seconds * sampleRate))
  const samples = new Float32Array(length)
  for (let i = 0; i < length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  return samples
}

/** 生成一段静音。 */
export function silence(seconds, { sampleRate = 16000 } = {}) {
  return new Float32Array(Math.max(1, Math.round(seconds * sampleRate)))
}

export function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    samples.set(part, offset)
    offset += part.length
  }
  return samples
}

/** 按固定块大小喂给分段器，模拟 ScriptProcessor 的分块回调。 */
export function feed(segmenter, samples, blockSize = 2048) {
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    segmenter.push(samples.subarray(offset, Math.min(offset + blockSize, samples.length)))
  }
}
