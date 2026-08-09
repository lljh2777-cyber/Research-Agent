import { MAX_KNOWLEDGE_ACTION_INPUT_BYTES } from '../shared/runtime-action-contracts.mjs'
import { isTerminalResearchRunStatus } from '../src/research/runProtocol.js'
import { CodexActionRunner } from './action-runner.mjs'
import { ActionService } from './action-service.mjs'

async function readJsonBody(request) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_KNOWLEDGE_ACTION_INPUT_BYTES) {
      throw Object.assign(new Error('Action request exceeds the 131,072-byte limit.'), { statusCode: 413, code: 'limit_exceeded' })
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Action request must be valid JSON.'), { statusCode: 400, code: 'invalid_json' })
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

function sendSse(response, envelope) {
  response.write('id: ' + envelope.cursor + String.fromCharCode(10))
  response.write('event: ' + envelope.event.type + String.fromCharCode(10))
  response.write('data: ' + JSON.stringify(envelope) + String.fromCharCode(10) + String.fromCharCode(10))
}

function trustedOrigin(request) {
  const origin = String(request.headers.origin || '')
  const host = String(request.headers.host || '')
  return !origin || origin === 'null' || origin === 'http://' + host || origin === 'https://' + host
}

function routeFor(request) {
  const url = new URL(request.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'runtime' || parts[2] !== 'actions') return null
  if (parts.length === 3) return { kind: 'collection', url }
  const runId = decodeURIComponent(parts[3] || '')
  if (parts.length === 4) return { kind: 'run', runId, url }
  if (parts.length === 5 && parts[4] === 'events') return { kind: 'events', runId, url }
  return { kind: 'unknown', runId, url }
}

function streamEvents(request, response, service, runId, after) {
  const replay = service.eventsAfter(runId, after)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  })
  response.flushHeaders?.()
  for (const envelope of replay.events) sendSse(response, envelope)
  if (isTerminalResearchRunStatus(replay.run.status)) return response.end()
  const unsubscribe = service.subscribe(runId, (envelope) => {
    if (response.destroyed) return
    sendSse(response, envelope)
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(envelope.event.type)) response.end()
  })
  const keepAlive = setInterval(() => {
    if (!response.destroyed) response.write(': keepalive' + String.fromCharCode(10) + String.fromCharCode(10))
  }, 15_000)
  const cleanup = () => {
    clearInterval(keepAlive)
    unsubscribe()
  }
  request.once('close', cleanup)
  response.once('close', cleanup)
}

function unavailable(response) {
  return sendJson(response, 503, {
    ok: false,
    unavailable: true,
    code: 'runtime_unavailable',
    reason: 'Local Action service is not configured.',
  })
}

export function createActionApiMiddleware({
  root = process.env.BIORESEARCH_VAULT_ROOT,
  service,
  runner,
} = {}) {
  const actionService = service || (root ? new ActionService({
    runner: runner || new CodexActionRunner({ root }),
  }) : null)
  const middleware = async function actionApiMiddleware(request, response, next) {
    const route = routeFor(request)
    if (!route) return next()
    try {
      if (!trustedOrigin(request)) {
        return sendJson(response, 403, { ok: false, code: 'untrusted_origin', error: 'Untrusted Action request.' })
      }
      if (!actionService) return unavailable(response)
      if (route.kind === 'collection') {
        if (request.method === 'GET') return sendJson(response, 200, actionService.list())
        if (request.method === 'POST') return sendJson(response, 202, actionService.start(await readJsonBody(request)))
        return sendJson(response, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed.' }, { Allow: 'GET, POST' })
      }
      if (route.kind === 'run') {
        if (request.method === 'GET') return sendJson(response, 200, actionService.get(route.runId))
        if (request.method === 'DELETE') return sendJson(response, 200, actionService.cancel(route.runId))
        return sendJson(response, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed.' }, { Allow: 'GET, DELETE' })
      }
      if (route.kind === 'events' && request.method === 'GET') {
        const after = route.url.searchParams.get('after') || request.headers['last-event-id'] || 0
        return streamEvents(request, response, actionService, route.runId, after)
      }
      return sendJson(response, 404, { ok: false, code: 'not_found', error: 'Action route was not found.' })
    } catch (error) {
      return sendJson(response, Number(error?.statusCode) || 500, {
        ok: false,
        code: error?.code || 'action_failed',
        error: error?.message || 'Runtime Action failed.',
      })
    }
  }
  middleware.service = actionService
  return middleware
}
