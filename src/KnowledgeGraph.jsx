import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, FileText, GitBranch, Network, RotateCcw, Search } from 'lucide-react'

import { createKnowledgeGraph } from './knowledgeGraph.js'

function Stat({ value, label, warning = false }) {
  return <div className={`graph-stat ${warning && value ? 'warning' : ''}`}><strong>{value}</strong><span>{label}</span></div>
}

function nodeClass(node, selected, matched) {
  return ['graph-node', `type-${node.type}`, selected ? 'selected' : '', matched ? 'matched' : '', node.missing ? 'missing' : ''].filter(Boolean).join(' ')
}

function viewBoxForNodes(nodes, graph) {
  if (!nodes.length) return `0 0 ${graph.width} ${graph.height}`
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x)
    minY = Math.min(minY, node.y)
    maxY = Math.max(maxY, node.y)
  }
  const width = Math.min(graph.width, Math.max(460, maxX - minX + 140))
  const height = Math.min(graph.height, Math.max(400, maxY - minY + 120))
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const x = Math.max(0, Math.min(graph.width - width, centerX - width / 2))
  const y = Math.max(0, Math.min(graph.height - height, centerY - height / 2))
  return `${x} ${y} ${width} ${height}`
}

export default function KnowledgeGraphSection({ index, onOpenNote }) {
  const graph = useMemo(() => createKnowledgeGraph(index), [index])
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [selectedId, setSelectedId] = useState(() => graph.nodes.find((node) => !node.missing)?.id || graph.nodes[0]?.id)

  const normalizedQuery = query.trim().toLowerCase()
  const matchedIds = useMemo(() => new Set(graph.nodes
    .filter((node) => (typeFilter === 'all' || node.type === typeFilter) && (!normalizedQuery || node.searchText.includes(normalizedQuery)))
    .map((node) => node.id)), [graph.nodes, normalizedQuery, typeFilter])

  const visibleIds = useMemo(() => {
    if (!normalizedQuery) return matchedIds
    const expanded = new Set(matchedIds)
    for (const id of matchedIds) {
      for (const neighborId of graph.neighbors.get(id) || []) expanded.add(neighborId)
    }
    return expanded
  }, [graph.neighbors, matchedIds, normalizedQuery])

  useEffect(() => {
    if (selectedId && visibleIds.has(selectedId)) return
    setSelectedId(graph.nodes.find((node) => visibleIds.has(node.id))?.id || null)
  }, [graph.nodes, selectedId, visibleIds])

  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  const visibleNodes = useMemo(() => graph.nodes.filter((node) => visibleIds.has(node.id)), [graph.nodes, visibleIds])
  const visibleLinks = useMemo(() => graph.links.filter((link) => visibleIds.has(link.sourceId) && visibleIds.has(link.targetId)), [graph.links, visibleIds])
  const selectedNode = nodesById.get(selectedId)
  const selectedLinks = useMemo(() => selectedNode ? graph.links.filter((link) => link.sourceId === selectedNode.id || link.targetId === selectedNode.id) : [], [graph.links, selectedNode])
  const labeledIds = useMemo(() => new Set(graph.nodes.slice(0, 10).map((node) => node.id)), [graph.nodes])
  const graphViewBox = useMemo(() => viewBoxForNodes(visibleNodes, graph), [graph, visibleNodes])

  const resetFilters = () => {
    setQuery('')
    setTypeFilter('all')
  }

  const handleQueryChange = (event) => {
    const nextQuery = event.target.value
    setQuery(nextQuery)
    const normalizedNextQuery = nextQuery.trim().toLowerCase()
    if (!normalizedNextQuery) return
    const directMatch = graph.nodes.find((node) => (typeFilter === 'all' || node.type === typeFilter) && node.searchText.includes(normalizedNextQuery))
    if (directMatch) setSelectedId(directMatch.id)
  }

  return (
    <div className="graph-section">
      <div className="graph-header">
        <div>
          <span className="graph-kicker"><Network size={16} /> Local wikilink graph</span>
          <h2>Knowledge Graph</h2>
          <p>Explore notes, backlinks, and unresolved references parsed from the connected Obsidian vault.</p>
        </div>
        <div className="graph-summary" aria-label="Knowledge graph summary">
          <Stat value={graph.stats.notes} label="notes" />
          <Stat value={graph.stats.resolvedLinks} label="resolved links" />
          <Stat value={graph.stats.orphans} label="orphans" warning />
          <Stat value={graph.stats.unresolvedLinks} label="unresolved" warning />
        </div>
      </div>

      <div className="graph-toolbar">
        <label className="graph-search"><Search size={15} /><span className="visually-hidden">Search graph</span><input value={query} onChange={handleQueryChange} placeholder="Search title, path, or type…" /></label>
        <label className="graph-filter"><span>Type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All types</option>{graph.types.map((type) => <option value={type} key={type}>{type}</option>)}{graph.stats.unresolvedLinks > 0 && <option value="unresolved">unresolved</option>}</select></label>
        <button className="graph-reset" onClick={resetFilters} disabled={!query && typeFilter === 'all'}><RotateCcw size={14} /> Reset</button>
        <span className="graph-result-count">{visibleNodes.length} of {graph.nodes.length} nodes</span>
      </div>

      <div className="graph-workspace">
        <section className="graph-canvas-panel" aria-label="Interactive knowledge graph">
          <svg className="graph-canvas" viewBox={graphViewBox} role="group" aria-label={`${visibleNodes.length} visible knowledge nodes and ${visibleLinks.length} links`}>
            <g className="graph-links">
              {visibleLinks.map((link) => {
                const source = nodesById.get(link.sourceId)
                const target = nodesById.get(link.targetId)
                const active = selectedId === link.sourceId || selectedId === link.targetId
                return <line className={`${active ? 'active' : ''} ${link.unresolved ? 'unresolved' : ''}`} key={link.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />
              })}
            </g>
            <g className="graph-nodes">
              {visibleNodes.map((node) => {
                const selected = node.id === selectedId
                const matched = Boolean(normalizedQuery && matchedIds.has(node.id))
                const showLabel = selected || matched || labeledIds.has(node.id)
                return (
                  <g className={nodeClass(node, selected, matched)} key={node.id} role="button" tabIndex="0" aria-label={`${node.title}, ${node.rawType}, ${node.degree} links`} aria-pressed={selected} onClick={() => setSelectedId(node.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(node.id) } }}>
                    <circle cx={node.x} cy={node.y} r={node.radius + (selected ? 4 : 0)} />
                    {showLabel && <text x={node.x} y={node.y + node.radius + 15} textAnchor="middle">{node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title}</text>}
                  </g>
                )
              })}
            </g>
          </svg>
          {visibleNodes.length === 0 && <div className="graph-no-results"><Search size={20} /><strong>No matching nodes</strong><span>Try another title, path, or note type.</span><button onClick={resetFilters}>Clear filters</button></div>}
          <div className="graph-legend" aria-label="Node type legend">{['paper', 'method', 'concept', 'dataset', 'gene', 'note'].map((type) => graph.nodes.some((node) => node.type === type) && <span className={`type-${type}`} key={type}><i />{type}</span>)}{graph.stats.unresolvedLinks > 0 && <span className="type-unresolved"><i />unresolved</span>}</div>
        </section>

        <aside className="graph-detail-panel">
          {selectedNode ? <>
            <div className="graph-detail-heading">
              <span className={`graph-detail-type type-${selectedNode.type}`}>{selectedNode.missing ? <AlertTriangle size={13} /> : <FileText size={13} />}{selectedNode.rawType}</span>
              <h3>{selectedNode.title}</h3>
              <p>{selectedNode.path}</p>
            </div>
            <div className="graph-node-metrics"><span><strong>{selectedNode.incoming}</strong>backlinks</span><span><strong>{selectedNode.outgoing}</strong>outgoing</span><span><strong>{selectedNode.degree}</strong>total links</span></div>
            <div className="graph-relations">
              <div className="graph-panel-heading"><span>Connected notes</span><small>{selectedLinks.length} relations</small></div>
              {selectedLinks.length ? selectedLinks.map((link) => {
                const outgoing = link.sourceId === selectedNode.id
                const neighbor = nodesById.get(outgoing ? link.targetId : link.sourceId)
                return <button key={link.id} onClick={() => setSelectedId(neighbor.id)}><span className={neighbor.missing ? 'missing' : ''}>{neighbor.title}</span><small>{outgoing ? 'outgoing' : 'backlink'} <ArrowRight size={11} /></small></button>
              }) : <div className="graph-empty">This note is not linked to another Vault note.</div>}
            </div>
            {selectedNode.note ? <button className="graph-open-note" onClick={() => onOpenNote(selectedNode.note)}>Open Markdown note <ArrowRight size={15} /></button> : <div className="graph-unresolved-note"><GitBranch size={15} /><span>Create a Markdown note matching this wikilink to resolve it.</span></div>}
          </> : <div className="graph-detail-empty"><Network size={24} /><span>Select a graph node to inspect its relationships.</span></div>}
        </aside>
      </div>
    </div>
  )
}
