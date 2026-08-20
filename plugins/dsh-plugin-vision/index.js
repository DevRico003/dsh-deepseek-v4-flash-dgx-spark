// dsh-plugin-vision: analyze_image tool for DeepSeek Harness.
//
// The brain (DeepSeek-V4-Flash on the Sparks) is text-only. This tool lets the
// agent hand an image FILE to a local vision model (mlx-vlm on the Mac) and get
// a TEXT description back; no image bytes ever enter the brain's context.
// Adapted from tonyd2wild/DeepSeek-Harness-Vision-Tools (MIT): harness tool DSL
// instead of raw JSON schema, sandbox-safe reads through ctx.fs when mounted,
// backends/timeouts from the plugin config block (hot-patchable in the profile).

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-plugin-vision'
export const inject = ['tools']

const DEFAULT_PROMPT = 'Describe this image in detail. Transcribe any visible text verbatim.'

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
}

function mimeFor(filePath) {
  const ext = String(filePath).toLowerCase().split('.').pop()
  return MIME[ext] ?? 'image/png'
}

/** Resolve backends: plugin config first, then env vars (VISION_FAST_URL/…), else none. */
function resolveBackends(config) {
  if (config.backends && Object.keys(config.backends).length > 0) return config.backends
  const env = process.env
  const out = {}
  if (env.VISION_FAST_URL) out.fast = { url: env.VISION_FAST_URL, model: env.VISION_FAST_MODEL ?? 'fast' }
  if (env.VISION_DETAILED_URL) out.detailed = { url: env.VISION_DETAILED_URL, model: env.VISION_DETAILED_MODEL ?? 'detailed' }
  return out
}

/**
 * Read image bytes. Prefer the harness fs service (workspace boundary + approval
 * policy); fall back to node:fs only when no fs service is mounted (headless
 * compositions without a sandbox).
 */
async function readImageBytes(ctx, filePath, signal, maxBytes) {
  const fs = ctx.get('fs')
  if (fs && typeof fs.resolve === 'function' && typeof fs.readBytes === 'function') {
    const target = await fs.resolve(filePath, { signal })
    const data = await fs.readBytes(target, signal, maxBytes)
    return { bytes: Buffer.from(data), displayPath: target.displayPath ?? filePath }
  }
  const { readFile, stat } = await import('node:fs/promises')
  const info = await stat(filePath)
  if (info.size > maxBytes) throw new Error(`[analyze_image] ${filePath} is ${info.size} bytes, above the ${maxBytes}-byte limit`)
  return { bytes: await readFile(filePath), displayPath: filePath }
}

export function apply(ctx, config = {}) {
  const backends = resolveBackends(config)
  const names = Object.keys(backends)
  if (names.length === 0) throw new Error('[analyze_image] no vision backends configured (config.backends or VISION_FAST_URL)')
  const defaultBackend = names.includes(config.defaultBackend ?? 'fast') ? (config.defaultBackend ?? 'fast') : names[0]
  const timeoutMs = Number(config.timeoutMs ?? 180000)
  const maxImageBytes = Number(config.maxImageBytes ?? 20 * 1024 * 1024)

  const description =
    'Analyze an image FILE (png/jpg/webp/gif) with a local vision model and return a text description. '
    + 'You cannot see images yourself; use this whenever you need to know what is in a screenshot, photo, diagram or camera frame on disk. '
    + `Available backends: ${names.join(', ')} (default "${defaultBackend}"). `
    + 'Use "fast" for colours, layout and coarse content; "detailed" for small text, OCR and fine detail. '
    + 'Report the result as a description from the vision model ("the description indicates…"), not as something you saw.'

  ctx.tools.register(defineTool({
    name: 'analyze_image',
    description,
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the image file (absolute or workspace-relative).' },
      backend: { type: 'string', description: `Vision backend: one of ${names.join(', ')}. Defaults to "${defaultBackend}".` },
      prompt: { type: 'string', description: 'What to ask the vision model about the image. Default: a detailed description including visible text.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const filePath = String(args.path ?? '').trim()
      if (filePath === '') throw new Error('[analyze_image] "path" is required')
      const backendName = args.backend ? String(args.backend) : defaultBackend
      const backend = backends[backendName]
      if (!backend) throw new Error(`[analyze_image] unknown backend "${backendName}". Valid backends: ${names.join(', ')}.`)
      const prompt = args.prompt ? String(args.prompt) : DEFAULT_PROMPT

      const { bytes, displayPath } = await readImageBytes(ctx, filePath, exec.signal, maxImageBytes)
      const dataUrl = `data:${mimeFor(filePath)};base64,${bytes.toString('base64')}`
      const body = JSON.stringify({
        model: backend.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        max_tokens: backend.maxTokens ?? 512,
        temperature: backend.temperature ?? 0.2,
      })
      const signal = exec.signal ? AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      let response
      try {
        response = await fetch(backend.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal })
      } catch (error) {
        throw new Error(`[analyze_image] cannot reach backend "${backendName}" at ${backend.url}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`[analyze_image] backend "${backendName}" (${backend.url}) returned HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
      const data = await response.json()
      const text = data?.choices?.[0]?.message?.content?.trim()
      if (!text) throw new Error(`[analyze_image] backend "${backendName}" (${backend.url}) returned no text`)
      return `[Image ${displayPath}, described by vision backend "${backendName}" (${backend.model})]\n${text}`
    },
  }))
}
