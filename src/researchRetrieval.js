import { retrieveEvidence } from './retrieval.js'
import {
  EVIDENCE_PACKET_V2_MAX_EVIDENCE,
  migrateEvidencePacketV1,
  normalizeEvidencePacketV2,
  normalizeRetrievalIndexIdentity,
  normalizeRetrievalIndexV2,
} from './retrievalContracts.js'

export const RETRIEVAL_DEGRADATION_CODES = Object.freeze({
  INDEX_UNAVAILABLE: 'retrieval_index_unavailable',
  INDEX_STALE: 'retrieval_index_stale',
  INDEX_INVALID: 'retrieval_index_invalid',
  EMBEDDING_UNAVAILABLE: 'embedding_unavailable',
  EMBEDDING_FAILED: 'embedding_failed',
  EMBEDDING_INVALID: 'embedding_invalid_response',
  RERANK_UNAVAILABLE: 'rerank_unavailable',
  RERANK_FAILED: 'rerank_failed',
  RERANK_INVALID: 'rerank_invalid_response',
  CANCELLED: 'retrieval_cancelled',
  VECTOR_INDEX_UNAVAILABLE: 'vector_index_unavailable',
  VECTOR_INDEX_STALE: 'vector_index_stale',
  VECTOR_INDEX_DEGRADED: 'vector_index_degraded',
  VECTOR_INDEX_FAILED: 'vector_index_failed',
  VECTOR_INDEX_CANCELLED: 'vector_index_cancelled',
  VECTOR_INDEX_MISMATCH: 'vector_index_identity_mismatch',
  VECTOR_INDEX_CORRUPT: 'vector_index_corrupt',
  VECTOR_QUERY_INVALID: 'vector_query_invalid',
  VECTOR_PROVENANCE_MISMATCH: 'vector_provenance_mismatch',
})

const MAX_VECTOR_SCORES = EVIDENCE_PACKET_V2_MAX_EVIDENCE * 8

function degradation(code, message) {
  return { code, message }
}

function isAbortError(error, signal) {
  return Boolean(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR')
}

function capabilityFor(runtime, operation) {
  const capability = runtime?.[operation] || runtime?.capabilities?.[operation] || null
  const operationMethod = operation === 'embedding' ? capability?.embed : capability?.rerank
  const execute = capability?.run || capability?.execute || operationMethod || capability?.[operation]
  return { capability, execute: typeof execute === 'function' ? execute : null }
}

function sameIdentity(left, right) {
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right)
}

function vectorIndexStateError(state) {
  if (state === 'stale') return RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_STALE
  if (state === 'degraded') return RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_DEGRADED
  if (state === 'failed') return RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_FAILED
  if (state === 'cancelled') return RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_CANCELLED
  return RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_UNAVAILABLE
}

