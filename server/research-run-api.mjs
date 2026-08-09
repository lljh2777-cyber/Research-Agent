import { eventStatus, isTerminalResearchRunStatus } from '../src/research/runProtocol.js'
import { ResearchRunManager } from './research-run-manager.mjs'
import { ResearchRunExecutor } from './research-run-executor.mjs'

const MAX_BODY_BYTES = 1024 * 1024

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

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(JSON.stringify(payload))
}

function sendSse(response, envelope) {
  response.write(`id: ${envelope.cursor}\nevent: ${envelope.event.type}\ndata: ${JSON.stringify(envelope)}\n\n`)
}

function routeFor(request) {
  const url = new URL(request.url || '/', 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'research' || parts[2] !== 'runs') return null
  if (parts.length === 3) return { kind: 'collection', url }
  const runId = decodeURIComponent(parts[3] || '')
  if (parts.length === 4) return { kind: 'run', runId, url }
  if (parts.length === 5 && parts[4] === 'events') return { kind: 'events', runId, url }
  if (parts.length === 5 && parts[4] === 'start') return { kind: 'start', runId, url }
  if (parts.length === 5 && parts[4] === 'tool-results') return { kind: 'tool-results', runId, url }
  return { kind: 'unknown', runId, url }
}

function streamEvents(request, response, manager, runId, after) {
  const replay = manager.eventsAfter(runId, after)
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

  const unsubscribe = manager.subscribe(runId, (envelope) => {
    if (response.destroyed) return
    sendSse(response, envelope)
    if (isTerminalResearchRunStatus(eventStatus(envelope.event.type))) response.end()
  })
  const keepAlive = setInterval(() => {
    if (!response.destroyed) response.write(': keepalive\n\n')
  }, 15_000)
  const cleanup = () => {
    clearInterval(keepAlive)
    unsubscribe()
  }
  request.once('close', cleanup)
  response.once('close', cleanup)
}

export function createResearchRunApiMiddleware({ manager = new ResearchRunManager(), executor } = {}) {
  const runExecutor = executor || new ResearchRunExecutor({ manager })
  const middleware = async function researchRunApiMiddleware(request, response, next) {
    const route = routeFor(request)
    if (!route) return next()
    try {
      const origin = String(request.headers.origin || '')
      const host = String(request.headers.host || '')
      if (origin && ![`http://${host}`, `https://${host}`].includes(origin)) {
        return sendJson(response, 403, { error: 'Untrusted research run request.' })
      }
      if (route.kind === 'collection') {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST' })
        const result = manager.create(await readJsonBody(request))
        return sendJson(response, result.created ? 201 : 200, result)
      }
      if (route.kind === 'run') {
        if (request.method === 'GET') return sendJson(response, 200, manager.get(route.runId))
        if (request.method === 'DELETE') {
          runExecutor.cancel(route.runId)
          return sendJson(response, 200, manager.cancel(route.runId))
        }
        return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, DELETE' })
      }
      if (route.kind === 'start') {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST' })
        const result = runExecutor.start(route.runId, await readJsonBody(request))
        return sendJson(response, result.started ? 202 : 200, result)
      }
      if (route.kind === 'tool-results') {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST' })
        const body = await readJsonBody(request)
        return sendJson(response, 202, runExecutor.submitToolResult(route.runId, body.requestId, body.result))
      }
      if (route.kind === 'events') {
        if (request.method === 'POST') {
          const body = await readJsonBody(request)
          return sendJson(response, 202, manager.append(route.runId, body.events || []))
        }
        if (request.method === 'GET') {
          const after = route.url.searchParams.get('after') || request.headers['last-event-id'] || 0
          const follows = route.url.searchParams.get('follow') === '1' || String(request.headers.accept || '').includes('text/event-stream')
          return follows
            ? streamEvents(request, response, manager, route.runId, after)
            : sendJson(response, 200, manager.eventsAfter(route.runId, after))
        }
        return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' })
      }
      return sendJson(response, 404, { error: 'Research run route was not found.' })
    } catch (error) {
      return sendJson(response, Number(error?.statusCode) || 500, { error: error?.message || 'Research run service failed.' })
    }
  }
  middleware.manager = manager
  middleware.executor = runExecutor
  return middleware
}
