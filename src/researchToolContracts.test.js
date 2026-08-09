import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRetrievalIndex } from './retrieval.js'
import { executeResearchTool } from './researchTools.js'

test('search_vault tool preserves Evidence Packet chunk and Markdown provenance', () => {
  const retrievalIndex = buildRetrievalIndex([{
    id: 'methods/cellchat.md',
    path: 'methods/cellchat.md',
    name: 'cellchat.md',
    title: 'CellChat',
    type: 'method',
    frontmatter: {},
    wikilinks: [],
    body: '# CellChat\nCellChat infers ligand receptor communication.',
  }])
  const result = executeResearchTool({
    id: 'trace-1',
    name: 'search_vault',
    arguments: '{"query":"ligand receptor","top_k":1}',
  }, { retrievalIndex })
  const evidence = JSON.parse(result.content).evidence[0]

  assert.equal(result.isError, false)
  assert.equal(evidence.noteId, 'methods/cellchat.md')
  assert.equal(evidence.source.chunkId, evidence.id)
  assert.equal(evidence.source.path, 'methods/cellchat.md')
})
