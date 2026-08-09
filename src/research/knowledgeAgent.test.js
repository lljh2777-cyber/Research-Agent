import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  consumeKnowledgeSessionHandoff,
  createKnowledgeActionInput,
  createKnowledgeActionOutput,
  createKnowledgeSessionHandoff,
  KNOWLEDGE_ACTION_STATUS,
  KNOWLEDGE_ACTION_TOOL_DESCRIPTORS,
  KNOWLEDGE_AGENT_ID,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
  KNOWLEDGE_SURFACE,
  KNOWLEDGE_TOOL_APPROVAL,
  KNOWLEDGE_TOOL_EFFECT,
  KNOWLEDGE_TOOL_IDS,
} from './knowledgeAgent.js'

const fixture = JSON.parse(readFileSync(new URL('../../docs/contracts/knowledge-agent-v1.fixture.json', import.meta.url), 'utf8'))

function knowledgeContext() {
  return structuredClone(fixture.context)
}

test('freezes eight typed tools with read/write approval policy and read-only lint', () => {
  assert.equal(KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.length, 8)
  assert.equal(new Set(KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.map(({ id }) => id)).size, 8)
  assert.equal(new Set(KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.map(({ name }) => name)).size, 8)

  const reads = KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.filter(({ effect }) => effect === KNOWLEDGE_TOOL_EFFECT.READ)
  const writes = KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.filter(({ effect }) => effect === KNOWLEDGE_TOOL_EFFECT.WRITE)
  assert.deepEqual(reads.map(({ id }) => id), [KNOWLEDGE_TOOL_IDS.QUERY, KNOWLEDGE_TOOL_IDS.EXPLAIN, KNOWLEDGE_TOOL_IDS.LINT])
  assert(reads.every(({ approvalPolicy, requiresScope, requiresIdempotencyKey }) => (
    approvalPolicy === KNOWLEDGE_TOOL_APPROVAL.NONE && !requiresScope && !requiresIdempotencyKey
  )))
  assert(writes.every(({ approvalPolicy, requiresScope, requiresIdempotencyKey }) => (
    approvalPolicy === KNOWLEDGE_TOOL_APPROVAL.EXPLICIT && requiresScope && requiresIdempotencyKey
  )))
  assert.match(KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.find(({ id }) => id === KNOWLEDGE_TOOL_IDS.LINT).description, /never repairs/i)
})

test('consumes Knowledge Context v1 opaquely and requires scope plus idempotency for writes', () => {
  const context = knowledgeContext()
  const request = createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.ANNOTATION, {
    requestId: 'call-1',
    runId: 'run-1',
    sessionId: 'session-1',
    context,
    scope: {
      vaultId: 'vault-1',
      target: { kind: 'selection', id: 'note-1#selection-1' },
      expectedRevision: 'vault-r7',
    },
    idempotencyKey: 'annotation:note-1:selection-1:r7',
    input: { operation: 'create', annotation: { schemaVersion: 1, id: 'annotation-1' } },
  })

  context.activeNote.id = 'mutated'
  assert.deepEqual(request.context, fixture.context)
  assert.equal(request.scope.target.kind, 'selection')
  assert.equal(request.idempotencyKey, 'annotation:note-1:selection-1:r7')
  assert.throws(() => createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.SYNTHESIS, {
    requestId: 'call-2', runId: 'run-1', sessionId: 'session-1', context: knowledgeContext(), input: {},
  }), /explicit scope/)
})

