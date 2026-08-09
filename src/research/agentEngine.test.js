import assert from 'node:assert/strict'
import test from 'node:test'

import { InsufficientEvidenceError, runResearchAgent } from './agentEngine.js'
import { RESEARCH_RUN_EVENT } from './runProtocol.js'

test('uses the conversation policy as the actual tool-loop budget', async () => {
  const events = []
  let requests = 0
  await assert.rejects(runResearchAgent({
    runId: 'run-policy',
    messages: [],
    tools: [{ name: 'search_vault' }],
    policy: { maxToolRounds: 2 },
    request: async () => ({ toolCalls: [{ id: `call-${++requests}`, name: 'search_vault', arguments: '{}' }] }),
    executeTool: async (call) => ({ id: call.id, name: call.name, content: '{}' }),
    onEvent: (event) => events.push(event),
  }), /2-round tool limit/)

  assert.equal(requests, 2)
  assert.equal(events.at(-1).type, RESEARCH_RUN_EVENT.RUN_FAILED)
})
test('runs a tool-free model through the same Agent Engine', async () => {
  const events = []
  const output = await runResearchAgent({
    runId: 'run-chat',
    messages: [{ role: 'user', content: 'Summarize the evidence.' }],
    request: async () => ({ text: 'Summary', toolCalls: [] }),
    onEvent: (event) => events.push(event),
  })

  assert.equal(output.result.text, 'Summary')
  assert.deepEqual(events.map((event) => event.type), [
    RESEARCH_RUN_EVENT.RUN_STARTED,
    RESEARCH_RUN_EVENT.MODEL_STARTED,
    RESEARCH_RUN_EVENT.RUN_COMPLETED,
  ])
})

test('can enforce evidence before spending a model request', async () => {
  let requested = false
  await assert.rejects(runResearchAgent({
    runId: 'run-evidence',
    messages: [],
    evidenceCount: 0,
    policy: { requireEvidence: true, stopOnInsufficientEvidence: true },
    request: async () => { requested = true },
  }), (error) => error instanceof InsufficientEvidenceError)
  assert.equal(requested, false)
})
