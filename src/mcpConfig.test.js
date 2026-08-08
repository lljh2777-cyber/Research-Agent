import assert from 'node:assert/strict'
import test from 'node:test'

import { createMcpServer, loadMcpConfig, normalizeMcpConfig, saveMcpConfig } from './mcpConfig.js'

test('normalizes MCP servers and enforces non-escalating permission defaults', () => {
  const config = normalizeMcpConfig({
    permissions: { read: 'allow', write: 'allow', destructive: 'allow' },
    servers: [{ id: 'server-1', name: 'Bio MCP', transport: 'stdio', command: 'bio-mcp', enabled: true }],
  })
  assert.deepEqual(config.permissions, { read: 'allow', write: 'ask', destructive: 'deny' })
  assert.equal(config.servers[0].transport, 'stdio')
  assert.equal(config.servers[0].enabled, true)
})

test('persists normalized MCP configuration without credentials', () => {
  const storage = new Map()
  const adapter = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) }
  const server = createMcpServer({ name: 'Remote MCP', transport: 'streamable-http', endpoint: ' https://example.test/mcp ' })
  saveMcpConfig({ permissions: { read: 'deny' }, servers: [server] }, adapter)
  const loaded = loadMcpConfig(adapter)
  assert.equal(loaded.permissions.read, 'deny')
  assert.equal(loaded.servers[0].endpoint, 'https://example.test/mcp')
  assert.equal('headers' in loaded.servers[0], false)
})
