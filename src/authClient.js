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

export async function startChatgptLogin() {
  const payload = await requestJson('/api/auth/chatgpt/start', { method: 'POST' })
  const popup = window.open(payload.url, 'bioresearch-chatgpt-auth', 'popup,width=620,height=760')
  if (!popup) window.location.assign(payload.url)
  return payload
}

export async function waitForAuth(provider = 'openai', { timeout = 5 * 60 * 1000, interval = 1500 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await getAuthStatus()
    if (status.provider === provider && status.connected) return status
    await new Promise((resolve) => window.setTimeout(resolve, interval))
  }
  throw new Error('Authentication timed out. You can try connecting again.')
}

export function logoutProvider(provider = 'openai') {
  return requestJson('/api/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  })
}

export function chatWithProvider({ model, messages }) {
  return requestJson('/api/llm/chat', {
    method: 'POST',
    body: JSON.stringify({ model, messages }),
  })
}
