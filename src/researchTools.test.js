import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRetrievalIndex } from './retrieval.js'
import { executeResearchTool, RESEARCH_TOOL_DEFINITIONS, toolResultMessage } from './researchTools.js'

const retrievalIndex = buildRetrievalIndex([{
  id: 'methods/cellchat.md',
  path: 'methods/cellchat.md',
  name: 'cellchat.md',
  title: 'CellChat',
  type: 'method',
  frontmatter: {},
  wikilinks: [],
  body: '# CellChat\nCellChat infers ligand receptor communication between cell populations.',
}])

test('exposes a read-only Vault search tool with a bounded JSON schema', () => {
  const tool = RESEARCH_TOOL_DEFINITIONS[0]
  assert.equal(tool.name, 'search_vault')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.required, ['query'])
  assert.equal(tool.parameters.properties.top_k.maximum, 8)
})

test('executes a valid Vault search and returns a protocol-neutral tool result', () => {
  const result = executeResearchTool({ id: 'call-1', name: 'search_vault', arguments: '{"query":"ligand receptor","top_k":3}' }, { retrievalIndex })
  assert.equal(result.isError, false)
  assert.match(result.summary, /Found 1 Vault evidence chunk/)
  assert.equal(JSON.parse(result.content).evidence[0].title, 'CellChat')
  assert.deepEqual(toolResultMessage(result), { role: 'tool', toolCallId: 'call-1', name: 'search_vault', content: result.content })
})

test('returns safe errors for unknown tools and invalid arguments', () => {
  assert.equal(executeResearchTool({ id: 'call-2', name: 'run_shell', arguments: '{}' }, { retrievalIndex }).isError, true)
  assert.match(executeResearchTool({ id: 'call-3', name: 'search_vault', arguments: '{broken' }, { retrievalIndex }).summary, /valid JSON/)
  assert.match(executeResearchTool({ id: 'call-4', name: 'search_vault', arguments: '{"query":"x","top_k":99}' }, { retrievalIndex }).summary, /1 to 8/)
})
