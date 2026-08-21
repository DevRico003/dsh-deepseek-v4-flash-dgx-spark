/**
 * dsh-plugin-browser — server-side PDF rendering.
 *
 * Why this exists: a `.pdf` in an iframe depends entirely on the browser having
 * a PDF viewer, and that is not something a preview pane can rely on. A
 * sandboxed frame refuses to instantiate the viewer at all, and some embedded
 * browsers (the one used to test this plugin among them) have no viewer and
 * offer a download instead — the pane just sits blank.
 *
 * Rendering the pages to images server-side removes the dependency: the result
 * is an ordinary HTML document of `<img>` tags, which every browser can draw.
 *
 * The images are inlined as data URIs deliberately. A relative `<img src>` in a
 * generated page would have to resolve against a route rather than a directory,
 * and a self-contained document sidesteps that entirely.
 *
 * Falls back to `null` when Python or PyMuPDF is unavailable, so the caller can
 * serve the `<embed>` wrapper instead and let a capable browser do its thing.
 *
 * @module dsh-plugin-browser/pdfrender
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

/**
 * Interpreters to try, in order. Set DSH_PREVIEW_PYTHON to point at a specific
 * one (e.g. a venv that has PyMuPDF) and it is tried first.
 */
const PYTHONS = [
  process.env.DSH_PREVIEW_PYTHON,
  'python',
  'python3',
  path.join(os.homedir(), '.dsh', 'venv', 'Scripts', 'python.exe'),
  path.join(os.homedir(), '.dsh', 'venv', 'bin', 'python'),
].filter(Boolean)

/** Cap the work: a 400-page scan would produce a payload nothing can display. */
const MAX_PAGES = 40
const ZOOM = 1.5
const TIMEOUT_MS = 120000

/** Rendered pages, keyed by path+mtime so an edited PDF re-renders. */
const cache = new Map()

const SCRIPT = `
import sys, json, base64
try:
    import pymupdf
except ImportError:
    try:
        import fitz as pymupdf
    except ImportError:
        print(json.dumps({"error": "pymupdf-missing"}))
        sys.exit(0)

src = sys.argv[1]
max_pages = int(sys.argv[2])
zoom = float(sys.argv[3])
try:
    doc = pymupdf.open(src)
except Exception as exc:
    print(json.dumps({"error": "open-failed: %s" % exc}))
    sys.exit(0)

total = doc.page_count
pages = []
for i in range(min(total, max_pages)):
    pix = doc[i].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    pages.append(base64.b64encode(pix.tobytes("jpeg", jpg_quality=82)).decode())

print(json.dumps({"total": total, "rendered": len(pages), "pages": pages}))
`

function runPython(exe, args, script) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }

    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } done(null) }, TIMEOUT_MS)

    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', () => { /* diagnostics only; failure shows as no JSON */ })
    child.on('error', () => { clearTimeout(timer); done(null) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        done(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        done(null)
      }
    })
    child.stdin.write(script || SCRIPT)
    child.stdin.end()
  })
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function bytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * Render a PDF to a self-contained HTML document of page images.
 *
 * @param {string} abs absolute path to the PDF
 * @param {{size: number, mtimeMs: number}} stat
 * @returns {Promise<string|null>} the HTML, or null if rendering is unavailable
 */
