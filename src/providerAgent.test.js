import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_AGENT_TOOL_ROUNDS, MAX_TOOL_CALLS_PER_ROUND, runProviderAgent } from './providerAgent.js'

test('runs a tool round and returns the final provider answer', async () => {
  const requests = []
  const rounds = []
  const responses = [
    { text: '', reasoning: 'Search first.', toolCalls: [{ id: 'call-1', name: 'search_vault', arguments: '{"query":"CellChat"}' }] },
    { text: 'CellChat is supported by Vault evidence.', reasoning: 'Synthesize result.', toolCalls: [] },
  ]
  const output = await runProviderAgent({
    messages: [{ role: 'user', content: 'Explain CellChat' }],
    tools: [{ name: 'search_vault' }],
    request: async (messages) => {
      requests.push(messages)
      return responses.shift()
    },
    executeTool: async (call) => ({ id: call.id, name: call.name, content: '{"evidence":["CellChat"]}', summary: 'Found evidence.', isError: false }),
    onToolRound: async (round) => rounds.push(round),
  })
  assert.equal(output.result.text, 'CellChat is supported by Vault evidence.')
  assert.equal(output.toolTrace.length, 1)
  assert.equal(rounds.length, 1)
  assert.equal(requests[1][1].reasoning, 'Search first.')
  assert.equal(requests[1][1].toolCalls[0].id, 'call-1')
  assert.equal(requests[1][2].role, 'tool')
})

test('rejects unavailable tools and excessive calls', async () => {
  const call = { id: 'call-1', name: 'search_vault', arguments: '{}' }
  await assert.rejects(runProviderAgent({
    messages: [],
    request: async () => ({ toolCalls: [call] }),
    executeTool: async () => ({}),
  }), /no research tools/)
  await assert.rejects(runProviderAgent({
    messages: [],
    tools: [{ name: 'search_vault' }],
    request: async () => ({ toolCalls: Array.from({ length: MAX_TOOL_CALLS_PER_ROUND + 1 }, (_, index) => ({ ...call, id: `call-${index}` })) }),
    executeTool: async () => ({}),
  }), /more than 8 tools/)
})

test('stops a provider that never exits its tool loop', async () => {
  let requests = 0
  await assert.rejects(runProviderAgent({
    messages: [],
    tools: [{ name: 'search_vault' }],
    request: async () => ({ reasoning: `round ${++requests}`, toolCalls: [{ id: `call-${requests}`, name: 'search_vault', arguments: '{}' }] }),
    executeTool: async (call) => ({ id: call.id, name: call.name, content: '{}' }),
  }), new RegExp(`${MAX_AGENT_TOOL_ROUNDS}-round tool limit`))
  assert.equal(requests, MAX_AGENT_TOOL_ROUNDS)
})
