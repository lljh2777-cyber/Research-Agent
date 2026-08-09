import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelResearchRun,
  executeResearchRun,
  getResearchRun,
  reattachResearchRun,
  readResearchRunEvents,
  setResearchRunExecutorForTests,
  setResearchRunTransportResolverForTests,
} from './client.js'
import { RESEARCH_RUN_EVENT } from './runProtocol.js'

test('keeps the UI behind a replaceable Research Runtime client boundary', async () => {
  const calls = []
  setResearchRunExecutorForTests(async (input) => {
    calls.push(input)
    return { result: { text: 'ok' } }
  })
  setResearchRunTransportResolverForTests(() => ({ available: false }))
  try {
    const result = await executeResearchRun({ runId: 'run-client' })
    assert.equal(result.result.text, 'ok')
    assert.equal(calls[0].runId, 'run-client')
  } finally {
    setResearchRunExecutorForTests()
    setResearchRunTransportResolverForTests()
  }
})

test('mirrors normalized events to the loopback buffer without changing executor output', async () => {
  const appended = []
  const transport = {
    available: true,
    create: async (input) => ({ created: true, run: input }),
    append: async (runId, events) => appended.push({ runId, events }),
    get: async (runId) => ({ run: { id: runId } }),
    events: async (runId, after) => ({ runId, after, events: [] }),
    cancel: async (runId) => ({ runId, cancelled: true }),
  }
  setResearchRunTransportResolverForTests(() => transport)
  setResearchRunExecutorForTests(async (input) => {
    input.onEvent({ type: RESEARCH_RUN_EVENT.RUN_STARTED, runId: input.runId })
    input.onEvent({ type: RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, runId: input.runId, delta: 'answer' })
    input.onEvent({ type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId: input.runId, iteration: 1 })
    return { result: { text: 'answer' } }
  })
  try {
    const output = await executeResearchRun({ runId: 'run-mirror', sessionId: 'research-1' })
    assert.equal(output.result.text, 'answer')
    assert.deepEqual(appended.flatMap((batch) => batch.events).map((event) => event.type), [
      RESEARCH_RUN_EVENT.RUN_STARTED,
      RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA,
      RESEARCH_RUN_EVENT.RUN_COMPLETED,
    ])
    assert.equal((await getResearchRun('run-mirror')).run.id, 'run-mirror')
    assert.equal((await readResearchRunEvents('run-mirror', 2)).after, 2)
    assert.equal((await reattachResearchRun('run-mirror', 2)).run.id, 'run-mirror')
    assert.equal((await cancelResearchRun('run-mirror')).cancelled, true)
  } finally {
    setResearchRunExecutorForTests()
    setResearchRunTransportResolverForTests()
  }
})

test('does not replay a delegated tool request that already has a completion event', async () => {
  let toolExecutions = 0
  const runId = 'run-replayed-tool'
  const envelopes = [
    { cursor: 1, event: { type: RESEARCH_RUN_EVENT.RUN_STARTED, runId } },
    { cursor: 2, event: { type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED, runId, requestId: 'tool-request-1', call: { id: 'call-1', name: 'vault_search' } } },
    { cursor: 3, event: { type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED, runId, requestId: 'tool-request-1' } },
    { cursor: 4, event: { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId, iteration: 2, result: { text: 'done' }, toolTrace: [] } },
  ]
  const transport = {
    available: true,
    create: async () => ({}),
    start: async () => ({ started: true }),
    events: async () => ({ events: envelopes, lastCursor: 4 }),
    follow: async () => { throw new Error('terminal replay should not open a stream') },
    submitToolResult: async () => ({}),
    cancel: async () => ({}),
  }
  setResearchRunTransportResolverForTests(() => transport)
  try {
    const output = await executeResearchRun({
      runId,
      execution: { kind: 'provider', messages: [] },
      executeTool: async () => { toolExecutions += 1 },
    })
    assert.equal(output.result.text, 'done')
    assert.equal(toolExecutions, 0)
  } finally {
    setResearchRunTransportResolverForTests()
  }
})

test('executes an unresolved delegated tool once and returns the streamed terminal result', async () => {
  const runId = 'run-live-tool'
  const submitted = []
  const sse = [
    `id: 3\nevent: tool.execution.completed\ndata: ${JSON.stringify({ cursor: 3, event: { type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED, runId, requestId: 'request-live' } })}\n\n`,
    `id: 4\nevent: run.completed\ndata: ${JSON.stringify({ cursor: 4, event: { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId, iteration: 2, result: { text: 'grounded' }, toolTrace: [] } })}\n\n`,
  ].join('')
  const transport = {
    available: true,
    create: async () => ({}),
    start: async () => ({ started: true }),
    events: async () => ({ events: [{ cursor: 2, event: { type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED, runId, requestId: 'request-live', call: { id: 'call-live', name: 'vault_search' } } }] }),
    follow: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    submitToolResult: async (...args) => { submitted.push(args); return { accepted: true } },
    cancel: async () => ({}),
  }
  setResearchRunTransportResolverForTests(() => transport)
  try {
    const output = await executeResearchRun({
      runId,
      execution: { kind: 'provider', messages: [] },
      executeTool: async (call) => ({ id: call.id, name: call.name, content: '{}', summary: 'ok', isError: false }),
    })
    assert.equal(output.result.text, 'grounded')
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0][1], 'request-live')
  } finally {
    setResearchRunTransportResolverForTests()
  }
})
