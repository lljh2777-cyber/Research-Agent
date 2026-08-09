import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RESEARCH_RUN_EVENT,
  RESEARCH_RUN_STATUS,
  applyResearchRunEvent,
  createResearchRunRecord,
  normalizeResearchRunPolicy,
} from './runProtocol.js'

test('normalizes bounded run policies without hard-coding a preset policy', () => {
  assert.deepEqual(normalizeResearchRunPolicy({
    maxToolRounds: 10,
    maxToolCallsPerRound: 99,
    requireEvidence: true,
    stopOnInsufficientEvidence: true,
  }), {
    maxToolRounds: 10,
    maxToolCallsPerRound: 16,
    requireEvidence: true,
    stopOnInsufficientEvidence: true,
  })
})

test('creates and advances a durable research run record from normalized events', () => {
  const run = createResearchRunRecord({
    id: 'run-1',
    sessionId: 'research-1',
    createdAt: '2026-08-09T00:00:00.000Z',
    model: { modelId: 'test-model' },
    executionOwner: 'loopback',
  })
  const started = applyResearchRunEvent(run, {
    type: RESEARCH_RUN_EVENT.RUN_STARTED,
    runId: 'run-1',
    iteration: 1,
  }, { now: '2026-08-09T00:00:01.000Z' })
  const completed = applyResearchRunEvent(started, {
    type: RESEARCH_RUN_EVENT.RUN_COMPLETED,
    runId: 'run-1',
    iteration: 3,
  }, { now: '2026-08-09T00:00:03.000Z' })

  assert.equal(started.status, RESEARCH_RUN_STATUS.RUNNING)
  assert.equal(run.executionOwner, 'loopback')
  assert.equal(completed.status, RESEARCH_RUN_STATUS.COMPLETED)
  assert.equal(completed.iteration, 3)
  assert.equal(completed.completedAt, '2026-08-09T00:00:03.000Z')
})

test('tracks delegated browser tool approval without treating it as a terminal state', () => {
  const run = createResearchRunRecord({ id: 'run-tool-status' })
  const started = applyResearchRunEvent(run, { type: RESEARCH_RUN_EVENT.RUN_STARTED, runId: run.id })
  const waiting = applyResearchRunEvent(started, {
    type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
    runId: run.id,
    requestId: 'request-1',
    call: { id: 'call-1', name: 'vault_search' },
  })
  const resumed = applyResearchRunEvent(waiting, {
    type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED,
    runId: run.id,
    requestId: 'request-1',
  })

  assert.equal(waiting.status, RESEARCH_RUN_STATUS.WAITING_APPROVAL)
  assert.equal(resumed.status, RESEARCH_RUN_STATUS.RUNNING)
  assert.equal(resumed.completedAt, null)
})

test('rejects illegal transitions and preserves a terminal record', () => {
  const created = createResearchRunRecord({ id: 'run-transitions' })
  const illegalCompletion = applyResearchRunEvent(created, { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId: created.id })
  assert.equal(illegalCompletion, created)

  const started = applyResearchRunEvent(created, { type: RESEARCH_RUN_EVENT.RUN_STARTED, runId: created.id })
  const completed = applyResearchRunEvent(started, { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId: created.id, iteration: 1 })
  const afterTerminal = applyResearchRunEvent(completed, { type: RESEARCH_RUN_EVENT.RUN_STARTED, runId: created.id })

  assert.equal(completed.status, RESEARCH_RUN_STATUS.COMPLETED)
  assert.equal(afterTerminal, completed)
})
