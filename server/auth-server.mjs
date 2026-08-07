import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4318
const OAUTH_PORT = 1455
const OAUTH_HOST = 'localhost'
const ISSUER = 'https://auth.openai.com'
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const REFRESH_SAFETY_WINDOW_MS = 60 * 1000
const MAX_BODY_BYTES = 1024 * 1024
const TRANSIENT_AUTH_STATUSES = new Set([408, 425, 429])
const CHATGPT_MODELS = new Set(['gpt-5.4', 'gpt-5.4-mini'])
const SYSTEM_INSTRUCTIONS = 'You are BioResearch OS, a careful scientific research assistant. Distinguish evidence from inference, preserve source context, and say when evidence is missing.'

const authFile = process.env.BIORESEARCH_AUTH_FILE || join(
  process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  'bioresearch-os',
  'auth.json',
)

let oauthServer
let pendingOAuth
let refreshPromise

function stopOAuthServer() {
  const current = oauthServer
  oauthServer = undefined
  current?.close(() => {})
}

function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

async function generatePkce() {
  const verifier = randomUrlSafe(32)
  const digest = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge: digest }
}

function parseJwtClaims(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function extractAccountId(tokens) {
  const claims = parseJwtClaims(tokens.id_token || '') || parseJwtClaims(tokens.access_token || '')
  return claims?.chatgpt_account_id
    || claims?.['https://api.openai.com/auth']?.chatgpt_account_id
    || claims?.organizations?.[0]?.id
}

function buildAuthorizeUrl(redirectUri, pkce, state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'bioresearch-os',
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function exchangeCode(code, redirectUri, verifier) {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })
  if (!response.ok) throw new ProviderHttpError(`Token exchange failed (${response.status})`, response.status)
  return response.json()
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) throw new ProviderHttpError(`Token refresh failed (${response.status})`, response.status)
  return response.json()
}

async function readAuth() {
  try {
    const data = JSON.parse(await readFile(authFile, 'utf8'))
    // Read the original `openai` key as a one-time compatibility path.
    const auth = data?.chatgpt || data?.openai
    if (auth?.type !== 'oauth' || typeof auth.refresh !== 'string') return {}
    return auth
  } catch {
    // Treat a missing or damaged credential file as logged out so the app can recover.
    return {}
  }
}

async function writeAuth(auth) {
  await mkdir(dirname(authFile), { recursive: true })
  const temporaryFile = `${authFile}.${process.pid}.${randomUrlSafe(8)}.tmp`
  await writeFile(temporaryFile, JSON.stringify({ version: 1, chatgpt: auth }, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporaryFile, authFile)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
    await unlink(authFile).catch(() => {})
    await rename(temporaryFile, authFile)
  }
  await chmod(authFile, 0o600).catch(() => {})
}

async function removeAuth() {
  await unlink(authFile).catch(() => {})
}

async function getFreshAuth(forceRefresh = false) {
  const auth = await readAuth()
  if (!auth.refresh) throw new Error('ChatGPT account is not connected')
  if (!forceRefresh && auth.access && Number(auth.expires) > Date.now() + REFRESH_SAFETY_WINDOW_MS) return auth

  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(auth.refresh)
      .then(async (tokens) => {
        const nextAuth = {
          type: 'oauth',
          refresh: tokens.refresh_token || auth.refresh,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in || 3600) * 1000,
          accountId: extractAccountId(tokens) || auth.accountId,
        }
        await writeAuth(nextAuth)
        return nextAuth
      })
      .catch(async (error) => {
        if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && !TRANSIENT_AUTH_STATUSES.has(error.status)) {
          await removeAuth()
        }
        throw error
      })
      .finally(() => { refreshPromise = undefined })
  }
  return refreshPromise
}

function authStatus(auth = {}) {
  return {
    provider: 'chatgpt',
    connected: Boolean(auth.refresh),
    type: auth.refresh ? 'oauth' : null,
    expiresAt: auth.expires || null,
    pending: Boolean(pendingOAuth),
  }
}

class ProviderHttpError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ProviderHttpError'
    this.status = status
  }
}

function allowedOrigin(origin) {
  if (!origin || origin === 'null') return ''
  try {
    const url = new URL(origin)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && ['127.0.0.1', 'localhost'].includes(url.hostname)) return origin
  } catch {}
  return ''
}

function setCorsHeaders(request, response) {
  const origin = allowedOrigin(request.headers.origin)
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
}

