import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

import { createMcpApiMiddleware } from '../server/mcp-api.mjs'
import { createProviderApiMiddleware } from '../server/provider-api.mjs'
import { createRuntimeApiMiddleware } from '../server/runtime-api.mjs'

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
})

function sendText(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(text)
}

function safeAssetPath(rootDir, pathname) {
  const decoded = decodeURIComponent(pathname)
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(rootDir, normalize(relative))
  const root = `${resolve(rootDir)}${sep}`
  return candidate.startsWith(root) ? candidate : null
}

async function serveAsset(rootDir, request, response) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) return sendText(response, 405, 'Method not allowed')
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  let filePath = safeAssetPath(rootDir, pathname)
  if (!filePath) return sendText(response, 400, 'Invalid path')
  let info = await stat(filePath).catch(() => null)
  if (!info?.isFile() && !extname(pathname)) {
    filePath = join(rootDir, 'index.html')
    info = await stat(filePath).catch(() => null)
  }
  if (!info?.isFile()) return sendText(response, 404, 'Not found')
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': extname(filePath) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:4317 http://127.0.0.1:4318; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  if (request.method === 'HEAD') return response.end()
  createReadStream(filePath).pipe(response)
}

export function createDesktopAppServer({ rootDir, runtimeManifest, fetchImpl = fetch, credentialResolver } = {}) {
  if (!rootDir || !runtimeManifest) throw new Error('Desktop app server requires a static root and runtime manifest.')
  const mcpApi = createMcpApiMiddleware()
  const middlewares = [
    createRuntimeApiMiddleware({ manifest: runtimeManifest }),
    mcpApi,
    createProviderApiMiddleware({ fetchImpl, credentialResolver, allowStreaming: false }),
  ]
  let expectedOrigin = ''

  const server = createServer(async (request, response) => {
    const host = request.headers.host || ''
    const origin = request.headers.origin || ''
    if (!expectedOrigin || `http://${host}` !== expectedOrigin || (origin && origin !== expectedOrigin)) {
      return sendText(response, 403, 'Untrusted desktop request')
    }
    let index = 0
    const next = () => {
      const middleware = middlewares[index++]
      if (middleware) return middleware(request, response, next)
      return serveAsset(rootDir, request, response).catch(() => sendText(response, 500, 'Desktop host failed'))
    }
    await next()
  })

  return {
    server,
    mcpRuntime: mcpApi.runtime,
    async listen() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolveListen)
      })
      const address = server.address()
      expectedOrigin = `http://127.0.0.1:${address.port}`
      return expectedOrigin
    },
    async close() {
      await mcpApi.runtime.shutdown()
      if (server.listening) await new Promise((resolveClose) => server.close(resolveClose))
    },
  }
}