function normalizeVectorIndexPayload(payload, requestedIdentity) {
  if (!payload) return { ok: false, error: null, absent: true }
  const state = payload.state || payload.index?.status || payload.retrievalIndex?.status || 'unavailable'
  if (state !== 'ready') {
    return {
      ok: false,
      error: degradation(vectorIndexStateError(state), `Runtime Retrieval Index vectors are not ready (${state}).`),
    }
  }

  const rawIndex = payload.index || payload.retrievalIndex
  const rawVectors = payload.vectors
  try {
    const identity = normalizeRetrievalIndexV2(rawIndex).identity
    const index = normalizeRetrievalIndexV2(rawIndex)
    if (payload.identity && !sameIdentity(normalizeRetrievalIndexIdentity(payload.identity), identity)) {
      return {
        ok: false,
        error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_MISMATCH, 'Runtime Retrieval Index outer identity does not match the v2 index identity.'),
      }
    }
    const requested = requestedIdentity ? normalizeRetrievalIndexV2({
      schemaVersion: 2,
      kind: 'retrieval-index',
      identity: requestedIdentity,
      status: 'ready',
      staleReason: null,
      chunks: index.chunks,
    }).identity : identity
    if (!sameIdentity(identity, requested)) {
      return {
        ok: false,
        error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_MISMATCH, 'Runtime Retrieval Index identity does not match the requested identity.'),
      }
    }
    if (!Array.isArray(rawVectors) || rawVectors.length !== index.chunks.length) throw new TypeError('Vector count does not match Retrieval Index chunks.')
    const dimensions = identity.embedding.dimensions
    if (!Number.isInteger(dimensions) || dimensions < 1) throw new TypeError('Retrieval Index embedding dimensions are invalid.')
    const chunkIds = new Set(index.chunks.map((chunk) => chunk.id))
    const indexes = new Set()
    const ids = new Set()
    const vectors = rawVectors.map((record, position) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError(`Vector ${position} is invalid.`)
      const keys = Object.keys(record).sort().join('|')
      if (keys !== 'chunkId|index|vector') throw new TypeError(`Vector ${position} has unexpected keys.`)
      if (typeof record.chunkId !== 'string' || !chunkIds.has(record.chunkId)) throw new TypeError(`Vector ${position} has an unknown chunk identity.`)
      if (!Number.isInteger(record.index) || record.index < 0 || record.index >= index.chunks.length) throw new TypeError(`Vector ${position} has an invalid index.`)
      if (ids.has(record.chunkId) || indexes.has(record.index)) throw new TypeError('Vector chunk ids and indexes must be unique.')
      if (index.chunks[record.index].id !== record.chunkId) throw new TypeError('Vector index does not bind to its chunk identity.')
      if (!Array.isArray(record.vector) || record.vector.length !== dimensions || record.vector.some((item) => !Number.isFinite(item))) throw new TypeError(`Vector ${position} has invalid dimensions.`)
      ids.add(record.chunkId)
      indexes.add(record.index)
      const values = record.vector.map(Number)
      const norm = Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0))
      if (!Number.isFinite(norm) || norm === 0) throw new TypeError(`Vector ${position} has a zero or invalid norm.`)
      return { chunkId: record.chunkId, index: record.index, vector: values, norm }
    })
    const provenance = payload.provenance
    if (!provenance || provenance.providerId !== identity.embedding.providerId || provenance.modelId !== identity.embedding.modelId) {
      return {
        ok: false,
        error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_PROVENANCE_MISMATCH, 'Runtime Retrieval Index vector provenance does not match its embedding identity.'),
      }
    }
    return { ok: true, identity, index, vectors, dimensions }
  } catch (error) {
    return {
      ok: false,
      error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_INDEX_CORRUPT, error.message || 'Runtime Retrieval Index vectors failed Core validation.'),
    }
  }
}

function normalizeQueryEmbedding(payload, identity) {
  if (!payload || payload.ok === false) return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.EMBEDDING_FAILED, payload?.error || 'Runtime query embedding failed.') }
  const providerId = payload.providerId
  const modelId = payload.modelId
  if (providerId !== identity.embedding.providerId || modelId !== identity.embedding.modelId) {
    return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_PROVENANCE_MISMATCH, 'Query embedding provenance does not match the ready Retrieval Index identity.') }
  }
  if (!payload.provenance || payload.provenance.providerId !== providerId || payload.provenance.modelId !== modelId) {
    return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_PROVENANCE_MISMATCH, 'Query embedding provenance is inconsistent.') }
  }
  const embeddings = payload.embeddings
  const dimensions = identity.embedding.dimensions
  if (!Number.isSafeInteger(payload.dimensions) || payload.dimensions <= 0 || payload.dimensions !== dimensions) return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_QUERY_INVALID, 'Query embedding dimensions must be a positive safe integer matching the ready Retrieval Index.') }
  if (!Array.isArray(embeddings) || embeddings.length !== 1 || !embeddings[0] || embeddings[0].index !== 0 || !Array.isArray(embeddings[0].vector) || embeddings[0].vector.length !== dimensions || embeddings[0].vector.some((item) => !Number.isFinite(item))) {
    return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_QUERY_INVALID, 'Runtime query embedding must contain one finite vector with the exact index dimensions.') }
  }
  const vector = embeddings[0].vector.map(Number)
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0))
  if (!Number.isFinite(norm) || norm === 0) return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_QUERY_INVALID, 'Runtime query embedding has a zero or invalid norm.') }
  return { ok: true, vector, norm }
}

