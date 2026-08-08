import { getAuthServiceBaseUrl } from './runtime/services.js'

const AUTH_SERVER_URL = getAuthServiceBaseUrl()
const AUTH_SERVICE_CONNECT_TIMEOUT_MS = 3000
const AUTH_STREAM_CONNECT_TIMEOUT_MS = 10000

export const AUTH_SERVICE_UNAVAILABLE = 'AUTH_SERVICE_UNAVAILABLE'

export function createAuthServiceUnavailableError(cause) {
  const error = new Error(`Local ChatGPT service is offline at ${AUTH_SERVER_URL}. Restart npm run dev, then try Connect again.`)
  error.code = AUTH_SERVICE_UNAVAILABLE
  error.cause = cause
  return error
}

async function fetchAuthService(path, options = {}, timeoutMs = AUTH_SERVICE_CONNECT_TIMEOUT_MS) {
  const timeoutController = new AbortController()
  const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal
  try {
    return await fetch(`${AUTH_SERVER_URL}${path}`, { ...options, signal })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw createAuthServiceUnavailableError(error)
  } finally {
    window.clearTimeout(timeout)
  }
}

async function requestJson(path, options = {}) {
  const response = await fetchAuthService(path, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Auth service request failed (${response.status})`)
  return payload
}

export function getAuthServerUrl() {
  return AUTH_SERVER_URL
}

export function getAuthStatus() {
  return requestJson('/api/auth/status')
}

export function getChatgptModels({ force = false } = {}) {
  return requestJson(`/api/chatgpt/models${force ? '?refresh=1' : ''}`)
}

export async function startChatgptLogin() {
  // Open synchronously from the click so browsers do not classify the OAuth
  // window as a popup created later by an asynchronous fetch.
  const popup = window.open('about:blank', 'bioresearch-chatgpt-auth', 'popup,width=620,height=760')
  if (!popup) throw new Error('Allow pop-ups for this local app, then try connecting again.')
  try {
    const payload = await requestJson('/api/auth/chatgpt/start', { method: 'POST' })
    popup.location.assign(payload.url)
    return payload
  } catch (error) {
    popup.close()
    throw error
  }
}

export async function waitForChatgptAuth({ timeout = 5 * 60 * 1000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await getAuthStatus()
    if (status.provider === 'chatgpt' && status.connected) return status
    if (status.loginState === 'failed') throw new Error(status.loginError || 'ChatGPT login failed. Try connecting again.')
    await new Promise((resolve) => window.setTimeout(resolve, interval))
  }
  throw new Error('Authentication timed out. You can try connecting again.')
}

export function cancelChatgptLogin() {
  return requestJson('/api/auth/chatgpt/cancel', { method: 'POST' })
}

export function logoutChatgpt() {
  return requestJson('/api/auth/chatgpt/logout', { method: 'POST' })
}

function parseEventBlock(block) {
  const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  try {
    return { event, payload: JSON.parse(data) }
  } catch {
    return null
  }
}

export async function streamChatgptResponse({ model, messages, signal, onDelta }) {
  const response = await fetchAuthService('/api/chatgpt/responses/stream', {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
    signal,
  }, AUTH_STREAM_CONNECT_TIMEOUT_MS)

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || `ChatGPT request failed (${response.status})`)
  }
  if (!response.body) throw new Error('The local ChatGPT service returned an empty stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const parsed = parseEventBlock(block)
      if (!parsed) continue
      if (parsed.event === 'delta' && typeof parsed.payload.delta === 'string') onDelta?.(parsed.payload.delta)
      if (parsed.event === 'completed') completed = parsed.payload
      if (parsed.event === 'error') throw new Error(parsed.payload.error || 'ChatGPT stream failed')
    }
    if (done) break
  }

  const finalEvent = parseEventBlock(buffer)
  if (finalEvent?.event === 'completed') completed = finalEvent.payload
  if (finalEvent?.event === 'error') throw new Error(finalEvent.payload.error || 'ChatGPT stream failed')
  if (!completed) throw new Error('ChatGPT stream ended before completion.')
  return completed
}
