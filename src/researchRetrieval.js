import { retrieveEvidence } from './retrieval.js'
import {
  EVIDENCE_PACKET_V2_MAX_EVIDENCE,
  migrateEvidencePacketV1,
  normalizeEvidencePacketV2,
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
    retrieval: { ...packet.retrieval, mode: 'hybrid', indexStatus: 'ready' },
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

export async function retrieveHybridEvidence(question, {
  lexicalIndex = null,
  retrievalIndex = null,
  runtime = null,
  topK = 6,
  signal,
  useVector = true,
  useReranker = false,
} = {}) {
  const boundedTopK = Math.min(EVIDENCE_PACKET_V2_MAX_EVIDENCE, Math.max(1, Number(topK) || 6))
  const { index, error: indexError } = normalizedIndex(retrievalIndex)
  const fallbackIndex = indexError ? null : index
  const lexical = migrateLexicalPacket(question, lexicalIndex, { topK: boundedTopK, index: fallbackIndex })

  if (indexError) return withError(lexical, indexError)
  if (!index) return withError(lexical, lexical.error || degradation(RETRIEVAL_DEGRADATION_CODES.INDEX_UNAVAILABLE, 'No Retrieval Index v2 is available.'))
  if (index.status === 'stale') return withError(lexical, degradation(RETRIEVAL_DEGRADATION_CODES.INDEX_STALE, `Retrieval Index is stale: ${index.staleReason}.`))
  if (!useVector) return lexical
  if (!index.identity.embedding.providerId) {
    return withError(lexical, degradation(RETRIEVAL_DEGRADATION_CODES.EMBEDDING_UNAVAILABLE, 'The Retrieval Index has no configured embedding capability.'))
  }
  if (signal?.aborted) return withError(lexical, degradation(RETRIEVAL_DEGRADATION_CODES.CANCELLED, 'Retrieval was cancelled.'))

  const embedding = capabilityFor(runtime, 'embedding')
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
