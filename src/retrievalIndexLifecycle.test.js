import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRetrievalIndexBuildInput,
  createRetrievalIndexIdentity,
  normalizeLifecycleResult,
  stableVectorNorm,
  validateEmbeddingDimensionProbe,
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

const twoChunkIndex = {
  schemaVersion: 2,
  kind: 'retrieval-index',
  identity,
  status: 'ready',
  staleReason: null,
  chunks: [
    { id: 'note::0', noteId: 'note', sourceId: 'source:note', path: 'note.md', ordinal: 0, heading: 'Methods' },
    { id: 'note::1', noteId: 'note', sourceId: 'source:note', path: 'note.md', ordinal: 1, heading: 'Results' },
  ],
}

function twoChunkEnvelope(vectors) {
  return {
    state: 'ready',
    identity,
    index: twoChunkIndex,
    vectors,
    provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' },
  }
}

const validTwoChunkVectors = [
  { chunkId: 'note::0', index: 0, vector: [0.1, 0.2] },
  { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] },
]

test('rejects the Integration reproductions: swapped bindings and zero-norm vectors', () => {
  assert.equal(validateReadyRetrievalIndex(twoChunkEnvelope(validTwoChunkVectors), identity).ok, true)
  const swapped = [
    { chunkId: 'note::0', index: 1, vector: [0.1, 0.2] },
    { chunkId: 'note::1', index: 0, vector: [0.3, 0.4] },
  ]
  assert.deepEqual(validateReadyRetrievalIndex(twoChunkEnvelope(swapped), identity), { ok: false, code: 'retrieval_index_invalid' })
  assert.deepEqual(validateReadyRetrievalIndex(twoChunkEnvelope([
    { chunkId: 'note::0', index: 0, vector: [0, 0] },
    { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] },
  ]), identity), { ok: false, code: 'retrieval_index_invalid' })
})

test('rejects every invalid one-to-one mapping and vector norm shape', () => {
  const cases = [
    ['duplicate chunk id', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }, { chunkId: 'note::0', index: 1, vector: [0.3, 0.4] }]],
    ['duplicate index', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }, { chunkId: 'note::1', index: 0, vector: [0.3, 0.4] }]],
    ['unknown chunk id', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }, { chunkId: 'unknown', index: 1, vector: [0.3, 0.4] }]],
    ['out of range index', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }, { chunkId: 'note::1', index: 2, vector: [0.3, 0.4] }]],
    ['unsafe index', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }, { chunkId: 'note::1', index: Number.MAX_SAFE_INTEGER + 1, vector: [0.3, 0.4] }]],
    ['fractional index', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }, { chunkId: 'note::1', index: 0.5, vector: [0.3, 0.4] }]],
    ['missing coverage', [{ chunkId: 'note::0', index: 0, vector: [0.1, 0.2] }]],
    ['empty vector', [{ chunkId: 'note::0', index: 0, vector: [] }, { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] }]],
    ['dimension mismatch', [{ chunkId: 'note::0', index: 0, vector: [0.1] }, { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] }]],
    ['NaN vector', [{ chunkId: 'note::0', index: 0, vector: [Number.NaN, 0.2] }, { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] }]],
    ['Infinity vector', [{ chunkId: 'note::0', index: 0, vector: [Number.POSITIVE_INFINITY, 0.2] }, { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] }]],
    ['zero vector', [{ chunkId: 'note::0', index: 0, vector: [0, 0] }, { chunkId: 'note::1', index: 1, vector: [0.3, 0.4] }]],
  ]
  for (const [label, vectors] of cases) {
    assert.deepEqual(validateReadyRetrievalIndex(twoChunkEnvelope(vectors), identity), { ok: false, code: 'retrieval_index_invalid' }, label)
  }
  assert.equal(Number.isFinite(stableVectorNorm([1e200, -1e200])), true)
  assert.equal(stableVectorNorm([0, 0]), null)
})

test('validates a single exact embedding dimension probe and rejects malformed or mismatched results', () => {
  const expected = { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' }
  const valid = {
    ok: true,
    ...expected,
    dimensions: 3,
    embeddings: [{ index: 0, vector: [0.1, -0.2, 0.3] }],
    provenance: expected,
  }
  assert.deepEqual(validateEmbeddingDimensionProbe(valid, expected), { ok: true, dimensions: 3 })
  const invalidCases = [
    ['missing', null, 'embedding_dimension_probe_failed'],
    ['provider mismatch', { ...valid, providerId: 'other' }, 'embedding_dimension_probe_mismatch'],
    ['model mismatch', { ...valid, modelId: 'other' }, 'embedding_dimension_probe_mismatch'],
    ['provenance mismatch', { ...valid, provenance: { ...expected, modelId: 'other' } }, 'embedding_dimension_probe_mismatch'],
    ['multiple embeddings', { ...valid, embeddings: [...valid.embeddings, { index: 1, vector: [0.1, 0.2, 0.3] }] }, 'embedding_dimension_probe_invalid'],
    ['wrong index', { ...valid, embeddings: [{ index: 1, vector: [0.1, 0.2, 0.3] }] }, 'embedding_dimension_probe_invalid'],
    ['dimension mismatch', { ...valid, embeddings: [{ index: 0, vector: [0.1, 0.2] }] }, 'embedding_dimension_probe_invalid'],
    ['dimension over bound', { ...valid, dimensions: 16_385 }, 'embedding_dimension_probe_invalid'],
    ['dimension string', { ...valid, dimensions: '3' }, 'embedding_dimension_probe_invalid'],
    ['NaN vector', { ...valid, embeddings: [{ index: 0, vector: [0.1, Number.NaN, 0.3] }] }, 'embedding_dimension_probe_invalid'],
    ['infinite vector', { ...valid, embeddings: [{ index: 0, vector: [0.1, Number.POSITIVE_INFINITY, 0.3] }] }, 'embedding_dimension_probe_invalid'],
    ['zero vector', { ...valid, embeddings: [{ index: 0, vector: [0, 0, 0] }] }, 'embedding_dimension_probe_invalid'],
  ]
  for (const [label, result, code] of invalidCases) {
    assert.deepEqual(validateEmbeddingDimensionProbe(result, expected), { ok: false, code }, label)
  }
  assert.deepEqual(validateEmbeddingDimensionProbe({ ok: false, code: 'authentication_failed' }, expected), { ok: false, code: 'authentication_failed' })
})
