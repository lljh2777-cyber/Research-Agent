import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4318
const OAUTH_PORT = 1455
const ISSUER = 'https://auth.openai.com'
const CODEX_API_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const REFRESH_SAFETY_WINDOW_MS = 60 * 1000
const MAX_BODY_BYTES = 1024 * 1024

const authFile = process.env.BIORESEARCH_AUTH_FILE || join(
  process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  'bioresearch-os',
  'auth.json',
)

let oauthServer
let pendingOAuth
let refreshPromise

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
  if (!response.ok) throw new Error(`Token exchange failed (${response.status})`)
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
  if (!response.ok) throw new Error(`Token refresh failed (${response.status})`)
  return response.json()
}

async function readAuth() {
  try {
    const data = JSON.parse(await readFile(authFile, 'utf8'))
    const auth = data?.openai
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
  await writeFile(temporaryFile, JSON.stringify({ openai: auth }, null, 2), { encoding: 'utf8', mode: 0o600 })
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

async function getFreshAuth() {
  const auth = await readAuth()
  if (!auth.refresh) throw new Error('ChatGPT account is not connected')
  if (auth.access && Number(auth.expires) > Date.now() + REFRESH_SAFETY_WINDOW_MS) return auth

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
      .finally(() => { refreshPromise = undefined })
  }
  return refreshPromise
}

function authStatus(auth = {}) {
  return {
    provider: 'openai',
    connected: Boolean(auth.refresh),
    type: auth.refresh ? 'oauth' : null,
    accountId: auth.accountId || null,
    expiresAt: auth.expires || null,
    pending: Boolean(pendingOAuth),
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
        oauthServer?.close(() => {})
        oauthServer = undefined
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
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      current.reject(new Error('OAuth authorization code missing'))
      pendingOAuth = undefined
      sendHtml(response, 400, '<h1>Authorization failed</h1><p>The authorization code was missing.</p>')
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
      oauthServer?.close(() => {})
      oauthServer = undefined
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    oauthServer.once('error', rejectListen)
    oauthServer.listen(OAUTH_PORT, DEFAULT_HOST, resolveListen)
  }).catch((error) => {
    pendingOAuth?.reject(error)
    pendingOAuth = undefined
    oauthServer = undefined
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
    return { role: message.role, content: message.content.slice(0, 100_000) }
  })
}

function extractResponseText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text
  const parts = []
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim()
}

async function requestChat(model, messages) {
  const auth = await getFreshAuth()
  const response = await fetch(CODEX_API_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access}`,
      ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
      'Content-Type': 'application/json',
      'User-Agent': 'BioResearch-OS/0.1',
    },
    body: JSON.stringify({
      model: model || 'gpt-5.4',
      instructions: 'You are BioResearch OS, a careful scientific research assistant. Distinguish evidence from inference and preserve source context.',
      store: false,
      stream: false,
      input: messages,
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || `Provider request failed (${response.status})`)
  return { text: extractResponseText(payload), model: model || 'gpt-5.4' }
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
      sendJson(request, response, 200, { ok: true, provider: 'openai', url: authorizationUrl, pending: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const body = await readJson(request)
      if (body.provider && body.provider !== 'openai') {
        sendJson(request, response, 400, { error: 'Unsupported provider' })
        return
      }
      await removeAuth()
      sendJson(request, response, 200, authStatus())
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/llm/chat') {
      const body = await readJson(request)
      const messages = normalizeMessages(body.messages)
      const result = await requestChat(typeof body.model === 'string' ? body.model : 'gpt-5.4', messages)
      sendJson(request, response, 200, result)
      return
    }
    sendJson(request, response, 404, { error: 'Not found' })
  } catch (error) {
    const status = error.message.includes('not connected') ? 401 : error.message.includes('too large') ? 413 : 500
    sendJson(request, response, status, { error: error.message || 'Request failed' })
  }
})

const port = Number(process.env.BIORESEARCH_AUTH_PORT || DEFAULT_PORT)
server.listen(port, DEFAULT_HOST, async () => {
  const fileExists = await stat(authFile).then(() => true).catch(() => false)
  console.log(`[auth-server] listening at http://${DEFAULT_HOST}:${port}`)
  console.log(`[auth-server] credential store: ${authFile}${fileExists ? '' : ' (created on first login)'}`)
})