test('preserves the exact KB fixture, nullable references, and maximum Context v1 bytes', () => {
  const emptyContext = {
    ...knowledgeContext(),
    activeNote: null,
    selection: null,
    attachments: [],
  }
  const handoff = createKnowledgeSessionHandoff({
    sessionId: 'session-empty', context: emptyContext, sourceSurface: KNOWLEDGE_SURFACE.RESEARCH,
  })
  assert.deepEqual(handoff.context, emptyContext)

  const maximumContext = knowledgeContext()
  maximumContext.attachments[0].reference = ''
  const baseBytes = new TextEncoder().encode(JSON.stringify(maximumContext)).length
  maximumContext.attachments[0].reference = 'x'.repeat(MAX_KNOWLEDGE_CONTEXT_BYTES - baseBytes)
  assert.equal(new TextEncoder().encode(JSON.stringify(maximumContext)).length, MAX_KNOWLEDGE_CONTEXT_BYTES)
  assert.doesNotThrow(() => createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'call-max', runId: 'run-max', sessionId: 'session-max',
    context: maximumContext, input: { query: 'preserve' },
  }))
  maximumContext.attachments[0].reference += 'x'
  assert.throws(() => createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'call-over', runId: 'run-max', sessionId: 'session-max',
    context: maximumContext, input: { query: 'preserve' },
  }), /Knowledge Context v1 exceeds/)
})


test('read tools cannot emit write effects or write artifacts and action envelopes are bounded', () => {
  assert.throws(() => createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'call-0',
    runId: 'run-1',
    sessionId: 'session-1',
    context: knowledgeContext(),
    input: {},
  }), /input\.query is required/)
  assert.throws(() => createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.LINT, {
    requestId: 'call-lint',
    runId: 'run-1',
    sessionId: 'session-1',
    context: knowledgeContext(),
    input: { repair: true },
  }), /input\.repair is not allowed/)
  assert.throws(() => createKnowledgeActionOutput(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'call-1', runId: 'run-1', effect: KNOWLEDGE_TOOL_EFFECT.WRITE,
  }), /cannot emit a write effect/)
  assert.throws(() => createKnowledgeActionOutput(KNOWLEDGE_TOOL_IDS.LINT, {
    requestId: 'call-2', runId: 'run-1', artifacts: [{ id: 'repair-1' }],
  }), /cannot emit write artifacts/)
  assert.throws(() => createKnowledgeActionOutput(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'call-error', runId: 'run-1', error: 'not-an-error-object',
  }), /output\.error has an invalid type/)
  assert.throws(() => createKnowledgeActionOutput(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'call-3', runId: 'run-1', data: { value: 'x'.repeat(70 * 1024) },
  }), /byte limit/)

  const cancelled = createKnowledgeActionOutput(KNOWLEDGE_TOOL_IDS.XRAY, {
    requestId: 'call-4', runId: 'run-1', status: KNOWLEDGE_ACTION_STATUS.CANCELLED, summary: 'Cancelled.',
  })
  assert.equal(cancelled.status, KNOWLEDGE_ACTION_STATUS.CANCELLED)
  assert.equal(cancelled.effect, KNOWLEDGE_TOOL_EFFECT.WRITE)
})

test('hands the same Knowledge Agent session, run cursor, and Context v1 across surfaces', () => {
  const handoff = createKnowledgeSessionHandoff({
    sessionId: 'session-1',
    runId: 'run-1',
    cursor: 17,
    context: knowledgeContext(),
    sourceSurface: KNOWLEDGE_SURFACE.SIDEBAR,
    createdAt: '2026-08-09T00:00:00.000Z',
  })
  const resumed = consumeKnowledgeSessionHandoff(handoff, { surface: KNOWLEDGE_SURFACE.RESEARCH })

  assert.equal(handoff.agentId, KNOWLEDGE_AGENT_ID)
  assert.equal(resumed.agentId, KNOWLEDGE_AGENT_ID)
  assert.equal(resumed.sessionId, 'session-1')
  assert.equal(resumed.runId, 'run-1')
  assert.equal(resumed.cursor, 17)
  assert.equal(resumed.surface, KNOWLEDGE_SURFACE.RESEARCH)
  assert.deepEqual(resumed.context, handoff.context)
  assert.notEqual(resumed.context, handoff.context)
  assert.throws(() => consumeKnowledgeSessionHandoff({ ...handoff, cursor: -1 }, {
    surface: KNOWLEDGE_SURFACE.RESEARCH,
  }), /non-negative integer/)
})
