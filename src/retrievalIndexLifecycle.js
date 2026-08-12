import { normalizeRetrievalIndexIdentity, normalizeRetrievalIndexV2 } from './retrievalContracts.js'

export const RETRIEVAL_INDEX_STATES = Object.freeze([
  'unavailable',
  'not-built',
  'building',
  'ready',
  'stale',
  'degraded',
  'failed',
  'cancelled',
])

export const RETRIEVAL_INDEX_REASON_MESSAGES = Object.freeze({
  missing_vault_revision: 'The current Vault has no authoritative revision.',
  no_embedding_model: 'Select an account-visible embedding model to build a vector index.',
  embedding_dimensions_unavailable: 'The selected embedding capability does not expose dimensions.',
  inspecting_embedding_dimensions: 'Inspecting embedding dimensions…',
  embedding_dimension_probe_failed: 'Embedding dimensions could not be inspected safely.',
  embedding_dimension_probe_mismatch: 'Embedding dimension inspection did not match the selected Provider and model.',
  embedding_dimension_probe_invalid: 'Embedding dimension inspection returned invalid vector metadata.',
  remote_consent_required: 'Consent is required before Vault chunks can be sent for remote embedding.',
  embedding_capability_unavailable: 'The selected embedding capability is unavailable.',
  vault_chunks_unavailable: 'Authoritative Vault chunks are unavailable for index construction.',
  identity_mismatch: 'The returned Retrieval Index identity did not match the current configuration.',
  schema_changed: 'The Retrieval Index schema changed.',
  vault_revision_changed: 'The Vault revision changed.',
  chunk_settings_changed: 'The chunk settings changed.',
  embedding_configuration_changed: 'The embedding configuration changed.',
  manual: 'The Retrieval Index requires an explicit rebuild.',
  cancelled: 'Index build was cancelled.',
  runtime_restarted: 'Index build was interrupted by a runtime restart.',
  storage_unavailable: 'Retrieval Index storage is unavailable.',
  storage_failed: 'Retrieval Index storage failed safely.',
  provider_unavailable: 'Embedding capability is unavailable.',
  authentication_failed: 'Embedding provider authentication failed.',
  rate_limited: 'Embedding provider rate limit was reached.',
  overloaded: 'Embedding provider is temporarily overloaded.',
  timeout: 'Embedding provider timed out.',
  network_error: 'Embedding provider could not be reached.',
  invalid_request: 'The Retrieval Index request was invalid.',
  malformed_response: 'Embedding provider returned a malformed response.',
  retrieval_index_invalid: 'Retrieval Index data failed validation.',
  provider_error: 'Embedding provider request failed.',
})

const SAFE_RUNTIME_CODES = new Set(Object.keys(RETRIEVAL_INDEX_REASON_MESSAGES))

function asReasonCode(value, fallback = 'provider_error') {
  const code = String(value || '').trim()
  return SAFE_RUNTIME_CODES.has(code) ? code : fallback
}

export function reasonMessage(code, fallback = 'Retrieval Index is unavailable.') {
  return RETRIEVAL_INDEX_REASON_MESSAGES[asReasonCode(code, fallback)] || fallback
}

export function safeLifecycleReason(result, fallback = null) {
  if (!result) return fallback
  if (result.staleReason) return asReasonCode(result.staleReason, 'manual')
  if (result.error?.code) return asReasonCode(result.error.code)
  return fallback
}

export function safeProgress(progress) {
  if (!progress || typeof progress !== 'object') return null
  const completed = Number(progress.completed)
  const total = Number(progress.total)
  const batches = Number(progress.batches)
  if (![completed, total, batches].every((value) => Number.isInteger(value) && value >= 0) || completed > total) return null
  return { completed, total, batches }
}

export function identitiesMatch(left, right) {
  try {
    return JSON.stringify(normalizeRetrievalIndexIdentity(left)) === JSON.stringify(normalizeRetrievalIndexIdentity(right))
  } catch {
    return false
  }
}

export function embeddingDimensions(model) {
  const candidates = [
    model?.dimensions,
    model?.embeddingDimensions,
    model?.capabilities?.dimensions,
    model?.capabilities?.embeddingDimensions,
  ]
  const value = candidates.find((candidate) => Number.isInteger(Number(candidate)) && Number(candidate) > 0 && Number(candidate) <= 16_384)
  return value === undefined ? null : Number(value)
}

export function createRetrievalIndexIdentity({ vaultId, vaultRevision, chunkSize, chunkOverlap, embeddingModel }) {
  if (!String(vaultId || '').trim() || !String(vaultRevision || '').trim()) return { ok: false, code: 'missing_vault_revision' }
  if (!embeddingModel) return { ok: false, code: 'no_embedding_model' }
  const dimensions = embeddingDimensions(embeddingModel)
  if (!dimensions) return { ok: false, code: 'embedding_dimensions_unavailable' }
  try {
    return {
      ok: true,
      identity: normalizeRetrievalIndexIdentity({
        schemaVersion: 2,
        vault: { id: String(vaultId), revision: String(vaultRevision) },
        chunking: {
          algorithm: 'section-window-v1',
          size: Number(chunkSize),
          overlap: Number(chunkOverlap),
        },
        embedding: {
          providerId: String(embeddingModel.providerId),
          modelId: String(embeddingModel.apiModelId || embeddingModel.id),
          dimensions,
        },
      }),
    }
  } catch {
    return { ok: false, code: 'invalid_request' }
  }
}

