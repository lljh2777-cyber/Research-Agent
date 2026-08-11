import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRetrievalIndex } from './retrieval.js'
import { retrieveHybridEvidence, validateCitationIndices } from './researchRetrieval.js'

const notes = [{
  id: 'methods/cellchat.md',
  path: 'methods/cellchat.md',
  title: 'CellChat',
  type: 'method',
  frontmatter: {},
  wikilinks: [],
  body: '# CellChat\nCellChat infers ligand receptor communication between cell populations.',
}]
const lexicalIndex = buildRetrievalIndex(notes)
const identity = {
  schemaVersion: 2,
  vault: { id: 'vault-lab', revision: 'vault-rev-7' },
  chunking: { algorithm: 'section-window-v1', size: 900, overlap: 120 },
  embedding: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dimensions: 1024 },
}
const readyIndex = {
  schemaVersion: 2,
  kind: 'retrieval-index',
  identity,
  status: 'ready',
  staleReason: null,
  chunks: lexicalIndex.chunks.map((chunk, ordinal) => ({
    id: chunk.id,
    noteId: chunk.noteId,
    sourceId: `source:${chunk.noteId}`,
    path: chunk.path,
    ordinal,
    heading: chunk.heading || null,
  })),
}

const embeddingRuntime = {
  embedding: {
    available: true,
    async embed({ query, indexIdentity, signal }) {
      assert.equal(query, 'ligand receptor')
      assert.equal(indexIdentity.embedding.modelId, 'BAAI/bge-m3')
      assert.equal(signal, undefined)
      return { scores: [{ chunkId: lexicalIndex.chunks[0].id, score: 0.92 }] }
    },
  },
}

test('keeps a truthful lexical path when embedding capability is unavailable', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: readyIndex,
    runtime: { embedding: { available: false, reason: 'Provider model is unavailable.' } },
  })

  assert.equal(packet.retrieval.mode, 'lexical')
  assert.equal(packet.index.status, 'ready')
  assert.equal(packet.error.code, 'embedding_unavailable')
  assert.equal(packet.evidence.length, 1)
})

test('fuses bounded Runtime scores without carrying credentials or changing citation identity', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: readyIndex,
    runtime: embeddingRuntime,
  })

  assert.equal(packet.retrieval.mode, 'hybrid')
  assert.equal(packet.error, null)
  assert.equal(packet.evidence[0].scoreProvenance.vector, 0.92)
  assert.equal(packet.evidence[0].scoreProvenance.fusion > 0, true)
  assert.equal(packet.evidence[0].citation.id, packet.evidence[0].id)
})

test('keeps hybrid evidence but exposes optional reranker degradation', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: readyIndex,
    runtime: { ...embeddingRuntime, rerank: { available: false, reason: 'Reranker is disabled.' } },
    useReranker: true,
  })

  assert.equal(packet.retrieval.mode, 'hybrid')
  assert.equal(packet.error.code, 'rerank_unavailable')
  assert.equal(packet.evidence[0].scoreProvenance.vector, 0.92)
})

test('does not label stale indexes as hybrid', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: { ...readyIndex, status: 'stale', staleReason: 'vault_revision_changed' },
    runtime: embeddingRuntime,
  })

  assert.equal(packet.retrieval.mode, 'lexical')
  assert.equal(packet.index.status, 'stale')
  assert.equal(packet.error.code, 'retrieval_index_stale')
})

test('turns cancellation into an observable lexical degradation', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: readyIndex,
    runtime: {
      embedding: {
        available: true,
        async embed() { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
      },
    },
  })

  assert.equal(packet.retrieval.mode, 'lexical')
  assert.equal(packet.error.code, 'retrieval_cancelled')
})

test('rejects missing, duplicate, out-of-range, and no-evidence citations', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: readyIndex,
    runtime: embeddingRuntime,
  })
  assert.equal(validateCitationIndices(packet).code, 'citations_missing')
  assert.equal(validateCitationIndices(packet, [1, 1]).code, 'citation_duplicate')
  assert.equal(validateCitationIndices(packet, [2]).code, 'citation_out_of_range')
  assert.equal(validateCitationIndices({ ...packet, evidence: [], sources: [], retrieval: { ...packet.retrieval, topK: 1, directCount: 0, graphExpanded: 0 } }, [1]).code, 'no_evidence')
  assert.equal(validateCitationIndices({ ...packet, evidence: [], sources: [], retrieval: { ...packet.retrieval, topK: 1, directCount: 0, graphExpanded: 0 } }, []).code, 'citations_missing')
})
