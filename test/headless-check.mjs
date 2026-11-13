/**
 * test/headless-check.mjs — 用无头 Chrome 打开一个 DSH Web 页面，检查流式麦克风是否挂载。
 *
 * 用法：node test/headless-check.mjs 'http://127.0.0.1:3099/?token=...'
 * 通过 CDP 读取 DOM，不依赖截图；退出码 0 表示找到 `.vs-trigger` 按钮。
 */
import { spawn } from 'node:child_process'

const url = process.argv[2]
if (url === undefined) {
  console.error('usage: node test/headless-check.mjs <dsh-web-url-with-token>')
  process.exit(2)
}

const PORT = 9333
const chrome = spawn('google-chrome', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--user-data-dir=/tmp/chrome-vs-check',
  url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

await send('Runtime.enable')
await sleep(9000)

const expression = `JSON.stringify({
  url: location.href,
  micButton: document.querySelector('.vs-trigger') !== null,
  micLabel: document.querySelector('.vs-trigger')?.getAttribute('aria-label') ?? null,
  micTitle: document.querySelector('.vs-trigger')?.getAttribute('title') ?? null,
  officialMic: document.querySelectorAll('[class*="triggerAnchor"]').length,
  buttons: [...document.querySelectorAll('button[aria-label]')].map((el) => el.getAttribute('aria-label')).slice(0, 25),
  bodyText: (document.body.innerText || '').slice(0, 400),
  errors: (window.__vsErrors ?? null),
})`
const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true })
const value = evaluated.result?.result?.value
console.log(value ?? JSON.stringify(evaluated))
socket.close()
chrome.kill('SIGKILL')

const parsed = value === undefined ? null : JSON.parse(value)
process.exitCode = parsed?.micButton === true ? 0 : 1
