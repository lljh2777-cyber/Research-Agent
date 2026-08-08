import { randomUUID } from 'node:crypto'

import { DEEPSEEK_ENDPOINT_TYPES, getDeepSeekModelProfile, isDeepSeekEndpointType } from '../shared/deepseek-provider.mjs'

const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const REQUEST_TIMEOUT_MS = 120_000

export const PROVIDER_REGISTRY = Object.freeze({
  openai: { protocol: 'openai-responses', auth: 'bearer', chatRoute: 'responses' },
  anthropic: { protocol: 'anthropic-messages', auth: 'anthropic', chatRoute: 'v1/messages' },
  gemini: { protocol: 'gemini-generate-content', auth: 'gemini', chatRoute: 'v1beta/models' },
  deepseek: { protocol: 'openai-chat-completions', auth: 'bearer', chatRoute: 'chat/completions' },
  openrouter: { protocol: 'openai-chat-completions', auth: 'bearer', chatRoute: 'chat/completions' },
  compatible: { protocol: 'openai-chat-completions', auth: 'optional-bearer', chatRoute: 'chat/completions' },
})

function runtimeError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

export function cleanProviderBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) throw runtimeError('Enter an API endpoint first.')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw runtimeError('The API endpoint is not a valid URL.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw runtimeError('Only HTTP and HTTPS API endpoints are supported.')
  if (parsed.username || parsed.password) throw runtimeError('Credentials must not be embedded in the API endpoint.')
  return raw
}

export function appendProviderRoute(baseUrl, route) {
  const normalizedRoute = String(route).replace(/^\/+/, '')
  if (baseUrl.toLowerCase().endsWith(`/${normalizedRoute.toLowerCase()}`)) return baseUrl
  return `${baseUrl}/${normalizedRoute}`
}

function providerHeaders(providerId, protocol, apiKey = '') {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) throw runtimeError(`Unsupported provider: ${providerId}`)
  const key = String(apiKey || '').trim()
  if (provider.auth !== 'optional-bearer' && !key) throw runtimeError('Enter an API key before using this provider.')
  const headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json' }
  const auth = providerId === 'deepseek' && protocol === 'anthropic-messages' ? 'anthropic' : provider.auth
  if (auth === 'bearer' || (auth === 'optional-bearer' && key)) headers.Authorization = `Bearer ${key}`
  if (auth === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  }
  if (provider.auth === 'gemini') headers['x-goog-api-key'] = key
  return headers
}

function normalizedMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw runtimeError('At least one message is required.')
  return messages.map((message) => {
    const role = ['system', 'user', 'assistant'].includes(message?.role) ? message.role : 'user'
    const content = typeof message?.content === 'string' ? message.content : ''
    if (!content.trim()) throw runtimeError('Messages must contain text content.')
    return { role, content }
  })
}

function openAiRequest(endpoint, model, messages, options) {
  return {
    url: appendProviderRoute(endpoint, 'responses'),
    body: {
      model,
      input: messages,
      stream: true,
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
    },
  }
}

function compatibleRequest(endpoint, model, messages, options, providerId) {
  const reasoningEffort = options.reasoningEffort === 'xhigh' ? 'max'
    : ['low', 'medium'].includes(options.reasoningEffort) ? 'high'
      : options.reasoningEffort
  return {
    url: appendProviderRoute(endpoint, 'chat/completions'),
    body: {
      model,
      messages,
      stream: true,
      ...(providerId === 'compatible' ? {} : { stream_options: { include_usage: true } }),
      ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
      ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
      ...(providerId === 'deepseek' && options.thinkingEnabled === false ? { thinking: { type: 'disabled' } } : {}),
      ...(providerId === 'deepseek' && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    },
  }
}

function anthropicRequest(endpoint, model, messages, options) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
  const conversational = messages.filter((message) => message.role !== 'system')
  return {
    url: appendProviderRoute(endpoint, 'v1/messages'),
    body: {
      model,
      messages: conversational,
      max_tokens: options.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
      stream: true,
      ...(system ? { system } : {}),
      ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
    },
  }
}

function geminiRequest(endpoint, model, messages, options) {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
  const contents = messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }))
  return {
    url: `${appendProviderRoute(endpoint, `v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`)}?alt=sse`,
    body: {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
      },
    },
  }
}

export function buildProviderChatRequest({ providerId, endpoint, endpointType, apiKey, model, messages, options = {} }) {
  const provider = PROVIDER_REGISTRY[providerId]
  if (!provider) throw runtimeError(`Unsupported provider: ${providerId}`)
  const cleanEndpoint = cleanProviderBaseUrl(endpoint)
  const cleanModel = String(model || '').trim()
  if (!cleanModel) throw runtimeError('Choose a model before starting the request.')
  const cleanMessages = normalizedMessages(messages)
  const protocol = providerId === 'deepseek'
    ? (isDeepSeekEndpointType(endpointType) ? endpointType : DEEPSEEK_ENDPOINT_TYPES.CHAT)
    : provider.protocol
  if (providerId === 'deepseek'
    && protocol !== DEEPSEEK_ENDPOINT_TYPES.RESPONSES
    && !getDeepSeekModelProfile(cleanModel).endpointTypes.includes(protocol)) {
    throw runtimeError(`${cleanModel} is not available through the selected DeepSeek request interface.`)
  }
  const request = protocol === 'openai-responses'
    ? openAiRequest(cleanEndpoint, cleanModel, cleanMessages, options)
    : protocol === 'anthropic-messages'
      ? anthropicRequest(cleanEndpoint, cleanModel, cleanMessages, options)
      : protocol === 'gemini-generate-content'
        ? geminiRequest(cleanEndpoint, cleanModel, cleanMessages, options)
        : compatibleRequest(cleanEndpoint, cleanModel, cleanMessages, options, providerId)
  return { ...request, headers: providerHeaders(providerId, protocol, apiKey), protocol }
}