function sendJson(request, response, status, payload) {
  setCorsHeaders(request, response)
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(html)
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'))
        request.destroy()
        return
      }
      body += chunk
    })
    request.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Invalid JSON request'))
      }
    })
    request.on('error', reject)
  })
}

async function startOAuth() {
  if (pendingOAuth) return pendingOAuth.authorizationUrl
  const pkce = await generatePkce()
  const state = randomUrlSafe()
  const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
  const authorizationUrl = buildAuthorizeUrl(redirectUri, pkce, state)
  const resultPromise = new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth?.state === state) {
        pendingOAuth = undefined
        stopOAuthServer()
      }
      rejectResult(new Error('OAuth callback timed out'))
    }, OAUTH_TIMEOUT_MS)
    pendingOAuth = {
      authorizationUrl,
      state,
      verifier: pkce.verifier,
      resolve: (value) => { clearTimeout(timeout); resolveResult(value) },
      reject: (error) => { clearTimeout(timeout); rejectResult(error) },
    }
  })

  oauthServer = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://localhost:${OAUTH_PORT}`)
    if (url.pathname === '/cancel') {
      pendingOAuth?.reject(new Error('Login cancelled'))
      pendingOAuth = undefined
      sendHtml(response, 200, '<h1>Login cancelled</h1><p>You can close this window.</p>')
      stopOAuthServer()
      return
    }
    if (url.pathname !== '/auth/callback') {
      sendHtml(response, 404, '<h1>Not found</h1>')
      return
    }
    const current = pendingOAuth
    if (!current || url.searchParams.get('state') !== current.state) {
      sendHtml(response, 400, '<h1>Invalid OAuth state</h1><p>Please restart the connection flow.</p>')
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      current.reject(new Error('OAuth authorization was declined'))
      pendingOAuth = undefined
      sendHtml(response, 400, '<h1>Authorization declined</h1><p>You can close this window.</p>')
      stopOAuthServer()
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      current.reject(new Error('OAuth authorization code missing'))
      pendingOAuth = undefined
      sendHtml(response, 400, '<h1>Authorization failed</h1><p>The authorization code was missing.</p>')
      stopOAuthServer()
      return
    }
    try {
      const tokens = await exchangeCode(code, redirectUri, current.verifier)
      const auth = {
        type: 'oauth',
        refresh: tokens.refresh_token,
        access: tokens.access_token,
        expires: Date.now() + (tokens.expires_in || 3600) * 1000,
        accountId: extractAccountId(tokens),
      }
      await writeAuth(auth)
      current.resolve(authStatus(auth))
      pendingOAuth = undefined
      sendHtml(response, 200, '<h1>Connected to ChatGPT</h1><p>You can close this window and return to BioResearch OS.</p>')
    } catch (callbackError) {
      current.reject(callbackError)
      pendingOAuth = undefined
      sendHtml(response, 502, '<h1>Connection failed</h1><p>Please close this window and try again.</p>')
    } finally {
      stopOAuthServer()
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    oauthServer.once('error', rejectListen)
    oauthServer.listen(OAUTH_PORT, OAUTH_HOST, resolveListen)
  }).catch((error) => {
    pendingOAuth?.reject(error)
    pendingOAuth = undefined
    stopOAuthServer()
    throw new Error(`OAuth callback server could not start on port ${OAUTH_PORT}`)
  })

  void resultPromise.catch(() => {})
  return authorizationUrl
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) throw new Error('messages must be a non-empty array')
  return messages.map((message) => {
    if (!message || !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string') {
      throw new Error('Each message must include a valid role and text content')
    }
    return { role: message.role, content: message.content.trim().slice(0, 100_000) }
  }).filter((message) => message.content)
}

function normalizeModel(model) {
  const requested = typeof model === 'string' ? model : 'gpt-5.4'
  if (!CHATGPT_MODELS.has(requested)) throw new Error('Unsupported ChatGPT model')
  return requested
}

export function coerceCodexRequestBody({ model, messages }) {
  const systemMessages = messages.filter((message) => message.role === 'system').map((message) => message.content)
  const input = messages.filter((message) => message.role !== 'system')
  return {
    model,
    instructions: [SYSTEM_INSTRUCTIONS, ...systemMessages].join('\n\n'),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    input,
  }
}

function buildCodexHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.access}`,
    ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'bioresearch-os',
    'session-id': randomUUID(),
    'User-Agent': 'BioResearch-OS/0.1',
  }
}

async function codexFetch(auth, body, signal) {
  return fetch(CODEX_API_ENDPOINT, {
    method: 'POST',
    headers: buildCodexHeaders(auth),
    body: JSON.stringify(body),
    signal,
  })
}

export function extractResponseText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text
  const parts = []
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim()
}

export function parseSseBlock(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function* readSseEvents(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const event = parseSseBlock(block)
      if (event) yield event
    }
    if (done) break
  }
  const finalEvent = parseSseBlock(buffer)
  if (finalEvent) yield finalEvent
}

async function providerError(response) {
  const payload = await response.json().catch(() => ({}))
  return new ProviderHttpError(payload?.error?.message || `ChatGPT request failed (${response.status})`, response.status)
}

async function openCodexStream(model, messages, signal) {
  const body = coerceCodexRequestBody({ model, messages })
  let auth = await getFreshAuth()
  let response = await codexFetch(auth, body, signal)
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    auth = await getFreshAuth(true)
    response = await codexFetch(auth, body, signal)
  }
  if (!response.ok) throw await providerError(response)
  if (!response.body) throw new Error('ChatGPT returned an empty stream')
  return response.body
}

function openEventStream(request, response) {
  setCorsHeaders(request, response)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders?.()
}

function writeEvent(response, event, payload) {
  if (response.writableEnded) return
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

async function streamChat(request, response, model, messages) {
  const abortController = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) abortController.abort()
  })
  // Keep authentication and upstream HTTP errors as normal JSON status codes.
  // Switch to SSE only after the provider has accepted the request.
  const body = await openCodexStream(model, messages, abortController.signal)
  openEventStream(request, response)
  writeEvent(response, 'start', { model })
  let text = ''
  let completed = false
  try {
    for await (const event of readSseEvents(body)) {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta
        writeEvent(response, 'delta', { delta: event.delta })
      } else if (event.type === 'response.completed') {
        const finalText = text || extractResponseText(event.response || {})
        writeEvent(response, 'completed', {
          text: finalText,
          model: event.response?.model || model,
          responseId: event.response?.id || null,
          usage: event.response?.usage || null,
        })
        completed = true
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(event.response?.error?.message || event.error?.message || event.message || 'ChatGPT stream failed')
      }
    }
    if (!completed) {
      if (!text) throw new Error('ChatGPT stream ended without a response')
      writeEvent(response, 'completed', { text, model, responseId: null, usage: null })
    }
  } catch (error) {
    if (!abortController.signal.aborted) writeEvent(response, 'error', { error: error.message || 'ChatGPT request failed' })
  } finally {
    response.end()
  }
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    setCorsHeaders(request, response)
    response.writeHead(204)
    response.end()
    return
  }
  try {
    const url = new URL(request.url || '/', `http://${DEFAULT_HOST}`)
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(request, response, 200, { ok: true, service: 'bioresearch-auth', storage: 'local' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/status') {
      sendJson(request, response, 200, authStatus(await readAuth()))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/chatgpt/start') {
      const authorizationUrl = await startOAuth()
      sendJson(request, response, 200, { ok: true, provider: 'chatgpt', url: authorizationUrl, pending: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/chatgpt/logout') {
      await removeAuth()
      sendJson(request, response, 200, authStatus())
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/chatgpt/responses/stream') {
      const body = await readJson(request)
      const messages = normalizeMessages(body.messages)
      const model = normalizeModel(body.model)
      await streamChat(request, response, model, messages)
      return
    }
    sendJson(request, response, 404, { error: 'Not found' })
  } catch (error) {
    const status = error instanceof ProviderHttpError
      ? error.status === 401 || error.status === 429 ? error.status : 502
      : error.message.includes('not connected')
        ? 401
        : error.message.includes('too large')
          ? 413
          : error.message.includes('Unsupported') || error.message.includes('messages must') || error.message.includes('Each message')
            ? 400
            : 500
    sendJson(request, response, status, { error: error.message || 'Request failed' })
  }
})

export function startAuthServer() {
  const port = Number(process.env.BIORESEARCH_AUTH_PORT || DEFAULT_PORT)
  server.listen(port, DEFAULT_HOST, async () => {
    const fileExists = await stat(authFile).then(() => true).catch(() => false)
    console.log(`[auth-server] listening at http://${DEFAULT_HOST}:${port}`)
    console.log(`[auth-server] credential store: ${authFile}${fileExists ? '' : ' (created on first login)'}`)
  })
  return server
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) startAuthServer()
