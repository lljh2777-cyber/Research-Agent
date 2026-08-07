import assert from 'node:assert/strict'
import test from 'node:test'

import { executePipeline, PIPELINE_TEMPLATES } from './pipelineEngine.js'

const notes = [
  { id: 'CellChat.md', title: 'CellChat', type: 'method', body: 'communication', frontmatter: { type: 'method' } },
  { id: 'Niche.md', title: 'Spatial niche', type: 'concept', body: 'niche', frontmatter: {} },
  { id: 'Orphan.md', title: 'Orphan', type: 'paper', body: 'paper', frontmatter: { type: 'paper' } },
]
const edges = [
  { source: notes[0], target: notes[1] },
  { source: notes[0], target: notes[1] },
  { source: notes[0], target: { title: 'Missing', path: 'Missing', missing: true } },
]
const context = {
  vaultName: 'test-vault',
  notes,
  vaultIndex: { edges },
  retrievalIndex: { chunks: [{}, {}, {}], averageLength: 14, graph: new Map([[notes[0].id, new Set([notes[1].id])], [notes[1].id, new Set([notes[0].id])], [notes[2].id, new Set()]]) },
  chunkSize: 1200,
}

test('all local pipeline templates execute into serializable completed runs', () => {
  for (const pipeline of PIPELINE_TEMPLATES) {
    const run = executePipeline(pipeline.id, context, { id: `test-${pipeline.id}`, startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z' })
    assert.equal(run.status, 'completed')
    assert.equal(run.steps.length, pipeline.stages.length)
    assert(run.metrics.length >= 4)
    assert(run.findings.length > 0)
    assert.doesNotThrow(() => JSON.stringify(run))
  }
})

test('pipeline execution requires a connected Vault', () => {
  assert.throws(() => executePipeline('vault-integrity-audit', { notes: [] }), /Connect a Vault/)
})

test('link health metrics ignore duplicate source-target relationships', () => {
  const run = executePipeline('vault-integrity-audit', context)
  assert.equal(run.metrics.find((metric) => metric.label === 'Resolved').value, 1)
  assert.equal(run.metrics.find((metric) => metric.label === 'Unresolved').value, 1)
})
