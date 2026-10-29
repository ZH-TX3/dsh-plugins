/**
 * edge-tools — two model-facing tools that widen what this Agent can reach.
 *
 * WHY THIS ROW EXISTS. A preset chooses an Agent's TOOL FACE, and the shipped
 * tools stop at what the harness natively models:
 *
 *   - `web_fetch` is GET-only, so every authenticated / POST / GraphQL / RPC
 *     endpoint is out of reach;
 *   - `read_image` hands the image to the MAIN route's model, which a text-only
 *     route refuses ("model does not declare image input").
 *
 * Both gaps close at the tool layer, which is the extension point the tool
 * contract invites: a preset registers tools into its own scope. Neither tool
 * provides a service, so neither needs an `isolate` realm.
 *
 *   http_request     — arbitrary method/headers/body over fetch(), bounded
 *                      response, non-2xx reported as a value (not a throw).
 *   vision_describe  — read an image (local path or URL), send it to a
 *                      SEPARATE vision route through this harness's own `llm`
 *                      service, and return TEXT. The main route never sees the
 *                      pixels, so a text-only agent can still read a screenshot.
 *
 * WHY `ctx.llm` AND NOT A RAW HTTP CALL. Routing the vision request through the
 * mounted `llm` service means the credential store, base URL, retry policy and
 * — crucially — the model's DECLARED input modalities all come from the
 * provider configuration that already exists. A raw `fetch` would need a
 * second copy of the API key in this file, and would happily send an image to
 * a model that cannot read it.
 *
 * CONFIG (optional; unconfigured means the tool says what to set):
 *
 *   - id: edge-tools
 *     name: '@local/dsh-agent-presets/modules/edge-agent/edge-tools.mjs'
 *     config:
 *       vision:
 *         provider: test        # a registered provider route
 *         model: glm-5.2        # a model on that route that accepts images
 *         maxTokens: 1200       # optional answer budget
 *         prompt: ...           # optional default instruction
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'edge-tools'

/** The tool registry must exist before anything can register. */
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_BYTES = 200000
const VISION_MAX_BYTES = 8 * 1024 * 1024

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

const httpParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      description: 'Absolute http(s) URL to request.',
    },
    method: {
      type: 'string',
      enum: HTTP_METHODS,
      description: 'HTTP method; defaults to GET.',
    },
    headers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Headers as "Name: value" strings, e.g. ["Authorization: Bearer abc", "Accept: application/json"].',
    },
    body: {
      type: 'string',
      description: 'Request body, sent verbatim. JSON must already be serialized.',
    },
    timeoutMs: {
      type: 'integer',
      description: `Request deadline in milliseconds; defaults to ${DEFAULT_TIMEOUT_MS}.`,
    },
    maxBytes: {
      type: 'integer',
      description: `Response body cap in bytes before truncation; defaults to ${DEFAULT_MAX_BYTES}.`,
    },
  },
}

const httpOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'body', 'truncated'],
  properties: {
    status: { type: 'integer' },
    body: { type: 'string' },
    truncated: { type: 'boolean' },
    headers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
}

const visionParameters = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    file_path: {
      type: 'string',
      description: 'Local path to a PNG/JPEG/WebP/GIF file. Give this or `url`.',
    },
    url: {
      type: 'string',
      description: 'Absolute http(s) URL of an image. Give this or `file_path`.',
    },
    prompt: {
      type: 'string',
      description: 'What to ask about the image. Defaults to a thorough description plus any visible text.',
    },
  },
}

const visionOutput = {
  type: 'object',
  additionalProperties: false,
  required: ['description'],
  properties: {
    description: { type: 'string' },
    route: { type: 'string' },
    source: { type: 'string' },
  },
}

const DEFAULT_VISION_PROMPT =
  'Describe this image thoroughly for someone who cannot see it, then transcribe every piece of visible text verbatim. If it is a user interface, name the controls and state. If it is a chart, state the axes, series and the values you can read. State only what the image supports.'