function cosineVectorScores(query, vectors) {
  const scores = new Map()
  for (const item of vectors) {
    const dot = item.vector.reduce((sum, value, index) => sum + (value * query.vector[index]), 0)
    const cosine = dot / (item.norm * query.norm)
    if (!Number.isFinite(cosine)) return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.VECTOR_QUERY_INVALID, 'Cosine scoring produced a non-finite value.') }
    scores.set(item.chunkId, Number(((cosine + 1) / 2).toFixed(6)))
  }
  return { ok: true, scores }
}

function normalizeScores(payload) {
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.scores)
      ? payload.scores
      : Array.isArray(payload?.results)
        ? payload.results
        : null
  if (!values || values.length > MAX_VECTOR_SCORES) return null

  const scores = new Map()
  for (const value of values) {
    const chunkId = String(value?.chunkId || value?.id || '').trim()
    const score = Number(value?.score)
    if (!chunkId || !Number.isFinite(score) || score < 0 || score > 1 || scores.has(chunkId)) continue
    scores.set(chunkId, Number(score.toFixed(6)))
  }
  return scores.size ? scores : null
}

function normalizedIndex(retrievalIndex) {
  if (!retrievalIndex) return { index: null, error: null }
  try {
    return { index: normalizeRetrievalIndexV2(retrievalIndex), error: null }
  } catch (error) {
    return {
      index: null,
      error: degradation(RETRIEVAL_DEGRADATION_CODES.INDEX_INVALID, error.message || 'Retrieval Index v2 is invalid.'),
    }
  }
}

function migrateLexicalPacket(question, lexicalIndex, { topK, index, error = null } = {}) {
  const rawPacket = retrieveEvidence(lexicalIndex, question, { topK, similarityThreshold: 0 })
  const indexStatus = index?.status || 'unavailable'
  const packet = migrateEvidencePacketV1(rawPacket, {
    indexIdentity: index?.identity || undefined,
    indexStatus,
    staleReason: index?.staleReason || undefined,
  })
  return normalizeEvidencePacketV2({
    ...packet,
    retrieval: { ...packet.retrieval, mode: 'lexical', indexStatus },
    error: error || packet.error,
  })
}

function withError(packet, error) {
  return normalizeEvidencePacketV2({ ...packet, error })
}

function hybridPacket(packet, scores, { rerankScores = null, error = null } = {}) {
  const ranked = packet.evidence
    .map((item) => {
      const vector = scores.get(item.chunkId) ?? null
      const lexical = item.scoreProvenance.lexical ?? item.scoreProvenance.final
      const fusion = vector === null ? lexical : (lexical * 0.6) + (vector * 0.4)
      const rerank = rerankScores?.get(item.chunkId) ?? null
      return {
        ...item,
        scoreProvenance: {
          ...item.scoreProvenance,
          vector,
          fusion: Number(fusion.toFixed(6)),
          rerank,
          final: rerank ?? Number(fusion.toFixed(6)),
        },
      }
    })
    .sort((left, right) => right.scoreProvenance.final - left.scoreProvenance.final || left.chunkId.localeCompare(right.chunkId))
    .slice(0, packet.retrieval.topK)

  return normalizeEvidencePacketV2({
    ...packet,
    retrieval: { ...packet.retrieval, mode: ranked.length ? 'hybrid' : 'lexical', indexStatus: 'ready' },
    evidence: ranked,
    error,
  })
}

function candidatePayload(packet, scores) {
  return packet.evidence.map((item) => ({
    chunkId: item.chunkId,
    excerpt: item.excerpt,
    lexicalScore: item.scoreProvenance.lexical ?? item.scoreProvenance.final,
    vectorScore: scores.get(item.chunkId) ?? null,
  }))
}

