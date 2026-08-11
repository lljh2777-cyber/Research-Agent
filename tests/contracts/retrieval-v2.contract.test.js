import { describe, expect, it } from 'vitest'

import fixture from '../../docs/contracts/retrieval-v2.fixture.json'
import {
  isEvidencePacketV2,
  migrateEvidencePacketV1,
  normalizeEvidencePacketV2,
  normalizeRetrievalIndexV2,
  serializeEvidencePacketV2,
} from '../../src/retrievalContracts.js'

describe('Retrieval Index v2 and Evidence Packet v2 owner contract', () => {
  it('accepts the fixture and preserves deterministic packet serialization', () => {
    const packet = normalizeEvidencePacketV2(fixture.packet)

    expect(packet).toEqual(fixture.packet)
    expect(packet.evidence[0].citation.id).toBe(packet.evidence[0].id)
    expect(serializeEvidencePacketV2(packet)).toBe(JSON.stringify(fixture.packet))
  })

  it('binds index identity and rejects stale hybrid output', () => {
    expect(normalizeRetrievalIndexV2(fixture.index).identity).toEqual(fixture.packet.index.identity)
    expect(() => normalizeEvidencePacketV2({
      ...fixture.packet,
      retrieval: { ...fixture.packet.retrieval, indexStatus: 'stale' },
      index: { status: 'stale', identity: fixture.index.identity, staleReason: 'vault_revision_changed' },
    })).toThrow(/Hybrid retrieval requires a ready index/)
  })

  it('migrates v1 as an explicit lexical compatibility path', () => {
    const packet = migrateEvidencePacketV1({
      schemaVersion: 1,
      question: 'Signal?',
      retrieval: { topK: 1, candidateCount: 1 },
      evidence: [{
        id: 'notes/one.md::0',
        noteId: 'notes/one.md',
        path: 'notes/one.md',
        title: 'One',
        type: 'note',
        heading: 'One',
        excerpt: 'Signal.',
        score: 0.91,
        relationship: 'direct',
      }],
      sources: [],
      error: null,
    }, { indexIdentity: fixture.index.identity })

    expect(packet.retrieval.mode).toBe('lexical')
    expect(packet.evidence[0].scoreProvenance.vector).toBeNull()
    expect(isEvidencePacketV2(packet)).toBe(true)
  })
})
