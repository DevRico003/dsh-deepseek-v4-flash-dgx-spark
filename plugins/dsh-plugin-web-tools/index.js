/**
 * dsh-plugin-web-tools: keyless `web_search` provider for DeepSeek Harness,
 * backed by the local DuckDuckGo shim (DeepSeek-Harness-Web-Tools/shim/server.py,
 * LaunchAgent com.devrico003.dsh-ddg-shim on 127.0.0.1:8899).
 *
 * Provider code adapted from tonyd2wild/DeepSeek-Harness-Web-Tools (MIT).
 * Registers into `ctx.web`'s provider registry as `ddg-shim`; the bundle's
 * cordis.patch.yml points `web.searchProvider` at it and mounts
 * `@deepseek-ai/dsh-web-fetch-http` as `web.fetchProvider: http`.
 */

export const name = 'web-search-ddg'
export const inject = ['web']

const DEFAULT_BASE_URL = 'http://127.0.0.1:8899'
const PROVIDER_ID = 'ddg-shim'

function isValidBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

class DdgSearchProvider {
  id = PROVIDER_ID
  constructor(options) { this.options = options }

  /** Cheap and local: the seam calls this to pick a provider, never to probe it. */
  available() { return isValidBaseUrl(this.options.baseURL) }

  async search(request, signal) {
    const body = { query: request.query, type: 'auto', contents: { highlights: { highlightsPerUrl: 1 } } }
    if (typeof request.maxResults === 'number' && request.maxResults > 0) body.numResults = request.maxResults
    let response
    try {
      response = await fetch(`${this.options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('DuckDuckGo search aborted')
      throw new Error(`DuckDuckGo shim unreachable at ${this.options.baseURL} (${String(error)}). Is the LaunchAgent com.devrico003.dsh-ddg-shim running?`)
    }
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const parsed = await response.json()
        if (typeof parsed?.error === 'string' && parsed.error.length > 0) detail = parsed.error
      } catch { /* keep status */ }
      throw new Error(`DuckDuckGo shim error: ${detail}`)
    }
    let payload
    try { payload = await response.json() } catch (error) { throw new Error(`DuckDuckGo shim returned an unprocessable body: ${String(error)}`) }
    const sources = []
    for (const result of payload?.results ?? []) {
      if (typeof result?.url !== 'string' || result.url.length === 0) continue
      const snippet = (result.highlights ?? []).find(h => typeof h === 'string' && h.trim().length > 0)
      const source = { url: result.url }
      if (typeof result.title === 'string' && result.title.length > 0) source.title = result.title
      if (snippet !== undefined) source.snippet = snippet
      sources.push(source)
    }
    return { sources, truncated: false }
  }
}

export function apply(ctx, config) {
  const baseURL = config?.baseURL ?? DEFAULT_BASE_URL
  ctx.web.registerSearchProvider(new DdgSearchProvider({ baseURL }))
}