async function executeCapability({ capability, execute, input, unavailableCode, unavailableMessage, failedCode, invalidCode, signal }) {
  if (capability?.available !== true || !execute) return { ok: false, error: degradation(unavailableCode, capability?.reason || unavailableMessage) }
  try {
    const result = await execute(input)
    if (result?.ok === false) return { ok: false, error: degradation(result.code || failedCode, result.error || result.message || unavailableMessage) }
    const scores = normalizeScores(result)
    if (!scores) return { ok: false, error: degradation(invalidCode, 'Runtime returned no bounded retrieval scores.') }
    return { ok: true, scores }
  } catch (error) {
    if (isAbortError(error, signal)) return { ok: false, cancelled: true, error: degradation(RETRIEVAL_DEGRADATION_CODES.CANCELLED, 'Retrieval was cancelled.') }
    return { ok: false, error: degradation(failedCode, error?.message || unavailableMessage) }
  }
}

async function executeQueryEmbedding({ capability, execute, input, identity, signal }) {
  if (capability?.available !== true || !execute) {
    return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.EMBEDDING_UNAVAILABLE, capability?.reason || 'Runtime embedding capability is unavailable.') }
  }
  try {
    const result = await execute(input)
    if (result?.ok === false) return { ok: false, error: degradation(result.code || RETRIEVAL_DEGRADATION_CODES.EMBEDDING_FAILED, result.error || result.message || 'Runtime query embedding failed.') }
    return normalizeQueryEmbedding(result, identity)
  } catch (error) {
    if (isAbortError(error, signal)) return { ok: false, error: degradation(RETRIEVAL_DEGRADATION_CODES.CANCELLED, 'Retrieval was cancelled.') }
    return { ok: false, error: degradation(error?.code || RETRIEVAL_DEGRADATION_CODES.EMBEDDING_FAILED, error?.message || 'Runtime query embedding failed.') }
  }
}

