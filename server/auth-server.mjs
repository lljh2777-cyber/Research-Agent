import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CodexAppServer, CodexRpcError } from './codex-app-server.mjs'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 4318
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_BODY_BYTES = 1024 * 1024
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/
const SYSTEM_INSTRUCTIONS = 'You are BioResearch OS, a careful scientific research assistant. Distinguish evidence from inference, preserve source context, and say when evidence is missing.'

const dataDirectory = process.env.BIORESEARCH_DATA_DIR || join(
  process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  'bioresearch-os',
)
const legacyAuthFile = process.env.BIORESEARCH_AUTH_FILE || join(dataDirectory, 'auth.json')
const modelsFile = process.env.BIORESEARCH_MODELS_FILE || join(dataDirectory, 'models.json')
const codex = new CodexAppServer()

let pendingLogin
let lastLoginError
let modelDiscoveryPromise

codex.on('notification', ({ method, params }) => {
  if (method === 'account/login/completed' && pendingLogin?.loginId === params?.loginId) {
    lastLoginError = params.success ? null : (params.error || 'ChatGPT login failed')
    pendingLogin = undefined
    if (params.success) void removeModelCache()
  }
  if (method === 'account/updated') void removeModelCache()
})

async function removeLegacyAuth() {
  await unlink(legacyAuthFile).catch(() => {})
}

async function removeModelCache() {
  await unlink(modelsFile).catch(() => {})
}

async function readModelCache() {
  try {
    const payload = JSON.parse(await readFile(modelsFile, 'utf8'))
    if (payload?.version !== 2 || !Array.isArray(payload.models) || !payload.models.length) return null
    return payload
  } catch {
    return null
  }
}

async function writeModelCache(catalog) {
  await mkdir(dirname(modelsFile), { recursive: true })
  const temporaryFile = `${modelsFile}.${process.pid}.${randomUUID()}.tmp`
  const payload = { version: 2, provider: 'chatgpt', ...catalog }
  await writeFile(temporaryFile, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporaryFile, modelsFile)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
    await unlink(modelsFile).catch(() => {})
    await rename(temporaryFile, modelsFile)
  }
  await chmod(modelsFile, 0o600).catch(() => {})
}

export function normalizeCodexAccount(result = {}) {
  const account = result.account
  const connected = account?.type === 'chatgpt'
  return {
    provider: 'chatgpt',
    connected,
    type: connected ? 'oauth' : null,
    email: connected ? account.email || null : null,
    planType: connected ? account.planType || null : null,
    requiresOpenaiAuth: result.requiresOpenaiAuth !== false,
  }
}

async function readAuthStatus({ refreshToken = false } = {}) {
  const result = await codex.request('account/read', { refreshToken })
  return {
    ...normalizeCodexAccount(result),
    pending: Boolean(pendingLogin),
    loginAttemptId: pendingLogin?.loginId || null,
    loginState: pendingLogin ? 'pending' : lastLoginError ? 'failed' : 'idle',
    loginError: lastLoginError || null,
    credentialOwner: 'codex',
  }
}

function fallbackModelCatalog({ connected = false, warning = '' } = {}) {
  return {
    provider: 'chatgpt',
    connected,
    source: 'fallback',
    stale: true,
    fetchedAt: null,
    defaultModelId: null,
    models: [],
    ...(warning ? { warning } : {}),
  }
}

function reasoningLevelId(level) {
  if (typeof level === 'string') return level
  if (level && typeof level.reasoningEffort === 'string') return level.reasoningEffort
  if (level && typeof level.effort === 'string') return level.effort
  if (level && typeof level.id === 'string') return level.id
  return null
}

async function fetchCodexModelCatalog() {
  const data = []
  let cursor = null
  for (let page = 0; page < 20; page += 1) {
    const result = await codex.request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }, 15_000)
    data.push(...(result?.data || []))
    cursor = result?.nextCursor || null
    if (!cursor) break
  }
  return { data }
}

