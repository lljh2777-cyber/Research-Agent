const AUTH_SERVER_URL = import.meta.env.VITE_AUTH_SERVER_URL || 'http://127.0.0.1:4318'

async function requestJson(path, options = {}) {
  const response = await fetch(`${AUTH_SERVER_URL}${path}`, {
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
    await new Promise((resolve) => window.setTimeout(resolve, interval))
  }
  throw new Error('Authentication timed out. You can try connecting again.')
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
  const response = await fetch(`${AUTH_SERVER_URL}/api/chatgpt/responses/stream`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }),
    signal,
  })

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
