import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { runResearchAgent } from './agentEngine.js'
import {
  consumeKnowledgeSessionHandoff,
  createKnowledgeSessionHandoff,
  KNOWLEDGE_ACTION_STATUS,
  KNOWLEDGE_SURFACE,
  KNOWLEDGE_TOOL_IDS,
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
} from './knowledgeAgent.js'
import {
  consumeKnowledgeReadReplay,
  consumeKnowledgeReadTerminalEvent,
  createKnowledgeReadRunMessages,
  createKnowledgeReadRunRequest,
  executeKnowledgeReadRun,
  isCompletedKnowledgeReadResult,
  knowledgeReadCapabilityState,
  knowledgeReadEnvelopeByteLength,
  normalizeKnowledgeReadCompletedResult,
  requireCompletedKnowledgeReadText,
} from './knowledgeReadRun.js'
import { RESEARCH_RUN_EVENT } from './runProtocol.js'

const fixture = JSON.parse(readFileSync(
  new URL('../../docs/contracts/knowledge-read-result-v1.fixture.json', import.meta.url),
  'utf8',
))

function request(overrides = {}) {
  return createKnowledgeReadRunRequest(KNOWLEDGE_TOOL_IDS.EXPLAIN, {
    ...fixture.request,
    context: structuredClone(fixture.request.context),
    ...overrides,
  })
}

test('executes knowledge.explain through the injected Research Run engine and returns real CJK model text', async () => {
  const events = []
  let executionOptions = null
  let providerContext = null
  const result = await executeKnowledgeReadRun({
    ...fixture.request,
    toolId: KNOWLEDGE_TOOL_IDS.EXPLAIN,
    context: structuredClone(fixture.request.context),
    executeRun: (options) => {
      executionOptions = options
      return runResearchAgent(options)
    },
    providerRequest: async (messages, context) => {
      providerContext = context
      assert.deepEqual(messages, createKnowledgeReadRunMessages(context.knowledgeReadRequest))
      return {
        text: fixture.result.data.text,
        summary: fixture.result.summary,
        toolCalls: [],
      }
    },
    onEvent: (event) => events.push(event),
  })

  assert.deepEqual(result, fixture.result)
  assert.equal(requireCompletedKnowledgeReadText(result), '该段证据说明 TP53 参与 DNA 损伤反应。')
  assert.equal(isCompletedKnowledgeReadResult(result), true)
  assert.deepEqual(executionOptions.tools, [])
  assert.equal(executionOptions.executeTool, undefined)
  assert.deepEqual(providerContext.knowledgeReadRequest.context, fixture.request.context)
  assert.equal(providerContext.knowledgeReadRequest.context.ownerExtension.opaque, true)
  assert.deepEqual(events.map(({ type }) => type), [
    RESEARCH_RUN_EVENT.RUN_STARTED,
    RESEARCH_RUN_EVENT.MODEL_STARTED,
    RESEARCH_RUN_EVENT.RUN_COMPLETED,
  ])
  assert.deepEqual(events.at(-1).result, fixture.result)
  assert(knowledgeReadEnvelopeByteLength(result) > JSON.stringify(result).length)
})

test('freezes exact query/explain messages and fails closed on Runtime capability availability', () => {
  const query = createKnowledgeReadRunRequest(KNOWLEDGE_TOOL_IDS.QUERY, {
    requestId: 'query-1',
    sessionId: 'session-query',
    runId: 'run-query',
    context: structuredClone(fixture.request.context),
    input: { query: 'TP53 的作用是什么？' },
  })
  const messages = createKnowledgeReadRunMessages(query)
  assert.equal(messages.length, 2)
  assert.match(messages[0].content, /untrusted evidence/i)
  assert.match(messages[0].content, /Do not request tools, write a Vault, create an annotation/i)
  assert.match(messages[1].content, /TP53 的作用是什么/)
  assert.match(messages[1].content, /ownerExtension/)
  assert(!JSON.stringify(messages).includes('apiKey'))
  assert.throws(() => createKnowledgeReadRunRequest(KNOWLEDGE_TOOL_IDS.QUERY, {
    ...query,
    input: {},
  }), /input\.query is required/)

  const available = knowledgeReadCapabilityState({
    knowledgeReads: {
      available: true,
      transport: 'research-run',
      capabilities: { 'knowledge.query': true, 'knowledge.explain': true },
      reason: null,
    },
  }, KNOWLEDGE_TOOL_IDS.EXPLAIN)
  assert.deepEqual(available, {
    capability: 'knowledge.explain',
    available: true,
    transport: 'research-run',
    reason: null,
  })
  assert.equal(knowledgeReadCapabilityState({}, KNOWLEDGE_TOOL_IDS.EXPLAIN).available, false)
  assert.equal(knowledgeReadCapabilityState({
    knowledgeReads: { available: true, transport: 'research-run-v1', capabilities: { 'knowledge.explain': true } },
  }, KNOWLEDGE_TOOL_IDS.EXPLAIN).available, false)
})

test('uses UTF-8 byte accounting and accepts exactly 65,536 output bytes', () => {
  const readRequest = request()
  const base = normalizeKnowledgeReadCompletedResult(readRequest, { text: 'x', summary: 's' })
  const textBytes = MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES - knowledgeReadEnvelopeByteLength(base) + 1
  const exact = normalizeKnowledgeReadCompletedResult(readRequest, {
    text: 'x'.repeat(textBytes),
    summary: 's',
  })
  assert.equal(knowledgeReadEnvelopeByteLength(exact), MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES)
  assert.equal(isCompletedKnowledgeReadResult(exact), true)
  assert.throws(() => normalizeKnowledgeReadCompletedResult(readRequest, {
    text: `${exact.data.text}x`,
    summary: 's',
  }), /65536-byte limit/)
})

