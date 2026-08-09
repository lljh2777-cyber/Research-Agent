import assert from 'node:assert/strict'
import test from 'node:test'

import { createKnowledgeActionToolRegistry } from '../toolRegistry.js'
import {
  KNOWLEDGE_ACTION_STATUS,
  KNOWLEDGE_TOOL_EFFECT,
} from './knowledgeAgent.js'

const context = Object.freeze({
  schemaVersion: 1,
  surface: 'knowledge-sidebar',
  vault: { id: 'vault-1' },
  activeNote: { id: 'note-1', path: 'notes/note-1.md' },
  contextRevision: 'context-r1',
})

function call(id, name, value) {
  return { id, name, arguments: JSON.stringify(value) }
}

test('fails closed for unavailable capabilities and exposes inventory reasons', async () => {
  const registry = createKnowledgeActionToolRegistry({
    capabilities: {
      'knowledge.query': true,
      'knowledge.lint': { available: false, reason: 'Vault lint service is offline.' },
    },
    context,
    sessionId: 'session-1',
    runId: 'run-1',
    permissions: { read: 'allow', write: 'ask' },
    executeAction: async () => ({ status: KNOWLEDGE_ACTION_STATUS.COMPLETED, summary: 'ok' }),
  })

  assert.deepEqual(registry.definitions.map(({ name }) => name), ['knowledge_query'])
  const lint = registry.inventory.find(({ id }) => id === 'knowledge.lint')
  assert.equal(lint.available, false)
  assert.equal(lint.unavailableReason, 'Vault lint service is offline.')
  const result = await registry.execute(call('call-1', 'knowledge_lint', { input: {} }))
  assert.equal(result.isError, true)
  assert.match(result.summary, /offline/)
})

test('runs read tools without approval and rejects any write effect from them', async () => {
  let approvals = 0
  const registry = createKnowledgeActionToolRegistry({
    capabilities: { 'knowledge.query': true },
    context,
    sessionId: 'session-1',
    runId: 'run-1',
    permissions: { read: 'allow', write: 'ask' },
    requestApproval: async () => { approvals += 1; return true },
    executeAction: async () => ({
      status: KNOWLEDGE_ACTION_STATUS.COMPLETED,
      effect: KNOWLEDGE_TOOL_EFFECT.READ,
      summary: 'Found evidence.',
      data: { matches: 2 },
    }),
  })
  const result = await registry.execute(call('call-1', 'knowledge_query', { input: { query: 'TP53' } }))
  assert.equal(approvals, 0)
  assert.equal(JSON.parse(result.content).effect, KNOWLEDGE_TOOL_EFFECT.READ)

  const invalid = createKnowledgeActionToolRegistry({
    capabilities: { 'knowledge.query': true },
    context,
    sessionId: 'session-1',
    runId: 'run-1',
    permissions: { read: 'allow' },
    executeAction: async () => ({ effect: KNOWLEDGE_TOOL_EFFECT.WRITE, summary: 'bad' }),
  })
  assert.match((await invalid.execute(call('call-2', 'knowledge_query', { input: { query: 'TP53' } }))).summary, /cannot emit a write effect/)
})

test('validates write scope and idempotency before showing one-call approval', async () => {
  let approval = null
  let executed = null
  const registry = createKnowledgeActionToolRegistry({
    capabilities: { 'annotations.write': true },
    context,
    sessionId: 'session-1',
    runId: 'run-1',
    permissions: { read: 'allow', write: 'allow' },
    requestApproval: async (value) => { approval = value; return true },
    executeAction: async (request) => {
      executed = request
      return {
        status: KNOWLEDGE_ACTION_STATUS.COMPLETED,
        summary: 'Annotation saved.',
        artifacts: [{ id: 'annotation-1', kind: 'annotation' }],
      }
    },
  })

  const missingScope = await registry.execute(call('call-1', 'knowledge_annotation_write', {
    input: { operation: 'create', annotation: { schemaVersion: 1 } },
  }))
  assert.equal(missingScope.isError, true)
  assert.match(missingScope.summary, /explicit scope/)
  assert.equal(approval, null)

  const result = await registry.execute(call('call-2', 'knowledge_annotation_write', {
    scope: { vaultId: 'vault-1', target: { kind: 'selection', id: 'selection-1' }, expectedRevision: 'r1' },
    idempotencyKey: 'annotation:selection-1:r1',
    input: { operation: 'create', annotation: { schemaVersion: 1, id: 'annotation-1' } },
  }))
  assert.equal(approval.descriptor.approvalPolicy, 'explicit')
  assert.equal(approval.action.scope.target.id, 'selection-1')
  assert.equal(executed.idempotencyKey, 'annotation:selection-1:r1')
  assert.equal(JSON.parse(result.content).artifacts[0].id, 'annotation-1')
})

test('propagates action cancellation through the Research Run v1 abort path', async () => {
  const registry = createKnowledgeActionToolRegistry({
    capabilities: { 'knowledge.query': true },
    context,
    sessionId: 'session-1',
    runId: 'run-1',
    permissions: { read: 'allow' },
    executeAction: async () => ({ status: KNOWLEDGE_ACTION_STATUS.CANCELLED, summary: 'User cancelled.' }),
  })

  await assert.rejects(
    registry.execute(call('call-1', 'knowledge_query', { input: { query: 'TP53' } })),
    (error) => error.name === 'AbortError' && /cancelled/i.test(error.message),
  )
})