import assert from 'node:assert/strict'
import test from 'node:test'

import { EVIDENCE_PACKET_SCHEMA_VERSION, buildRetrievalIndex } from './retrieval.js'
import { executeResearchTool } from './researchTools.js'

const call = (id, query) => ({
  id,
  name: 'search_vault',
  arguments: JSON.stringify({ query, top_k: 2 }),
})

test('search_vault serializes the complete successful Evidence Packet v1 envelope', () => {
  const retrievalIndex = buildRetrievalIndex([{
    id: 'notes/cellchat.md',
    path: 'notes/cellchat.md',
    name: 'cellchat.md',
    title: 'CellChat',
    type: 'method',
    frontmatter: {},
    wikilinks: [],
    body: '# CellChat\nCellChat infers ligand receptor communication.',
  }])
  const result = executeResearchTool(call('packet-success', 'ligand receptor'), { retrievalIndex })
  const packet = JSON.parse(result.content)

  assert.equal(result.isError, false)
  assert.equal(packet.schemaVersion, EVIDENCE_PACKET_SCHEMA_VERSION)
  assert.equal(packet.question, 'ligand receptor')
  assert.equal(packet.error, null)
  assert.equal(packet.sources.length, 1)
  assert.deepEqual(packet.sources[0].chunkIds, packet.evidence.map((item) => item.id))
  assert.equal(packet.evidence[0].source.chunkId, packet.evidence[0].id)
})

test('search_vault serializes an unavailable-index Evidence Packet error and empty source map', () => {
  const result = executeResearchTool(call('packet-error', 'ligand receptor'), { retrievalIndex: null })
  const packet = JSON.parse(result.content)

  assert.equal(packet.schemaVersion, EVIDENCE_PACKET_SCHEMA_VERSION)
  assert.deepEqual(packet.evidence, [])
  assert.deepEqual(packet.sources, [])
  assert.deepEqual(packet.error, {
    code: 'retrieval_index_unavailable',
    message: 'No retrieval index is available.',
  })
})
