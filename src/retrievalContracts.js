export const RETRIEVAL_INDEX_V2_SCHEMA_VERSION = 2
export const EVIDENCE_PACKET_V2_SCHEMA_VERSION = 2

export const RETRIEVAL_INDEX_V2_MAX_CHUNKS = 100_000
export const EVIDENCE_PACKET_V2_MAX_EVIDENCE = 50
export const RETRIEVAL_ID_MAX_LENGTH = 512
export const RETRIEVAL_PATH_MAX_BYTES = 1_024
export const RETRIEVAL_EXCERPT_MAX_BYTES = 16_384

const INDEX_KIND = 'retrieval-index'
const PACKET_KIND = 'evidence-packet'
const INDEX_STATUSES = new Set(['ready', 'stale'])
const PACKET_INDEX_STATUSES = new Set(['ready', 'stale', 'unavailable'])
const STALE_REASONS = new Set([
  'vault_revision_changed',
  'chunk_settings_changed',
  'embedding_configuration_changed',
  'schema_changed',
  'manual',
])
const RELATIONSHIPS = new Set(['direct', 'wikilink', 'vector', 'fused', 'reranked'])
const SCORE_FIELDS = ['lexical', 'vector', 'graph', 'fusion', 'rerank', 'final']

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new TypeError(message)
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`)
  return value
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected or missing keys.`)
  }
}

function requireString(value, label, { maxLength = RETRIEVAL_ID_MAX_LENGTH, maxBytes = null } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string.`)
  if (value.length > maxLength) fail(`${label} exceeds its character bound.`)
  if (maxBytes !== null && utf8ByteLength(value) > maxBytes) fail(`${label} exceeds its UTF-8 bound.`)
  return value
}

function optionalString(value, label, options = {}) {
  if (value === null) return null
  return requireString(value, label, options)
}

function requireInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${label} must be an integer in range.`)
  return value
}

function requireScore(value, label, { nullable = true } = {}) {
  if (value === null && nullable) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite score from 0 to 1 or null.`)
  }
  return Number(value.toFixed(6))
}

function requireUniqueStrings(value, label, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} must be a bounded array.`)
  const values = value.map((item, index) => requireString(item, `${label}[${index}]`))
  if (new Set(values).size !== values.length) fail(`${label} must contain unique values.`)
  return values
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).length
}

export function normalizeScoreProvenance(value) {
  const input = requireRecord(value, 'scoreProvenance')
  requireExactKeys(input, SCORE_FIELDS, 'scoreProvenance')
  const normalized = {}
  for (const field of SCORE_FIELDS) normalized[field] = requireScore(input[field], `scoreProvenance.${field}`)
  if (normalized.final === null) fail('scoreProvenance.final must be present.')
  return normalized
}

export function normalizeRetrievalIndexIdentity(value) {
  const input = requireRecord(value, 'index identity')
  requireExactKeys(input, ['schemaVersion', 'vault', 'chunking', 'embedding'], 'index identity')
  if (input.schemaVersion !== RETRIEVAL_INDEX_V2_SCHEMA_VERSION) fail('index identity schemaVersion must be 2.')

  const vault = requireRecord(input.vault, 'index identity.vault')
  requireExactKeys(vault, ['id', 'revision'], 'index identity.vault')
  const chunking = requireRecord(input.chunking, 'index identity.chunking')
  requireExactKeys(chunking, ['algorithm', 'size', 'overlap'], 'index identity.chunking')
  const embedding = requireRecord(input.embedding, 'index identity.embedding')
  requireExactKeys(embedding, ['providerId', 'modelId', 'dimensions'], 'index identity.embedding')

  const normalizedEmbedding = {
    providerId: optionalString(embedding.providerId, 'index identity.embedding.providerId'),
    modelId: optionalString(embedding.modelId, 'index identity.embedding.modelId'),
    dimensions: embedding.dimensions === null
      ? null
      : requireInteger(embedding.dimensions, 'index identity.embedding.dimensions', { min: 1, max: 16_384 }),
  }
  const embeddingFields = [normalizedEmbedding.providerId, normalizedEmbedding.modelId, normalizedEmbedding.dimensions]
  if (embeddingFields.some((field) => field !== null) && embeddingFields.some((field) => field === null)) {
    fail('index identity.embedding providerId, modelId, and dimensions must be all null or all present.')
  }

  return {
    schemaVersion: RETRIEVAL_INDEX_V2_SCHEMA_VERSION,
    vault: {
      id: requireString(vault.id, 'index identity.vault.id'),
      revision: requireString(vault.revision, 'index identity.vault.revision', { maxLength: 256, maxBytes: 512 }),
    },
    chunking: {
      algorithm: requireString(chunking.algorithm, 'index identity.chunking.algorithm', { maxLength: 64 }),
      size: requireInteger(chunking.size, 'index identity.chunking.size', { min: 1, max: 65_536 }),
      overlap: requireInteger(chunking.overlap, 'index identity.chunking.overlap', { min: 0, max: 65_535 }),
    },
    embedding: normalizedEmbedding,
  }
}

