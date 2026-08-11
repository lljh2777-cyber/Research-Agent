import assert from 'node:assert/strict'
import test from 'node:test'

import fixture from '../docs/contracts/retrieval-v2.fixture.json' with { type: 'json' }
import {
  EVIDENCE_PACKET_V2_SCHEMA_VERSION,
  RETRIEVAL_INDEX_V2_SCHEMA_VERSION,
  isEvidencePacketV2,
  migrateEvidencePacketV1,
  migrateRetrievalIndexV1,
  normalizeEvidencePacketV2,
  normalizeRetrievalIndexV2,
  serializeEvidencePacketV2,
  serializeRetrievalIndexV2,
} from './retrievalContracts.js'

test('Retrieval Index v2 fixture freezes identity, stale state, and chunk identity', () => {
  const normalized = normalizeRetrievalIndexV2(fixture.index)
  assert.deepEqual(normalized, fixture.index)
  assert.equal(normalized.schemaVersion, RETRIEVAL_INDEX_V2_SCHEMA_VERSION)
  assert.equal(normalized.identity.vault.revision, 'vault-rev-7')
  assert.equal(normalized.identity.embedding.modelId, 'BAAI/bge-m3')
  assert.equal(normalized.chunks[0].sourceId, 'source:methods/CellChat.md')
  assert.equal(serializeRetrievalIndexV2(normalized), JSON.stringify(fixture.index))
})

test('Evidence Packet v2 fixture preserves score provenance and citation/source joins', () => {
  const normalized = normalizeEvidencePacketV2(fixture.packet)
  assert.deepEqual(normalized, fixture.packet)
  assert.equal(normalized.schemaVersion, EVIDENCE_PACKET_V2_SCHEMA_VERSION)
  assert.equal(normalized.retrieval.mode, 'hybrid')
  assert.equal(normalized.evidence[0].scoreProvenance.vector, 0.75)
  assert.equal(normalized.evidence[0].citation.id, normalized.evidence[0].id)
  assert.equal(serializeEvidencePacketV2(normalized), JSON.stringify(fixture.packet))
})

test('stale indexes are explicit and cannot be represented as hybrid retrieval', () => {
  const staleIndex = { ...fixture.index, status: 'stale', staleReason: 'vault_revision_changed' }
  assert.equal(normalizeRetrievalIndexV2(staleIndex).status, 'stale')
  assert.throws(() => normalizeRetrievalIndexV2({ ...fixture.index, status: 'stale', staleReason: null }), /typed staleReason/)
  assert.throws(() => normalizeEvidencePacketV2({
    ...fixture.packet,
    retrieval: { ...fixture.packet.retrieval, indexStatus: 'stale' },
    index: { status: 'stale', identity: fixture.index.identity, staleReason: 'vault_revision_changed' },
  }), /Hybrid retrieval requires a ready index/)
})

test('explicit v1 migration preserves lexical meaning without relabeling it as hybrid', () => {
  const indexV1 = {
    schemaVersion: 1,
    chunks: [{ id: 'notes/one.md::0', noteId: 'notes/one.md', path: 'notes/one.md', heading: 'One' }],
  }
  const identity = fixture.index.identity
  const migratedIndex = migrateRetrievalIndexV1(indexV1, { vault: identity.vault, chunking: identity.chunking, embedding: identity.embedding })
  assert.equal(migratedIndex.schemaVersion, 2)
  assert.equal(migratedIndex.chunks[0].sourceId, 'source:notes/one.md')

  const packetV1 = {
    schemaVersion: 1,
    question: 'Signal?',
    retrieval: { strategy: 'bm25', topK: 1, candidateCount: 1 },
    evidence: [{ id: 'notes/one.md::0', noteId: 'notes/one.md', path: 'notes/one.md', title: 'One', type: 'note', heading: 'One', excerpt: 'Signal.', score: 0.91, relationship: 'direct' }],
    sources: [],
    error: null,
  }
  const migratedPacket = migrateEvidencePacketV1(packetV1, { indexIdentity: identity })
  assert.equal(migratedPacket.schemaVersion, 2)
  assert.equal(migratedPacket.retrieval.mode, 'lexical')
  assert.equal(migratedPacket.evidence[0].scoreProvenance.lexical, 0.91)
  assert.equal(isEvidencePacketV2(migratedPacket), true)
})
