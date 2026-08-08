import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyMcpTool, McpRuntime, normalizeMcpRuntimeServer } from './mcp-runtime.mjs'

function mockClientFactory(state) {
  return async () => ({
    transport: { terminateSession: async () => { state.terminated += 1 } },
    client: {
      listTools: async () => ({ tools: [
        { name: 'search', description: 'Read data', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'save', description: 'Write data', inputSchema: { type: 'object' } },
        { name: 'delete', description: 'Delete data', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
      ] }),
      getInstructions: () => 'Use carefully.',
      callTool: async (input) => { state.calls.push(input); return { content: [{ type: 'text', text: 'ok' }] } },
      close: async () => { state.closed += 1 },
    },
  })
}

test('normalizes transports without shell-parsing STDIO commands', () => {
  assert.deepEqual(normalizeMcpRuntimeServer({ id: 'bio', name: 'Bio', transport: 'stdio', command: 'npx', args: ['--yes', '@example/mcp'] }), {
    id: 'bio', name: 'Bio', transport: 'stdio', command: 'npx', args: ['--yes', '@example/mcp'],
  })
  assert.throws(() => normalizeMcpRuntimeServer({ id: 'bio', transport: 'stdio', command: 'npx\nwhoami' }), /invalid/)
  assert.equal(classifyMcpTool({ annotations: { readOnlyHint: true } }), 'read')
  assert.equal(classifyMcpTool({}), 'write')
  assert.equal(classifyMcpTool({ annotations: { readOnlyHint: true, destructiveHint: true } }), 'destructive')
})

test('discovers tools, requires write approval, and consumes one-time tickets', async () => {
  const state = { calls: [], closed: 0, terminated: 0 }
  let now = 1_000
  const runtime = new McpRuntime({ clientFactory: mockClientFactory(state), now: () => now })
  const status = await runtime.connect({ id: 'remote', name: 'Remote', transport: 'streamable-http', endpoint: 'https://example.test/mcp' })
  assert.deepEqual(status.sessions[0].tools.map((tool) => tool.effect), ['read', 'write', 'destructive'])

  const read = runtime.prepareCall({ serverId: 'remote', toolName: 'search', arguments: { q: 'x' } })
  assert.equal(read.requiresConfirmation, false)
  await runtime.executeCall({ ticketId: read.ticketId })

  const write = runtime.prepareCall({ serverId: 'remote', toolName: 'save', arguments: { value: 1 } })
  await assert.rejects(runtime.executeCall({ ticketId: write.ticketId }), /explicit approval/)
  await assert.rejects(runtime.executeCall({ ticketId: write.ticketId, approved: true }), /expired or was already used/)
  assert.throws(() => runtime.prepareCall({ serverId: 'remote', toolName: 'delete', arguments: {} }), /blocked/)

  const approved = runtime.prepareCall({ serverId: 'remote', toolName: 'save', arguments: { value: 2 } })
  await runtime.executeCall({ ticketId: approved.ticketId, approved: true })
  assert.equal(state.calls.length, 2)
  now += 61_000
  const expired = runtime.prepareCall({ serverId: 'remote', toolName: 'search', arguments: {} })
  now += 61_000
  await assert.rejects(runtime.executeCall({ ticketId: expired.ticketId }), /expired/)

  await runtime.disconnect('remote')
  assert.equal(state.terminated, 1)
  assert.equal(state.closed, 1)
})