export async function retrieveHybridEvidence(question, {
  lexicalIndex = null,
  retrievalIndex = null,
  vectorIndex = null,
  requestedIndexIdentity = null,
  runtime = null,
  topK = 6,
  signal,
  useVector = true,
  useReranker = false,
} = {}) {
  const boundedTopK = Math.min(EVIDENCE_PACKET_V2_MAX_EVIDENCE, Math.max(1, Number(topK) || 6))
  const readyVector = vectorIndex
    ? normalizeVectorIndexPayload(vectorIndex, requestedIndexIdentity || retrievalIndex?.identity)
    : { ok: false, absent: true, error: null }
  const vectorIndexError = useVector && !readyVector.absent && !readyVector.ok ? readyVector.error : null
  const sourceIndex = retrievalIndex || (readyVector.ok ? readyVector.index : null)
  const { index, error: indexError } = normalizedIndex(sourceIndex)
  const fallbackIndex = indexError ? null : index
  const lexical = migrateLexicalPacket(question, lexicalIndex, { topK: boundedTopK, index: fallbackIndex })

  if (indexError) return withError(lexical, indexError)
  if (vectorIndexError) return withError(lexical, vectorIndexError)
  if (!index) return withError(lexical, lexical.error || degradation(RETRIEVAL_DEGRADATION_CODES.INDEX_UNAVAILABLE, 'No Retrieval Index v2 is available.'))
  if (index.status === 'stale') return withError(lexical, degradation(RETRIEVAL_DEGRADATION_CODES.INDEX_STALE, `Retrieval Index is stale: ${index.staleReason}.`))
  if (!useVector) return lexical
  if (!index.identity.embedding.providerId) {
    return withError(lexical, degradation(RETRIEVAL_DEGRADATION_CODES.EMBEDDING_UNAVAILABLE, 'The Retrieval Index has no configured embedding capability.'))
  }
  if (signal?.aborted) return withError(lexical, degradation(RETRIEVAL_DEGRADATION_CODES.CANCELLED, 'Retrieval was cancelled.'))

  const embedding = capabilityFor(runtime, 'embedding')
  if (readyVector.ok) {
    const queryEmbedding = await executeQueryEmbedding({
      ...embedding,
      input: { query: String(question || ''), indexIdentity: readyVector.identity, signal },
      identity: readyVector.identity,
      signal,
    })
    if (!queryEmbedding.ok) return withError(lexical, queryEmbedding.error)
    const vectorScores = cosineVectorScores(queryEmbedding, readyVector.vectors)
    if (!vectorScores.ok) return withError(lexical, vectorScores.error)
    let packet = hybridPacket(lexical, vectorScores.scores)
    if (!useReranker) return packet

    const rerank = capabilityFor(runtime, 'rerank')
    const rerankResult = await executeCapability({
      ...rerank,
      input: { query: String(question || ''), candidates: candidatePayload(packet, vectorScores.scores), signal },
      unavailableCode: RETRIEVAL_DEGRADATION_CODES.RERANK_UNAVAILABLE,
      unavailableMessage: 'Runtime reranker capability is unavailable.',
      failedCode: RETRIEVAL_DEGRADATION_CODES.RERANK_FAILED,
      invalidCode: RETRIEVAL_DEGRADATION_CODES.RERANK_INVALID,
      signal,
    })
    if (!rerankResult.ok) {
      if (rerankResult.cancelled) return withError(lexical, rerankResult.error)
      return withError(packet, rerankResult.error)
    }
    packet = hybridPacket(packet, vectorScores.scores, { rerankScores: rerankResult.scores })
    return packet
  }

  const embeddingResult = await executeCapability({
    ...embedding,
    input: { query: String(question || ''), indexIdentity: index.identity, signal },
    unavailableCode: RETRIEVAL_DEGRADATION_CODES.EMBEDDING_UNAVAILABLE,
    unavailableMessage: 'Runtime embedding capability is unavailable.',
    failedCode: RETRIEVAL_DEGRADATION_CODES.EMBEDDING_FAILED,
    invalidCode: RETRIEVAL_DEGRADATION_CODES.EMBEDDING_INVALID,
    signal,
  })
  if (!embeddingResult.ok) return withError(lexical, embeddingResult.error)

  let packet = hybridPacket(lexical, embeddingResult.scores)
  if (!useReranker) return packet

  const rerank = capabilityFor(runtime, 'rerank')
  const rerankResult = await executeCapability({
    ...rerank,
    input: { query: String(question || ''), candidates: candidatePayload(packet, embeddingResult.scores), signal },
    unavailableCode: RETRIEVAL_DEGRADATION_CODES.RERANK_UNAVAILABLE,
    unavailableMessage: 'Runtime reranker capability is unavailable.',
    failedCode: RETRIEVAL_DEGRADATION_CODES.RERANK_FAILED,
    invalidCode: RETRIEVAL_DEGRADATION_CODES.RERANK_INVALID,
    signal,
  })
  if (!rerankResult.ok) {
    if (rerankResult.cancelled) return withError(lexical, rerankResult.error)
    return withError(packet, rerankResult.error)
  }
  packet = hybridPacket(packet, embeddingResult.scores, { rerankScores: rerankResult.scores })
  return packet
}

export function validateCitationIndices(packet, citations) {
  const normalized = normalizeEvidencePacketV2(packet)
  if (citations === undefined || citations === null || !Array.isArray(citations) || citations.length === 0) {
    return { valid: false, code: 'citations_missing', message: 'Answer citations are missing.' }
  }
  if (!normalized.evidence.length) {
    return { valid: false, code: 'no_evidence', message: 'Citations cannot be validated without evidence.' }
  }

  const seen = new Set()
  for (const citation of citations) {
    if (!Number.isInteger(citation) || citation < 1 || citation > normalized.evidence.length) {
      return { valid: false, code: 'citation_out_of_range', message: 'A citation index is outside the Evidence Packet.' }
    }
    if (seen.has(citation)) {
      return { valid: false, code: 'citation_duplicate', message: 'An answer citation index is duplicated.' }
    }
    seen.add(citation)
  }
  return { valid: true, indices: [...seen] }
}
