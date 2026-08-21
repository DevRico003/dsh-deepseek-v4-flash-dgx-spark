/**
 * dsh-plugin-browser: the HOST half of an in-app preview browser for DeepSeek
 * Harness.
 *
 * The browser half (client.js) renders a visible browser pane in the web GUI —
 * a real <iframe> the human watches — and pushes the LIVE extracted state of
 * the currently visible tab back to this host half over a same-origin HTTP
 * bridge (ctx.webServer). The three model-facing tools then read / drive that
 * live pane:
 *
 *   open_preview(url, label?)   navigate (or open) a tab in the pane
 *   read_preview(start?, count?)  return the currently visible tab's rendered text
 *   close_preview(url?)         close a tab or the whole pane
 *
 * The agent does NOT see pixels; it only ever sees what the browser has
 * extracted from the live pane. Navigation goes stale in seconds, so read_preview
 * always reads the freshest pushed snapshot, never a cached copy.
 *
 * This package is composed as an ENABLED LOADER ENTRY on the host plane (see
 * ~/.dsh/profiles/web/cordis.patch.yml). That dual role is intentional: the
 * host row makes ctx.webServer + ctx.tools available here, and the same entry's
 * `dsh.client` declaration makes the node-half client-modules scanner serve
 * ./client.js at /plugins/dsh-plugin-browser/client.js and inject it into the
 * boot graph — which is how the browser half reaches the page. One entry, two
 * halves, no shipped-code changes.
 *
 * @module dsh-plugin-browser
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { renderFile, rawFile } from './filerender.js'
import { proxyFetch, proxyToken } from './webproxy.js'
import { extractPdfText } from './pdfrender.js'
import * as live from './cdpbrowser.js'

/** Cordis-plugin name for loader diagnostics. */
export const name = 'dsh-plugin-browser'

/**
 * Cordis injection face: we need the model-facing tool registry and the host
 * HTTP server so we can (a) register tools and (b) bridge to the browser pane.
 */
export const inject = ['tools', 'webServer']

/** Route prefix the browser pane uses to talk back to us (all exact routes). */
const STATE_PATH = '/api/preview/state'
const COMMANDS_PATH = '/api/preview/commands'
const FILE_PATH = '/api/preview/file'
const OPEN_PATH = '/api/preview/open'
const PROXY_PATH = '/api/preview/proxy'
const ASSET_PATH = '/api/preview/asset'   // NO trailing slash: the matcher appends one
const LIVE_PATH = '/api/preview/live'     // prefix: /open /frame /input /state /viewport /back /reload

const DEFAULT_COUNT = 4000
const MAX_COUNT = 20000

/**
 * Tiny shared, in-memory preview store owned by this host half.
 * The browser half is the single source of truth for what is RENDERED; this
 * store only mirrors what the browser pushes and holds the command queue that
 * drives the pane.
 */
function createStore() {
  return {
    opened: false,
    tabs: new Map(), // tabId -> { id, url, title, kind, label }
    activeTabId: null,
    // tabId -> { url, title, text } most recently pushed by the browser.
    state: new Map(),
    // Commands for the pane to execute. NOT a drain-on-read queue: more than
    // one pane can be open on the same harness (a second browser tab, another
    // machine), and a queue that empties on first read means whichever polls
    // first swallows the command and every other pane misses it entirely.
    // Each entry carries a monotonic seq; a pane asks for everything after the
    // seq it last saw.
    commands: [],
    commandSeq: 0,
  }
}

/**
 * Build a same-origin preview URL for a local file.
 * The path is base64url-encoded so Windows backslashes, spaces, and `#` survive
 * the query string untouched.
 */
function fileTarget(rawPath) {
  const abs = path.resolve(String(rawPath).trim())
  const token = Buffer.from(abs, 'utf8').toString('base64url')
  return { url: `${FILE_PATH}?p=${token}`, kind: 'file', filePath: abs }
}

/**
 * Route an external page through the host proxy.
 *
 * Direct framing fails for most of the web -- sites send X-Frame-Options or a
 * CSP frame-ancestors directive and the pane renders blank. Proxying strips
 * those and makes the document same-origin, which also makes it readable.
 */
