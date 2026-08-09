export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 1

const GRAPH_WIDTH = 900
const GRAPH_HEIGHT = 520
const KNOWN_TYPES = new Set(['paper', 'method', 'concept', 'dataset', 'gene'])

function canonicalType(type) {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : ''
  return KNOWN_TYPES.has(normalized) ? normalized : 'note'
}

function missingNodeId(path) {
  return `missing:${String(path).trim().toLowerCase()}`
}

function nodePosition(index) {
  if (index === 0) return { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }
  const spiralIndex = index - 1
  const angle = spiralIndex * 2.399963229728653
  const radius = Math.min(390, 78 + Math.sqrt(spiralIndex) * 48)
  return {
    x: Math.max(42, Math.min(GRAPH_WIDTH - 42, GRAPH_WIDTH / 2 + Math.cos(angle) * radius)),
    y: Math.max(38, Math.min(GRAPH_HEIGHT - 38, GRAPH_HEIGHT / 2 + Math.sin(angle) * radius * 0.58)),
  }
}

export function createKnowledgeGraph(index) {
  const nodesById = new Map()
  for (const note of index?.notes || []) {
    nodesById.set(note.id, {
      id: note.id,
      title: note.title,
      path: note.path,
      type: canonicalType(note.type),
      rawType: note.type || 'note',
      note,
      missing: false,
      incoming: 0,
      outgoing: 0,
      degree: 0,
    })
  }

  const links = []
  const seenLinks = new Set()
  for (const edge of index?.edges || []) {
    const sourceId = edge.source.id
    const targetId = edge.target.missing ? missingNodeId(edge.target.path) : edge.target.id
    const relationshipId = `${sourceId}->${targetId}`
    if (seenLinks.has(relationshipId)) continue
    seenLinks.add(relationshipId)
    if (!nodesById.has(targetId)) {
      nodesById.set(targetId, {
        id: targetId,
        title: edge.target.title,
        path: edge.target.path,
        type: 'unresolved',
        rawType: 'unresolved',
        note: null,
        missing: true,
        incoming: 0,
        outgoing: 0,
        degree: 0,
      })
    }
    const source = nodesById.get(sourceId)
    const target = nodesById.get(targetId)
    if (!source || !target) continue
    source.outgoing += 1
    target.incoming += 1
    source.degree += 1
    target.degree += 1
    links.push({ id: relationshipId, sourceId, targetId, unresolved: target.missing })
  }

  const nodes = [...nodesById.values()]
    .sort((left, right) => right.degree - left.degree || Number(left.missing) - Number(right.missing) || left.title.localeCompare(right.title))
    .map((node, nodeIndex) => ({
      ...node,
      ...nodePosition(nodeIndex),
      radius: node.missing ? 6 : Math.min(17, 8 + node.degree * 1.4),
      searchText: `${node.title} ${node.path} ${node.rawType}`.toLowerCase(),
    }))

  const neighbors = new Map(nodes.map((node) => [node.id, new Set()]))
  for (const link of links) {
    neighbors.get(link.sourceId)?.add(link.targetId)
    neighbors.get(link.targetId)?.add(link.sourceId)
  }

  const resolvedLinks = links.filter((link) => !link.unresolved).length
  const unresolvedLinks = links.length - resolvedLinks
  const noteNodes = nodes.filter((node) => !node.missing)

  return {
    schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION,
    width: GRAPH_WIDTH,
    height: GRAPH_HEIGHT,
    nodes,
    links,
    neighbors,
    stats: {
      notes: noteNodes.length,
      resolvedLinks,
      unresolvedLinks,
      orphans: noteNodes.filter((node) => node.degree === 0).length,
    },
    types: [...new Set(noteNodes.map((node) => node.type))].sort(),
  }
}
