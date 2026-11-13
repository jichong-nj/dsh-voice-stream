/**
 * test/real-audio.mjs — 用真实语音文件验证分段器（可选再走一遍 Host 转写）。
 *
 * 用法：
 *   node test/real-audio.mjs /tmp/aaa16.wav
 *   node test/real-audio.mjs /tmp/aaa16.wav --api http://127.0.0.1:3080 \
 *     --cookie /tmp/dsh-cookie
 *
 * 输入必须是 16 kHz 单声道 PCM16 WAV；可用 ffmpeg 生成：
 *   ffmpeg -i in.wav -ar 16000 -ac 1 -c:a pcm_s16le out.wav
 */
import { readFile } from 'node:fs/promises'
import { loadClientModule } from './harness.mjs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node test/real-audio.mjs <16k-mono-pcm16.wav> [--api http://127.0.0.1:3080]')
  process.exit(2)
}

const apiIndex = process.argv.indexOf('--api')
const baseUrl = apiIndex >= 0 ? process.argv[apiIndex + 1] : null
const cookieIndex = process.argv.indexOf('--cookie')
const cookieFile = cookieIndex >= 0 ? process.argv[cookieIndex + 1] : null

// DSH web 用签名 cookie 鉴权；先用浏览器 URL 里的 token 换 cookie，再把 cookie
// 文件传给这里，就能在没有浏览器的环境里验证 Host 路由。
let cookieHeader = null
if (cookieFile !== null) {
  const lines = (await readFile(cookieFile, 'utf8')).split('\n')
  const pairs = []
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const fields = line.split('\t')
    if (fields.length < 7) continue
    pairs.push(`${fields[5]}=${fields[6]}`)
  }
  cookieHeader = pairs.join('; ')
}
const requestHeaders = (extra = {}) => ({ ...(cookieHeader === null ? {} : { cookie: cookieHeader }), ...extra })

const wav = await readFile(file)
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
// 只认 44 字节头的 PCM16 WAV（ffmpeg 生成的文件满足）。
const sampleRate = view.getUint32(24, true)
const channels = view.getUint16(22, true)
const bits = view.getUint16(34, true)
if (sampleRate !== 16000 || channels !== 1 || bits !== 16) {
  throw new Error(`expected 16 kHz mono PCM16, got ${sampleRate} Hz / ${channels} ch / ${bits} bit`)
}
const dataOffset = 44
const samples = new Float32Array((wav.byteLength - dataOffset) / 2)
for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768

const module = await loadClientModule()
const { Segmenter, encodeWave, bytesToBase64 } = module.__test

const segments = []
let fed = 0
const segmenter = new Segmenter({
  sampleRate: 16000,
  onSegment: (part, meta) => segments.push({ samples: part, meta, end: fed }),
})
const blockSize = 2048 // 与浏览器 ScriptProcessor 一致（128 ms）
for (let offset = 0; offset < samples.length; offset += blockSize) {
  fed += Math.min(blockSize, samples.length - offset)
  segmenter.push(samples.subarray(offset, offset + blockSize))
}
segmenter.flush()

const duration = samples.length / 16000
console.log(`file:     ${file}`)
console.log(`audio:    ${duration.toFixed(2)} s`)
console.log(`segments: ${segments.length}`)
for (const [index, segment] of segments.entries()) {
  const seconds = segment.samples.length / 16000
  const end = segment.end / 16000
  const start = Math.max(0, end - seconds)
  const tail = seconds - 0.3 // 扣掉 300 ms 预卷，便于看实际语句长度
  console.log(`  #${index + 1}  ${seconds.toFixed(2)} s  (${start.toFixed(2)}s → ${end.toFixed(2)}s, 语音约 ${Math.max(0, tail).toFixed(2)}s)`)
}

if (baseUrl !== null) {
  const status = await (await fetch(new URL('/voice-stream-api/status', baseUrl), { headers: requestHeaders() })).json()
  if (status.ok !== true || status.data?.available !== true) {
    console.error('speech service unavailable:', JSON.stringify(status))
    process.exitCode = 1
  } else {
    const selection = status.data.catalog.selection
    console.log(`provider: ${selection.providerId}  language: ${selection.language}`)
    for (const [index, segment] of segments.entries()) {
      const audioBase64 = bytesToBase64(encodeWave(segment.samples))
      const startedAt = performance.now()
      const response = await fetch(new URL('/voice-stream-api/transcribe', baseUrl), {
        method: 'POST',
        headers: requestHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ audioBase64, providerId: selection.providerId, language: selection.language }),
      })
      const payload = await response.json()
      if (payload.ok !== true) {
        console.error(`  #${index + 1} FAILED: ${payload.error?.message}`)
        process.exitCode = 1
      } else {
        const wall = performance.now() - startedAt
        console.log(`  #${index + 1} ${payload.data.audioSeconds.toFixed(2)}s audio, ${payload.data.inferenceSeconds.toFixed(2)}s inference, ${wall.toFixed(0)}ms round-trip → ${payload.data.text}`)
      }
    }
  }
}
