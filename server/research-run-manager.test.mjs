import assert from 'node:assert/strict'
import test from 'node:test'

import { RESEARCH_RUN_EVENT, RESEARCH_RUN_STATUS } from '../src/research/runProtocol.js'
import { ResearchRunManager } from './research-run-manager.mjs'

test('keeps an idempotent, cursor-addressable Research Run event history', () => {
  let timestamp = Date.parse('2026-08-09T00:00:00.000Z')
  const manager = new ResearchRunManager({ now: () => new Date(timestamp += 1000) })
  const created = manager.create({
    id: 'run-reconnect',
    sessionId: 'research-1',
    model: { modelId: 'test-model' },
    policy: { maxToolRounds: 4 },
    evidenceCount: 2,
  })

  assert.equal(created.created, true)
  assert.equal(manager.create({ id: 'run-reconnect' }).created, false)
  const appended = manager.append('run-reconnect', [
    { type: RESEARCH_RUN_EVENT.RUN_STARTED, iteration: 1, clientEventId: 'event-1' },
    { type: RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, delta: 'evidence', clientEventId: 'event-2' },
    { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, iteration: 1, clientEventId: 'event-3' },
  ])

  assert.equal(appended.accepted, 3)
  assert.equal(appended.run.status, RESEARCH_RUN_STATUS.COMPLETED)
  assert.equal(appended.lastCursor, 3)
  const replay = manager.eventsAfter('run-reconnect', 1)
  assert.deepEqual(replay.events.map((item) => item.cursor), [2, 3])
  assert.equal(replay.run.model.modelId, 'test-model')
  assert.equal(manager.append('run-reconnect', { type: RESEARCH_RUN_EVENT.RUN_FAILED }).accepted, 0)
})

test('deduplicates retried batches and reports a truncated replay window', () => {
  const manager = new ResearchRunManager({ maxEventsPerRun: 2 })
  manager.create({ id: 'run-bounded' })
  const started = { type: RESEARCH_RUN_EVENT.RUN_STARTED, clientEventId: 'stable-1' }
  assert.equal(manager.append('run-bounded', [started, started]).accepted, 1)
  manager.append('run-bounded', { type: RESEARCH_RUN_EVENT.MODEL_STARTED, iteration: 1, clientEventId: 'stable-2' })
  manager.append('run-bounded', { type: RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, delta: 'next', clientEventId: 'stable-3' })

  const replay = manager.eventsAfter('run-bounded', 0)
  assert.equal(replay.truncated, true)
  assert.equal(replay.oldestCursor, 2)
  assert.deepEqual(replay.events.map((item) => item.cursor), [2, 3])
})

test('cancels an active run through the same terminal event protocol', () => {
  const manager = new ResearchRunManager()
  manager.create({ id: 'run-cancel' })
  manager.append('run-cancel', { type: RESEARCH_RUN_EVENT.RUN_STARTED })
  const cancelled = manager.cancel('run-cancel')

  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.run.status, RESEARCH_RUN_STATUS.CANCELLED)
  assert.equal(manager.cancel('run-cancel').cancelled, false)
})

test('rejects illegal transitions and keeps waiting until every delegated tool result is recorded', () => {
  const manager = new ResearchRunManager()
  manager.create({ id: 'run-tool-round' })
  assert.throws(() => manager.append('run-tool-round', { type: RESEARCH_RUN_EVENT.RUN_COMPLETED }), /invalid while status is created/)

  manager.append('run-tool-round', { type: RESEARCH_RUN_EVENT.RUN_STARTED, clientEventId: 'start' })
  manager.append('run-tool-round', {
    type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
    clientEventId: 'request-1', requestId: 'request-1', call: { id: 'call-1', name: 'vault_search' },
  })
  manager.append('run-tool-round', {
    type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
    clientEventId: 'request-2', requestId: 'request-2', call: { id: 'call-2', name: 'web_search' },
  })
  manager.append('run-tool-round', { type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED, clientEventId: 'result-1', requestId: 'request-1' })
  assert.equal(manager.get('run-tool-round').run.status, RESEARCH_RUN_STATUS.WAITING_APPROVAL)

  manager.append('run-tool-round', { type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED, clientEventId: 'result-2', requestId: 'request-2' })
  assert.equal(manager.get('run-tool-round').run.status, RESEARCH_RUN_STATUS.RUNNING)
  assert.throws(() => manager.append('run-tool-round', {
    type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED, requestId: 'request-2', clientEventId: 'late-result',
  }), /invalid while status is running/)
})