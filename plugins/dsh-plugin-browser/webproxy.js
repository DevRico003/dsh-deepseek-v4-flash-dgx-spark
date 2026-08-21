/**
 * dsh-plugin-browser — same-origin web proxy for the preview pane.
 *
 * Why this exists: most real sites refuse to be framed. They send
 * `X-Frame-Options: DENY/SAMEORIGIN` or a CSP `frame-ancestors` directive, and
 * the browser then renders an empty pane. cnn.com, google.com, github.com,
 * x.com and most of the web behave this way, so an iframe-only preview browser
 * looks broken for exactly the sites people try first.
 *
 * Fetching server-side and re-serving from the harness solves two things at
 * once:
 *   1. The frame-blocking headers are simply not forwarded, so the page frames.
 *   2. The document becomes SAME-ORIGIN, so the browser half can read its live
 *      DOM instead of re-fetching and re-parsing the HTML.
 *
 * What it cannot do, honestly: pages behind a login, anything depending on the
 * site's own cookies, and SPAs whose scripts hard-code their origin. A `<base>`
 * tag fixes relative assets, but a site determined to detect proxying will.
 *
 * @module dsh-plugin-browser/webproxy
 */

/** Looks like a browser, because many sites serve junk to unknown agents. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Headers that would either block framing or lie about the transport. */
const STRIP = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'set-cookie',
])

const MAX_BYTES = 12 * 1024 * 1024

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}


/**
 * Sites whose signed-in experience will not survive proxying.
 *
 * Not a guess: a login session IS a cookie, this proxy fetches anonymously and
 * strips Set-Cookie, and the login form would POST cross-origin from an
 * opaque-origin frame. On top of that these platforms run CSRF tokens bound to
 * cookies, bot detection, and device fingerprinting. Browsing signed-out often
 * works; signing IN will not, and pretending otherwise wastes the user's time.
 */
const LOGIN_HOSTILE = [
  'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'threads.net',
  'reddit.com', 'linkedin.com', 'tiktok.com', 'accounts.google.com',
  'login.microsoftonline.com', 'appleid.apple.com',
]

function isLoginHostile(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return LOGIN_HOSTILE.some((d) => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

/** A one-line banner offering the real browser, for sites that need a session. */
function loginBanner(realUrl) {
  return '<div id="__dsh_login_note" style="all:initial;display:block;position:sticky;top:0;z-index:2147483647;'
    + 'font:13px/1.5 ui-sans-serif,-apple-system,system-ui,sans-serif;'
    + 'background:#1d2430;color:#dfe6f2;border-bottom:1px solid #33405a;padding:9px 14px">'
    + '<span style="all:unset">Signed-out view — you cannot log in through the preview. </span>'
    + '<a href="' + escapeAttr(realUrl) + '" target="_blank" rel="noreferrer" '
    + 'style="all:unset;color:#7cc0ff;text-decoration:underline;cursor:pointer">Open in your browser</a>'
    + '<span style="all:unset"> to sign in.</span>'
    + '<span onclick="this.parentNode.remove()" '
    + 'style="all:unset;float:right;cursor:pointer;color:#8b97ab;padding:0 4px">×</span>'
    + '</div>'
}

/**
 * Rewrite an HTML document so it still works when served from another origin.
 *
 * A `<base>` tag is the whole trick: relative URLs for stylesheets, scripts and
 * images then resolve against the ORIGINAL site rather than against the
 * harness. Without it the page loads but arrives unstyled.
 */
function rewriteHtml(html, finalUrl, proxyPath) {
  const base = finalUrl.replace(/[^/]*$/, '')
  const baseTag = `<base href="${escapeAttr(base)}">`

  // Route in-page navigation back through the proxy so following a link keeps
  // working instead of dumping the user onto a blocked bare iframe load.
  const hook = `<script>(function(){
  function proxied(href){
    try{
      var abs = new URL(href, ${JSON.stringify(finalUrl)}).href;
      if(!/^https?:/i.test(abs)) return null;
      return ${JSON.stringify(proxyPath)} + "?u=" + btoa(unescape(encodeURIComponent(abs)))
        .replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
    }catch(e){ return null; }
  }
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if(!a) return;
    var href = a.getAttribute("href") || "";
    if(/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    var next = proxied(href);
    if(!next) return;
    e.preventDefault();
    window.location.href = next;
  }, true);
})();</script>`

  let out = String(html)
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m) => m + baseTag)
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, (m) => m + '<head>' + baseTag + '</head>')
  } else {
    out = baseTag + out
  }

  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, hook + '</body>')
  else out += hook

  if (isLoginHostile(finalUrl)) {
    const banner = loginBanner(finalUrl)
    if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, (m) => m + banner)
    else out = banner + out
  }

  return out
}

/** Encode a URL the same way the in-page hook does, so both agree. */
export function proxyToken(url) {
  return Buffer.from(String(url), 'utf8').toString('base64url')
}

/**
 * Fetch a URL server-side and return a framable, same-origin version.
 *
 * @param {string} token base64url of the target URL
 * @param {string} proxyPath the route this proxy is mounted at
 * @returns {Promise<{status: number, type: string, body: Buffer|string, headers?: object}>}
 */
export async function proxyFetch(token, proxyPath) {
  let target = ''
  try {
    target = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    return { status: 400, type: 'text/plain; charset=utf-8', body: 'bad url token' }
  }
  if (!/^https?:\/\//i.test(target)) {
    return { status: 400, type: 'text/plain; charset=utf-8', body: 'only http(s) can be proxied' }
  }

  let res
  try {
    res = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
  } catch (error) {
    return {
      status: 502,
      type: 'text/html; charset=utf-8',
      body: '<body style="font:14px sans-serif;background:#16181d;color:#e6e8eb;padding:28px">'
        + '<b>Could not reach that site.</b><br><br><code>' + escapeAttr(target) + '</code><br><br>'
        + escapeAttr(String(error)) + '</body>',
    }
  }

  const type = res.headers.get('content-type') || 'application/octet-stream'
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) {
    return { status: 413, type: 'text/plain; charset=utf-8', body: 'response too large to preview' }
  }

  const passthrough = {}
  for (const [k, v] of res.headers) {
    if (!STRIP.has(k.toLowerCase())) passthrough[k] = v
  }

  if (/text\/html/i.test(type)) {
    const html = rewriteHtml(buf.toString('utf8'), res.url || target, proxyPath)
    return { status: res.status, type: 'text/html; charset=utf-8', body: html, headers: passthrough }
  }

  return { status: res.status, type, body: buf, headers: passthrough }
}
