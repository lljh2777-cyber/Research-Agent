import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES,
  ANNOTATION_RECORD_PATH_MAX_LENGTH,
  normalizeArchiveAnnotationInput,
} from '../annotations/annotation.js'
import { createKnowledgeActionToolRegistry } from '../toolRegistry.js'
import { runResearchAgent } from './agentEngine.js'
import {
  consumeKnowledgeArchiveReplay,
  consumeKnowledgeArchiveResult,
  consumeKnowledgeArchiveTerminalEvent,
  createKnowledgeArchiveActionInput,
  createKnowledgeArchivePendingState,
  createKnowledgeArchiveResult,
  isCompletedKnowledgeArchiveResult,
  knowledgeArchiveResultToAnnotationArchive,
  normalizeKnowledgeArchiveTargetEvidence,
  requireCompletedKnowledgeArchiveResult,
} from './knowledgeArchive.js'
import {
  getKnowledgeActionToolDescriptor,
  KNOWLEDGE_ACTION_STATUS,
  KNOWLEDGE_TOOL_IDS,
} from './knowledgeAgent.js'
import { RESEARCH_RUN_EVENT } from './runProtocol.js'

const fixture = JSON.parse(readFileSync(
  new URL('../../docs/contracts/knowledge-archive-result-v1.fixture.json', import.meta.url),
  'utf8',
))
const ownerFixture = JSON.parse(readFileSync(
  new URL('../../docs/contracts/annotation-archive-v1.fixture.json', import.meta.url),
  'utf8',
))

function request(overrides = {}) {
  return createKnowledgeArchiveActionInput({
    ...structuredClone(fixture.request),
    ...overrides,
  })
}

test('consumes the integrated KB archive input exactly and freezes the synthesis descriptor shape', () => {
  assert.deepEqual(fixture.request.input, ownerFixture.archiveInput)
  assert.deepEqual(normalizeArchiveAnnotationInput(ownerFixture.archiveInput), ownerFixture.archiveInput)
  assert.deepEqual(request(), fixture.request)

  const descriptor = getKnowledgeActionToolDescriptor(KNOWLEDGE_TOOL_IDS.SYNTHESIS)
  assert.deepEqual(Object.keys(descriptor.inputSchema.properties.input.properties), [
    'operation', 'sourceAnnotation', 'targets',
  ])
  assert.deepEqual(descriptor.inputSchema.properties.input.required, [
    'operation', 'sourceAnnotation', 'targets',
  ])
  assert.deepEqual(descriptor.inputSchema.properties.input.properties.sourceAnnotation.required, [
    'id', 'path', 'revision',
  ])
  assert.equal(descriptor.approvalPolicy, 'explicit')
  assert.equal(descriptor.requiresScope, true)
  assert.equal(descriptor.requiresIdempotencyKey, true)

  assert.throws(() => request({ input: { instruction: 'archive somewhere' } }), /operation/)
  assert.throws(() => request({ input: { ...ownerFixture.archiveInput, instruction: 'free text identity' } }), /not allowed/)
  assert.throws(() => request({ input: { ...ownerFixture.archiveInput, targets: [] } }), /too few items|must not be empty/)
  assert.throws(() => request({ input: { ...ownerFixture.archiveInput, targets: ['../escape.md'] } }), /normalized relative/)
  assert.throws(() => request({
    input: { ...ownerFixture.archiveInput, targets: ['knowledge/findings.md', 'knowledge/findings.md'] },
  }), /duplicate/)
  assert.throws(() => request({
    input: {
      ...ownerFixture.archiveInput,
      sourceAnnotation: { ...ownerFixture.archiveInput.sourceAnnotation, revision: '界'.repeat(86) },
    },
  }), /256 UTF-8 bytes/)

  const boundary = `${ownerFixture.runtimeReadablePathSemantics.boundaryRecipe.prefix}${'界'.repeat(
    ownerFixture.runtimeReadablePathSemantics.boundaryRecipe.cjkCountAtLimit,
  )}${ownerFixture.runtimeReadablePathSemantics.boundaryRecipe.suffix}`
  assert.equal(boundary.length, ANNOTATION_RECORD_PATH_MAX_LENGTH)
  assert.equal(request({ input: {
    ...ownerFixture.archiveInput,
    sourceAnnotation: { ...ownerFixture.archiveInput.sourceAnnotation, path: boundary },
  } }).input.sourceAnnotation.path, boundary)
  assert.equal(request().input.sourceAnnotation.path, 'wiki/annotations/annotation-cjk-1.MD')
  assert.throws(() => request({ input: {
    ...ownerFixture.archiveInput,
    sourceAnnotation: { ...ownerFixture.archiveInput.sourceAnnotation, path: `${boundary}x` },
  } }), /512 JavaScript UTF-16 code units|too long/)
  assert.throws(() => request({ input: {
    ...ownerFixture.archiveInput,
    sourceAnnotation: { id: ownerFixture.archiveInput.sourceAnnotation.id, revision: 'missing-path' },
  } }), /path is required/)
  assert.throws(() => request({ input: {
    ...ownerFixture.archiveInput,
    sourceAnnotation: { ...ownerFixture.archiveInput.sourceAnnotation, extra: true },
  } }), /exactly|not allowed/)
})

