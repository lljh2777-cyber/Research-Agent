import { randomBytes, timingSafeEqual } from 'node:crypto'

import { McpRuntime } from './mcp-runtime.mjs'

const MAX_BODY_BYTES = 256 * 1024
const ROUTES = new Set([
  '/api/mcp/bootstrap',
  '/api/mcp/sessions/connect',
  '/api/mcp/sessions/disconnect',
  '/api/mcp/calls/prepare',
  '/api/mcp/calls/execute',
])

function readJson(request) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }))
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(payload))
}

function trustedRequest(request) {
  const value = String(request.headers.host || '')
  const host = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.split(':')[0]
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return false
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

function validToken(request, token) {
  const supplied = Buffer.from(String(request.headers['x-bioresearch-runtime-token'] || ''))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function createMcpApiMiddleware({ runtime = new McpRuntime(), runtimeToken = randomBytes(32).toString('base64url') } = {}) {
  const middleware = async function mcpApiMiddleware(request, response, next) {
    const path = new URL(request.url || '/', 'http://localhost').pathname
    if (!ROUTES.has(path)) return next()
    if (!trustedRequest(request)) return sendJson(response, 403, { error: 'MCP runtime accepts trusted loopback requests only.' })
    if (path === '/api/mcp/bootstrap') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' })
      return sendJson(response, 200, { runtimeToken, ...runtime.status() })
    }
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' })
    if (!validToken(request, runtimeToken)) return sendJson(response, 403, { error: 'Invalid local runtime token.' })
    try {
      const body = await readJson(request)
      let result
      if (path === '/api/mcp/sessions/connect') result = await runtime.connect(body.server)
      else if (path === '/api/mcp/sessions/disconnect') result = await runtime.disconnect(body.serverId)
      else if (path === '/api/mcp/calls/prepare') result = runtime.prepareCall(body)
      else result = await runtime.executeCall(body)
      return sendJson(response, 200, result)
    } catch (error) {
      return sendJson(response, Number(error?.statusCode) || 500, { error: error?.message || 'MCP runtime request failed.' })
    }
  }
  middleware.runtime = runtime
  return middleware
}
