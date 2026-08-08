import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalMcpToolEntries, formatMcpToolResult, parseMcpCallArguments } from './mcpRuntimeClient.js'

test('maps connected MCP tools into collision-resistant provider definitions', async () => {
  const calls = []
  const entries = createExternalMcpToolEntries([{
    server: { id: 'bio-tools', name: 'Bio tools' },
    state: 'connected',
    tools: [
      { name: 'search_gene', description: 'Search genes', effect: 'read', inputSchema: { type: 'object' } },
      { name: 'save_note', description: 'Save note', effect: 'write', inputSchema: { type: 'object' } },
      { name: 'delete_all', effect: 'destructive', inputSchema: { type: 'object' } },
    ],
  }], async (call) => { calls.push(call); return { content: '{}' } })
  assert.equal(entries.length, 2)
  assert.match(entries[0].definition.name, /^mcp_bio-tools_[a-z0-9]+_search_gene_[a-z0-9]+$/)
  assert.match(entries[1].definition.name, /^mcp_bio-tools_[a-z0-9]+_save_note_[a-z0-9]+$/)
  assert.ok(entries.every((entry) => entry.definition.name.length <= 64))
  await entries[1].execute({ id: '1', name: entries[1].definition.name, arguments: '{}' }, { approved: true })
  assert.equal(calls[0].approved, true)
  assert.equal(calls[0].toolName, 'save_note')
})

test('parses arguments and marks external MCP results as untrusted data', () => {
  assert.deepEqual(parseMcpCallArguments({ arguments: '{"gene":"TP53"}' }), { gene: 'TP53' })
  assert.throws(() => parseMcpCallArguments({ arguments: '[]' }), /valid JSON object/)
  const result = formatMcpToolResult({ id: '1', name: 'tool', arguments: '{}' }, { serverId: 'bio', toolName: 'search', result: { content: [{ type: 'text', text: 'data' }] } })
  assert.match(result.content, /untrusted external data/)
  assert.equal(result.isError, false)
})
