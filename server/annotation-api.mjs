import { RUNTIME_ANNOTATION_REQUEST_MAX_BYTES, RUNTIME_ACTION_SCHEMA_VERSION } from '../shared/runtime-action-contracts.mjs'
import { AnnotationStore } from './annotation-store.mjs'

async function readJsonBody(request) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > RUNTIME_ANNOTATION_REQUEST_MAX_BYTES) {
      throw Object.assign(new Error('Annotation request exceeds the 131,072-byte limit.'), { statusCode: 413, code: 'limit_exceeded' })
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('Annotation request must be valid JSON.'), { statusCode: 400, code: 'invalid_json' })
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

function trustedOrigin(request) {
  const origin = String(request.headers.origin || '')
  const host = String(request.headers.host || '')
  return !origin || origin === 'null' || origin === 'http://' + host || origin === 'https://' + host
}

function routeFor(request) {
  const url = new URL(request.url || '/', 'http://localhost')
  if (url.pathname !== '/api/runtime/annotations') return null
  return { url }
}

function unavailable(response) {
  return sendJson(response, 503, {
    ok: false,
    unavailable: true,
    code: 'runtime_unavailable',
    reason: 'Local annotation persistence is not configured.',
  })
}

export function createAnnotationApiMiddleware({ root = process.env.BIORESEARCH_VAULT_ROOT, store } = {}) {
  const annotationStore = store || (root ? new AnnotationStore({ root }) : null)
  const middleware = async function annotationApiMiddleware(request, response, next) {
    const route = routeFor(request)
    if (!route) return next()
    try {
      if (!trustedOrigin(request)) {
        return sendJson(response, 403, { ok: false, code: 'untrusted_origin', error: 'Untrusted annotation request.' })
      }
      if (!annotationStore) return unavailable(response)
      if (request.method === 'GET') {
        const path = route.url.searchParams.get('path')
        const result = path ? await annotationStore.read(path) : await annotationStore.list()
        return sendJson(response, 200, { ok: true, schemaVersion: RUNTIME_ACTION_SCHEMA_VERSION, ...result })
      }
      if (request.method === 'PUT') {
        const result = await annotationStore.write(await readJsonBody(request))
        return sendJson(response, 200, { schemaVersion: RUNTIME_ACTION_SCHEMA_VERSION, ...result })
      }
      return sendJson(response, 405, { ok: false, code: 'method_not_allowed', error: 'Method not allowed.' }, { Allow: 'GET, PUT' })
    } catch (error) {
      return sendJson(response, Number(error?.statusCode) || 500, {
        ok: false,
        code: error?.code || 'annotation_failed',
        error: error?.message || 'Annotation persistence failed.',
        ...(Object.prototype.hasOwnProperty.call(error || {}, 'currentRevision') ? { currentRevision: error.currentRevision } : {}),
      })
    }
  }
  middleware.store = annotationStore
  return middleware
}