function normalizeChunkIdentity(value, label = 'chunk') {
  const input = requireRecord(value, label)
  requireExactKeys(input, ['id', 'noteId', 'sourceId', 'path', 'ordinal', 'heading'], label)
  const normalized = {
    id: requireString(input.id, `${label}.id`),
    noteId: requireString(input.noteId, `${label}.noteId`),
    sourceId: requireString(input.sourceId, `${label}.sourceId`),
    path: requireString(input.path, `${label}.path`, { maxLength: 2_048, maxBytes: RETRIEVAL_PATH_MAX_BYTES }),
    ordinal: requireInteger(input.ordinal, `${label}.ordinal`, { max: 1_000_000 }),
    heading: optionalString(input.heading, `${label}.heading`, { maxLength: 512 }),
  }
  return normalized
}

export function normalizeRetrievalIndexV2(value) {
  const input = requireRecord(value, 'Retrieval Index v2')
  requireExactKeys(input, ['schemaVersion', 'kind', 'identity', 'status', 'staleReason', 'chunks'], 'Retrieval Index v2')
  if (input.schemaVersion !== RETRIEVAL_INDEX_V2_SCHEMA_VERSION) fail('Retrieval Index v2 schemaVersion must be 2.')
  if (input.kind !== INDEX_KIND) fail('Retrieval Index v2 kind is invalid.')
  if (!INDEX_STATUSES.has(input.status)) fail('Retrieval Index v2 status is invalid.')
  const staleReason = input.staleReason === null
    ? null
    : requireString(input.staleReason, 'Retrieval Index v2 staleReason', { maxLength: 64 })
  if (input.status === 'stale' && (!staleReason || !STALE_REASONS.has(staleReason))) fail('A stale Retrieval Index requires a typed staleReason.')
  if (input.status === 'ready' && staleReason !== null) fail('A ready Retrieval Index cannot have a staleReason.')
  if (!Array.isArray(input.chunks) || input.chunks.length > RETRIEVAL_INDEX_V2_MAX_CHUNKS) fail('Retrieval Index v2 chunks exceed the bound.')

  const chunks = input.chunks.map((chunk, index) => normalizeChunkIdentity(chunk, `Retrieval Index v2 chunks[${index}]`))
  const ids = chunks.map((chunk) => chunk.id)
  if (new Set(ids).size !== ids.length) fail('Retrieval Index v2 chunk ids must be unique.')
  return {
    schemaVersion: RETRIEVAL_INDEX_V2_SCHEMA_VERSION,
    kind: INDEX_KIND,
    identity: normalizeRetrievalIndexIdentity(input.identity),
    status: input.status,
    staleReason,
    chunks,
  }
}