test('requires explicit approval over the normalized root scope and exact requested targets', async () => {
  let approval = null
  let executed = null
  const registry = createKnowledgeActionToolRegistry({
    capabilities: { 'actions.synthesis': true },
    context: fixture.request.context,
    sessionId: fixture.request.sessionId,
    runId: fixture.request.runId,
    permissions: { read: 'allow', write: 'allow' },
    requestApproval: async (value) => { approval = value; return true },
    executeAction: async (value) => {
      executed = value
      return {
        status: KNOWLEDGE_ACTION_STATUS.COMPLETED,
        summary: fixture.completed.summary,
        data: { targets: fixture.completed.data.targets },
      }
    },
  })
  const result = await registry.execute({
    id: fixture.request.requestId,
    name: 'knowledge_synthesis_write',
    arguments: JSON.stringify({
      input: fixture.request.input,
      scope: fixture.request.scope,
      idempotencyKey: fixture.request.idempotencyKey,
    }),
  })

  assert.deepEqual(approval.action.scope, fixture.request.scope)
  assert.deepEqual(approval.action.input.targets, fixture.request.input.targets)
  assert.equal(approval.descriptor.approvalPolicy, 'explicit')
  assert.equal(executed.idempotencyKey, fixture.request.idempotencyKey)
  assert.deepEqual(JSON.parse(result.content), fixture.completed)
})

test('enforces the KB archive run ID UTF-8 byte bound before lifecycle mapping', () => {
  const maximumRunId = '界'.repeat(85) + 'a'
  assert.equal(new TextEncoder().encode(maximumRunId).length, ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES)
  const action = request({ runId: maximumRunId })
  assert.equal(createKnowledgeArchivePendingState(action).runId, maximumRunId)
  assert.equal(knowledgeArchiveResultToAnnotationArchive(action, createKnowledgeArchiveResult(action, {
    targets: action.input.targets.map((path) => ({ path, status: 'unchanged', revision: null })),
  })).runId, maximumRunId)

  const oversizedRunId = '界'.repeat(86)
  assert(new TextEncoder().encode(oversizedRunId).length > ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES)
  assert.throws(() => request({ runId: oversizedRunId }), /256 UTF-8 bytes/)
  assert.throws(() => consumeKnowledgeArchiveResult({
    ...fixture.request,
    runId: oversizedRunId,
  }, fixture.completed), /256 UTF-8 bytes/)
})

