import assert from 'node:assert/strict'
import test from 'node:test'
import { getResearchRunPresentation } from './runPresentation.js'

const packet = { evidence: [{ id: 'evidence-1' }] }

test('Research UI preserves cancelled terminal state instead of claiming a cited answer', () => {
  const presentation = getResearchRunPresentation({
    runStatus: 'cancelled',
    hasActivity: true,
    activeStage: 5,
    packet,
    answerMode: 'chatgpt',
  })

  assert.equal(presentation.agentLabel, 'Run cancelled')
  assert.equal(presentation.runDetail, 'Generation was cancelled. Any partial response is kept in the conversation.')
  assert.equal(presentation.progressLabel, 'Cancelled')
  assert.equal(presentation.answerDetail, 'Generation cancelled before answer completion')
  assert.notEqual(presentation.answerDetail, 'Cited answer generated')
  assert.notEqual(presentation.progress, 100)
})

test('Research UI preserves failed terminal state instead of claiming a completed run', () => {
  const presentation = getResearchRunPresentation({
    runStatus: 'failed',
    hasActivity: true,
    activeStage: 5,
    packet,
    answerMode: 'chatgpt',
  })

  assert.equal(presentation.agentLabel, 'Agent failed')
  assert.equal(presentation.runDetail, 'The answer model could not complete this run. Review the error and retry.')
  assert.equal(presentation.progressLabel, 'Failed')
  assert.equal(presentation.answerDetail, 'Answer generation failed')
  assert.notEqual(presentation.runDetail, 'Run complete')
  assert.notEqual(presentation.progress, 100)
})

test('Research UI reserves completion wording and 100 percent for completed runs', () => {
  const presentation = getResearchRunPresentation({
    runStatus: 'completed',
    hasActivity: true,
    activeStage: 5,
    packet,
    answerMode: 'chatgpt',
  })

  assert.equal(presentation.agentLabel, 'Agent ready')
  assert.equal(presentation.runDetail, 'Run complete')
  assert.equal(presentation.progressLabel, '100%')
  assert.equal(presentation.progress, 100)
  assert.equal(presentation.answerDetail, 'Cited answer generated')
})

test('Research UI keeps waiting-approval runs active instead of treating them as terminal', () => {
  const presentation = getResearchRunPresentation({
    runStatus: 'waiting-approval',
    running: true,
    hasActivity: true,
    activeStage: 2,
    packet,
  })

  assert.equal(presentation.agentLabel, 'Agent running')
  assert.equal(presentation.answerDetail, 'Agent working...')
  assert.notEqual(presentation.progress, 100)
})