function normalizePacketIndex(value) {
  const input = requireRecord(value, 'Evidence Packet v2 index')
  requireExactKeys(input, ['status', 'identity', 'staleReason'], 'Evidence Packet v2 index')
  if (!PACKET_INDEX_STATUSES.has(input.status)) fail('Evidence Packet v2 index status is invalid.')
  const identity = input.identity === null ? null : normalizeRetrievalIndexIdentity(input.identity)
  const staleReason = input.staleReason === null
    ? null
    : requireString(input.staleReason, 'Evidence Packet v2 index staleReason', { maxLength: 64 })
  if (input.status === 'unavailable' && identity !== null) fail('An unavailable index cannot carry an identity.')
  if (input.status !== 'unavailable' && identity === null) fail('A ready or stale index must carry an identity.')
  if (input.status === 'stale' && (!staleReason || !STALE_REASONS.has(staleReason))) fail('A stale packet index requires a typed staleReason.')
  if (input.status !== 'stale' && staleReason !== null) fail('Only a stale packet index may carry a staleReason.')
  return { status: input.status, identity, staleReason }
}

function normalizeRetrievalSummary(value) {
  const input = requireRecord(value, 'Evidence Packet v2 retrieval')
  requireExactKeys(input, ['mode', 'topK', 'candidateCount', 'directCount', 'graphExpanded', 'indexStatus'], 'Evidence Packet v2 retrieval')
  if (!['lexical', 'hybrid'].includes(input.mode)) fail('Evidence Packet v2 retrieval mode is invalid.')
  if (!PACKET_INDEX_STATUSES.has(input.indexStatus)) fail('Evidence Packet v2 retrieval indexStatus is invalid.')
  if (input.mode === 'hybrid' && input.indexStatus !== 'ready') fail('Hybrid retrieval requires a ready index.')
  return {
    mode: input.mode,
    topK: requireInteger(input.topK, 'Evidence Packet v2 retrieval.topK', { min: 1, max: EVIDENCE_PACKET_V2_MAX_EVIDENCE }),
    candidateCount: requireInteger(input.candidateCount, 'Evidence Packet v2 retrieval.candidateCount'),
    directCount: requireInteger(input.directCount, 'Evidence Packet v2 retrieval.directCount'),
    graphExpanded: requireInteger(input.graphExpanded, 'Evidence Packet v2 retrieval.graphExpanded'),
    indexStatus: input.indexStatus,
  }
}

function normalizeEvidenceSource(value, label) {
  const input = requireRecord(value, label)
  requireExactKeys(input, ['id', 'noteId', 'path'], label)
  return {
    id: requireString(input.id, `${label}.id`),
    noteId: requireString(input.noteId, `${label}.noteId`),
    path: requireString(input.path, `${label}.path`, { maxLength: 2_048, maxBytes: RETRIEVAL_PATH_MAX_BYTES }),
  }
}

function normalizeSource(value, index) {
  const input = requireRecord(value, `Evidence Packet v2 sources[${index}]`)
  requireExactKeys(input, ['id', 'noteId', 'path', 'title', 'kind', 'chunkIds'], `Evidence Packet v2 sources[${index}]`)
  return {
    id: requireString(input.id, `Evidence Packet v2 sources[${index}].id`),
    noteId: requireString(input.noteId, `Evidence Packet v2 sources[${index}].noteId`),
    path: requireString(input.path, `Evidence Packet v2 sources[${index}].path`, { maxLength: 2_048, maxBytes: RETRIEVAL_PATH_MAX_BYTES }),
    title: requireString(input.title, `Evidence Packet v2 sources[${index}].title`, { maxLength: 512 }),
    kind: requireString(input.kind, `Evidence Packet v2 sources[${index}].kind`, { maxLength: 64 }),
    chunkIds: requireUniqueStrings(input.chunkIds, `Evidence Packet v2 sources[${index}].chunkIds`),
  }
}

function normalizeCitation(value, index) {
  const input = requireRecord(value, `Evidence Packet v2 evidence[${index}].citation`)
  requireExactKeys(input, ['id', 'sourceId', 'chunkId', 'noteId', 'path', 'heading'], `Evidence Packet v2 evidence[${index}].citation`)
  return {
    id: requireString(input.id, `Evidence Packet v2 evidence[${index}].citation.id`),
    sourceId: requireString(input.sourceId, `Evidence Packet v2 evidence[${index}].citation.sourceId`),
    chunkId: requireString(input.chunkId, `Evidence Packet v2 evidence[${index}].citation.chunkId`),
    noteId: requireString(input.noteId, `Evidence Packet v2 evidence[${index}].citation.noteId`),
    path: requireString(input.path, `Evidence Packet v2 evidence[${index}].citation.path`, { maxLength: 2_048, maxBytes: RETRIEVAL_PATH_MAX_BYTES }),
    heading: optionalString(input.heading, `Evidence Packet v2 evidence[${index}].citation.heading`, { maxLength: 512 }),
  }
}

