import assert from 'node:assert/strict'
import test from 'node:test'

import { RESEARCH_RUN_EVENT, RESEARCH_RUN_STATUS } from '../src/research/runProtocol.js'
import { ResearchRunExecutor } from './research-run-executor.mjs'
import { ResearchRunManager } from './research-run-manager.mjs'

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for Research Run state.')
}

async function* toolCallingProvider(input) {
  const hasToolResult = input.messages.some((message) => message.role === 'tool')
  if (!hasToolResult) {
    yield { type: 'message.delta', delta: 'Searching' }
    yield {
      type: 'run.completed',
      text: 'Searching',
      model: input.model,
      toolCalls: [{ id: 'call-1', name: 'vault_search', arguments: '{"query":"TP53"}' }],
    }
    return
  }
  yield { type: 'message.delta', delta: 'Grounded answer' }
  yield { type: 'run.completed', text: 'Grounded answer', model: input.model, toolCalls: [] }
}

test('owns provider streaming and resumes after a delegated browser tool result', async () => {
  const manager = new ResearchRunManager()
  manager.create({ id: 'run-provider', executionOwner: 'loopback' })
  const executor = new ResearchRunExecutor({ manager, streamProvider: toolCallingProvider })
  executor.start('run-provider', {
    kind: 'provider',
    providerId: 'compatible',
    endpoint: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'Find TP53 evidence' }],
    tools: [{ type: 'function', function: { name: 'vault_search', parameters: { type: 'object' } } }],
  })

  const requested = await waitFor(() => manager.eventsAfter('run-provider').events
    .find((item) => item.event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED))
  assert.equal(manager.get('run-provider').run.status, RESEARCH_RUN_STATUS.WAITING_APPROVAL)
  assert.equal(executor.submitToolResult('run-provider', requested.event.requestId, {
    id: 'call-1', name: 'vault_search', content: '{"matches":["TP53"]}', summary: '1 match', isError: false,
  }).accepted, true)
  const completed = await waitFor(() => manager.get('run-provider').run.status === RESEARCH_RUN_STATUS.COMPLETED && manager.eventsAfter('run-provider'))

  assert.equal(completed.run.executionOwner, 'loopback')
  assert.deepEqual(completed.events.map((item) => item.event.type).filter((type) => [
    RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
    RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED,
    RESEARCH_RUN_EVENT.RUN_COMPLETED,
  ].includes(type)), [
    RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
    RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED,
    RESEARCH_RUN_EVENT.RUN_COMPLETED,
  ])
  assert.equal(completed.events.at(-1).event.result.text, 'Grounded answer')
  assert.equal(executor.activeCount, 0)
})

test('cancels provider ownership and rejects late tool results', async () => {
  const manager = new ResearchRunManager()
  manager.create({ id: 'run-provider-cancel', executionOwner: 'loopback' })
  const executor = new ResearchRunExecutor({ manager, streamProvider: toolCallingProvider })
  executor.start('run-provider-cancel', {
    kind: 'provider', providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'test-model',
    messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'vault_search', parameters: {} } }],
  })
  const requested = await waitFor(() => manager.eventsAfter('run-provider-cancel').events
    .find((item) => item.event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED))
  executor.cancel('run-provider-cancel')
  manager.cancel('run-provider-cancel')
  await waitFor(() => executor.activeCount === 0)

  assert.throws(() => executor.submitToolResult('run-provider-cancel', requested.event.requestId, {}), /no longer accepting/i)
  assert.equal(manager.get('run-provider-cancel').run.status, RESEARCH_RUN_STATUS.CANCELLED)
})
