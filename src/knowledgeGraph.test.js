import assert from 'node:assert/strict'
import test from 'node:test'

import { createKnowledgeGraph } from './knowledgeGraph.js'

test('createKnowledgeGraph calculates resolved, unresolved, and orphan relationships', () => {
  const cellChat = { id: 'methods/CellChat.md', path: 'methods/CellChat.md', title: 'CellChat', type: 'method' }
  const niche = { id: 'concepts/Niche.md', path: 'concepts/Niche.md', title: 'Spatial niche', type: 'concept' }
  const orphan = { id: 'papers/Orphan.md', path: 'papers/Orphan.md', title: 'Orphan paper', type: 'paper' }
  const graph = createKnowledgeGraph({
    notes: [cellChat, niche, orphan],
    edges: [
      { source: cellChat, target: niche },
      { source: cellChat, target: niche },
      { source: cellChat, target: { title: 'Missing dataset', path: 'Missing dataset', missing: true } },
    ],
  })

  assert.deepEqual(graph.stats, { notes: 3, resolvedLinks: 1, unresolvedLinks: 1, orphans: 1 })
  assert.equal(graph.nodes.find((node) => node.id === cellChat.id).outgoing, 2)
  assert.equal(graph.nodes.find((node) => node.id === niche.id).incoming, 1)
  assert.equal(graph.nodes.find((node) => node.missing).type, 'unresolved')
  assert(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))
})