function normalizeEvidence(value, index) {
  const label = `Evidence Packet v2 evidence[${index}]`
  const input = requireRecord(value, label)
  requireExactKeys(input, ['id', 'noteId', 'chunkId', 'sourceId', 'source', 'chunk', 'citation', 'excerpt', 'scoreProvenance', 'relationship', 'relatedFrom'], label)
  const source = normalizeEvidenceSource(input.source, `${label}.source`)
  const chunk = normalizeChunkIdentity(input.chunk, `${label}.chunk`)
  const citation = normalizeCitation(input.citation, index)
  if (!RELATIONSHIPS.has(input.relationship)) fail(`${label}.relationship is invalid.`)
  const normalized = {
    id: requireString(input.id, `${label}.id`),
    noteId: requireString(input.noteId, `${label}.noteId`),
    chunkId: requireString(input.chunkId, `${label}.chunkId`),
    sourceId: requireString(input.sourceId, `${label}.sourceId`),
    source,
    chunk,
    citation,
    excerpt: requireString(input.excerpt, `${label}.excerpt`, { maxLength: 32_768, maxBytes: RETRIEVAL_EXCERPT_MAX_BYTES }),
    scoreProvenance: normalizeScoreProvenance(input.scoreProvenance),
    relationship: input.relationship,
    relatedFrom: optionalString(input.relatedFrom, `${label}.relatedFrom`),
  }
  if (normalized.id !== citation.id || normalized.id !== normalized.citation.id) fail(`${label} id must equal citation.id.`)
  if (normalized.noteId !== normalized.chunk.noteId || normalized.noteId !== normalized.citation.noteId || normalized.noteId !== normalized.source.noteId) fail(`${label} note identity is inconsistent.`)
  if (normalized.chunkId !== normalized.chunk.id || normalized.chunkId !== normalized.citation.chunkId) fail(`${label} chunk identity is inconsistent.`)
  if (normalized.sourceId !== normalized.source.id || normalized.sourceId !== normalized.chunk.sourceId || normalized.sourceId !== normalized.citation.sourceId) fail(`${label} source identity is inconsistent.`)
  if (normalized.source.path !== normalized.chunk.path || normalized.source.path !== normalized.citation.path) fail(`${label} path identity is inconsistent.`)
  if (normalized.chunk.heading !== normalized.citation.heading) fail(`${label} heading identity is inconsistent.`)
  return normalized
}

function normalizePacketError(value) {
  if (value === null) return null
  const input = requireRecord(value, 'Evidence Packet v2 error')
  requireExactKeys(input, ['code', 'message'], 'Evidence Packet v2 error')
  return {
    code: requireString(input.code, 'Evidence Packet v2 error.code', { maxLength: 96 }),
    message: requireString(input.message, 'Evidence Packet v2 error.message', { maxLength: 1_024 }),
  }
}