export async function* parseServerSentEvents(body) {
  if (!body) throw runtimeError('The provider returned an empty response stream.', 502)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const parsed = parseSseBlock(block)
      if (parsed) yield parsed
    }
    if (done) break
  }
  const final = parseSseBlock(buffer)
  if (final) yield final
}

function parseSseBlock(block) {
  if (!block.trim()) return null
  const lines = block.split(/\r?\n/)
  const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  if (!data) return null
  if (data === '[DONE]') return { event, data, payload: null, done: true }
  try {
    return { event, data, payload: JSON.parse(data), done: false }
  } catch {
    return { event, data, payload: null, done: false }
  }
}

function extractProtocolEvents(protocol, event) {
  const payload = event.payload || {}
  if (protocol === 'openai-responses') {
    const type = payload.type || event.event
    if (type === 'response.output_text.delta') return [{ type: 'message.delta', delta: payload.delta || '' }]
    if (type === 'response.reasoning_summary_text.delta') return [{ type: 'reasoning.delta', delta: payload.delta || '' }]
    if (type === 'response.completed') return [{ type: 'usage.updated', usage: payload.response?.usage || null, responseId: payload.response?.id }]
    if (type === 'error' || type === 'response.failed') throw runtimeError(payload.error?.message || payload.response?.error?.message || 'OpenAI response failed.', 502)
    return []
  }
  if (protocol === 'openai-chat-completions') {
    if (event.done) return []
    if (payload.error) throw runtimeError(payload.error.message || 'Provider response failed.', 502)
    const delta = payload.choices?.[0]?.delta || {}
    const events = []
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) events.push({ type: 'reasoning.delta', delta: delta.reasoning_content })
    if (typeof delta.content === 'string' && delta.content) events.push({ type: 'message.delta', delta: delta.content })
    if (payload.usage) events.push({ type: 'usage.updated', usage: payload.usage, responseId: payload.id })
    return events
  }
  if (protocol === 'anthropic-messages') {
    const type = payload.type || event.event
    if (type === 'content_block_delta' && payload.delta?.type === 'text_delta') return [{ type: 'message.delta', delta: payload.delta.text || '' }]
    if (type === 'content_block_delta' && payload.delta?.type === 'thinking_delta') return [{ type: 'reasoning.delta', delta: payload.delta.thinking || '' }]
    if (type === 'message_start') return [{ type: 'usage.updated', usage: payload.message?.usage || null, responseId: payload.message?.id }]
    if (type === 'message_delta') return [{ type: 'usage.updated', usage: payload.usage || null }]
    if (type === 'error') throw runtimeError(payload.error?.message || 'Anthropic response failed.', 502)
    return []
  }
  if (protocol === 'gemini-generate-content') {
    if (payload.error) throw runtimeError(payload.error.message || 'Gemini response failed.', 502)
    const text = (payload.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('')
    const events = text ? [{ type: 'message.delta', delta: text }] : []
    if (payload.usageMetadata) events.push({ type: 'usage.updated', usage: payload.usageMetadata })
    return events
  }
  return []
}

async function providerResponseError(response) {
  const payload = await response.json().catch(() => null)
  const detail = payload?.error?.message || payload?.message || `${response.status} ${response.statusText}`
  return runtimeError(`Provider request failed: ${String(detail).slice(0, 500)}`, response.status >= 400 && response.status < 500 ? 400 : 502)
}

export async function* streamProviderChat(input, fetchImpl = fetch) {
  const request = buildProviderChatRequest(input)
  const runId = randomUUID()
  yield { type: 'run.started', runId, providerId: input.providerId, model: input.model, endpointType: request.protocol }
  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: input.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    const message = error?.name === 'TimeoutError' ? 'The provider response timed out.' : `Could not reach the provider endpoint: ${error?.message || 'network request failed'}`
    throw runtimeError(message, error?.name === 'TimeoutError' ? 504 : 502)
  }
  if (!response.ok) throw await providerResponseError(response)

  let text = ''
  let reasoning = ''
  let usage = null
  let responseId = null
  for await (const upstreamEvent of parseServerSentEvents(response.body)) {
    for (const event of extractProtocolEvents(request.protocol, upstreamEvent)) {
      if (event.type === 'message.delta') text += event.delta
      if (event.type === 'reasoning.delta') reasoning += event.delta
      if (event.type === 'usage.updated') {
        usage = event.usage || usage
        responseId = event.responseId || responseId
      }
      yield { ...event, runId }
    }
  }
  yield { type: 'run.completed', runId, providerId: input.providerId, model: input.model, endpointType: request.protocol, responseId, text, reasoning, usage }
}
