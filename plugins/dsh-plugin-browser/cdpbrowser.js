/**
 * dsh-plugin-browser — a REAL browser, driven over the Chrome DevTools Protocol.
 *
 * Why this exists, when the pane already has an iframe and a proxy:
 *
 *   1. Most sites refuse to be framed. x.com and reddit.com send
 *      `X-Frame-Options: SAMEORIGIN`, so an iframe of them is blank no matter
 *      what the harness does.
 *   2. Even when framing is allowed, cookies default to `SameSite=Lax` and are
 *      withheld inside a cross-site iframe — so a framed page renders signed
 *      out even though the browser holds a valid session.
 *   3. The proxy fetches anonymously and cannot log in at all.
 *
 * A real top-level browser has none of those problems. Its cookies stay in
 * Chrome's own encrypted store with real per-origin isolation and SameSite
 * enforcement — nothing is copied into a jar of our own, which is the part that
 * would actually have been unsafe.
 *
 * It runs a DEDICATED profile under $DSH_HOME, so the user's daily Chrome is
 * untouched (Chrome cannot open one profile twice) and a login performed here
 * persists across restarts.
 *
 * No dependency: CDP is JSON over one WebSocket, and Node has both built in.
 *
 * @module dsh-plugin-browser/cdpbrowser
 */

import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = 9334
const PROFILE_DIR = path.join(os.homedir(), '.dsh', 'browser-profile')

/**
 * Launch mode. Headless by default in this adapted copy: on macOS the window
 * manager clamps an off-screen window back onto the desktop, so the upstream
 * `--window-position=-32000,-32000` trick puts a second Chrome window on the
 * screen. Chrome's new headless mode paints, streams Page.startScreencast
 * frames and takes CDP input exactly like a windowed Chrome, and keeps the
 * same persistent profile, so logins still stick. `configure({ headless:
 * false })` restores the upstream behaviour (set `headless: false` in the
 * plugin config).
 */
let headless = true
export function configure(opts = {}) {
  if (typeof opts.headless === 'boolean') headless = opts.headless
}

/** Chrome, then Edge — both speak CDP identically. */
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One live CDP session against one page target. */
class Session {
  constructor(targetId, wsUrl) {
    this.targetId = targetId
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()   // CDP method -> Set<fn>
    this.closed = false
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method).add(fn)
    return () => { const set = this.listeners.get(method); if (set) set.delete(fn) }
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl)
    this.ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg)
        this.pending.delete(msg.id)
        return
      }
      if (msg.method) {
        const set = this.listeners.get(msg.method)
        if (set) for (const fn of set) { try { fn(msg.params) } catch { /* one bad listener must not kill the feed */ } }
      }
    })
    this.ws.addEventListener('close', () => { this.closed = true })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp: socket timeout')), 10000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() })
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('cdp: socket error')) })
    })
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    return this
  }

  send(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.resolve({ error: { message: 'socket closed' } })
    }
    const id = ++this.nextId
    return new Promise((resolve) => {
      // A command that never answers must not wedge the pane; resolve with an
      // error shape instead so callers keep working.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ error: { message: 'cdp timeout: ' + method } })
      }, 30000)
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch {
        clearTimeout(timer); this.pending.delete(id)
        resolve({ error: { message: 'cdp send failed' } })
      }
    })
  }

  close() {
    this.closed = true
    try { this.ws && this.ws.close() } catch { /* ignore */ }
  }
}

let launching = null
let session = null

function findBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p
  return null
}

async function debuggerUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json() : null
  } catch { return null }
}

/**
 * Ensure a browser is running with the harness profile, returning its version
 * info. Concurrent callers share one launch.
 */
async function ensureBrowser() {
  const existing = await debuggerUp()
  if (existing) return existing
  if (launching) return launching

  launching = (async () => {
    const exe = findBrowser()
    if (!exe) throw new Error('no Chrome or Edge found to drive')
    mkdirSync(PROFILE_DIR, { recursive: true })

    const child = spawn(exe, [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,900',
      // Off-screen so the harness pane is the way you look at it, rather than a
      // second Chrome window fighting for the desktop.
      '--window-position=-32000,-32000',
      // ...but Chrome does not PAINT a window it thinks nobody can see, and a
      // window that never paints emits no screencast frames -- which is exactly
      // what made the pane feel like a stuttering remote desktop. These four
      // stop that throttling. Measured: 0 frames without them, 176 with.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion,Translate',
      'about:blank',
    ], { detached: true, stdio: 'ignore' })
    child.unref()

    for (let i = 0; i < 60; i++) {
      await sleep(500)
      const v = await debuggerUp()
      if (v) return v
    }
    throw new Error('browser did not expose its debugging port')
  })()

  try { return await launching } finally { launching = null }
}

/** Attach to a page target, creating one if needed. */
async function ensureSession() {
  if (session && !session.closed) return session
  await ensureBrowser()

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  let page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) {
    page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  }
  session = await new Session(page.id, page.webSocketDebuggerUrl).open()
  return session
}