test('normalizes completed target evidence with exact identity, order, status, and revision bounds', () => {
  const action = request()
  assert.deepEqual(createKnowledgeArchiveResult(action, {
    summary: fixture.completed.summary,
    targets: fixture.completed.data.targets,
  }), fixture.completed)
  assert.deepEqual(consumeKnowledgeArchiveResult(action, fixture.completed), fixture.completed)
  assert.equal(isCompletedKnowledgeArchiveResult(action, fixture.completed), true)
  assert.deepEqual(requireCompletedKnowledgeArchiveResult(action, fixture.completed), fixture.completed)

  assert.throws(() => createKnowledgeArchiveResult(action, {
    targets: fixture.completed.data.targets.slice(0, 1),
  }), /every requested target/)
  assert.throws(() => createKnowledgeArchiveResult(action, {
    targets: [...fixture.completed.data.targets].reverse(),
  }), /requested target order/)
  assert.throws(() => normalizeKnowledgeArchiveTargetEvidence(action, [
    fixture.completed.data.targets[0], fixture.completed.data.targets[0],
  ]), /duplicates target evidence/)
  assert.throws(() => normalizeKnowledgeArchiveTargetEvidence(action, [{
    path: 'knowledge/unrequested.md', status: 'created', revision: null,
  }]), /unrequested target/)
  assert.throws(() => normalizeKnowledgeArchiveTargetEvidence(action, [{
    path: fixture.request.input.targets[0], status: 'pending', revision: null,
  }]), /Unsupported Knowledge archive target status/)
  assert.throws(() => normalizeKnowledgeArchiveTargetEvidence(action, [{
    path: fixture.request.input.targets[0], status: 'created', revision: '界'.repeat(86),
  }]), /256 UTF-8 bytes/)
  assert.equal(isCompletedKnowledgeArchiveResult(action, {
    ...fixture.completed,
    data: { ...fixture.completed.data, sourceAnnotation: { ...fixture.completed.data.sourceAnnotation, revision: 'other' } },
  }), false)
  assert.equal(isCompletedKnowledgeArchiveResult(action, {
    ...fixture.completed,
    data: { ...fixture.completed.data, sourceAnnotation: { ...fixture.completed.data.sourceAnnotation, path: 'wiki/annotations/other.md' } },
  }), false)
})

test('keeps requested targets separate from truthful partial failed and cancelled execution evidence', () => {
  const action = request()
  const failed = consumeKnowledgeArchiveResult(action, fixture.failedPartial)
  const cancelled = consumeKnowledgeArchiveResult(action, fixture.cancelledPartial)

  assert.equal(isCompletedKnowledgeArchiveResult(action, failed), false)
  assert.equal(isCompletedKnowledgeArchiveResult(action, cancelled), false)
  assert.throws(() => requireCompletedKnowledgeArchiveResult(action, failed), /completed/)
  assert.deepEqual(failed.data.targets, fixture.failedPartial.data.targets)
  assert.deepEqual(cancelled.data.targets, fixture.cancelledPartial.data.targets)

  assert.deepEqual(createKnowledgeArchivePendingState(action), {
    state: 'pending', targets: fixture.request.input.targets, runId: fixture.request.runId, error: null,
  })
  assert.deepEqual(knowledgeArchiveResultToAnnotationArchive(action, fixture.completed), {
    state: 'completed', targets: fixture.request.input.targets, runId: fixture.request.runId, error: null,
  })
  assert.deepEqual(knowledgeArchiveResultToAnnotationArchive(action, failed), {
    state: 'failed', targets: fixture.request.input.targets, runId: fixture.request.runId,
    error: fixture.failedPartial.error,
  })
  assert.deepEqual(knowledgeArchiveResultToAnnotationArchive(action, cancelled), {
    state: 'failed', targets: fixture.request.input.targets, runId: fixture.request.runId,
    error: fixture.cancelledPartial.error,
  })
})