function webTarget(rawUrl) {
  return { url: `${PROXY_PATH}?u=${proxyToken(rawUrl)}`, kind: 'url', siteUrl: rawUrl }
}

/** Normalize a model-supplied target into an absolute URL + a kind. */
function normalizeTarget(raw) {
  let target = String(raw ?? '').trim()
  if (target.length === 0) throw new Error('url must be a non-empty string')

  // localhost / 127.0.0.1 / [::1] with or without a port → http
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(target)
  if (isLocalHost) {
    return { url: /^https?:\/\//i.test(target) ? target : `http://${target}`, kind: 'url' }
  }

  // Local files are served through THIS host, never handed to the iframe as a
  // `file:` URL: Chrome refuses to load file: inside an http(s) page, so the
  // frame would render nothing. Serving it makes the document same-origin,
  // which also lets the browser half read its real rendered DOM.
  if (/^file:/i.test(target)) {
    let decoded = target.replace(/^file:\/\/\/?/i, '')
    try { decoded = decodeURIComponent(decoded) } catch { /* keep raw */ }
    return fileTarget(decoded)
  }

  // Windows absolute (C:\...  or  C:/...), UNC (\server\share), or POSIX /abs
  if (/^[a-z]:[\\/]/i.test(target) || /^\\\\/.test(target) || /^\//.test(target)) {
    return fileTarget(target)
  }

  // Anything already http(s)
  if (/^https?:\/\//i.test(target)) {
    return webTarget(target)
  }

  // Bare domain (or dotted host with optional path) → https
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*(\.[a-z]{2,})(:\d+)?(\/.*)?$/i.test(target)) {
    return webTarget(`https://${target}`)
  }

  // Last resort: treat as a web URL.
  return webTarget(`https://${target}`)
}

