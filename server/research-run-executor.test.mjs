import assert from 'node:assert/strict'
import test from 'node:test'

import { KNOWLEDGE_TOOL_IDS } from '../src/research/knowledgeAgent.js'
import {
  createKnowledgeReadRunRequest,
  requireCompletedKnowledgeReadText,
} from '../src/research/knowledgeReadRun.js'
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

test('does not start terminal or renderer-owned Research Runs', () => {
  const manager = new ResearchRunManager()
  const executor = new ResearchRunExecutor({ manager, streamProvider: toolCallingProvider })
  manager.create({ id: 'run-terminal', executionOwner: 'loopback' })
  manager.cancel('run-terminal')
  assert.deepEqual(executor.start('run-terminal', {}), { started: false, terminal: true, runId: 'run-terminal' })

  manager.create({ id: 'run-renderer', executionOwner: 'renderer' })
  assert.throws(() => executor.start('run-renderer', {}), /not owned by the loopback executor/)
})

test('keeps accepted delegated tool result retries idempotent', async () => {
  const manager = new ResearchRunManager()
  manager.create({ id: 'run-provider-retry', executionOwner: 'loopback' })
  const executor = new ResearchRunExecutor({ manager, streamProvider: toolCallingProvider })
  executor.start('run-provider-retry', {
    kind: 'provider', providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'test-model',
    messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'vault_search', parameters: {} } }],
  })
  const requested = await waitFor(() => manager.eventsAfter('run-provider-retry').events
    .find((item) => item.event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED))
  const result = { id: 'call-1', name: 'vault_search', content: '{}', summary: 'ok', isError: false }
  assert.equal(executor.submitToolResult('run-provider-retry', requested.event.requestId, result).accepted, true)
  assert.deepEqual(executor.submitToolResult('run-provider-retry', requested.event.requestId, result), { accepted: false, duplicate: true })
  await waitFor(() => manager.get('run-provider-retry').run.status === RESEARCH_RUN_STATUS.COMPLETED)
})

test('normalizes a real Knowledge explain Provider terminal before run.completed', async () => {
  let providerInput = null
  async function* knowledgeProvider(input) {
    providerInput = input
    yield { type: 'message.delta', delta: '该段证据说明 ' }
    yield { type: 'run.completed', text: '该段证据说明 TP53 参与 DNA 损伤反应。', model: input.model, toolCalls: [] }
  }

  const manager = new ResearchRunManager()
  manager.create({ id: 'knowledge-run', sessionId: 'knowledge-session', executionOwner: 'loopback' })
  const executor = new ResearchRunExecutor({ manager, streamProvider: knowledgeProvider })
  const knowledgeRead = createKnowledgeReadRunRequest(KNOWLEDGE_TOOL_IDS.EXPLAIN, {
    requestId: 'knowledge-request',
    sessionId: 'knowledge-session',
    runId: 'knowledge-run',
    context: {
      schemaVersion: 1,
      surface: 'knowledge-sidebar',
      vault: { id: 'vault-1', name: 'Lab Vault', revision: 'r1' },
      activeNote: null,
      selection: null,
      attachments: [],
      contextRevision: 'context-r1',
      ownerExtension: { opaque: true },
    },
    input: { question: '请解释当前证据。' },
  })

  executor.start('knowledge-run', {
    kind: 'provider',
    providerId: 'compatible',
    endpoint: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    knowledgeRead,
  })
  const completed = await waitFor(() => manager.get('knowledge-run').run.status === RESEARCH_RUN_STATUS.COMPLETED
    && manager.eventsAfter('knowledge-run'))
  const terminal = completed.events.at(-1).event

  assert.equal(terminal.type, RESEARCH_RUN_EVENT.RUN_COMPLETED)
  assert.equal(requireCompletedKnowledgeReadText(terminal.result), '该段证据说明 TP53 参与 DNA 损伤反应。')
  assert.deepEqual(providerInput.tools, [])
  assert.match(providerInput.messages[0].content, /untrusted evidence/i)
  assert.match(providerInput.messages[1].content, /ownerExtension/)
  assert.equal(completed.events.some(({ event }) => event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED), false)
  assert.equal(executor.activeCount, 0)
})

test('fails empty Knowledge reads before completion and rejects tools or mismatched identity', async () => {
  async function* emptyKnowledgeProvider(input) {
    yield { type: 'run.completed', text: '', model: input.model, toolCalls: [] }
  }
  const context = {
    schemaVersion: 1,
    surface: 'research',
    vault: { id: 'vault-1', name: 'Lab Vault', revision: 'r1' },
    activeNote: null,
    selection: null,
    attachments: [],
    contextRevision: 'context-r1',
  }
  const knowledgeRead = createKnowledgeReadRunRequest(KNOWLEDGE_TOOL_IDS.EXPLAIN, {
    requestId: 'empty-request', sessionId: 'empty-session', runId: 'empty-run', context, input: {},
  })
  const manager = new ResearchRunManager()
  manager.create({ id: 'empty-run', sessionId: 'empty-session', executionOwner: 'loopback' })
  const executor = new ResearchRunExecutor({ manager, streamProvider: emptyKnowledgeProvider })
  executor.start('empty-run', {
    kind: 'provider', providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'test-model', knowledgeRead,
  })
  const failed = await waitFor(() => manager.get('empty-run').run.status === RESEARCH_RUN_STATUS.FAILED
    && manager.eventsAfter('empty-run'))
  assert.equal(failed.events.at(-1).event.type, RESEARCH_RUN_EVENT.RUN_FAILED)
  assert.match(failed.events.at(-1).event.error.message, /non-empty text/)
  assert.equal(failed.events.some(({ event }) => event.type === RESEARCH_RUN_EVENT.RUN_COMPLETED), false)

  manager.create({ id: 'tool-run', sessionId: 'tool-session', executionOwner: 'loopback' })
  const toolRead = createKnowledgeReadRunRequest(KNOWLEDGE_TOOL_IDS.EXPLAIN, {
    requestId: 'tool-request', sessionId: 'tool-session', runId: 'tool-run', context, input: {},
  })
  assert.throws(() => executor.start('tool-run', {
    kind: 'provider', providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'test-model',
    knowledgeRead: toolRead,
    tools: [{ type: 'function', function: { name: 'knowledge_annotation_write', parameters: {} } }],
  }), /cannot expose provider tools/)

  manager.create({ id: 'identity-run', sessionId: 'identity-session', executionOwner: 'loopback' })
  assert.throws(() => executor.start('identity-run', {
    kind: 'provider', providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'test-model', knowledgeRead,
  }), /identity does not match/)
})