export function normalizeCodexModels(payload) {
  const models = []
  const seen = new Set()
  for (const entry of payload?.data || payload?.models || []) {
    const rawId = entry?.id || entry?.model || entry?.slug
    const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : ''
    if (!MODEL_ID_PATTERN.test(id) || seen.has(id) || entry.hidden === true || (entry.visibility && entry.visibility !== 'list')) continue
    seen.add(id)
    models.push({
      id,
      name: (typeof entry.displayName === 'string' && entry.displayName.trim())
        || (typeof entry.display_name === 'string' && entry.display_name.trim())
        || id,
      description: typeof entry.description === 'string' ? entry.description : '',
      reasoningLevels: (entry.supportedReasoningEfforts || entry.supported_reasoning_levels || []).map(reasoningLevelId).filter(Boolean),
      defaultReasoningLevel: reasoningLevelId(entry.defaultReasoningEffort || entry.default_reasoning_level),
      priority: Number.isFinite(entry.priority) ? entry.priority : models.length,
    })
  }
  if (!models.length) throw new Error('ChatGPT returned an empty model catalog')
  return {
    fetchedAt: new Date().toISOString(),
    defaultModelId: models.find((model) => {
      const source = (payload?.data || payload?.models || []).find((entry) => (entry.id || entry.model || entry.slug)?.toLowerCase() === model.id)
      return source?.isDefault === true
    })?.id || models[0].id,
    models,
  }
}