/** A short deterministic-ish tab id for a URL. */
function tabIdFor(url, existing) {
  for (const [id, tab] of existing) {
    if (tab.url === url) return id
  }
  return `tab-${Math.random().toString(36).slice(2, 8)}`
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function json(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Register routes + the three model tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{count?: number, headless?: boolean}} [config]
 */
export function apply(ctx, config) {
  const store = createStore()
  live.configure({ headless: config?.headless !== false })
  const defaultCount = (Number.isInteger(config?.count) && config.count > 0)
    ? config.count
    : DEFAULT_COUNT

  ctx.effect(() => {
    // ── Browser → host: live pane state push ────────────────────────────────
    const disposeState = ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const body = await readJsonBody(req)
        const { tabId, url, title, text, opened, mode } = body
        if (typeof tabId === 'string' && tabId.length > 0) {
          const prev = store.state.get(tabId)
          store.state.set(tabId, {
            url: typeof url === 'string' ? url : (prev?.url ?? ''),
            title: typeof title === 'string' ? title : (prev?.title ?? ''),
            text: typeof text === 'string' ? text : (prev?.text ?? ''),
            // 'webview' means the pane is the desktop shell and owns the
            // browser itself. read_preview must then read what the PANE
            // pushed, not a CDP browser -- that one is either not running or,
            // worse, still parked on some older page, which is exactly how a
            // confident wrong answer gets produced.
            mode: typeof mode === 'string' ? mode : (prev?.mode ?? 'stream'),
          })
          // Sticky, not per-tab. Once a pane has told us it owns its own
          // browser, that is a fact about the PANE, and it must hold even for a
          // tab whose first state push has not landed yet. Deciding per-tab
          // leaves a window where a tab exists but has no state, and the read
          // falls through to a CDP browser that is driving nothing -- which is
          // how a rendered page reports "no text yet".
          if (mode === 'webview') store.paneMode = 'webview'
          const tab = store.tabs.get(tabId)
          if (tab) {
            if (typeof url === 'string' && url.length > 0) tab.url = url
            if (typeof title === 'string' && title.length > 0) tab.title = title
          }
        }
        if (typeof opened === 'boolean') store.opened = opened
        return json(res, 200, { ok: true })
      },
    })

    // ── Browser polls: pending commands to execute on the pane ─────────────
    const disposeCommands = ctx.webServer.register({
      kind: 'exact',
      path: COMMANDS_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const raw = new URL(req.url, 'http://localhost').searchParams.get('since')
        const since = Number.isFinite(Number(raw)) ? Number(raw) : -1
        // A pane with no cursor yet gets nothing rather than the backlog: it
        // should show what is on screen, not replay history on every reload.
        const batch = since < 0 ? [] : store.commands.filter((c) => c.seq > since)
        // Retain a short window so a briefly-stalled pane can still catch up,
        // then discard so this never grows without bound.
        const cutoff = Date.now() - 60000
        store.commands = store.commands.filter((c) => c.at > cutoff)
        return json(res, 200, { commands: batch, seq: store.commandSeq })
      },
    })

    // ── Iframe -> host: fetch an external page and re-serve it framable ────
    const disposeProxy = ctx.webServer.register({
      kind: 'exact',
      path: PROXY_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const token = new URL(req.url, 'http://localhost').searchParams.get('u') || ''
        const out = await proxyFetch(token, PROXY_PATH)
        const headers = Object.assign({}, out.headers || {}, {
          'content-type': out.type,
          'cache-control': 'no-store',
        })
        res.writeHead(out.status, headers)
        return res.end(out.body)
      },
    })

    // ── Iframe -> host: sibling assets of a previewed local HTML file ──────
    // A local page's relative <img>/<link>/<script> resolve against the <base>
    // filerender injects, which points here. Prefix route: everything after the
    // base64url directory token is the path relative to that directory.
    const disposeAsset = ctx.webServer.register({
      kind: 'prefix',
      path: ASSET_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const rest = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(ASSET_PATH.length + 1))
        const slash = rest.indexOf('/')
        if (slash < 1) return json(res, 400, { ok: false, error: 'bad-asset-path' })

        let dir = ''
        try {
          dir = Buffer.from(rest.slice(0, slash), 'base64url').toString('utf8')
        } catch {
          return json(res, 400, { ok: false, error: 'bad-dir-token' })
        }
        const relative = rest.slice(slash + 1)
        const abs = path.resolve(dir, relative)
        // The token names the directory, so a `../` in the relative part must
        // not escape it -- that would turn a preview into an arbitrary file read
        // driven by page content rather than by the user.
        if (path.relative(dir, abs).startsWith('..')) {
          return json(res, 403, { ok: false, error: 'outside-asset-root' })
        }

        let info
        try { info = await stat(abs) } catch { return json(res, 404, { ok: false, error: 'not-found' }) }
        if (info.isDirectory()) return json(res, 415, { ok: false, error: 'is-directory' })

        try {
          // Raw bytes, not the framed viewer page: this is what an <img>,
          // stylesheet or script tag is asking for.
          const out = (await rawFile(abs)) || (await renderFile(abs, info))
          res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store' })
          return res.end(out.body)
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error) })
        }
      },
    })

    // ── The live browser: a real Chrome driven over CDP ────────────────────
    //
    // Everything here exists because an iframe cannot do it: x.com and
    // reddit.com refuse framing outright, and SameSite=Lax withholds cookies
    // from a cross-site frame even when framing is allowed. A real top-level
    // page has neither problem, so this is the only path on which the user can
    // actually be logged in.
    const disposeLive = ctx.webServer.register({
      kind: 'prefix',
      path: LIVE_PATH,
      handler: async (req, res) => {
        const action = new URL(req.url, 'http://localhost').pathname.slice(LIVE_PATH.length + 1)
        try {
          if (action === 'frame') {
            const buf = await live.screenshot()
            if (!buf) return json(res, 503, { ok: false, error: 'no-frame' })
            res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
            return res.end(buf)
          }
          if (action === 'stream') {
            // Server-Sent Events: Chrome pushes a frame only when the page
            // actually repaints, and this forwards it immediately. Polling
            // screenshots over HTTP was the reason the pane felt like a remote
            // desktop -- a full encode every tick, stale pixels in between.
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            res.write('retry: 1000'+'\n\n')

            let stop = null
            let closed = false
            const end = () => {
              if (closed) return
              closed = true
              if (stop) { try { stop() } catch { /* ignore */ } }
            }
            req.on('close', end)
            req.on('error', end)

            // Chrome will happily push ~100fps on an animated page. That is far
            // more than a reading pane needs and costs real bandwidth (~46KB a
            // frame), so forward at most ~25fps and drop the rest. Coalescing
            // here rather than in the client keeps the wire quiet too.
            const MIN_FRAME_GAP_MS = 40
            let lastSent = 0

            try {
              stop = await live.startScreencast((b64) => {
                if (closed) return
                const now = Date.now()
                if (now - lastSent < MIN_FRAME_GAP_MS) return
                lastSent = now
                // One frame per SSE message. Base64 costs ~33% but avoids
                // hand-rolling a WebSocket frame writer on a raw socket.
                res.write('data: ' + b64 + '\n\n')
              })
            } catch (error) {
              res.write('event: error'+'\n'+'data: ' + JSON.stringify(String(error)) + '\n\n')
              res.end()
              return undefined
            }
            // Held open deliberately; the disposer below tears it down.
            return undefined
          }
          if (action === 'state') return json(res, 200, { ok: true, ...(await live.state()) })
          if (action === 'text') return json(res, 200, { ok: true, text: await live.readText() })

          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
          const body = await readJsonBody(req)

          if (action === 'open') {
            const target = String(body?.url || '').trim()
            if (!target) return json(res, 400, { ok: false, error: 'missing-url' })
            const url = /^[a-z]+:\/\//i.test(target) ? target : 'https://' + target
            return json(res, 200, { ok: true, ...(await live.navigate(url)) })
          }
          if (action === 'viewport') {
            await live.setViewport(Number(body?.width) || 900, Number(body?.height) || 700, Number(body?.dpr) || 2)
            return json(res, 200, { ok: true })
          }
          if (action === 'back') return json(res, 200, { ok: true, ...(await live.goBack()) })
          if (action === 'reload') return json(res, 200, { ok: true, ...(await live.reload()) })
          if (action === 'input') {
            const k = body?.kind
            if (k === 'move') await live.mouse('mouseMoved', body.x, body.y)
            else if (k === 'down') await live.mouse('mousePressed', body.x, body.y, body.button || 'left', body.clickCount || 1)
            else if (k === 'up') await live.mouse('mouseReleased', body.x, body.y, body.button || 'left', body.clickCount || 1)
            else if (k === 'wheel') await live.mouse('wheel', body.x, body.y, 'none', 0, body.deltaY || 0)
            else if (k === 'text') await live.typeText(String(body.text || ''))
            else if (k === 'key') {
              await live.key('keyDown', body.event || {})
              await live.key('keyUp', body.event || {})
            } else return json(res, 400, { ok: false, error: 'unknown-input' })
            return json(res, 200, { ok: true })
          }
          return json(res, 404, { ok: false, error: 'unknown-live-action' })
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error) })
        }
      },
    })

    // ── Pane -> host: resolve what the human typed in the address bar ──────
    // Reuses normalizeTarget so a path typed by hand behaves exactly like one
    // passed to open_preview -- one implementation, no drift.
    const disposeOpen = ctx.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const body = await readJsonBody(req)
        let target
        try {
          target = normalizeTarget(body?.url)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error) })
        }
        let tabId = tabIdFor(target.url, store.tabs)
        const title = target.filePath ? path.basename(target.filePath) : (target.siteUrl || target.url)
        store.tabs.set(tabId, {
          id: tabId, url: target.url, title, kind: target.kind,
          filePath: target.filePath, siteUrl: target.siteUrl, openAt: Date.now(),
        })
        store.activeTabId = tabId
        store.opened = true
        return json(res, 200, {
          ok: true, tabId, url: target.url, kind: target.kind,
          filePath: target.filePath ?? null, siteUrl: target.siteUrl ?? null, label: title,
        })
      },
    })

    // ── Iframe -> host: serve a local file for the pane ────────────────────
    // Same-origin by construction, which is what makes the document both
    // renderable (file: would be blocked) and live-DOM readable.
    const disposeFile = ctx.webServer.register({
      kind: 'exact',
      path: FILE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const params = new URL(req.url, 'http://localhost').searchParams
        const token = params.get('p') || ''
        const raw = params.get('raw') === '1'
        let abs = ''
        try {
          abs = Buffer.from(token, 'base64url').toString('utf8')
        } catch {
          return json(res, 400, { ok: false, error: 'bad-path-token' })
        }
        if (!abs) return json(res, 400, { ok: false, error: 'missing-path' })

        let info
        try {
          info = await stat(abs)
        } catch {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
          return res.end(`<body style="font:14px sans-serif;background:#16181d;color:#e6e8eb;padding:24px">`
            + `File not found:<br><code>${escapeAttr(abs)}</code></body>`)
        }
        if (info.isDirectory()) {
          res.writeHead(415, { 'content-type': 'text/html; charset=utf-8' })
          return res.end(`<body style="font:14px sans-serif;background:#16181d;color:#e6e8eb;padding:24px">`
            + `That is a directory, not a file:<br><code>${escapeAttr(abs)}</code></body>`)
        }

        try {
          // ── save to the machine the human is sitting at ──────────────────
          // Not the same thing as `raw`: this asks the browser to WRITE the
          // file rather than display it. It matters most when the harness is on
          // another machine -- the file lives over there, and this is the only
          // way it reaches the one being looked at.
          if (params.get('dl') === '1') {
            const { readFile } = await import('node:fs/promises')
            const known = await rawFile(abs)
            // Anything rawFile has no opinion about (.md, .py, .zip...) still
            // has to be downloadable, so fall back to opaque bytes.
            const body = known ? known.body : await readFile(abs)
            const name = path.basename(abs)
            // A quoted filename cannot carry quotes, backslashes or non-ASCII,
            // so send a sanitised one for old clients and the real one via the
            // RFC 5987 form that every current browser prefers.
            const safe = name.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_')
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`,
              'content-length': Buffer.byteLength(body),
              'cache-control': 'no-store',
            })
            return res.end(body)
          }

          if (raw) {
            // Bytes as-is. Originally only the PDF wrapper's <embed> used this,
            // and the type was hardcoded to application/pdf -- which mislabels
            // every other file, and an <img> pointing here got a PNG announced
            // as a PDF. rawFile knows the real type; PDF is only the fallback
            // because that is what the original caller needs.
            const known = await rawFile(abs)
            if (known) {
              res.writeHead(200, { 'content-type': known.type, 'cache-control': 'no-store' })
              return res.end(known.body)
            }
            const { readFile } = await import('node:fs/promises')
            const buf = await readFile(abs)
            res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' })
            return res.end(buf)
          }
          const out = await renderFile(abs, info, `${FILE_PATH}?p=${token}&raw=1`)
          res.writeHead(200, {
            'content-type': out.type,
            // The pane re-reads on navigate; a stale cached copy would show old
            // content after the agent rewrites the file.
            'cache-control': 'no-store',
          })
          return res.end(out.body)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
          return res.end(`<body style="font:14px sans-serif;background:#16181d;color:#e6e8eb;padding:24px">`
            + `Could not render:<br><code>${escapeAttr(abs)}</code><br><br>${escapeAttr(String(error))}</body>`)
        }
      },
    })

    return () => {
      disposeState()
      disposeCommands()
      disposeFile()
      disposeOpen()
      disposeProxy()
      disposeAsset()
      disposeLive()
      live.detach()
    }
  }, 'dsh-plugin-browser: http bridge')

  // ── open_preview ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'open_preview',
    description:
      'Open a web page OR a local file in the visible in-app preview browser pane and make it '
      + 'the active tab. The human sees the page; you then read its rendered text with '
      + 'read_preview. Accepts bare domains (reddit.com), http(s) URLs, localhost:PORT, and local '
      + 'file paths (C:\path\to\file.md, /abs/path, or file: URLs). Local files are rendered: '
      + 'markdown becomes a formatted document, .html renders as a real page, images display, and '
      + 'code/text is shown syntax-framed. Does not open the OS browser.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'URL to open in the preview pane (bare domain, http(s), localhost, or file:).',
      },
      label: {
        type: 'string',
        description: 'Optional human-readable label for the tab.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          tabId: { type: 'string' },
          url: { type: 'string' },
          kind: { type: 'string' },
          opened: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `[preview] ${value.kind}: ${value.url} (tab ${value.tabId})` }],
    },
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const { url, kind, filePath, siteUrl } = normalizeTarget(args.url)
      const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : undefined

      let tabId = tabIdFor(url, store.tabs)
      if (!store.tabs.has(tabId)) {
        const id = tabId // reuses the found id or the fresh one
        // A file tab shows its basename, not the base64 token in the URL.
        const title = filePath ? path.basename(filePath) : (siteUrl || url)
        store.tabs.set(id, { id, url, title, kind, label, filePath, siteUrl, openAt: Date.now() })
        tabId = id
      } else {
        // Existing tab: reuse, keep id stable, refresh target.
        const tab = store.tabs.get(tabId)
        tab.url = url
        tab.filePath = filePath
        tab.siteUrl = siteUrl
        if (filePath) tab.title = path.basename(filePath)
        else if (siteUrl) tab.title = siteUrl
        if (label) tab.label = label
      }

      store.activeTabId = tabId
      store.opened = true
      // Queue the navigation for the browser pane to execute.
      store.commands.push({ seq: ++store.commandSeq, at: Date.now(), action: 'navigate', tabId, url, kind, label, filePath, siteUrl })

      // Best-effort: give the browser a moment so a following read_preview sees
      // the freshly pushed state rather than a stale/empty pane.
      await new Promise((resolve) => setTimeout(resolve, 450))

      const latest = store.state.get(tabId)
      return {
        ok: true,
        tabId,
        url,
        kind,
        opened: Boolean(latest && typeof latest.text === 'string'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Open preview', kind: 'preview', rawInput: args.url }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Preview opened', kind: 'preview', output: result.url }),
  }))

  // ── read_preview ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'read_preview',
    description:
      'Read the CURRENTLY VISIBLE tab in the in-app preview browser pane, returning its rendered '
      + 'visible text (not HTML). Works for web pages AND local files. Always re-read: never reuse '
      + 'an earlier read, the pane goes stale in seconds. If end < total_chars, call again with '
      + 'start=end to page through. If the pane is empty or still loading, it says so — do not '
      + 'invent content.',
    parameters: {
      start: {
        type: 'integer',
        description: `Character offset to read from. Defaults to 0.`,
      },
      count: {
        type: 'integer',
        description: `Max characters to read. Defaults to ${defaultCount}, max ${MAX_COUNT}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          start: { type: 'integer' },
          end: { type: 'integer' },
          total_chars: { type: 'integer' },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute(args) {
      if (!store.opened || store.activeTabId === null) {
        return { kind: 'empty', url: '', title: '', text: 'The preview pane is closed. Open it with open_preview.', start: 0, end: 0, total_chars: 0 }
      }
      // A PDF is shown as page IMAGES, so its DOM holds nothing but page
      // numbers. Read the document's text layer instead -- otherwise the agent
      // is looking at a document it cannot read.
      const activeTab = store.tabs.get(store.activeTabId)
      if (activeTab?.filePath && /\.pdf$/i.test(activeTab.filePath)) {
        try {
          const info = await stat(activeTab.filePath)
          const full = await extractPdfText(activeTab.filePath, info)
          if (full) {
            const s0 = Number.isInteger(args?.start) && args.start >= 0 ? args.start : 0
            const c0 = Number.isInteger(args?.count) && args.count > 0 ? Math.min(args.count, MAX_COUNT) : defaultCount
            const e0 = Math.min(s0 + c0, full.length)
            return {
              kind: 'file', url: activeTab.filePath, title: path.basename(activeTab.filePath),
              text: full.slice(s0, e0), start: s0, end: e0, total_chars: full.length,
            }
          }
          return {
            kind: 'file', url: activeTab.filePath, title: path.basename(activeTab.filePath),
            text: 'This PDF has no text layer (it is scanned images). The pane shows the '
              + 'rendered pages; use analyze_image on a page if you need to read it.',
            start: 0, end: 0, total_chars: 0,
          }
        } catch {
          // fall through to the normal pane read
        }
      }

      // A web target is shown by the LIVE browser, which streams pixels and
      // pushes no text -- so the pane's store has nothing for it. Ask the
      // browser itself: Runtime.evaluate on the real DOM, which is both the
      // freshest answer and the only one that exists for these tabs.
      // ...unless the pane is the desktop shell, where the live tab is an
      // embedded <webview> the pane reads directly and pushes. Then the pushed
      // text IS the live DOM, and asking a CDP browser would answer about a
      // different browser entirely.
      const activeState = store.state.get(store.activeTabId)
      const paneOwnsBrowser = store.paneMode === 'webview' || activeState?.mode === 'webview'

      if (activeTab?.siteUrl && !paneOwnsBrowser) {
        try {
          const liveState = await live.state()
          if (liveState?.url) {
            const full = (await live.readText())
              .replace(new RegExp(String.fromCharCode(160), 'g'), ' ')
              .split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean)
              .join(String.fromCharCode(10))
            const s0 = Number.isInteger(args?.start) && args.start >= 0 ? args.start : 0
            const c0 = Number.isInteger(args?.count) && args.count > 0 ? Math.min(args.count, MAX_COUNT) : defaultCount
            const e0 = Math.min(s0 + c0, full.length)
            return {
              kind: 'url',
              url: liveState.url,
              title: liveState.title || activeTab.title || '',
              text: full.length ? full.slice(s0, e0)
                : 'The page is open but has rendered no text yet.',
              start: s0, end: e0, total_chars: full.length,
            }
          }
        } catch {
          // Live browser unreachable -- fall through to the proxy's pushed text.
        }
      }

      // No stale fallback. If the active tab has not rendered, the honest
      // answer is "still loading" -- reading whatever the pane showed BEFORE
      // produced a confident wrong answer once already (a tab labelled Google
      // returned CNN's text, and the agent reported it as current). A warning
      // label on a wrong answer is not a fix; not giving the wrong answer is.
      const tabId = store.activeTabId
      const state = store.state.get(tabId)
      const tab = store.tabs.get(tabId)

      if (!state || typeof state.text !== 'string' || state.text.length === 0) {
        return {
          kind: tab?.kind === 'file' ? 'file' : 'empty',
          url: tab?.filePath || tab?.siteUrl || tab?.url || '',
          title: tab?.title ?? '',
          text: 'The preview pane is still loading this page; no rendered text yet.',
          start: 0, end: 0, total_chars: 0,
        }
      }

      const start = Number.isInteger(args?.start) && args.start >= 0 ? args.start : 0
      const count = Number.isInteger(args?.count) && args.count > 0 ? Math.min(args.count, MAX_COUNT) : defaultCount
      const end = Math.min(start + count, state.text.length)

      return {
        kind: tab?.kind === 'file' ? 'file' : 'url',
        url: tab?.filePath || tab?.siteUrl || state.url || tab?.url || '',
        title: state.title || tab?.title || '',
        text: state.text.slice(start, end),
        start,
        end,
        total_chars: state.text.length,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Read preview', kind: 'preview', rawInput: JSON.stringify(args ?? {}) }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Preview text', kind: 'preview', output: result.text }),
  }))

  // ── close_preview ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'close_preview',
    description:
      'Close the in-app preview browser pane, or one tab of it. Without an argument closes the '
      + 'whole pane; with a url closes just that tab.',
    parameters: {
      url: {
        type: 'string',
        description: 'Optional URL of the tab to close. Omit to close the whole pane.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          closed_tab: { type: 'boolean' },
          pane_open: { type: 'boolean' },
        },
      },
      render: (args, value) => [{ type: 'text', text: value.closed_tab ? 'closed tab' : 'closed pane' }],
    },
    timeoutMs: 10000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      if (url.length > 0) {
        // Close one tab matching that URL.
        let tabId = null
        for (const [id, tab] of store.tabs) {
          if (tab.url === url || tab.url === normalizeTarget(url).url) { tabId = id; break }
        }
        if (!tabId) return { ok: true, closed_tab: false, pane_open: store.opened }
        store.tabs.delete(tabId)
        store.state.delete(tabId)
        if (store.activeTabId === tabId) {
          store.activeTabId = store.tabs.size ? [...store.tabs.keys()][store.tabs.size - 1] : null
          if (store.tabs.size === 0) store.opened = false
        }
        store.commands.push({ seq: ++store.commandSeq, at: Date.now(), action: 'close-tab', tabId })
        return { ok: true, closed_tab: true, pane_open: store.opened }
      }

      store.opened = false
      store.state.clear()
      store.commands.push({ seq: ++store.commandSeq, at: Date.now(), action: 'close-all' })
      return { ok: true, closed_tab: false, pane_open: false }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Close preview', kind: 'preview', rawInput: args?.url ?? '' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Preview closed', kind: 'preview', output: result.closed_tab ? 'tab' : 'pane' }),
  }))
}
