import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
} from '../shared/runtime-action-contracts.mjs'
import { ActionService } from './action-service.mjs'

async function waitForTerminal(service, runId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = service.get(runId)
    if (['completed', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('Action did not reach a terminal state.')
}

function knowledgeContextAtLimit() {
  const context = {
    schemaVersion: 1,
    surface: 'knowledge-sidebar',
    vault: { vaultId: 'vault-1' },
    activeNote: null,
    selection: null,
    attachments: [],
    contextRevision: '',
  }
  const remaining = MAX_KNOWLEDGE_CONTEXT_BYTES - Buffer.byteLength(JSON.stringify(context))
  context.contextRevision = 'r'.repeat(remaining)
  assert.equal(Buffer.byteLength(JSON.stringify(context)), MAX_KNOWLEDGE_CONTEXT_BYTES)
  return context
}

function coreActionInput(overrides = {}) {
  return {
    schemaVersion: 1,
    toolId: 'knowledge.lint',
    requestId: 'call-1',
    runId: 'run-1',
    sessionId: 'session-1',
    context: { schemaVersion: 1 },
    scope: null,
    idempotencyKey: null,
    input: {},
    ...overrides,
  }
}

test('ActionService exposes Core descriptors and completes through Research Run v1 events', async () => {
  const calls = []
  const service = new ActionService({
    runner: {
      async run(input) {
        calls.push(input)
        input.onProgress({ stage: 'audit' })
        return { findings: 2 }
      },
    },
  })

  const listed = service.list()
  assert.equal(listed.schemaVersion, 1)
  assert.deepEqual(listed.actions.map((entry) => entry.id), [
    'knowledge.lint',
    'knowledge.paper.ingest',
    'knowledge.xray',
    'knowledge.code.analyze',
    'knowledge.synthesis.write',
  ])
  assert.deepEqual(Object.keys(listed.actions[0]), [
    'schemaVersion',
    'id',
    'name',
    'title',
    'description',
    'effect',
    'riskClass',
    'approvalPolicy',
    'capability',
    'inputSchema',
    'outputSchema',
    'requiresScope',
    'requiresIdempotencyKey',
  ])

  const context = knowledgeContextAtLimit()
  const started = service.start(coreActionInput({
    requestId: 'call-lint-1',
    runId: 'action-lint-1',
    input: { rules: [] },
    context,
  }))
  assert.equal(started.started, true)
  const completed = await waitForTerminal(service, 'action-lint-1')
  assert.equal(completed.run.status, 'completed')
  const replay = service.eventsAfter('action-lint-1', 0)
  assert.deepEqual(replay.events.map((entry) => entry.event.type), [
    'run.started',
    'provider.event',
    'run.completed',
  ])
  assert.deepEqual(replay.events.at(-1).event.output.data, { findings: 2 })
  assert.strictEqual(calls[0].context, context)
})

test('ActionService enforces approval, scope, idempotency, bounds, and cancellation terminality', async () => {
  let resolveRunner
  const service = new ActionService({
    runner: {
      run({ signal }) {
        return new Promise((resolve, reject) => {
          resolveRunner = resolve
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
        })
      },
    },
  })
  const approved = coreActionInput({
    toolId: 'knowledge.xray',
    requestId: 'call-xray-1',
    runId: 'action-xray-1',
    input: { sourceRef: 'paper-1' },
    context: { schemaVersion: 1, surface: 'research', vault: { vaultId: 'vault-1' }, activeNote: null, selection: null, attachments: [], contextRevision: 'opaque-context' },
    scope: { vaultId: 'vault-1', target: { kind: 'note', id: 'wiki/sources/paper-1.md' }, expectedRevision: null },
    idempotencyKey: 'xray-paper-1',
    approval: { status: 'approved' },
  })

  assert.throws(
    () => service.start({ ...approved, runId: 'missing-approval', approval: undefined, permission: { write: 'allow' } }),
    (error) => error.code === 'approval_required' && error.statusCode === 403,
  )
  assert.throws(
    () => service.start({ ...approved, runId: 'missing-scope', scope: undefined }),
    (error) => error.code === 'scope_required' && error.statusCode === 403,
  )
  assert.throws(
    () => service.start({ ...approved, runId: 'missing-key', idempotencyKey: '' }),
    /idempotencyKey/,
  )
  assert.throws(
    () => service.start(coreActionInput({ input: { value: 'x'.repeat(MAX_KNOWLEDGE_ACTION_INPUT_BYTES) } })),
    (error) => error.code === 'limit_exceeded' && error.statusCode === 413,
  )
  assert.throws(
    () => service.start(coreActionInput({ context: { ...knowledgeContextAtLimit(), contextRevision: knowledgeContextAtLimit().contextRevision + 'x' } })),
    (error) => error.code === 'limit_exceeded' && error.statusCode === 413,
  )

  const started = service.start(approved)
  assert.equal(started.started, true)
  const replayed = service.start({ ...approved, runId: 'ignored-by-idempotency' })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.run.id, 'action-xray-1')
  assert.throws(
    () => service.start({ ...approved, runId: 'action-xray-conflict', input: { sourceRef: 'different' } }),
    (error) => error.code === 'idempotency_conflict' && error.statusCode === 409,
  )

  const cancelled = service.cancel('action-xray-1')
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.run.status, 'cancelled')
  resolveRunner({ shouldNotComplete: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(service.get('action-xray-1').run.status, 'cancelled')
  assert.equal(service.eventsAfter('action-xray-1', 0).events.at(-1).event.type, 'run.cancelled')
})

test('ActionService bounds terminal output independently from Action input', async () => {
  const service = new ActionService({
    runner: {
      async run() {
        return { summary: 'x'.repeat(MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES) }
      },
    },
  })
  service.start(coreActionInput({ requestId: 'call-output-limit', runId: 'action-output-limit' }))
  const failed = await waitForTerminal(service, 'action-output-limit')
  assert.equal(failed.run.status, 'failed')
  assert.equal(service.eventsAfter('action-output-limit', 0).events.at(-1).event.error.code, 'limit_exceeded')
})

test('ActionService atomically replays the original terminal result for a scoped idempotency key', async () => {
  let calls = 0
  const service = new ActionService({
    runner: {
      async run() {
        calls += 1
        return { changed: ['wiki/sources/paper-1.md'] }
      },
    },
  })
  const envelope = coreActionInput({
    toolId: 'knowledge.paper.ingest',
    requestId: 'call-ingest-terminal',
    runId: 'action-ingest-terminal',
    input: { attachmentId: 'paper.pdf' },
    scope: { vaultId: 'vault-1', target: { kind: 'note', id: 'wiki/sources/paper-1.md' }, expectedRevision: null },
    idempotencyKey: 'paper-ingest-terminal-1',
    approval: { status: 'approved' },
  })
  service.start(envelope)
  const completed = await waitForTerminal(service, envelope.runId)
  assert.equal(completed.run.status, 'completed')
  const replayed = service.start({ ...envelope, runId: 'must-not-run' })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.run.id, envelope.runId)
  assert.equal(replayed.run.status, 'completed')
  assert.deepEqual(replayed.terminalEvent.output.data, {
    changed: ['wiki/sources/paper-1.md'],
  })
  assert.equal(calls, 1)
  assert.deepEqual(service.eventsAfter(envelope.runId, 0).events.at(-1).event.output.data, {
    changed: ['wiki/sources/paper-1.md'],
  })
})