/** Is a real browser available at all? Used to decide against the proxy. */
export async function browserAvailable() {
  if (await debuggerUp()) return true
  return findBrowser() !== null
}

export async function navigate(url) {
  const s = await ensureSession()
  await s.send('Page.navigate', { url })
  // Give the load a moment so the first frame is not a blank white flash.
  await sleep(600)
  return state()
}

export async function state() {
  const s = await ensureSession()
  const r = await s.send('Runtime.evaluate', {
    expression: 'JSON.stringify({url: location.href, title: document.title, ready: document.readyState})',
    returnByValue: true,
  })
  try {
    return JSON.parse(r.result?.result?.value || '{}')
  } catch { return {} }
}

/** A JPEG frame of the live page. */
export async function screenshot(quality = 88) {
  const s = await ensureSession()
  const r = await s.send('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false })
  const data = r.result?.data
  return data ? Buffer.from(data, 'base64') : null
}


/**
 * Stream frames as Chrome produces them.
 *
 * Polling `Page.captureScreenshot` was the wrong mechanism: it forces a full
 * encode on every tick whether or not anything changed, pays an HTTP round trip
 * per frame, and still shows stale pixels between ticks -- which is exactly why
 * it felt like a remote desktop.
 *
 * `Page.startScreencast` inverts it: Chrome pushes a frame only when the page
 * actually paints, at whatever rate it can manage. Each frame must be acked or
 * the browser stops sending, so the ack is not optional bookkeeping.
 *
 * @param {(b64: string, meta: object) => void} onFrame
 * @returns {Promise<() => void>} stop function
 */
export async function startScreencast(onFrame, opts = {}) {
  const s = await ensureSession()
  const off = s.on('Page.screencastFrame', (params) => {
    if (!params) return
    // Ack first: a dropped ack silently ends the stream.
    s.send('Page.screencastFrameAck', { sessionId: params.sessionId })
    try { onFrame(params.data, params.metadata || {}) } catch { /* keep streaming */ }
  })
  await s.send('Page.startScreencast', {
    format: 'jpeg',
    quality: opts.quality ?? 88,
    maxWidth: opts.maxWidth ?? Math.round(view.width * view.dpr),
    maxHeight: opts.maxHeight ?? Math.round(view.height * view.dpr),
    everyNthFrame: 1,
  })
  return () => {
    off()
    s.send('Page.stopScreencast')
  }
}

/** The page's real rendered text — the DOM, not a re-parsed fetch. */
export async function readText() {
  const s = await ensureSession()
  const r = await s.send('Runtime.evaluate', {
    expression: '(document.body && (document.body.innerText || document.body.textContent) || "")',
    returnByValue: true,
  })
  return String(r.result?.result?.value || '')
}


/**
 * Evaluate an expression in the live page and return it by value.
 * Exported because "what does the page actually think right now" is the only
 * reliable way to verify input landed, and because tooling wants it.
 */
export async function evaluate(expression) {
  const s = await ensureSession()
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.error) return { error: r.error.message }
  const ex = r.result?.exceptionDetails
  if (ex) return { error: ex.text || 'evaluation failed' }
  return { value: r.result?.result?.value }
}

let view = { width: 1280, height: 800, dpr: 2 }

export async function setViewport(width, height, dpr) {
  const s = await ensureSession()
  view.width = Math.max(320, Math.round(width))
  view.height = Math.max(240, Math.round(height))
  const scale = Number(dpr)
  view.dpr = Number.isFinite(scale) && scale >= 1 ? Math.min(scale, 3) : 2
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: view.width,
    height: view.height,
    deviceScaleFactor: view.dpr,
    mobile: false,
  })
}

export async function mouse(type, x, y, button = 'left', clickCount = 1, deltaY = 0) {
  const s = await ensureSession()
  if (type === 'wheel') {
    return s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  }
  return s.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mouseReleased' ? 0 : 1 })
}

export async function typeText(text) {
  const s = await ensureSession()
  return s.send('Input.insertText', { text })
}

export async function key(type, opts) {
  const s = await ensureSession()
  return s.send('Input.dispatchKeyEvent', Object.assign({ type }, opts))
}


export async function goBack() {
  const s = await ensureSession()
  const h = await s.send('Page.getNavigationHistory')
  const idx = h.result?.currentIndex
  const entries = h.result?.entries || []
  if (typeof idx === 'number' && idx > 0) {
    await s.send('Page.navigateToHistoryEntry', { entryId: entries[idx - 1].id })
    await sleep(500)
  }
  return state()
}

export async function reload() {
  const s = await ensureSession()
  await s.send('Page.reload', {})
  await sleep(700)
  return state()
}

/** Close the CDP session; the browser itself keeps running so logins persist. */
export function detach() {
  if (session) { session.close(); session = null }
}

export const PROFILE_PATH = PROFILE_DIR