/** Parse `["Name: value"]` into a plain header record; a malformed entry fails loud. */
function parseHeaders(entries) {
  if (!Array.isArray(entries)) return {}
  const headers = {}
  for (const entry of entries) {
    if (typeof entry !== 'string') throw new Error('headers entries must be "Name: value" strings')
    const at = entry.indexOf(':')
    if (at <= 0) throw new Error(`header ${JSON.stringify(entry)} is not "Name: value"`)
    headers[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
  }
  return headers
}

/** Read at most `cap` bytes of a response body and say whether more existed. */
async function readBounded(response, cap) {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const before = seen
    seen += value.byteLength
    if (seen > cap) {
      const keep = Math.max(0, cap - before)
      if (keep > 0) text += decoder.decode(value.subarray(0, keep), { stream: true })
      truncated = true
      try {
        await reader.cancel()
      } catch {
        // Cancellation is best effort; the byte bound already holds.
      }
      break
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return { text, truncated }
}

/** Map a path extension to a supported image media type. */
function mediaTypeForPath(path) {
  const match = /\.([a-z0-9]+)$/iu.exec(path)
  const ext = match === null ? '' : match[1].toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return undefined
}

/** Resolve an image's bytes and media type from a local path or an http(s) URL. */
async function readImageSource(ctx, args, signal) {
  if (typeof args.file_path === 'string' && args.file_path.length > 0) {
    const mediaType = mediaTypeForPath(args.file_path)
    if (mediaType === undefined) {
      throw new Error(`cannot classify ${JSON.stringify(args.file_path)}: give it a .png/.jpg/.jpeg/.webp/.gif extension, or pass \`url\``)
    }
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('no filesystem service is mounted; pass `url` instead')
    const target = await fs.resolve(args.file_path, { cwd: process.cwd(), signal })
    const data = await fs.readBytes(target, signal, VISION_MAX_BYTES)
    return { data, mediaType, source: target.displayPath ?? args.file_path }
  }

  if (typeof args.url === 'string' && args.url.length > 0) {
    const response = await fetch(args.url, { signal })
    if (!response.ok) throw new Error(`fetching ${args.url} failed: HTTP ${response.status}`)
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > VISION_MAX_BYTES) {
      throw new Error(`image at ${args.url} is ${data.byteLength} bytes, above the ${VISION_MAX_BYTES}-byte limit`)
    }
    const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim()
    const mediaType = declared.startsWith('image/') ? declared : mediaTypeForPath(args.url)
    if (mediaType === undefined) {
      throw new Error(`cannot determine the image type of ${args.url}; host it with an image content type or an image extension`)
    }
    return { data, mediaType, source: args.url }
  }

  throw new Error('give `file_path` (local image) or `url` (remote image)')
}

/** Register both tools into the mounting scope. */
export function apply(ctx, config) {
  const source = config === undefined || config === null ? {} : config
  const vision = source.vision

  ctx.tools.register({
    name: 'http_request',
    description: [
      'Make an arbitrary HTTP request and return the response body as text.',
      '* Use this when `web_fetch` is not enough: any method (POST/PUT/PATCH/DELETE), custom headers, auth tokens, JSON or form bodies, GraphQL and RPC endpoints.',
      '* `headers` entries are "Name: value" strings; the body is sent verbatim, so serialize JSON yourself.',
      '* A non-2xx response is returned as a value with its status, not raised as a failure — read the status before trusting the body.',
      '* The response is truncated at `maxBytes`; `truncated: true` means there was more.',
      '* This performs real network side effects. Do not retry a mutating request blindly.',
    ].join('\n'),
    parameters: httpParameters,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: {
      schema: httpOutput,
      render: (_args, value) => {
        const lines = [`HTTP ${value.status}${value.truncated ? ' (truncated)' : ''}`]
        const interesting = (value.headers ?? [])
          .filter((header) => /^(content-type|content-length|location|www-authenticate|retry-after)$/iu.test(header.name))
        for (const header of interesting) lines.push(`${header.name}: ${header.value}`)
        lines.push('', value.body)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: (args) => (args?.method ?? 'GET').toUpperCase() === 'GET',
    async execute(args, exec) {
      if (typeof args.url !== 'string' || !/^https?:\/\//iu.test(args.url)) throw new Error('url must be an absolute http(s) URL')
      const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
      if (!HTTP_METHODS.includes(method)) throw new Error(`unsupported method ${method}; use one of ${HTTP_METHODS.join(', ')}`)
      const timeoutMs = Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS
      const maxBytes = Number.isSafeInteger(args.maxBytes) && args.maxBytes > 0 ? args.maxBytes : DEFAULT_MAX_BYTES
      const headers = parseHeaders(args.headers)

      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = exec?.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])

      let response
      try {
        response = await fetch(args.url, {
          method,
          headers,
          signal,
          redirect: 'follow',
          ...typeof args.body === 'string' && method !== 'GET' && method !== 'HEAD' ? { body: args.body } : {},
        })
      } catch (error) {
        if (timeout.aborted) throw new Error(`request to ${args.url} timed out after ${timeoutMs}ms`)
        throw new Error(`request to ${args.url} failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      const { text, truncated } = await readBounded(response, maxBytes)
      return {
        status: response.status,
        body: text,
        truncated,
        headers: [...response.headers.entries()].map(([name, value]) => ({ name, value })),
      }
    },
  })

  ctx.tools.register({
    name: 'vision_describe',
    description: [
      'Look at an image and return a TEXT description of it.',
      '* Use this on a route that cannot accept image input: this tool sends the picture to a separate vision model and gives you its answer as text.',
      '* Accepts a local `file_path` (PNG/JPEG/WebP/GIF) or a remote `url`.',
      '* Ask a focused `prompt` for OCR, UI review, chart reading, or layout questions; the default asks for a thorough description plus all visible text.',
      '* It describes, it does not edit: you never receive the pixels, so state what the description supports and nothing more.',
    ].join('\n'),
    parameters: visionParameters,
    timeoutMs: 120000,
    output: {
      schema: visionOutput,
      render: (_args, value) => [
        { type: 'text', text: `${value.description}\n\n(described by ${value.route} from ${value.source})` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (vision === undefined || typeof vision !== 'object') {
        throw new Error('vision_describe is not configured: set config.vision { provider, model } on the edge-tools row')
      }
      for (const field of ['provider', 'model']) {
        if (typeof vision[field] !== 'string' || vision[field].length === 0) {
          throw new Error(`vision_describe needs config.vision.${field}`)
        }
      }

      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('vision_describe needs the llm service, which is not mounted in this composition')
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('vision_describe needs the attachments service to commit the image')

      // Refuse BEFORE spending a request when the configured route cannot read
      // images: the provider's declared modalities are the authoritative fact,
      // and the default for a hand-configured OpenAI-compatible model is
      // text-only. Say exactly which config field fixes it.
      if (typeof llm.resolveModelInfo === 'function') {
        let info
        try {
          info = await llm.resolveModelInfo(vision.provider, vision.model, exec?.signal)
        } catch (error) {
          throw new Error(`vision route ${vision.provider}/${vision.model} is not usable: ${error instanceof Error ? error.message : String(error)}`)
        }
        const modalities = info?.inputModalities
        if (Array.isArray(modalities) && !modalities.includes('image')) {
          throw new Error(
            `vision route ${vision.provider}/${vision.model} does not declare image input (declared: ${modalities.join(', ') || 'text'}). `
            + `Add "input: [text, image]" to that model under the provider's "models" list in the llm-pi-ai config, or point config.vision at a model that already declares it.`,
          )
        }
      }

      const prompt = typeof args.prompt === 'string' && args.prompt.trim().length > 0
        ? args.prompt.trim()
        : typeof vision.prompt === 'string' && vision.prompt.trim().length > 0 ? vision.prompt.trim() : DEFAULT_VISION_PROMPT

      const input = await readImageSource(ctx, args, exec?.signal)

      // Commit the bytes so the request carries a durable attachment reference
      // rather than an ad-hoc base64 blob: the adapter then applies the route's
      // own image sizing, byte budget and capability check.
      const ref = await attachments.saveImage({
        data: input.data,
        mediaType: input.mediaType,
        name: typeof args.file_path === 'string' ? args.file_path.split(/[\\/]/u).pop() : undefined,
      })

      const maxTokens = Number.isSafeInteger(vision.maxTokens) && vision.maxTokens > 0 ? vision.maxTokens : undefined
      const stream = llm.stream({
        provider: vision.provider,
        model: vision.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', attachment: ref },
          ],
        }],
        ...maxTokens === undefined ? {} : { maxTokens },
        ...exec?.signal === undefined ? {} : { signal: exec.signal },
      })

      let description = ''
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') description += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          throw new Error(`vision route ${vision.provider}/${vision.model} failed: ${chunk.reason.failure.message}`)
        } else if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
          throw new Error(`vision route ${vision.provider}/${vision.model} was aborted: ${chunk.reason.failure.message}`)
        }
      }

      description = description.trim()
      if (description.length === 0) {
        throw new Error(`vision route ${vision.provider}/${vision.model} returned no text; check that the model accepts image input`)
      }
      return {
        description,
        route: `${vision.provider}/${vision.model}`,
        source: input.source,
      }
    },
  })
}