export function normalizeEvidencePacketV2(value) {
  const input = requireRecord(value, 'Evidence Packet v2')
  requireExactKeys(input, ['schemaVersion', 'kind', 'question', 'retrieval', 'index', 'evidence', 'sources', 'error'], 'Evidence Packet v2')
  if (input.schemaVersion !== EVIDENCE_PACKET_V2_SCHEMA_VERSION) fail('Evidence Packet v2 schemaVersion must be 2.')
  if (input.kind !== PACKET_KIND) fail('Evidence Packet v2 kind is invalid.')
  if (typeof input.question !== 'string' || input.question.length > 4_096) fail('Evidence Packet v2 question is invalid.')
  if (!Array.isArray(input.evidence) || input.evidence.length > EVIDENCE_PACKET_V2_MAX_EVIDENCE) fail('Evidence Packet v2 evidence exceeds the bound.')
  if (!Array.isArray(input.sources) || input.sources.length > EVIDENCE_PACKET_V2_MAX_EVIDENCE) fail('Evidence Packet v2 sources exceeds the bound.')

  const retrieval = normalizeRetrievalSummary(input.retrieval)
  const index = normalizePacketIndex(input.index)
  if (retrieval.indexStatus !== index.status) fail('Evidence Packet v2 retrieval and index status must agree.')
  const sources = input.sources.map(normalizeSource)
  const sourceById = new Map()
  sources.forEach((source) => {
    if (sourceById.has(source.id)) fail('Evidence Packet v2 source ids must be unique.')
    sourceById.set(source.id, source)
  })
  const evidence = input.evidence.map(normalizeEvidence)
  const citationIds = new Set()
  evidence.forEach((item, index) => {
    if (citationIds.has(item.citation.id)) fail(`Evidence Packet v2 evidence[${index}] citation id is duplicated.`)
    citationIds.add(item.citation.id)
    const source = sourceById.get(item.sourceId)
    if (!source) fail(`Evidence Packet v2 evidence[${index}] references an unknown source.`)
    if (!source.chunkIds.includes(item.chunkId)) fail(`Evidence Packet v2 evidence[${index}] chunk is absent from its source.`)
  })
  if (evidence.length > retrieval.topK) fail('Evidence Packet v2 evidence cannot exceed topK.')
  const directCount = evidence.filter((item) => item.relationship === 'direct').length
  const graphExpanded = evidence.filter((item) => item.relationship === 'wikilink').length
  if (retrieval.directCount !== directCount || retrieval.graphExpanded !== graphExpanded) fail('Evidence Packet v2 retrieval counts do not match evidence.')
  if (retrieval.candidateCount < retrieval.directCount) fail('Evidence Packet v2 candidateCount cannot be below directCount.')

  return {
    schemaVersion: EVIDENCE_PACKET_V2_SCHEMA_VERSION,
    kind: PACKET_KIND,
    question: input.question,
    retrieval,
    index,
    evidence,
    sources,
    error: normalizePacketError(input.error),
  }
}

function migrationIndexIdentity(options = {}) {
  const vault = requireRecord(options.vault, 'v1 migration vault identity')
  return normalizeRetrievalIndexIdentity({
    schemaVersion: RETRIEVAL_INDEX_V2_SCHEMA_VERSION,
    vault,
    chunking: {
      algorithm: options.chunking?.algorithm || 'section-window-v1',
      size: options.chunking?.size ?? 900,
      overlap: options.chunking?.overlap ?? 120,
    },
    embedding: options.embedding || { providerId: null, modelId: null, dimensions: null },
  })
}

export function migrateRetrievalIndexV1(value, options = {}) {
  const input = requireRecord(value, 'Retrieval Index v1')
  if (input.schemaVersion !== 1 || !Array.isArray(input.chunks)) fail('Retrieval Index v1 input is invalid.')
  const chunks = input.chunks.map((chunk, index) => {
    const noteId = requireString(chunk.noteId || chunk.path, `v1 chunks[${index}].noteId`)
    const id = requireString(chunk.id, `v1 chunks[${index}].id`)
    const ordinalMatch = id.match(/::(\d+)$/)
    return {
      id,
      noteId,
      sourceId: `source:${noteId}`,
      path: requireString(chunk.path || noteId, `v1 chunks[${index}].path`, { maxLength: 2_048, maxBytes: RETRIEVAL_PATH_MAX_BYTES }),
      ordinal: ordinalMatch ? Number(ordinalMatch[1]) : index,
      heading: chunk.heading ? String(chunk.heading) : null,
    }
  })
  return normalizeRetrievalIndexV2({
    schemaVersion: RETRIEVAL_INDEX_V2_SCHEMA_VERSION,
    kind: INDEX_KIND,
    identity: migrationIndexIdentity(options),
    status: 'ready',
    staleReason: null,
    chunks,
  })
}

function migrationScoreProvenance(item) {
  const score = requireScore(Number(item.score || 0), 'v1 evidence score', { nullable: false })
  return {
    lexical: item.relationship === 'direct' ? score : null,
    vector: null,
    graph: item.relationship === 'wikilink' ? score : null,
    fusion: null,
    rerank: null,
    final: score,
  }
}

