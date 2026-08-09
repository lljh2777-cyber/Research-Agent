import assert from 'node:assert/strict'
import test from 'node:test'

import { KNOWLEDGE_GRAPH_SCHEMA_VERSION, createKnowledgeGraph } from './knowledgeGraph.js'
import { EVIDENCE_PACKET_SCHEMA_VERSION, RETRIEVAL_INDEX_SCHEMA_VERSION, buildRetrievalIndex, evidenceSources, retrieveEvidence } from './retrieval.js'
import { VAULT_INDEX_SCHEMA_VERSION, VAULT_NOTE_SCHEMA_VERSION, buildVaultIndex, parseVaultTextEntries } from './vault.js'

test('Knowledge Base v1 contract preserves versioned Notes through graph, retrieval, and evidence provenance', async () => {
  const notes = await parseVaultTextEntries([
    { path: 'notes/overview.md', content: '# Overview\n[[method]]\nCell communication evidence.' },
    { path: 'notes/method.md', content: '---\ntype: method\n---\n# Method\nCell communication is inferred from ligands.' },
  ])
  const vaultIndex = buildVaultIndex(notes)
  const graph = createKnowledgeGraph(vaultIndex)
  const retrievalIndex = buildRetrievalIndex(notes)
  const packet = retrieveEvidence(retrievalIndex, 'cell communication', { topK: 3, similarityThreshold: 0 })
  const sources = evidenceSources(packet)

  assert(notes.every((note) => note.schemaVersion === VAULT_NOTE_SCHEMA_VERSION))
  assert.equal(vaultIndex.schemaVersion, VAULT_INDEX_SCHEMA_VERSION)
  assert.equal(graph.schemaVersion, KNOWLEDGE_GRAPH_SCHEMA_VERSION)
  assert.equal(retrievalIndex.schemaVersion, RETRIEVAL_INDEX_SCHEMA_VERSION)
  assert.equal(packet.schemaVersion, EVIDENCE_PACKET_SCHEMA_VERSION)
  assert.equal(packet.error, null)
  assert(packet.evidence.length > 0)
  assert(packet.evidence.every((item) => item.source.chunkId === item.id && item.source.noteId === item.noteId && item.source.path === item.path))
  assert(packet.evidence.every((item) => sources.find((source) => source.id === item.noteId)?.chunkIds.includes(item.id)))
})

test('Evidence Packet v1 distinguishes empty matches from unavailable indexes and empty queries', async () => {
  const notes = await parseVaultTextEntries([{ path: 'notes/one.md', content: '# One\nSignal evidence.' }])
  const index = buildRetrievalIndex(notes)

  const noMatch = retrieveEvidence(index, 'zzzz-no-match')
  assert.equal(noMatch.error, null)
  assert.deepEqual(noMatch.evidence, [])
  assert.equal(retrieveEvidence(null, 'signal').error.code, 'retrieval_index_unavailable')
  assert.equal(retrieveEvidence(index, 'the').error.code, 'query_empty')
})