test('turns empty, failed, cancelled, and tool-calling reads into non-completed terminals', async () => {
  const cases = [
    {
      label: 'empty',
      providerRequest: async () => ({ text: '   ', toolCalls: [] }),
      expectedEvent: RESEARCH_RUN_EVENT.RUN_FAILED,
      expectedError: /non-empty text/,
    },
    {
      label: 'failed',
      providerRequest: async () => { throw new Error('Provider offline.') },
      expectedEvent: RESEARCH_RUN_EVENT.RUN_FAILED,
      expectedError: /Provider offline/,
    },
    {
      label: 'tool-call',
      providerRequest: async () => ({ text: 'write', toolCalls: [{ id: 'call-1', name: 'knowledge_annotation_write' }] }),
      expectedEvent: RESEARCH_RUN_EVENT.RUN_FAILED,
      expectedError: /cannot request tools/,
    },
  ]

  for (const item of cases) {
    const events = []
    await assert.rejects(executeKnowledgeReadRun({
      ...fixture.request,
      requestId: `${item.label}-request`,
      runId: `${item.label}-run`,
      toolId: KNOWLEDGE_TOOL_IDS.EXPLAIN,
      context: structuredClone(fixture.request.context),
      executeRun: runResearchAgent,
      providerRequest: item.providerRequest,
      onEvent: (event) => events.push(event),
    }), item.expectedError)
    assert.equal(events.at(-1).type, item.expectedEvent)
    assert.equal(events.some(({ type }) => type === RESEARCH_RUN_EVENT.RUN_COMPLETED), false)
  }

  const controller = new AbortController()
  controller.abort()
  const cancelledEvents = []
  await assert.rejects(executeKnowledgeReadRun({
    ...fixture.request,
    requestId: 'cancel-request',
    runId: 'cancel-run',
    toolId: KNOWLEDGE_TOOL_IDS.EXPLAIN,
    context: structuredClone(fixture.request.context),
    executeRun: runResearchAgent,
    providerRequest: async () => { throw new Error('must not run') },
    signal: controller.signal,
    onEvent: (event) => cancelledEvents.push(event),
  }), (error) => error.name === 'AbortError')
  assert.equal(cancelledEvents.at(-1).type, RESEARCH_RUN_EVENT.RUN_CANCELLED)
  assert.equal(cancelledEvents.some(({ type }) => type === RESEARCH_RUN_EVENT.RUN_COMPLETED), false)

  const invalidCompleted = consumeKnowledgeReadTerminalEvent(request(), {
    type: RESEARCH_RUN_EVENT.RUN_COMPLETED,
    runId: fixture.request.runId,
    result: { text: '' },
  })
  assert.equal(invalidCompleted.status, KNOWLEDGE_ACTION_STATUS.FAILED)
  assert.equal(isCompletedKnowledgeReadResult(invalidCompleted), false)
  assert.throws(() => requireCompletedKnowledgeReadText(invalidCompleted), /completed, non-empty/)
})

test('consumes replay cursor and preserves session/run/opaque Context through the existing handoff', () => {
  const readRequest = request()
  const result = normalizeKnowledgeReadCompletedResult(readRequest, {
    text: fixture.result.data.text,
    summary: fixture.result.summary,
  })
  const replay = consumeKnowledgeReadReplay(readRequest, [
    { cursor: 8, event: { type: RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, runId: readRequest.runId, delta: '该段证据' } },
    { cursor: 9, event: { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId: readRequest.runId, result } },
  ])
  assert.equal(replay.cursor, 9)
  assert.deepEqual(replay.output, fixture.result)

  const failed = consumeKnowledgeReadReplay(readRequest, [{
    cursor: 10,
    event: { type: RESEARCH_RUN_EVENT.RUN_FAILED, runId: readRequest.runId, error: { message: 'Provider failed.' } },
  }])
  assert.equal(failed.output.status, KNOWLEDGE_ACTION_STATUS.FAILED)
  assert.equal(isCompletedKnowledgeReadResult(failed.output), false)

  const cancelled = consumeKnowledgeReadReplay(readRequest, [{
    cursor: 11,
    event: { type: RESEARCH_RUN_EVENT.RUN_CANCELLED, runId: readRequest.runId, error: { name: 'AbortError', message: 'Stopped.' } },
  }])
  assert.equal(cancelled.output.status, KNOWLEDGE_ACTION_STATUS.CANCELLED)
  assert.equal(isCompletedKnowledgeReadResult(cancelled.output), false)

  const handoff = createKnowledgeSessionHandoff({
    sessionId: readRequest.sessionId,
    runId: readRequest.runId,
    cursor: replay.cursor,
    context: readRequest.context,
    sourceSurface: KNOWLEDGE_SURFACE.SIDEBAR,
    createdAt: '2026-08-11T00:00:00.000Z',
  })
  const resumed = consumeKnowledgeSessionHandoff(handoff, { surface: KNOWLEDGE_SURFACE.RESEARCH })
  assert.equal(resumed.sessionId, readRequest.sessionId)
  assert.equal(resumed.runId, readRequest.runId)
  assert.equal(resumed.cursor, 9)
  assert.deepEqual(resumed.context, readRequest.context)
  assert.equal(resumed.context.ownerExtension.opaque, true)
})