test('preserves partial cancellation evidence on the existing Research Run cancelled terminal', async () => {
  const events = []
  const registry = createKnowledgeActionToolRegistry({
    capabilities: { 'actions.synthesis': true },
    context: fixture.request.context,
    sessionId: fixture.request.sessionId,
    runId: fixture.request.runId,
    permissions: { write: 'ask' },
    requestApproval: async () => true,
    executeAction: async () => ({
      status: KNOWLEDGE_ACTION_STATUS.CANCELLED,
      summary: fixture.cancelledPartial.summary,
      data: { targets: fixture.cancelledPartial.data.targets },
      error: fixture.cancelledPartial.error,
    }),
  })
  let requested = false
  await assert.rejects(runResearchAgent({
    runId: fixture.request.runId,
    messages: [{ role: 'user', content: 'archive after save' }],
    tools: registry.definitions,
    request: async () => {
      if (requested) return { text: 'must not complete', toolCalls: [] }
      requested = true
      return {
        text: '',
        toolCalls: [{
          id: fixture.request.requestId,
          name: 'knowledge_synthesis_write',
          arguments: JSON.stringify({
            input: fixture.request.input,
            scope: fixture.request.scope,
            idempotencyKey: fixture.request.idempotencyKey,
          }),
        }],
      }
    },
    executeTool: (call) => registry.execute(call),
    onEvent: (event) => events.push(event),
  }), (error) => error.name === 'AbortError')

  const terminal = events.at(-1)
  assert.equal(terminal.type, RESEARCH_RUN_EVENT.RUN_CANCELLED)
  assert.deepEqual(terminal.result, fixture.cancelledPartial)
  assert.deepEqual(consumeKnowledgeArchiveTerminalEvent(request(), terminal), fixture.cancelledPartial)
  assert.equal(events.some(({ type }) => type === RESEARCH_RUN_EVENT.RUN_COMPLETED), false)
})

test('preserves partial failure evidence on the existing Research Run failed terminal', async () => {
  const events = []
  const registry = createKnowledgeActionToolRegistry({
    capabilities: { 'actions.synthesis': true },
    context: fixture.request.context,
    sessionId: fixture.request.sessionId,
    runId: fixture.request.runId,
    permissions: { write: 'ask' },
    requestApproval: async () => true,
    executeAction: async () => ({
      status: KNOWLEDGE_ACTION_STATUS.FAILED,
      summary: fixture.failedPartial.summary,
      data: { targets: fixture.failedPartial.data.targets },
      error: fixture.failedPartial.error,
    }),
  })
  await assert.rejects(runResearchAgent({
    runId: fixture.request.runId,
    messages: [{ role: 'user', content: 'archive after save' }],
    tools: registry.definitions,
    request: async () => ({
      text: '',
      toolCalls: [{
        id: fixture.request.requestId,
        name: 'knowledge_synthesis_write',
        arguments: JSON.stringify({
          input: fixture.request.input,
          scope: fixture.request.scope,
          idempotencyKey: fixture.request.idempotencyKey,
        }),
      }],
    }),
    executeTool: (call) => registry.execute(call),
    onEvent: (event) => events.push(event),
  }), (error) => error.message === fixture.failedPartial.summary)

  const terminal = events.at(-1)
  assert.equal(terminal.type, RESEARCH_RUN_EVENT.RUN_FAILED)
  assert.deepEqual(terminal.result, fixture.failedPartial)
  assert.deepEqual(consumeKnowledgeArchiveTerminalEvent(request(), terminal), fixture.failedPartial)
})

test('consumes replay cursors and rejects stale run or result identity', () => {
  const action = request()
  const replay = consumeKnowledgeArchiveReplay(action, [
    { cursor: 4, event: { type: RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, runId: action.runId, delta: 'working' } },
    { cursor: 5, event: { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId: action.runId, output: fixture.completed } },
  ])
  assert.equal(replay.cursor, 5)
  assert.deepEqual(replay.output, fixture.completed)

  const failedReplay = consumeKnowledgeArchiveReplay(action, [{
    cursor: 6,
    event: {
      type: RESEARCH_RUN_EVENT.RUN_FAILED,
      runId: action.runId,
      error: { message: fixture.failedPartial.error.message },
      result: fixture.failedPartial,
    },
  }])
  assert.equal(failedReplay.output.status, KNOWLEDGE_ACTION_STATUS.FAILED)
  assert.deepEqual(failedReplay.output.data.targets, fixture.failedPartial.data.targets)

  assert.throws(() => consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_CANCELLED, runId: 'stale-run', error: { message: 'stale' },
  }), /mismatched run ID/)
  assert.throws(() => consumeKnowledgeArchiveResult(action, {
    ...fixture.completed, requestId: 'stale-request',
  }), /identity does not match/)

  const invalidCompleted = consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_COMPLETED,
    runId: action.runId,
    output: { ...fixture.completed, data: { ...fixture.completed.data, targets: [] } },
  })
  assert.equal(invalidCompleted.status, KNOWLEDGE_ACTION_STATUS.FAILED)
  assert.equal(isCompletedKnowledgeArchiveResult(action, invalidCompleted), false)

  const failedAtCompletedTerminal = consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_COMPLETED,
    runId: action.runId,
    output: fixture.failedPartial,
  })
  assert.equal(failedAtCompletedTerminal.status, KNOWLEDGE_ACTION_STATUS.FAILED)
  assert.deepEqual(failedAtCompletedTerminal.data.targets, [])
})

