import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createMcpApiMiddleware } from './mcp-api.mjs'

test('protects mutating MCP runtime routes with an in-memory bootstrap token', async (context) => {
  const calls = []
  const runtime = {
    status: () => ({ sessions: [] }),
    connect: async (server) => { calls.push(server); return { sessions: [{ server, state: 'connected', tools: [] }] } },
    disconnect: async () => ({ sessions: [] }),
    prepareCall: () => ({}),
    executeCall: async () => ({}),
  }
  const middleware = createMcpApiMiddleware({ runtime, runtimeToken: 'test-runtime-token' })
  const server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end() }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`

  const bootstrap = await fetch(`${base}/api/mcp/bootstrap`)
  assert.equal(bootstrap.status, 200)
  assert.equal((await bootstrap.json()).runtimeToken, 'test-runtime-token')

  const denied = await fetch(`${base}/api/mcp/sessions/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403)

  const allowed = await fetch(`${base}/api/mcp/sessions/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bioresearch-runtime-token': 'test-runtime-token' },
    body: JSON.stringify({ server: { id: 'test' } }),
  })
  assert.equal(allowed.status, 200)
  assert.equal(calls[0].id, 'test')
})
