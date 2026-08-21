/**
 * dsh-plugin-browser — local file rendering for the preview pane.
 *
 * Files are served through the HOST's own web server rather than handed to the
 * iframe as a `file:` URL. Two reasons, both decisive:
 *
 *   1. Chrome refuses to load `file:` inside an http(s) page, so a `file:`
 *      iframe simply renders nothing.
 *   2. Served from the host, the document is SAME-ORIGIN with the app, so the
 *      browser half can read its live DOM directly -- no fetch-and-reparse
 *      fallback, and `read_preview` returns true rendered text.
 *
 * Markdown is rendered here rather than pulled from a client library: the pane
 * has no bundler, so a small dependency-free renderer keeps the plugin
 * self-contained.
 *
 * @module dsh-plugin-browser/filerender
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { renderPdf } from './pdfrender.js'

/** Rendered as rich markdown. */
const MARKDOWN = new Set(['.md', '.markdown', '.mdown', '.mkd'])

/** Served verbatim so they render as real pages. */
const RAW_HTML = new Set(['.html', '.htm'])

/** Binary media served with a correct content-type. */
const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
}

/** Media shown inside a framed page rather than served bare. */
const FRAMED_IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif', '.ico'])

/** Language labels for the code viewer header. */
const CODE_LANG = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cs': 'C#',
  '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.vbs': 'VBScript',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.xml': 'XML', '.css': 'CSS', '.sql': 'SQL', '.txt': 'Text',
  '.log': 'Log', '.ini': 'INI', '.env': 'Env', '.csv': 'CSV',
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Inline markdown: code spans, bold, italic, strike, links, images.
 *
 * Code spans are lifted out first and restored last, so their contents are
 * never re-processed as markup -- otherwise `**` inside a code sample would
 * turn into bold tags.
 */
function inline(src) {
  let s = escapeHtml(src)
  const spans = []
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    spans.push('<code>' + code + '</code>')
    return '@@DSHCODE' + (spans.length - 1) + '@@'
  })
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  s = s.replace(/@@DSHCODE(\d+)@@/g, (_m, i) => spans[Number(i)])
  return s
}

/**
 * Render markdown to HTML. Deliberately small: headings, fenced code, lists,
 * tables, blockquotes, rules, paragraphs. Not CommonMark-complete -- it covers
 * what agent-authored documents actually contain.
 */
