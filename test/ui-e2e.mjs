/**
 * test/ui-e2e.mjs — 无头 Chrome + 假麦克风，把「点击麦克风 → 边录边出字 → 停止插入草稿」
 * 整条链路走一遍。
 *
 * 用法：
 *   node test/ui-e2e.mjs '<http://127.0.0.1:PORT/?token=...>' [fake-audio.wav] [out-dir]
 *
 * 退出码 0 表示：录音条出现、录音中出现了实时字幕、停止后草稿里出现了识别文本。
 * 假麦克风用 Chrome 的 --use-file-for-fake-audio-capture 循环播放给定 WAV。
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node test/ui-e2e.mjs <dsh-web-url-with-token> [fake-audio.wav] [out-dir]')
  process.exit(2)
}
const audioFile = process.argv[3] ?? '/tmp/aaa-pause.wav'
const outDir = process.argv[4] ?? '/tmp'
const PORT = 9334

await mkdir(outDir, { recursive: true })

const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--user-data-dir=/tmp/chrome-vs-e2e',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${audioFile}`,
  '--autoplay-policy=no-user-gesture-required',
  url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForTarget() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith('http'))
      if (page !== undefined) return page
    } catch {
      /* chrome not ready */
    }
    await sleep(200)
  }
  throw new Error('headless chrome did not expose a page target')
}

const page = await waitForTarget()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let sequence = 0
const pending = new Map()
const polishRequests = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.method === 'Network.requestWillBeSent' && String(message.params?.request?.url ?? '').includes('/voice-stream-api/polish')) {
    try {
      polishRequests.push(JSON.parse(message.params.request.postData ?? '{}'))
    } catch {
      polishRequests.push({ raw: message.params.request.postData ?? null })
    }
  }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
function send(method, params = {}) {
  sequence += 1
  const id = sequence
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.result.exceptionDetails))
  return result.result?.result?.value
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = result.result?.data
  if (data === undefined) return null
  const path = `${outDir}/${name}`
  await writeFile(path, Buffer.from(data, 'base64'))
  return path
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await sleep(8000) // SPA 挂载 + 状态轮询

// 关掉首次启动的「预览版说明」等遮挡层，避免截图被盖住。
await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const dismiss = buttons.find((button) => ['继续', 'Continue'].includes((button.innerText || '').trim()))
  if (dismiss !== undefined) { dismiss.click(); return 'dismissed' }
  return 'none'
})()`)
await sleep(800)

const initial = await evaluate(`JSON.stringify({
  mic: document.querySelector('.vs-trigger') !== null,
  officialMic: document.querySelectorAll('[class*="triggerAnchor"]').length,
  title: document.querySelector('.vs-trigger')?.getAttribute('title') ?? null,
})`)

// 点麦克风开始录音
const clicked = await evaluate(`(() => {
  const button = document.querySelector('.vs-trigger')
  if (button === null) return 'no-mic'
  button.click()
  return 'clicked'
})()`)

await sleep(2500)
const recording = await evaluate(`JSON.stringify({
  phase: document.querySelector('.vs-row')?.getAttribute('data-phase') ?? null,
  caption: document.querySelector('.vs-caption')?.innerText ?? null,
  stopButton: document.querySelector('.vs-stop') !== null,
  dialog: document.querySelector('.vs-dialog') !== null,
})`)

// 等假麦克风里的第一段（约 6.6 s 处停顿）识别回来
await sleep(7000)
const live = await evaluate(`JSON.stringify({
  phase: document.querySelector('.vs-row')?.getAttribute('data-phase') ?? null,
  caption: document.querySelector('.vs-caption')?.innerText ?? null,
})`)
const liveShot = await screenshot('voice-stream-recording.png')

// 停止并等待插入草稿；顺带记录停止后经过的相位（finishing / polishing / …）
await evaluate(`(() => { const button = document.querySelector('.vs-stop'); if (button !== null) button.click(); return true })()`)
const phases = []
for (let attempt = 0; attempt < 30; attempt += 1) {
  const value = await evaluate(`document.querySelector('.vs-row')?.getAttribute('data-phase') ?? null`)
  if (value !== null && !phases.includes(value)) phases.push(value)
  if (value === null && attempt > 2) break
  await sleep(250)
}
await sleep(1000)
const final = await evaluate(`JSON.stringify({
  phase: document.querySelector('.vs-row')?.getAttribute('data-phase') ?? null,
  draft: (document.querySelector('[contenteditable="true"]')?.innerText
    ?? document.querySelector('textarea')?.value
    ?? '').slice(0, 300),
})`)
const finalShot = await screenshot('voice-stream-final.png')

console.log(JSON.stringify({
  initial: JSON.parse(initial),
  clicked,
  recording: JSON.parse(recording),
  live: JSON.parse(live),
  final: JSON.parse(final),
  phases,
  polishRequests,
  screenshots: [liveShot, finalShot],
}, null, 2))

socket.close()
chrome.kill('SIGKILL')

const liveCaption = JSON.parse(live).caption ?? ''
const draft = JSON.parse(final).draft ?? ''
process.exitCode = JSON.parse(initial).mic === true
  && JSON.parse(recording).phase === 'recording'
  && liveCaption.includes('欢迎关注')
  && draft.includes('欢迎关注')
  ? 0
  : 1
