/**
 * test/popover-check.mjs — 无头 Chrome 检查右键设置浮层：位置、尺寸、开关、点外部关闭。
 *
 * 用法：node test/popover-check.mjs '<http://127.0.0.1:PORT/?token=...>' [out-dir]
 * 退出码 0 表示：浮层出现在麦克风左上角、包含滑块开关、能切开关、点外部会关闭。
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node test/popover-check.mjs <dsh-web-url-with-token> [out-dir]')
  process.exit(2)
}
const outDir = process.argv[3] ?? '/tmp'
const PORT = 9335

await mkdir(outDir, { recursive: true })

const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--user-data-dir=/tmp/chrome-vs-popover',
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
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
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
  const result = await send('Page.captureScreenshot', { format: 'png' })
  if (result.result?.data === undefined) return null
  const path = `${outDir}/${name}`
  await writeFile(path, Buffer.from(result.result.data, 'base64'))
  return path
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
await sleep(8000)

await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const dismiss = buttons.find((button) => ['继续', 'Continue'].includes((button.innerText || '').trim()))
  if (dismiss !== undefined) dismiss.click()
  return true
})()`)
await sleep(600)

const opened = await evaluate(`(() => {
  const trigger = document.querySelector('.vs-trigger')
  if (trigger === null) return { opened: false, reason: 'no-mic' }
  trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  return { opened: true }
})()`)
await sleep(500)

const metrics = await evaluate(`(() => {
  const trigger = document.querySelector('.vs-trigger')
  const pop = document.querySelector('.vs-pop')
  const toggle = document.querySelector('.vs-switch input')
  if (trigger === null || pop === null) return { pop: false, trigger: trigger !== null, toggle: toggle !== null }
  const mic = trigger.getBoundingClientRect()
  const rect = pop.getBoundingClientRect()
  const style = getComputedStyle(pop)
  return {
    pop: true,
    toggle: toggle !== null,
    checked: toggle === null ? null : toggle.checked,
    mic: { left: Math.round(mic.left), top: Math.round(mic.top), right: Math.round(mic.right), bottom: Math.round(mic.bottom) },
    rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
    fontSize: style.fontSize,
    title: pop.querySelector('.vs-pop-head span')?.innerText ?? null,
    label: pop.querySelector('.vs-pop-row .vs-pop-label')?.innerText ?? null,
    switchCount: pop.querySelectorAll('.vs-switch').length,
    overflowTop: rect.top < 0,
    outsideMic: rect.right <= mic.left + 1 && rect.bottom <= mic.top + 1,
  }
})()`)
const shot = await screenshot('voice-stream-popover.png')

const toggled = await evaluate(`(() => {
  const toggle = document.querySelector('.vs-switch input')
  if (toggle === null) return null
  const before = toggle.checked
  toggle.click()
  return { before, after: toggle.checked }
})()`)
await sleep(300)
const stored = await evaluate(`localStorage.getItem('dsh-voice-stream:polish')`)

// 还原开关，避免影响后续使用
await evaluate(`(() => { const toggle = document.querySelector('.vs-switch input'); if (toggle !== null && toggle.checked !== ${JSON.stringify(true)}) toggle.click(); return true })()`)

await evaluate(`(() => {
  const editor = document.querySelector('[contenteditable="true"]') ?? document.body
  editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  return true
})()`)
await sleep(400)
const closed = await evaluate(`document.querySelector('.vs-pop') === null`)

const result = {
  opened,
  metrics,
  toggled: toggled ?? null,
  stored,
  closed,
  screenshot: shot,
}
console.log(JSON.stringify(result, null, 2))

socket.close()
chrome.kill('SIGKILL')

const m = metrics
process.exitCode = m.pop === true
  && m.toggle === true
  && m.outsideMic === true
  && m.overflowTop !== true
  && m.rect.width <= 300
  && closed === true
  ? 0
  : 1