export async function renderPdf(abs, stat) {
  const key = abs + '|' + stat.mtimeMs + '|' + stat.size
  if (cache.has(key)) return cache.get(key)

  let result = null
  for (const exe of PYTHONS) {
    // eslint-disable-next-line no-await-in-loop -- ordered fallback, not a batch
    result = await runPython(exe, ['-', abs, String(MAX_PAGES), String(ZOOM)])
    if (result && !result.error && Array.isArray(result.pages)) break
    result = null
  }
  if (!result) return null

  const base = path.basename(abs)
  const truncated = result.total > result.rendered
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + escapeHtml(base) + '</title><style>'
    + ':root{color-scheme:dark}'
    + 'body{margin:0;padding:18px 16px 48px;background:#16181d;color:#e6e8eb;'
    + 'font:13px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}'
    + '.bar{display:flex;align-items:baseline;gap:10px;margin:0 0 16px;padding-bottom:10px;'
    + 'border-bottom:1px solid #23262d}'
    + '.bar .name{font-weight:620}.bar .meta{font-size:11px;color:#6b7280}'
    + '.page{position:relative;margin:0 auto 16px;max-width:900px;background:#fff;'
    + 'border-radius:4px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.45)}'
    + '.page img{width:100%;height:auto;display:block}'
    + '.num{position:absolute;top:6px;right:8px;background:rgba(0,0,0,.55);color:#fff;'
    + 'font-size:10px;padding:2px 6px;border-radius:999px}'
    + '.note{max-width:900px;margin:0 auto 16px;padding:9px 12px;border-radius:6px;'
    + 'background:rgba(111,179,255,.10);border:1px solid rgba(111,179,255,.35);font-size:12px}'
    + '</style></head><body>'
    + '<div class="bar"><span class="name">' + escapeHtml(base) + '</span>'
    + '<span class="meta">PDF · ' + result.total + ' page' + (result.total === 1 ? '' : 's')
    + ' · ' + bytes(stat.size) + '</span></div>'
    + (truncated
      ? '<div class="note">Showing the first ' + result.rendered + ' of ' + result.total
        + ' pages. Read the rest with a file tool.</div>'
      : '')
    + result.pages.map((b64, i) =>
      '<div class="page"><span class="num">' + (i + 1) + '</span>'
      + '<img loading="lazy" alt="page ' + (i + 1) + '" src="data:image/jpeg;base64,' + b64 + '"></div>'
    ).join('')
    + '</body></html>'

  // One document at a time is plenty; this is a preview pane, not a library.
  if (cache.size > 3) cache.clear()
  cache.set(key, html)
  return html
}

const TEXT_SCRIPT = `
import sys, json
try:
    import pymupdf
except ImportError:
    try:
        import fitz as pymupdf
    except ImportError:
        print(json.dumps({"error": "pymupdf-missing"}))
        sys.exit(0)

NL = chr(10)
try:
    doc = pymupdf.open(sys.argv[1])
except Exception as exc:
    print(json.dumps({"error": "open-failed: %s" % exc}))
    sys.exit(0)

parts = []
for i in range(doc.page_count):
    t = doc[i].get_text().strip()
    if t:
        parts.append("===== PAGE %d =====%s%s" % (i + 1, NL, t))
print(json.dumps({"total": doc.page_count, "text": (NL + NL).join(parts)}))
`

/** Extracted text, keyed like the render cache. */
const textCache = new Map()

/**
 * Extract a PDF's text layer.
 *
 * The pane shows a PDF as page IMAGES, so reading its DOM yields nothing but
 * page numbers — the agent would see a document and be unable to read it. The
 * text layer is the honest answer to `read_preview` for a PDF.
 *
 * Returns null for a scanned PDF with no text layer, so the caller can say so
 * rather than pretending the document is empty.
 *
 * @param {string} abs
 * @param {{size: number, mtimeMs: number}} stat
 * @returns {Promise<string|null>}
 */
export async function extractPdfText(abs, stat) {
  const key = abs + '|' + stat.mtimeMs + '|' + stat.size
  if (textCache.has(key)) return textCache.get(key)

  let result = null
  for (const exe of PYTHONS) {
    // eslint-disable-next-line no-await-in-loop -- ordered fallback, not a batch
    result = await runPython(exe, ['-', abs], TEXT_SCRIPT)
    if (result && !result.error && typeof result.text === 'string') break
    result = null
  }
  if (!result) return null

  const text = result.text.trim()
  const value = text.length > 0 ? text : null
  if (textCache.size > 5) textCache.clear()
  textCache.set(key, value)
  return value
}