function markdownToHtml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  let listType = null

  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null } }

  while (i < lines.length) {
    const line = lines[i]

    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      closeList()
      const marker = fence[1][0]
      const lang = fence[2].trim()
      const buf = []
      i++
      while (i < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      out.push('<pre class="code"' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '')
        + '><code>' + escapeHtml(buf.join('\n')) + '</code></pre>')
      continue
    }

    // table: a header row followed by a |---|---| separator
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList()
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(line)
      i += 2
      const body = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i++ }
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>')
      continue
    }

    if (/^\s*$/.test(line)) { closeList(); i++; continue }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>')
      i++
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      closeList()
      const buf = [quote[1]]
      i++
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push('<blockquote>' + markdownToHtml(buf.join('\n')) + '</blockquote>')
      continue
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (listType !== want) { closeList(); out.push('<' + want + '>'); listType = want }
      const item = ul ? ul[1] : ol[1]
      const box = /^\[([ xX])\]\s+(.*)$/.exec(item)
      if (box) {
        const checked = box[1].toLowerCase() === 'x'
        out.push('<li class="task"><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' + inline(box[2]) + '</li>')
      } else {
        out.push('<li>' + inline(item) + '</li>')
      }
      i++
      continue
    }

    closeList()
    const para = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i])
      && !/^\s*\d+[.)]\s/.test(lines[i]) && !/^\s*>/.test(lines[i])
      && !/^\s*(`{3,}|~{3,})/.test(lines[i]) && !/^\s*\|/.test(lines[i])) {
      para.push(lines[i]); i++
    }
    out.push('<p>' + inline(para.join('\n')) + '</p>')
  }
  closeList()
  return out.join('\n')
}

/** Shared page chrome. Dark, to sit inside the harness shell without glare. */
function page(title, bodyHtml) {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>' + escapeHtml(title) + '</title>\n<style>\n'
    + ':root { color-scheme: dark; }\n'
    + '* { box-sizing: border-box; }\n'
    + 'body { margin:0; padding:24px 28px 64px; background:#16181d; color:#e6e8eb;'
    + ' font:14px/1.65 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }\n'
    + 'a { color:#6fb3ff; text-decoration:none; } a:hover { text-decoration:underline; }\n'
    + 'h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.6em 0 .6em; font-weight:650; }\n'
    + 'h1 { font-size:1.7em; margin-top:0; padding-bottom:.3em; border-bottom:1px solid #2b2f37; }\n'
    + 'h2 { font-size:1.35em; padding-bottom:.25em; border-bottom:1px solid #23262d; }\n'
    + 'h3 { font-size:1.13em; } h4 { font-size:1em; color:#c7ccd4; }\n'
    + 'p { margin:.75em 0; } ul,ol { margin:.6em 0; padding-left:1.5em; } li { margin:.25em 0; }\n'
    + 'li.task { list-style:none; margin-left:-1.2em; }\n'
    + 'code { font-family:ui-monospace,"Cascadia Code",Consolas,monospace; font-size:.9em;'
    + ' background:#21252c; border:1px solid #2b2f37; border-radius:4px; padding:.12em .38em; }\n'
    + 'pre.code { background:#101216; border:1px solid #262a32; border-radius:8px; padding:14px 16px;'
    + ' overflow-x:auto; position:relative; }\n'
    + 'pre.code code { background:none; border:0; padding:0; font-size:.875em; line-height:1.55; }\n'
    + 'pre.code[data-lang]::before { content:attr(data-lang); position:absolute; top:6px; right:10px;'
    + ' font:10px ui-sans-serif,sans-serif; letter-spacing:.04em; text-transform:uppercase; color:#6b7280; }\n'
    + 'blockquote { margin:.9em 0; padding:.1em 0 .1em 14px; border-left:3px solid #3a4150; color:#b6bcc6; }\n'
    + 'hr { border:0; border-top:1px solid #2b2f37; margin:1.8em 0; }\n'
    + 'table { border-collapse:collapse; margin:1em 0; display:block; overflow-x:auto; max-width:100%; }\n'
    + 'th,td { border:1px solid #2b2f37; padding:7px 11px; text-align:left; }\n'
    + 'th { background:#1d2027; font-weight:620; } tr:nth-child(even) td { background:#191c22; }\n'
    + 'img { max-width:100%; height:auto; border-radius:6px; }\n'
    + '.filebar { display:flex; align-items:baseline; gap:10px; margin:-8px 0 20px; padding-bottom:10px;'
    + ' border-bottom:1px solid #23262d; }\n'
    + '.filebar .name { font-weight:620; font-size:13px; }\n'
    + '.filebar .meta { font-size:11px; color:#6b7280; }\n'
    + '</style></head><body>\n' + bodyHtml + '\n</body></html>'
}

function bytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function filebar(name, meta) {
  return '<div class="filebar"><span class="name">' + escapeHtml(name) + '</span>'
    + '<span class="meta">' + escapeHtml(meta) + '</span></div>'
}


/** Asset-route prefix for a file's own directory, used as an HTML <base>. */
export function assetBase(absFile) {
  const dir = path.dirname(absFile)
  return '/api/preview/asset/' + Buffer.from(dir, 'utf8').toString('base64url') + '/'
}

/** Insert a <base href> so relative URLs resolve against the file's directory. */
function withBase(html, base) {
  const tag = '<base href="' + escapeHtml(base) + '">'
  if (/<base\s/i.test(html)) return html            // the document already decided
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => m + tag)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, (m) => m + '<head>' + tag + '</head>')
  return tag + html
}


/**
 * Serve a file as its own bytes, with no framing page.
 *
 * This is what an `<img src>`, `<link rel=stylesheet>` or `<script src>` needs.
 * renderFile() deliberately wraps images in a styled page for direct viewing --
 * feeding that to an <img> tag would render nothing at all.
 *
 * @returns {Promise<{body: Buffer|string, type: string}|null>} null when the
 *   type is one that has no meaningful raw form here.
 */
export async function rawFile(abs) {
  const ext = path.extname(abs).toLowerCase()
  if (MEDIA[ext]) return { type: MEDIA[ext], body: await readFile(abs) }
  if (RAW_HTML.has(ext)) {
    return { type: 'text/html; charset=utf-8', body: withBase(await readFile(abs, 'utf8'), assetBase(abs)) }
  }
  const TEXTUAL = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  }
  if (TEXTUAL[ext]) return { type: TEXTUAL[ext], body: await readFile(abs) }
  return null
}

/**
 * Render one local file for the preview pane.
 *
 * @param {string} abs absolute filesystem path
 * @param {{size: number}} stat
 * @returns {Promise<{body: Buffer|string, type: string}>}
 */
export async function renderFile(abs, stat, rawUrl) {
  const ext = path.extname(abs).toLowerCase()
  const base = path.basename(abs)

  if (ext === '.pdf') {
    // Preferred: render the pages server-side to images. That works in every
    // browser, including ones with no PDF viewer at all, rather than depending
    // on a plugin the pane cannot check for.
    const rendered = await renderPdf(abs, stat)
    if (rendered) return { type: 'text/html; charset=utf-8', body: rendered }

    // Fallback when Python/PyMuPDF is unavailable: hand it to the browser's own
    // viewer via <embed>, which at least works where one exists.
    return {
      type: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><meta charset="utf-8">'
        + '<title>' + escapeHtml(base) + '</title>'
        + '<style>html,body{margin:0;height:100%;background:#1e1e1e}'
        + 'embed{display:block;width:100%;height:100%;border:0}</style></head><body>'
        + '<embed src="' + escapeHtml(rawUrl || '') + '" type="application/pdf">'
        + '</body></html>',
    }
  }

  if (MEDIA[ext]) {
    const buf = await readFile(abs)
    if (FRAMED_IMAGE.has(ext)) {
      // Framed rather than bare so the image sits on the app's background
      // instead of the browser's default white, and so read_preview has an
      // identity line to report rather than an empty document.
      const dataUrl = 'data:' + MEDIA[ext] + ';base64,' + buf.toString('base64')
      return {
        type: 'text/html; charset=utf-8',
        body: page(base, filebar(base, ext.slice(1).toUpperCase() + ' · ' + bytes(stat.size))
          + '<img src="' + dataUrl + '" alt="' + escapeHtml(base) + '">'),
      }
    }
    return { type: MEDIA[ext], body: buf }
  }

  if (RAW_HTML.has(ext)) {
    // Verbatim content, but with a <base> pointing at an asset route for the
    // file's own directory. Without it a relative `<img src="page1.png">`
    // resolves against the harness origin and 404s -- the page renders with
    // every local image blank, which is exactly what was observed.
    const raw = await readFile(abs, 'utf8')
    return { type: 'text/html; charset=utf-8', body: withBase(raw, assetBase(abs)) }
  }

  const text = await readFile(abs, 'utf8')

  if (MARKDOWN.has(ext)) {
    return {
      type: 'text/html; charset=utf-8',
      body: page(base, filebar(base, 'Markdown · ' + bytes(stat.size)) + markdownToHtml(text)),
    }
  }

  const lang = CODE_LANG[ext] || (ext ? ext.slice(1).toUpperCase() : 'Text')
  const lineCount = text.replace(/\r\n?/g, '\n').split('\n').length
  return {
    type: 'text/html; charset=utf-8',
    body: page(base, filebar(base, lang + ' · ' + lineCount + ' lines · ' + bytes(stat.size))
      + '<pre class="code" data-lang="' + escapeHtml(lang) + '"><code>' + escapeHtml(text) + '</code></pre>'),
  }
}

export { markdownToHtml, escapeHtml }