test('accepts only absent or full exact failed/cancelled terminal result evidence', () => {
  const action = request()
  const legacyFailed = consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_FAILED,
    runId: action.runId,
    error: { message: 'Legacy failure without structured evidence.' },
  })
  const legacyCancelled = consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_CANCELLED,
    runId: action.runId,
    error: { message: 'Legacy cancellation without structured evidence.' },
  })
  assert.deepEqual(legacyFailed.data.targets, [])
  assert.deepEqual(legacyCancelled.data.targets, [])
  assert.deepEqual(consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_FAILED,
    runId: action.runId,
    result: fixture.failedPartial,
  }), fixture.failedPartial)
  assert.deepEqual(consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_CANCELLED,
    runId: action.runId,
    result: fixture.cancelledPartial,
  }), fixture.cancelledPartial)

  const malformedResults = [
    { targets: fixture.failedPartial.data.targets },
    { data: { targets: fixture.failedPartial.data.targets } },
    { ...fixture.failedPartial, schemaVersion: 2 },
    { ...fixture.failedPartial, requestId: 'wrong-request' },
    { ...fixture.failedPartial, status: KNOWLEDGE_ACTION_STATUS.CANCELLED, error: fixture.cancelledPartial.error },
    { ...fixture.failedPartial, artifacts: [{}] },
  ]
  for (const result of malformedResults) {
    assert.throws(() => consumeKnowledgeArchiveTerminalEvent(action, {
      type: RESEARCH_RUN_EVENT.RUN_FAILED,
      runId: action.runId,
      result,
    }))
    assert.throws(() => consumeKnowledgeArchiveReplay(action, [{
      cursor: 9,
      event: { type: RESEARCH_RUN_EVENT.RUN_FAILED, runId: action.runId, result },
    }]))
  }

  assert.throws(() => consumeKnowledgeArchiveTerminalEvent(action, {
    type: RESEARCH_RUN_EVENT.RUN_CANCELLED,
    runId: action.runId,
    result: fixture.failedPartial,
  }), /status does not match/)
  assert.throws(() => consumeKnowledgeArchiveReplay(action, [{
    cursor: 10,
    event: {
      type: RESEARCH_RUN_EVENT.RUN_CANCELLED,
      runId: action.runId,
      result: fixture.failedPartial,
    },
  }]), /status does not match/)
})

test('enforces owner target-count/path bounds and the existing bounded Action output', () => {
  const maximumPath = `${'a'.repeat(1_021)}.md`
  const targets = Array.from({ length: 32 }, (_, index) => index === 0 ? maximumPath : `knowledge/target-${index}.md`)
  const action = request({ input: {
    ...fixture.request.input,
    targets,
  } })
  const evidence = targets.map((path) => ({ path, status: 'unchanged', revision: null }))
  const result = createKnowledgeArchiveResult(action, { targets: evidence })
  assert.equal(result.data.targets.length, 32)
  assert(new TextEncoder().encode(JSON.stringify(result)).length <= 65_536)

  assert.throws(() => request({ input: {
    ...fixture.request.input,
    targets: Array.from({ length: 33 }, (_, index) => `knowledge/target-${index}.md`),
  } }), /too many items|exceeds 32 targets/)
  assert.throws(() => request({ input: {
    ...fixture.request.input,
    targets: [`${'a'.repeat(1_022)}.md`],
  } }), /too long|exceeds 1024 UTF-8 bytes/)
})