function publicCachedCatalog(cache, { source = 'cache', stale = false, warning = '' } = {}) {
  return {
    provider: 'chatgpt',
    connected: true,
    source,
    stale,
    fetchedAt: cache.fetchedAt || null,
    defaultModelId: cache.defaultModelId || cache.models[0]?.id || null,
    models: cache.models,
    ...(warning ? { warning } : {}),
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
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
}

export function isTrustedLoopbackRequest(request) {
  const host = request.headers.host || ''
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false
  return !request.headers.origin || Boolean(allowedOrigin(request.headers.origin))
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
  if (pendingLogin) return pendingLogin
  lastLoginError = null
  const result = await codex.request('account/login/start', {
    type: 'chatgpt',
    useHostedLoginSuccessPage: true,
    appBrand: 'chatgpt',
  }, OAUTH_TIMEOUT_MS)
  if (result?.type !== 'chatgpt' || !result.loginId || !result.authUrl) {
    throw new Error('Codex did not return a ChatGPT authorization URL')
  }
  pendingLogin = { loginId: result.loginId, authorizationUrl: result.authUrl }
  return pendingLogin
}

async function cancelOAuth() {
  if (!pendingLogin) return readAuthStatus()
  const { loginId } = pendingLogin
  await codex.request('account/login/cancel', { loginId })
  pendingLogin = undefined
  lastLoginError = 'Login cancelled'
  return readAuthStatus()
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

async function discoverChatgptModels({ force = false } = {}) {
  const status = await readAuthStatus()
  if (!status.connected) return fallbackModelCatalog({ warning: 'Connect ChatGPT to discover models available to this account.' })

  const cached = await readModelCache()
  const fetchedAt = cached?.fetchedAt ? Date.parse(cached.fetchedAt) : 0
  if (!force && cached && Number.isFinite(fetchedAt) && Date.now() - fetchedAt < MODEL_CACHE_TTL_MS) {
    return publicCachedCatalog(cached)
  }

  if (!modelDiscoveryPromise) {
    modelDiscoveryPromise = (async () => {
      try {
        const catalog = normalizeCodexModels(await fetchCodexModelCatalog())
        await writeModelCache(catalog)
        return publicCachedCatalog(catalog, { source: 'codex-app-server' })
      } catch (error) {
        const latestStatus = await readAuthStatus().catch(() => ({ connected: false }))
        if (!latestStatus.connected) {
          return fallbackModelCatalog({ warning: 'The ChatGPT session expired. Reconnect to discover available models.' })
        }
        const warning = `ChatGPT model discovery failed; using the last known catalog. ${error.message || ''}`.trim()
        if (cached) return publicCachedCatalog(cached, { stale: true, warning })
        return fallbackModelCatalog({ connected: true, warning })
      }
    })().finally(() => { modelDiscoveryPromise = undefined })
  }
  return modelDiscoveryPromise
}

async function normalizeModel(model) {
  const requested = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (!MODEL_ID_PATTERN.test(requested)) throw new Error('Unsupported ChatGPT model')
  const catalog = await discoverChatgptModels()
  if (!catalog.connected || !catalog.models.some((entry) => entry.id === requested)) throw new Error('Unsupported ChatGPT model')
  return requested
}

export function buildResearchPrompt(messages) {
  const transcript = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n')
  return `${SYSTEM_INSTRUCTIONS}\nDo not use tools, browse, or read local files. Answer only from the conversation and evidence below.\n\n${transcript}`
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
  const account = await readAuthStatus()
  if (!account.connected) throw new Error('ChatGPT account is not connected')
  const threadResult = await codex.request('thread/start', {
    model,
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'readOnly',
    personality: 'none',
    serviceName: 'research_agent',
  })
  const threadId = threadResult?.thread?.id
  if (!threadId) throw new Error('Codex did not create a response thread')

  openEventStream(request, response)
  writeEvent(response, 'start', { model })
  let text = ''
  let turnId
  let settled = false
  let cleanupNotifications = () => {}

  const terminal = new Promise((resolveTurn, rejectTurn) => {
    const onNotification = ({ method, params }) => {
      if (params?.threadId !== threadId && params?.thread?.threadId !== threadId) return
      if (turnId && params?.turnId && params.turnId !== turnId && params?.turn?.id !== turnId) return
      if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
        text += params.delta
        writeEvent(response, 'delta', { delta: params.delta })
      } else if (method === 'turn/completed') {
        cleanupNotifications()
        const turn = params?.turn || {}
        if (turn.status === 'failed') rejectTurn(new Error(turn.error?.message || 'ChatGPT response failed'))
        else resolveTurn(turn)
      } else if (method === 'error') {
        cleanupNotifications()
        rejectTurn(new Error(params?.error?.message || 'ChatGPT response failed'))
      }
    }
    cleanupNotifications = () => codex.off('notification', onNotification)
    codex.on('notification', onNotification)
  })

  const interrupt = () => {
    if (turnId && !settled) void codex.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }
  response.once('close', interrupt)

  try {
    const started = await codex.request('turn/start', {
      threadId,
      clientUserMessageId: randomUUID(),
      input: [{ type: 'text', text: buildResearchPrompt(messages) }],
    })
    turnId = started?.turn?.id
    const turn = await terminal
    const finalMessage = turn.items?.findLast?.((item) => item.type === 'agentMessage')?.text || text
    if (!finalMessage) throw new Error('ChatGPT stream ended without a response')
    if (!text && finalMessage) writeEvent(response, 'delta', { delta: finalMessage })
    writeEvent(response, 'completed', { text: finalMessage, model, responseId: turn.id || turnId || null, usage: null })
  } catch (error) {
    if (!response.destroyed) writeEvent(response, 'error', { error: error.message || 'ChatGPT request failed' })
  } finally {
    settled = true
    cleanupNotifications()
    response.off('close', interrupt)
    response.end()
  }
}

const server = createServer(async (request, response) => {
  if (!isTrustedLoopbackRequest(request)) {
    sendJson(request, response, 403, { error: 'Untrusted request origin' })
    return
  }
  if (request.method === 'OPTIONS') {
    setCorsHeaders(request, response)
    response.writeHead(204)
    response.end()
    return
  }
  try {
    const url = new URL(request.url || '/', `http://${DEFAULT_HOST}`)
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(request, response, 200, { ok: true, service: 'bioresearch-auth', credentialOwner: 'codex-app-server' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/status') {
      sendJson(request, response, 200, await readAuthStatus())
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/chatgpt/models') {
      const catalog = await discoverChatgptModels({ force: url.searchParams.get('refresh') === '1' })
      sendJson(request, response, 200, catalog)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/chatgpt/start') {
      const login = await startOAuth()
      sendJson(request, response, 200, {
        ok: true,
        provider: 'chatgpt',
        url: login.authorizationUrl,
        loginAttemptId: login.loginId,
        pending: true,
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/chatgpt/cancel') {
      sendJson(request, response, 200, await cancelOAuth())
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/chatgpt/logout') {
      if (pendingLogin) await cancelOAuth().catch(() => {})
      await codex.request('account/logout')
      await removeModelCache()
      lastLoginError = null
      sendJson(request, response, 200, await readAuthStatus())
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/chatgpt/responses/stream') {
      const body = await readJson(request)
      const messages = normalizeMessages(body.messages)
      const model = await normalizeModel(body.model)
      await streamChat(request, response, model, messages)
      return
    }
    sendJson(request, response, 404, { error: 'Not found' })
  } catch (error) {
    const status = error instanceof CodexRpcError && /unauthorized|login|required/i.test(error.message)
      ? 401
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
    await removeLegacyAuth()
    console.log(`[auth-server] listening at http://${DEFAULT_HOST}:${port}`)
    console.log('[auth-server] credentials are owned by the official Codex app-server')
  })
  return server
}

server.on('close', () => codex.close())

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) startAuthServer()
