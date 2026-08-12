import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRetrievalIndexBuildInput,
  createRetrievalIndexIdentity,
  normalizeLifecycleResult,
  validateReadyRetrievalIndex,
} from './retrievalIndexLifecycle.js'

const model = {
  id: 'siliconflow:BAAI/bge-m3',
  apiModelId: 'BAAI/bge-m3',
  providerId: 'siliconflow',
  name: 'BAAI/bge-m3',
  dimensions: 2,
}

const identity = createRetrievalIndexIdentity({
  vaultId: 'vault-1',
  vaultRevision: 'rev-1',
  chunkSize: 900,
  chunkOverlap: 120,
  embeddingModel: model,
}).identity

const lexicalIndex = {
  chunks: [{ id: 'note::0', noteId: 'note', sourceId: 'source:note', path: 'note.md', ordinal: 0, heading: 'Methods', text: 'bounded Vault text' }],
}

test('creates exact identity only when authoritative revision and dimensions exist', () => {
  assert.equal(createRetrievalIndexIdentity({ vaultId: 'vault-1', vaultRevision: '', chunkSize: 900, chunkOverlap: 120, embeddingModel: model }).code, 'missing_vault_revision')
  assert.equal(createRetrievalIndexIdentity({ vaultId: 'vault-1', vaultRevision: 'rev-1', chunkSize: 900, chunkOverlap: 120, embeddingModel: { ...model, dimensions: null } }).code, 'embedding_dimensions_unavailable')
  assert.deepEqual(identity.embedding, { providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dimensions: 2 })
})

test('build input is consent-gated, bounded, and strips text from chunk identities', () => {
  assert.equal(createRetrievalIndexBuildInput({ identity, retrievalIndex: lexicalIndex, remoteEmbeddingConsent: false }).code, 'remote_consent_required')
  const result = createRetrievalIndexBuildInput({ identity, retrievalIndex: lexicalIndex, remoteEmbeddingConsent: true, provider: { endpoint: 'https://example.invalid', apiKey: 'session-only' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.input.chunks[0], { id: 'note::0', noteId: 'note', sourceId: 'source:note', path: 'note.md', ordinal: 0, heading: 'Methods' })
  assert.deepEqual(result.input.texts, ['bounded Vault text'])
  assert.equal(result.input.provider.apiKey, 'session-only')
})

test('normalizes safe lifecycle states without exposing raw runtime errors', () => {
  const view = normalizeLifecycleResult({ state: 'building', progress: { completed: 1, total: 3, batches: 1 } }, identity)
  assert.deepEqual(view.progress, { completed: 1, total: 3, batches: 1 })
  assert.equal(view.message, null)
  const failed = normalizeLifecycleResult({ state: 'failed', error: { code: 'secret-provider-stack' } }, identity)
  assert.equal(failed.reason, 'provider_error')
  assert.equal(failed.message, 'Embedding provider request failed.')
  for (const state of ['unavailable', 'not-built', 'building', 'ready', 'stale', 'degraded', 'failed', 'cancelled']) {
    assert.equal(normalizeLifecycleResult({ state }, identity).state, state)
  }
})

test('accepts only exact ready vectors and rejects stale or incomplete reads', () => {
  const index = { schemaVersion: 2, kind: 'retrieval-index', identity, status: 'ready', staleReason: null, chunks: [{ id: 'note::0', noteId: 'note', sourceId: 'source:note', path: 'note.md', ordinal: 0, heading: 'Methods' }] }
  const ready = validateReadyRetrievalIndex({ state: 'ready', identity, index, vectors: [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }], provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' } }, identity)
  assert.equal(ready.ok, true)
  assert.equal(validateReadyRetrievalIndex({ state: 'ready', identity, index, vectors: [], provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' } }, identity).code, 'retrieval_index_invalid')
  assert.equal(validateReadyRetrievalIndex({ state: 'stale', identity, staleReason: 'vault_revision_changed', index: { ...index, status: 'stale', staleReason: 'vault_revision_changed' }, vectors: [] }, identity).code, 'vault_revision_changed')
  assert.equal(validateReadyRetrievalIndex({ state: 'ready', identity, index, vectors: [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }], provenance: { providerId: 'other', modelId: 'BAAI/bge-m3' } }, identity).code, 'retrieval_index_invalid')
})