export function migrateEvidencePacketV1(value, options = {}) {
  const input = requireRecord(value, 'Evidence Packet v1')
  if (input.schemaVersion !== 1 || !Array.isArray(input.evidence)) fail('Evidence Packet v1 input is invalid.')
  const indexIdentity = options.indexIdentity ? normalizeRetrievalIndexIdentity(options.indexIdentity) : null
  const indexStatus = indexIdentity ? (options.indexStatus || 'ready') : 'unavailable'
  if (!PACKET_INDEX_STATUSES.has(indexStatus)) fail('v1 migration indexStatus is invalid.')
  const rawSources = Array.isArray(input.sources) ? input.sources : []
  const sourceMap = new Map()
  const evidence = input.evidence.map((item, index) => {
    const rawSource = isRecord(item.source) ? item.source : {}
    const noteId = requireString(item.noteId || rawSource.noteId || item.path, `v1 evidence[${index}].noteId`)
    const path = requireString(item.path || rawSource.path || noteId, `v1 evidence[${index}].path`, { maxLength: 2_048, maxBytes: RETRIEVAL_PATH_MAX_BYTES })
    const chunkId = requireString(item.id || rawSource.chunkId || `legacy:${index}`, `v1 evidence[${index}].chunkId`)
    const sourceId = `source:${noteId}`
    const citationId = `citation:${chunkId}`
    const heading = item.heading || rawSource.heading || null
    const source = { id: sourceId, noteId, path }
    const chunk = { id: chunkId, noteId, sourceId, path, ordinal: index, heading }
    const citation = { id: citationId, sourceId, chunkId, noteId, path, heading }
    sourceMap.set(sourceId, {
      id: sourceId,
      noteId,
      path,
      title: String(item.title || path.split('/').at(-1) || path),
      kind: String(item.type || 'note'),
      chunkIds: [...(sourceMap.get(sourceId)?.chunkIds || []), chunkId],
    })
    return {
      id: citationId,
      noteId,
      chunkId,
      sourceId,
      source,
      chunk,
      citation,
      excerpt: String(item.excerpt || ''),
      scoreProvenance: migrationScoreProvenance(item),
      relationship: RELATIONSHIPS.has(item.relationship) ? item.relationship : 'direct',
      relatedFrom: item.relatedFrom ? String(item.relatedFrom) : null,
    }
  })
  const rawRetrieval = isRecord(input.retrieval) ? input.retrieval : {}
  const packet = {
    schemaVersion: EVIDENCE_PACKET_V2_SCHEMA_VERSION,
    kind: PACKET_KIND,
    question: typeof input.question === 'string' ? input.question : '',
    retrieval: {
      mode: 'lexical',
      topK: Math.min(EVIDENCE_PACKET_V2_MAX_EVIDENCE, Math.max(1, Number(rawRetrieval.topK) || Math.max(1, evidence.length))),
      candidateCount: Math.max(evidence.length, Number(rawRetrieval.candidateCount) || 0),
      directCount: evidence.filter((item) => item.relationship === 'direct').length,
      graphExpanded: evidence.filter((item) => item.relationship === 'wikilink').length,
      indexStatus,
    },
    index: { status: indexStatus, identity: indexIdentity, staleReason: indexStatus === 'stale' ? options.staleReason : null },
    evidence,
    sources: [...sourceMap.values()],
    error: input.error === null || input.error === undefined ? null : input.error,
  }
  return normalizeEvidencePacketV2(packet)
}

export function serializeRetrievalIndexV2(value) {
  return JSON.stringify(normalizeRetrievalIndexV2(value))
}

export function serializeEvidencePacketV2(value) {
  return JSON.stringify(normalizeEvidencePacketV2(value))
}

export function isRetrievalIndexV2(value) {
  try {
    normalizeRetrievalIndexV2(value)
    return true
  } catch {
    return false
  }
}

export function isEvidencePacketV2(value) {
  try {
    normalizeEvidencePacketV2(value)
    return true
  } catch {
    return false
  }
}
