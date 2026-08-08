import { appendProviderRoute, cleanProviderBaseUrl, streamProviderChat } from './provider-runtime.mjs'
import { withDeepSeekModelProfile } from '../shared/deepseek-provider.mjs'

const PROVIDER_MODEL_ROUTES = {
  openai: { route: 'models', auth: 'bearer' },
  anthropic: { route: 'v1/models', auth: 'anthropic' },
  gemini: { route: 'v1beta/models', auth: 'gemini' },
  deepseek: { route: 'models', auth: 'bearer' },
  openrouter: { route: 'models', auth: 'bearer' },
  compatible: { route: 'models', auth: 'optional-bearer' },
}

const MAX_BODY_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 20_000

function buildRequest(providerId, endpoint, apiKey = '') {
  const protocol = PROVIDER_MODEL_ROUTES[providerId]
  if (!protocol) throw Object.assign(new Error(`Unsupported provider: ${providerId}`), { statusCode: 400 })
  const key = String(apiKey || '').trim()
  if (protocol.auth !== 'optional-bearer' && !key) {
    throw Object.assign(new Error('Enter an API key before fetching models.'), { statusCode: 400 })
  }

  const headers = { Accept: 'application/json' }
  if (protocol.auth === 'bearer' || (protocol.auth === 'optional-bearer' && key)) {
    headers.Authorization = `Bearer ${key}`
  } else if (protocol.auth === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (protocol.auth === 'gemini') {
    headers['x-goog-api-key'] = key
  }

  return { url: appendProviderRoute(cleanProviderBaseUrl(endpoint), protocol.route), headers }
}

function inferModelKind(model) {
  const id = `${model.id || ''} ${model.name || ''}`.toLowerCase()
  const methods = model.supportedGenerationMethods || []
  if (id.includes('embed') || methods.some((method) => /embed/i.test(method))) return 'embedding'
  if (id.includes('rerank')) return 'rerank'
  if (id.includes('image') || id.includes('dall-e') || id.includes('imagen')) return 'image'
  if (id.includes('audio') || id.includes('tts') || id.includes('transcri')) return 'audio'
  return 'chat'
}

export function inferModelCapabilities(providerId, record, kind = inferModelKind(record)) {
  const haystack = `${record?.id || ''} ${record?.name || ''}`.toLowerCase()
  const methods = Array.isArray(record?.supportedGenerationMethods) ? record.supportedGenerationMethods : []
  const parameters = Array.isArray(record?.supported_parameters) ? record.supported_parameters : []
  const modalities = record?.architecture?.input_modalities || record?.input_modalities || record?.modalities?.input || []
  const explicit = record?.capabilities || {}
  const chat = kind === 'chat'
  return {
    chat,
    embeddings: kind === 'embedding',
    reasoning: chat && Boolean(explicit.reasoning || parameters.includes('reasoning') || /(^|[-_. ])(o1|o3|o4|r1)([-_. ]|$)|reason(er|ing)|gpt-5/i.test(haystack)),
    vision: chat && Boolean(explicit.vision || modalities.some?.((item) => /image|vision/i.test(String(item))) || /vision|[-_.]vl([-.]|$)|gpt-4o|gpt-5|gemini/i.test(haystack)),
    tools: chat && Boolean(explicit.tools || explicit.function_calling || parameters.some((item) => /tools|tool_choice|function/i.test(String(item))) || methods.some((item) => /generateContent/i.test(item))),
    webSearch: chat && Boolean(explicit.web_search || parameters.some((item) => /web_search/i.test(String(item)))),
  }
}

export function normalizeProviderModels(providerId, payload) {
  const records = providerId === 'gemini'
    ? payload?.models
    : payload?.data || payload?.models
  if (!Array.isArray(records)) return []

  const unique = new Map()
  for (const record of records) {
    const rawId = record?.id || record?.name
    if (!rawId) continue
    const id = String(rawId).replace(/^models\//, '')
    if (!id || unique.has(id)) continue
    const model = {
      id,
      name: String(record.display_name || record.displayName || record.name || record.id || id).replace(/^models\//, ''),
      ownedBy: record.owned_by || record.ownedBy || providerId,
      kind: inferModelKind({ ...record, id }),
    }
    model.capabilities = inferModelCapabilities(providerId, { ...record, id }, model.kind)
    if (Array.isArray(record.supportedGenerationMethods)) {
      model.methods = record.supportedGenerationMethods
    }
    unique.set(id, providerId === 'deepseek' ? withDeepSeekModelProfile(model) : model)
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
}

async function responseError(response) {
  const payload = await response.json().catch(() => null)
  const detail = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`
  const error = new Error(`Provider rejected model discovery: ${String(detail).slice(0, 360)}`)
  error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502
  return error
}

export async function discoverProviderModels({ providerId, endpoint, apiKey }, fetchImpl = fetch) {
  const request = buildRequest(providerId, endpoint, apiKey)
  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError'
      ? 'The provider did not respond before the connection timed out.'
      : `Could not reach the provider endpoint: ${error?.message || 'network request failed'}`
    throw Object.assign(new Error(message), { statusCode: error?.name === 'TimeoutError' ? 504 : 502 })
  }
  if (!response.ok) throw await responseError(response)
  const payload = await response.json().catch(() => {
    throw Object.assign(new Error('The provider returned an invalid JSON model list.'), { statusCode: 502 })
  })
  return {
    providerId,
    endpoint: request.url,
    models: normalizeProviderModels(providerId, payload),
    fetchedAt: new Date().toISOString(),
  }
}

async function readJsonBody(request) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

function sendEvent(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

export function createProviderApiMiddleware({ fetchImpl = fetch } = {}) {
  return async function providerApiMiddleware(request, response, next) {
    const path = new URL(request.url || '/', 'http://localhost').pathname
    if (!['/api/providers/models', '/api/providers/responses/stream'].includes(path)) return next()
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      return sendJson(response, 405, { error: 'Method not allowed.' })
    }
    try {
      const body = await readJsonBody(request)
      if (path === '/api/providers/responses/stream') {
        const controller = new AbortController()
        response.once('close', () => controller.abort())
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store, no-transform')
        response.setHeader('Connection', 'keep-alive')
        response.flushHeaders?.()
        try {
          for await (const event of streamProviderChat({ ...body, signal: controller.signal }, fetchImpl)) {
            if (!response.destroyed) sendEvent(response, event)
          }
        } catch (error) {
          if (!response.destroyed && error?.name !== 'AbortError') sendEvent(response, { type: 'run.failed', error: error?.message || 'Provider request failed.' })
        }
        if (!response.destroyed) response.end()
        return
      }
      const result = await discoverProviderModels(body, fetchImpl)
      return sendJson(response, 200, result)
    } catch (error) {
      const statusCode = Number(error?.statusCode) || (error?.name === 'TimeoutError' ? 504 : 502)
      return sendJson(response, statusCode, { error: error?.message || 'Model discovery failed.' })
    }
  }
}