export function createRetrievalIndexBuildInput({ identity, retrievalIndex, remoteEmbeddingConsent, provider }) {
  if (!remoteEmbeddingConsent) return { ok: false, code: 'remote_consent_required' }
  if (!retrievalIndex || !Array.isArray(retrievalIndex.chunks) || !retrievalIndex.chunks.length) return { ok: false, code: 'vault_chunks_unavailable' }
  try {
    const normalizedIdentity = normalizeRetrievalIndexIdentity(identity)
    if (retrievalIndex.chunks.length > 100_000) throw new Error('chunk-bound')
    const chunks = retrievalIndex.chunks.map((chunk, index) => {
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      if (!text.trim() || new TextEncoder().encode(text).length > 16_384) throw new Error(`text-bound-${index}`)
      return {
        id: chunk.id,
        noteId: chunk.noteId,
        sourceId: chunk.sourceId,
        path: chunk.path,
        ordinal: chunk.ordinal,
        heading: chunk.heading || null,
      }
    })
    if (chunks.some((chunk) => !chunk.id || !chunk.noteId || !chunk.sourceId || !chunk.path || !Number.isInteger(chunk.ordinal))) throw new Error('invalid-chunk-identity')
    return {
      ok: true,
      input: {
        identity: normalizedIdentity,
        chunks,
        texts: retrievalIndex.chunks.map((chunk) => chunk.text),
        provider: provider || undefined,
      },
    }
  } catch {
    return { ok: false, code: 'vault_chunks_unavailable' }
  }
}

export function normalizeLifecycleResult(result, requestedIdentity, fallbackState = 'unavailable') {
  const state = RETRIEVAL_INDEX_STATES.includes(result?.state) ? result.state : fallbackState
  const identity = result?.identity && identitiesMatch(result.identity, requestedIdentity) ? result.identity : requestedIdentity || null
  const progress = safeProgress(result?.progress)
  const reason = safeLifecycleReason(result, state === 'stale' ? 'manual' : null)
  return {
    state,
    identity,
    progress,
    reason,
    message: reason ? reasonMessage(reason) : null,
    key: typeof result?.key === 'string' ? result.key : null,
  }
}

export function stableVectorNorm(vector) {
  if (!Array.isArray(vector) || !vector.length) return null
  let scale = 0
  let sumSquares = 1
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    const magnitude = Math.abs(value)
    if (magnitude === 0) continue
    if (magnitude > scale) {
      const ratio = scale === 0 ? 0 : scale / magnitude
      sumSquares = 1 + (sumSquares * ratio * ratio)
      scale = magnitude
    } else {
      const ratio = magnitude / scale
      sumSquares += ratio * ratio
    }
    if (!Number.isFinite(sumSquares)) return null
  }
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const norm = scale * Math.sqrt(sumSquares)
  return Number.isFinite(norm) && norm > 0 ? norm : null
}

export function validateEmbeddingDimensionProbe(result, { providerId, modelId } = {}) {
  if (!result || result.ok !== true) {
    return { ok: false, code: asReasonCode(result?.code || result?.error?.code, 'embedding_dimension_probe_failed') }
  }
  if (result.providerId !== providerId || result.modelId !== modelId
    || result.provenance?.providerId !== providerId || result.provenance?.modelId !== modelId) {
    return { ok: false, code: 'embedding_dimension_probe_mismatch' }
  }
  const dimensions = result.dimensions
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > 16_384
    || !Array.isArray(result.embeddings) || result.embeddings.length !== 1) {
    return { ok: false, code: 'embedding_dimension_probe_invalid' }
  }
  const embedding = result.embeddings[0]
  if (!embedding || !Number.isSafeInteger(embedding.index) || embedding.index !== 0
    || !Array.isArray(embedding.vector) || embedding.vector.length !== dimensions
    || stableVectorNorm(embedding.vector) === null) {
    return { ok: false, code: 'embedding_dimension_probe_invalid' }
  }
  return { ok: true, dimensions }
}

export function validateReadyRetrievalIndex(result, requestedIdentity) {
  if (result?.state !== 'ready' || !identitiesMatch(result.identity, requestedIdentity) || !Array.isArray(result.vectors)) {
    return { ok: false, code: result?.state === 'stale' ? safeLifecycleReason(result, 'manual') : 'identity_mismatch' }
  }
  try {
    const index = normalizeRetrievalIndexV2(result.index)
    if (index.status !== 'ready' || !identitiesMatch(index.identity, requestedIdentity) || result.vectors.length !== index.chunks.length) throw new Error('not-ready')
    if (!result.provenance || result.provenance.providerId !== requestedIdentity.embedding.providerId || result.provenance.modelId !== requestedIdentity.embedding.modelId) throw new Error('provenance-mismatch')
    const dimensions = requestedIdentity.embedding.dimensions
    const expectedIds = new Set(index.chunks.map((chunk) => chunk.id))
    const seenIds = new Set()
    const seenIndexes = new Set()
    for (const vector of result.vectors) {
      if (!vector || typeof vector !== 'object' || Array.isArray(vector)) throw new Error('invalid-vector')
      if (typeof vector.chunkId !== 'string' || !expectedIds.has(vector.chunkId) || seenIds.has(vector.chunkId)) throw new Error('invalid-vector')
      if (!Number.isSafeInteger(vector.index) || vector.index < 0 || vector.index >= index.chunks.length || seenIndexes.has(vector.index)) throw new Error('invalid-vector')
      if (index.chunks[vector.index].id !== vector.chunkId) throw new Error('invalid-vector')
      if (!Array.isArray(vector.vector) || vector.vector.length !== dimensions || stableVectorNorm(vector.vector) === null) throw new Error('invalid-vector')
      seenIds.add(vector.chunkId)
      seenIndexes.add(vector.index)
    }
    if (seenIds.size !== index.chunks.length || seenIndexes.size !== index.chunks.length) throw new Error('incomplete-vectors')
    return { ok: true, index, vectors: result.vectors }
  } catch {
    return { ok: false, code: 'retrieval_index_invalid' }
  }
}
