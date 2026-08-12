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

function readyVectorIndex({ vectors = [{ chunkId: lexicalIndex.chunks[0].id, index: 0, vector: [1, 0] }], state = 'ready', identityOverride = identity, provenance = { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' } } = {}) {
  const vectorIdentity = { ...identityOverride, embedding: { ...identityOverride.embedding, dimensions: 2 } }
  const index = { ...readyIndex, identity: vectorIdentity }
  return { state, identity: vectorIdentity, index, vectors, provenance }
}

function vectorRuntime({ result = { ok: true, providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dimensions: 2, embeddings: [{ index: 0, vector: [1, 0] }], provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' } }, rerank } = {}) {
  return {
    embedding: { available: true, async embed() { return result } },
    ...(rerank ? { rerank } : {}),
  }
}

test('consumes an exact Runtime-ready vector index and computes deterministic cosine fusion in Core', async () => {
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: readyVectorIndex(),
    runtime: vectorRuntime(),
  })

  assert.equal(packet.retrieval.mode, 'hybrid')
  assert.equal(packet.error, null)
  assert.equal(packet.evidence[0].scoreProvenance.vector, 1)
  assert.equal(packet.evidence[0].scoreProvenance.fusion > 0, true)
})

test('does not fabricate vector-only evidence when lexical retrieval has no candidate', async () => {
  const packet = await retrieveHybridEvidence('unrelated query', {
    lexicalIndex,
    vectorIndex: readyVectorIndex(),
    runtime: vectorRuntime(),
  })

  assert.equal(packet.retrieval.mode, 'lexical')
  assert.equal(packet.evidence.length, 0)
  assert.equal(packet.error, null)
})

test('rejects query dimension, provenance, zero-norm, and non-finite failures without hybrid labeling', async () => {
  const cases = [
    [{ dimensions: 3, embeddings: [{ index: 0, vector: [1, 0, 0] }] }, 'vector_query_invalid'],
    [{ providerId: 'other', modelId: 'BAAI/bge-m3', dimensions: 2, embeddings: [{ index: 0, vector: [1, 0] }] }, 'vector_provenance_mismatch'],
    [{ dimensions: 2, embeddings: [{ index: 0, vector: [0, 0] }] }, 'vector_query_invalid'],
    [{ dimensions: 2, embeddings: [{ index: 0, vector: [Number.NaN, 0] }] }, 'vector_query_invalid'],
  ]
  for (const [result, code] of cases) {
    const packet = await retrieveHybridEvidence('ligand receptor', {
      lexicalIndex,
      vectorIndex: readyVectorIndex(),
      runtime: vectorRuntime({ result: { ok: true, providerId: 'siliconflow', modelId: 'BAAI/bge-m3', provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' }, ...result } }),
    })
    assert.equal(packet.retrieval.mode, 'lexical')
    assert.equal(packet.error.code, code)
  }
})

test('rejects vector identity/provenance and chunk mapping corruption deterministically', async () => {
  const mismatchIdentity = { ...identity, vault: { ...identity.vault, revision: 'different-revision' } }
  const mismatch = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    retrievalIndex: readyIndex,
    requestedIndexIdentity: identity,
    vectorIndex: readyVectorIndex({ identityOverride: mismatchIdentity }),
    runtime: vectorRuntime(),
  })
  assert.equal(mismatch.retrieval.mode, 'lexical')
  assert.equal(mismatch.error.code, 'vector_index_identity_mismatch')

  const provenance = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: readyVectorIndex({ provenance: { providerId: 'other', modelId: 'BAAI/bge-m3' } }),
    runtime: vectorRuntime(),
  })
  assert.equal(provenance.error.code, 'vector_provenance_mismatch')

  const outerIdentity = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: { ...readyVectorIndex(), identity: { ...identity, vault: { ...identity.vault, revision: 'outer-mismatch' } } },
    runtime: vectorRuntime(),
  })
  assert.equal(outerIdentity.error.code, 'vector_index_identity_mismatch')

  const corrupt = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: readyVectorIndex({ vectors: [{ chunkId: 'unknown', index: 0, vector: [1, 0] }] }),
    runtime: vectorRuntime(),
  })
  assert.equal(corrupt.error.code, 'vector_index_corrupt')
})

test('treats every non-ready Runtime vector state as typed lexical degradation', async () => {
  for (const state of ['stale', 'degraded', 'failed', 'cancelled', 'unavailable']) {
    const packet = await retrieveHybridEvidence('ligand receptor', {
      lexicalIndex,
      vectorIndex: { state },
      runtime: vectorRuntime(),
    })
    assert.equal(packet.retrieval.mode, 'lexical')
    assert.equal(packet.error.code, state === 'stale'
      ? 'vector_index_stale'
      : state === 'degraded'
        ? 'vector_index_degraded'
        : state === 'failed'
          ? 'vector_index_failed'
          : state === 'cancelled'
            ? 'vector_index_cancelled'
            : 'vector_index_unavailable')
  }
})

test('preserves typed query embedding errors and cancellation on the ready vector path', async () => {
  const failed = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: readyVectorIndex(),
    runtime: vectorRuntime({ result: { ok: false, code: 'rate_limited', error: 'Retry later.' } }),
  })
  assert.equal(failed.retrieval.mode, 'lexical')
  assert.equal(failed.error.code, 'rate_limited')

  const cancelled = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: readyVectorIndex(),
    runtime: { embedding: { available: true, async embed() { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }) } } },
  })
  assert.equal(cancelled.retrieval.mode, 'lexical')
  assert.equal(cancelled.error.code, 'retrieval_cancelled')
})

test('bounds reranker input to lexical evidence and preserves citation validation after vector fusion', async () => {
  let rerankInput
  const packet = await retrieveHybridEvidence('ligand receptor', {
    lexicalIndex,
    vectorIndex: readyVectorIndex(),
    runtime: vectorRuntime({ rerank: {
      available: true,
      async rerank(input) {
        rerankInput = input
        return { scores: [{ chunkId: input.candidates[0].chunkId, score: 0.88 }] }
      },
    } }),
    useReranker: true,
  })
  assert.equal(packet.retrieval.mode, 'hybrid')
  assert.equal(packet.evidence[0].scoreProvenance.rerank, 0.88)
  assert.equal(rerankInput.candidates.length, 1)
  assert.equal(validateCitationIndices(packet, [1]).valid, true)
})
