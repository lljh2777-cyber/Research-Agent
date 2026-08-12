import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Hash,
  Highlighter,
  LayoutPanelLeft,
  LayoutPanelTop,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Tag,
  X,
} from 'lucide-react'

import { createKnowledgeGraph } from './knowledgeGraph.js'
import { buildVaultFileTree, collectVaultTags, DEFAULT_DOCK_LAYOUT, extractMarkdownBlockReferences, extractMarkdownOutline, filterVaultFileTree, markdownBlockReferenceAnchorId, moveDockPanel, normalizeDockLayout, parseWikilinks, resolveWikilink } from './knowledgeWorkspace.js'
import { AgentConversationPanel } from './features/knowledge/AgentConversationPanel.jsx'
import { AnnotationEditor, SelectionChooser } from './features/knowledge/KnowledgeRoundTwo.jsx'
import { createKnowledgeContextFixture } from './features/knowledge/fixtures.js'
import { activeAnnotationRanges, isEditableSelectionTarget, mapDomSelectionToMarkdown, splitSourceText } from './features/knowledge/annotationSelection.js'
import { createAnnotationPatchIntent, createTextAnchor, migrateAnnotationToV2, normalizeAnnotation, normalizeAnnotationArchiveTargets, parseAnnotationMarkdown, relocateTextAnchor } from './annotations/annotation.js'
import { createKnowledgeArchiveActionInput, createKnowledgeArchiveResult, knowledgeArchiveResultToAnnotationArchive } from './research/knowledgeArchive.js'
import { executeKnowledgeArchiveAction } from './features/knowledge/archiveActionClient.js'
import { ANNOTATION_WRITE_STAGES, createAnnotationWriteIdempotencyKey } from './features/knowledge/annotationWriteClient.js'

const LAYOUT_KEY = 'bioresearch-os:knowledge-dock-layout'

function newAnnotationWriteTarget(annotationId) {
  if (!/^annotation-[a-zA-Z0-9._-]+$/.test(annotationId)) {
    throw new TypeError('A new annotation needs a generated safe id before its first save.')
  }
  return `wiki/annotations/${annotationId}.md`
}

const PANEL_META = {
  files: { title: 'Files', icon: FolderOpen },
  outline: { title: 'Outline', icon: LayoutPanelTop },
  tags: { title: 'Tags', icon: Tag },
  graph: { title: 'Local graph', icon: Network },
  web: { title: 'Web browser', icon: Globe2 },
  plugins: { title: 'Research tools', icon: Boxes },
  agent: { title: 'Curator', icon: Bot },
}

function loadDockLayout() {
  try {
    return normalizeDockLayout(JSON.parse(window.localStorage.getItem(LAYOUT_KEY)))
  } catch {
    return normalizeDockLayout(DEFAULT_DOCK_LAYOUT)
  }
}

function SourceMappedText({ value, sourceStart, annotations, onOpenAnnotation, interactive = true }) {
  return splitSourceText(value, sourceStart, annotations).map((part) => {
    const sourceAttributes = { 'data-source-start': part.start, 'data-source-end': part.end }
    if (!part.annotations.length) return <span {...sourceAttributes} key={part.start}>{part.text}</span>
    const annotation = part.annotations[0]
    const label = part.annotations.length === 1
      ? `Open annotation for ${annotation.anchor.quote.exact}`
      : `Open ${part.annotations.length} overlapping annotations for ${part.text}`
    if (!interactive) return <mark className="annotation-highlight" {...sourceAttributes} data-annotation-count={part.annotations.length} key={part.start}>{part.text}</mark>
    return <button type="button" className="annotation-highlight" aria-label={label} data-annotation-count={part.annotations.length} onClick={() => onOpenAnnotation(annotation)} {...sourceAttributes} key={part.start}>{part.text}</button>
  })
}

function InlineMarkdown({ value, sourceStart, note, notes, annotations, onNavigate, onOpenAnnotation }) {
  let cursor = 0
  return parseWikilinks(value).map((segment, index) => {
    if (segment.type === 'text') {
      const segmentStart = sourceStart + cursor
      cursor += segment.value.length
      return <SourceMappedText value={segment.value} sourceStart={segmentStart} annotations={annotations} onOpenAnnotation={onOpenAnnotation} key={`text-${segmentStart}`} />
    }
    const rawStart = value.indexOf(segment.raw, cursor)
    cursor = rawStart + segment.raw.length
    const labelOffset = segment.raw.indexOf(segment.label)
    const mappedLabel = labelOffset >= 0 ? segment.label : segment.raw
    const mappedStart = sourceStart + rawStart + (labelOffset >= 0 ? labelOffset : 0)
    const resolved = resolveWikilink(notes, note, segment)
    const unavailable = resolved.missing || resolved.missingHeading
    const linkedAnnotations = activeAnnotationRanges(annotations).filter((annotation) => annotation.relocation.start < mappedStart + mappedLabel.length && annotation.relocation.end > mappedStart)
    const title = linkedAnnotations.length
      ? `Open ${linkedAnnotations.length === 1 ? 'annotation' : `${linkedAnnotations.length} overlapping annotations`} for ${mappedLabel}`
      : resolved.missing
        ? `Note not found: ${segment.target}`
        : resolved.missingHeading
          ? `${segment.heading.startsWith('^') ? 'Block reference' : 'Heading'} not found: ${segment.heading}`
          : `Open ${resolved.note.title}${segment.heading ? ` · ${segment.heading}` : ''}`
    const opensAnnotation = linkedAnnotations.length > 0
    return <button
      type="button"
      className={`document-wikilink ${unavailable ? 'missing' : ''} ${linkedAnnotations.length ? 'annotated' : ''}`}
      disabled={unavailable && !opensAnnotation}
      title={title}
      onClick={() => opensAnnotation ? onOpenAnnotation(linkedAnnotations[0]) : onNavigate(resolved.note, resolved.anchorId)}
      key={`${segment.raw}-${index}`}
    ><SourceMappedText value={mappedLabel} sourceStart={mappedStart} annotations={annotations} onOpenAnnotation={onOpenAnnotation} interactive={false} /></button>
  })
}

function metadataText(value) {
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value !== 'string') return String(value)
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.join(', ')
    } catch {
      return value
    }
  }
  return value
}

function splitTrailingBlockReference(value = '') {
  const text = String(value)
  const match = text.match(/(?:^|\s)\^([A-Za-z0-9-]+)\s*$/)
  if (!match) return { value: text, anchorId: null }
  return {
    value: text.slice(0, match.index).trimEnd(),
    anchorId: markdownBlockReferenceAnchorId(match[1]),
  }
}

function MarkdownDocument({ note, notes, selection, annotations, onNavigate, onSelectPassage, onSelectionAction, onClearSelection, onOpenAnnotation, aiAvailable, aiUnavailableReason }) {
  const documentRef = useRef(null)
  const [chooserPosition, setChooserPosition] = useState(null)
  const blocks = useMemo(() => {
    if (!note?.body) return []
    const blockReferenceCounts = extractMarkdownBlockReferences(note.body).reduce((counts, reference) => {
      counts.set(reference.blockId, (counts.get(reference.blockId) || 0) + 1)
      return counts
    }, new Map())
    const uniqueBlockAnchorId = (blockId) => blockReferenceCounts.get(blockId) === 1 ? markdownBlockReferenceAnchorId(blockId) : null
    const lines = note.body.split(/\r?\n/)
    let sourceCursor = 0
    const lineOffsets = lines.map((line) => { const offset = note.body.indexOf(line, sourceCursor); sourceCursor = offset + line.length + (note.body.slice(offset + line.length).startsWith('\r\n') ? 2 : 1); return offset })
    const output = []
    let paragraph = []
    let paragraphStart = null
    let paragraphEnd = null
    let paragraphHeading = null
    let code = []
    let codeStart = null
    let inCode = false
    let inComment = false
    let currentHeading = null
    const flushParagraph = () => {
      if (paragraph.length) {
        const rawValue = note.body.slice(lineOffsets[paragraphStart], lineOffsets[paragraphEnd] + lines[paragraphEnd].length)
        const mapped = splitTrailingBlockReference(rawValue)
        const blockId = mapped.anchorId?.replace(/^block-reference-/, '') || ''
        output.push({
          type: 'paragraph',
          value: mapped.value,
          anchorExact: mapped.value,
          blockAnchorId: uniqueBlockAnchorId(blockId),
          start: lineOffsets[paragraphStart],
          end: lineOffsets[paragraphStart] + mapped.value.length,
          heading: paragraphHeading,
          lineStart: paragraphStart + 1,
          lineEnd: paragraphEnd + 1,
        })
      }
      paragraph = []
      paragraphStart = null
      paragraphEnd = null
      paragraphHeading = null
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (inComment) {
        if (line.includes('-->')) inComment = false
        continue
      }
      if (line.trim().startsWith('<!--')) {
        if (!line.includes('-->')) inComment = true
        continue
      }
      if (line.trim().startsWith('```')) {
        flushParagraph()
        if (inCode) {
          output.push({ type: 'code', value: code.join('\n'), lineStart: codeStart + 1, lineEnd: index })
          code = []
          codeStart = null
        } else {
          codeStart = index + 1
        }
        inCode = !inCode
        continue
      }
      if (inCode) {
        code.push(line)
        continue
      }
      const standaloneBlockReference = line.match(/^\s*\^([A-Za-z0-9-]+)\s*$/)
      if (standaloneBlockReference) {
        flushParagraph()
        output.push({
          type: 'block-reference',
          blockId: standaloneBlockReference[1],
          id: uniqueBlockAnchorId(standaloneBlockReference[1]),
          start: lineOffsets[index],
          end: lineOffsets[index] + line.length,
          lineStart: index + 1,
          lineEnd: index + 1,
        })
        continue
      }
      const mappedLine = splitTrailingBlockReference(line)
      const mappedLineBlockId = mappedLine.anchorId?.replace(/^block-reference-/, '') || ''
      const mappedLineAnchorId = uniqueBlockAnchorId(mappedLineBlockId)
      const renderedLine = mappedLine.value
      const heading = renderedLine.match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        flushParagraph()
        currentHeading = { text: heading[2], level: heading[1].length, line: index + 1 }
        const isRepeatedTitle = heading[1].length === 1 && heading[2].trim() === note.title.trim() && output.length === 0
        if (!isRepeatedTitle) output.push({ type: 'heading', level: heading[1].length, value: heading[2], anchorExact: heading[2], start: lineOffsets[index] + heading[1].length + 1, end: lineOffsets[index] + renderedLine.length, id: `heading-${index}`, blockAnchorId: mappedLineAnchorId, lineStart: index + 1, lineEnd: index + 1, heading: currentHeading })
      } else if (/^[-*]\s+/.test(renderedLine)) {
        flushParagraph()
        const value = renderedLine.replace(/^[-*]\s+/, '')
        const start = lineOffsets[index] + renderedLine.indexOf(value)
        output.push({ type: 'list', value, anchorExact: value, blockAnchorId: mappedLineAnchorId, start, end: start + value.length, heading: currentHeading, lineStart: index + 1, lineEnd: index + 1 })
      } else if (/^>\s?/.test(renderedLine)) {
        flushParagraph()
        const value = renderedLine.replace(/^>\s?/, '')
        const start = lineOffsets[index] + renderedLine.indexOf(value)
        output.push({ type: 'quote', value, anchorExact: value, blockAnchorId: mappedLineAnchorId, start, end: start + value.length, heading: currentHeading, lineStart: index + 1, lineEnd: index + 1 })
      } else if (!renderedLine.trim()) {
        flushParagraph()
      } else {
        if (paragraphStart == null) {
          paragraphStart = index
          paragraphHeading = currentHeading
        }
        paragraphEnd = index
        paragraph.push(line.trim())
      }
    }
    flushParagraph()
    return output
  }, [note])

  const commitDomSelection = useCallback((openChooser) => {
    const domSelection = window.getSelection()
    const mapped = mapDomSelectionToMarkdown(domSelection, documentRef.current, note?.body)
    if (!mapped) return false
    try {
      const nextSelection = {
        selectionId: `${note.id}:${mapped.start}:${mapped.end}`,
        anchor: createTextAnchor(note.body, mapped),
      }
      onSelectPassage(nextSelection)
      if (openChooser) {
        const rect = domSelection.getRangeAt(0).getBoundingClientRect()
        setChooserPosition({
          x: Math.max(8, Math.min(window.innerWidth - 190, rect.left + rect.width / 2 - 90)),
          y: Math.max(8, rect.top > 54 ? rect.top - 46 : rect.bottom + 8),
        })
      }
      return true
    } catch {
      setChooserPosition(null)
      onClearSelection()
      return false
    }
  }, [note, onClearSelection, onSelectPassage])

  useEffect(() => {
    const handleShortcut = (event) => {
      if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.key.toLocaleLowerCase() !== 's') return
      if (isEditableSelectionTarget(event.target)) return
      if (commitDomSelection(true)) event.preventDefault()
    }
    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [commitDomSelection])

  if (!note) return null
  const metadata = Object.entries(note.frontmatter || {}).filter(([, value]) => value !== '' && value != null)
  return (
    <article className="knowledge-document" ref={documentRef} onMouseUp={(event) => {
      if (event.button !== 0) return
      if (event.target.closest?.('.selection-chooser')) return
      window.setTimeout(() => commitDomSelection(true), 0)
    }}>
      <div className="document-path">{note.path}</div>
      <h1>{note.title}</h1>
      {metadata.length > 0 && <dl className="document-properties">
        {metadata.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{metadataText(value)}</dd></div>)}
      </dl>}
      <div className="document-markdown">
        {blocks.map((block, index) => {
          const content = (() => {
          if (block.type === 'heading') {
            const Heading = `h${Math.min(6, block.level + 1)}`
            return <Heading id={block.id}><InlineMarkdown value={block.value} sourceStart={block.start} note={note} notes={notes} annotations={annotations} onNavigate={onNavigate} onOpenAnnotation={onOpenAnnotation} /></Heading>
          }
          if (block.type === 'list') return <div className="document-list-item"><CircleDot size={9} /> <span><InlineMarkdown value={block.value} sourceStart={block.start} note={note} notes={notes} annotations={annotations} onNavigate={onNavigate} onOpenAnnotation={onOpenAnnotation} /></span></div>
          if (block.type === 'quote') return <blockquote><InlineMarkdown value={block.value} sourceStart={block.start} note={note} notes={notes} annotations={annotations} onNavigate={onNavigate} onOpenAnnotation={onOpenAnnotation} /></blockquote>
          if (block.type === 'code') return <pre><code>{block.value}</code></pre>
          if (block.type === 'block-reference') return <span className="document-block-reference" id={block.id} aria-label={`Obsidian block ${block.blockId}`} />
          return <p><InlineMarkdown value={block.value} sourceStart={block.start} note={note} notes={notes} annotations={annotations} onNavigate={onNavigate} onOpenAnnotation={onOpenAnnotation} /></p>
          })()
          return <div
            className={`selectable-markdown-block ${block.type === 'code' ? 'not-selectable' : ''}`}
            id={block.blockAnchorId || undefined}
            key={`${block.id || block.type}-${index}`}
          >
            {content}
          </div>
        })}
      </div>
      <SelectionChooser selection={selection} position={chooserPosition} onAction={(action) => { const position = chooserPosition; setChooserPosition(null); onSelectionAction(action, position) }} onDismiss={() => setChooserPosition(null)} aiAvailable={aiAvailable} aiUnavailableReason={aiUnavailableReason} />
    </article>
  )
}

function FileTreeNode({ node, selectedId, expandedFolders, forceExpanded, onToggle, onSelect }) {
  if (node.type === 'folder') {
    const expanded = forceExpanded || expandedFolders.has(node.path)
    return <div className="file-tree-branch">
      <button className="file-tree-row folder-row" aria-expanded={expanded} onClick={() => onToggle(node.path)} title={node.path}>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? <FolderOpen size={13} /> : <Folder size={13} />}
        <span>{node.name}</span>
      </button>
      {expanded && <div className="file-tree-children">
        {node.children.map((child) => <FileTreeNode node={child} selectedId={selectedId} expandedFolders={expandedFolders} forceExpanded={forceExpanded} onToggle={onToggle} onSelect={onSelect} key={`${child.type}-${child.id}`} />)}
      </div>}
    </div>
  }

  return <button className={`file-tree-row file-row ${node.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(node.note)} title={node.path}>
    <span className="file-tree-spacer" />
    <FileText size={13} />
    <span>{node.name}</span>
  </button>
}

function FilesPanel({ notes, selectedId, onSelect }) {
  const [query, setQuery] = useState('')
  const [expandedFolders, setExpandedFolders] = useState(() => new Set(['wiki', 'wiki/annotations']))
  const tree = useMemo(() => buildVaultFileTree(notes), [notes])
  const filteredTree = useMemo(() => filterVaultFileTree(tree, query), [tree, query])
  const forceExpanded = Boolean(query.trim())

  useEffect(() => {
    const selected = notes.find((note) => note.id === selectedId)
    if (!selected) return
    const folders = String(selected.path).split('/').slice(0, -1)
    setExpandedFolders((current) => {
      const next = new Set(current)
      let path = ''
      folders.forEach((folder) => {
        path = path ? `${path}/${folder}` : folder
        next.add(path)
      })
      return next
    })
  }, [notes, selectedId])

  const handleToggle = (path) => {
    if (forceExpanded) return
    setExpandedFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return <div className="files-panel-content">
    <label className="dock-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" /></label>
    <div className="file-tree">
      {filteredTree.map((node) => <FileTreeNode node={node} selectedId={selectedId} expandedFolders={expandedFolders} forceExpanded={forceExpanded} onToggle={handleToggle} onSelect={onSelect} key={`${node.type}-${node.id}`} />)}
      {!notes.length && <div className="dock-empty">Connect a Vault to browse Markdown files.</div>}
      {notes.length > 0 && filteredTree.length === 0 && <div className="dock-empty">No matching notes.</div>}
    </div>
  </div>
}

function OutlinePanel({ note }) {
  const outline = useMemo(() => extractMarkdownOutline(note?.body), [note])
  const handleHeading = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return <div className="outline-list">
    {outline.map((heading) => <button style={{ '--outline-level': heading.level }} onClick={() => handleHeading(heading.id)} key={heading.id}><Hash size={11} /><span>{heading.title}</span></button>)}
    {!outline.length && <div className="dock-empty">Headings in the open note appear here.</div>}
  </div>
}

function TagsPanel({ tags }) {
  return <div className="tag-cloud">
    {tags.map((tag) => <button key={tag.name}><Hash size={10} /><span>{tag.name}</span><small>{tag.count}</small></button>)}
    {!tags.length && <div className="dock-empty">No tags found in this Vault.</div>}
  </div>
}

function MiniGraph({ graph, selectedId, onSelect }) {
  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes])
  return <div className="dock-graph">
    {graph.nodes.length ? <svg viewBox={`0 0 ${graph.width} ${graph.height}`} aria-label={`${graph.nodes.length} knowledge nodes`}>
      <g>{graph.links.map((link) => {
        const source = nodesById.get(link.sourceId)
        const target = nodesById.get(link.targetId)
        return source && target ? <line className={selectedId === link.sourceId || selectedId === link.targetId ? 'active' : ''} key={link.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} /> : null
      })}</g>
      <g>{graph.nodes.map((node, index) => <circle className={`type-${node.type} ${node.id === selectedId ? 'selected' : ''}`} role="button" tabIndex="0" aria-label={node.title} key={`${node.id}-${index}`} cx={node.x} cy={node.y} r={Math.max(8, node.radius)} onClick={() => onSelect(node)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(node) }} />)}</g>
    </svg> : <div className="dock-empty">Wikilinks will form a local graph here.</div>}
    <div className="dock-graph-stats"><span><strong>{graph.stats.notes}</strong> notes</span><span><strong>{graph.stats.resolvedLinks}</strong> links</span><span><strong>{graph.stats.orphans}</strong> orphans</span></div>
  </div>
}

function WebPanel() {
  const [address, setAddress] = useState('https://pubmed.ncbi.nlm.nih.gov/')
  const openAddress = () => window.open(address, '_blank', 'noopener,noreferrer')
  return <div className="web-panel-content">
    <form onSubmit={(event) => { event.preventDefault(); openAddress() }}><Globe2 size={12} /><input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Web address" /><button aria-label="Open web address"><ExternalLink size={12} /></button></form>
    <div className="web-preview">
      <span>Literature browser</span>
      <strong>Search papers without leaving your research context.</strong>
      <p>Open PubMed, bioRxiv, DOI pages, and linked datasets in a dedicated research tab.</p>
      <button onClick={openAddress}>Open current address <ExternalLink size={12} /></button>
    </div>
  </div>
}

function PluginsPanel() {
  const tools = [
    ['Deep read', BookOpen],
    ['Knowledge search', Search],
    ['Vault audit', RefreshCw],
    ['Code analysis', Boxes],
  ]
  return <div className="plugin-grid">{tools.map(([label, Icon]) => <button key={label}><Icon size={14} /><span>{label}</span><small>Ready</small></button>)}</div>
}

function Dock({ side, panelIds, activePanelId, draggingId, onActivate, onDragStart, onDragEnd, onDrop, renderPanel }) {
  const activePanel = panelIds.includes(activePanelId) ? activePanelId : panelIds[0]
  return <aside className={`knowledge-dock dock-${side}`} data-sidebar={side} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, side)}>
    <div className="dock-tabbar" role="tablist" aria-label={`${side} sidebar panels`}>
      {panelIds.map((panelId) => {
        const meta = PANEL_META[panelId]
        const Icon = meta.icon
        const active = panelId === activePanel
        return <button className={`dock-tab ${active ? 'active' : ''} ${draggingId === panelId ? 'dragging' : ''}`} role="tab" aria-selected={active} aria-label={`${meta.title} panel`} title={`${meta.title} · drag to move`} data-panel-tab={panelId} draggable onClick={() => onActivate(side, panelId)} onDragStart={(event) => onDragStart(event, panelId)} onDragEnd={onDragEnd} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, side, panelId)} key={panelId}><Icon size={17} /><span>{meta.title}</span></button>
      })}
      <span className="dock-tab-dropzone" aria-hidden="true" />
    </div>
    {activePanel ? <section className={`dock-active-panel dock-panel-${activePanel}`} data-panel-id={activePanel} role="tabpanel" aria-label={PANEL_META[activePanel].title}>{renderPanel(activePanel)}</section> : <div className="dock-empty">Drag a panel tab here.</div>}
  </aside>
}

export default function KnowledgeGraphSection({
  index,
  onConnectVault,
  vaultId = '',
  vaultName = '',
  vaultRevision = '',
  knowledgeSession,
  knowledgeInput = '',
  onKnowledgeInput,
  knowledgeToolDescriptors = [],
  knowledgeApproval,
  onKnowledgeAction,
  onKnowledgeSubmit,
  onResolveKnowledgeApproval,
  onContinueInResearch,
  onKnowledgeContextChange,
  annotationRuntime,
  actionRuntime,
  provider,
  onOpenSettings,
}) {
  const graph = useMemo(() => createKnowledgeGraph(index), [index])
  const notes = index?.notes || []
  const [selectedNote, setSelectedNote] = useState(() => notes[0] || null)
  const [openNoteIds, setOpenNoteIds] = useState(() => notes[0] ? [notes[0].id] : [])
  const [dockLayout, setDockLayout] = useState(loadDockLayout)
  const [activePanels, setActivePanels] = useState({ left: 'files', right: 'agent' })
  const [draggingId, setDraggingId] = useState(null)
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const [pendingAnchor, setPendingAnchor] = useState(null)
  const [selection, setSelection] = useState(null)
  const [annotations, setAnnotations] = useState([])
  const [activeAnnotation, setActiveAnnotation] = useState(null)
  const [annotationWorkbenchOpen, setAnnotationWorkbenchOpen] = useState(false)
  const [annotationDraft, setAnnotationDraft] = useState({ manual: '', ai: '' })
  const [annotationMeta, setAnnotationMeta] = useState({})
  const [annotationVaultId, setAnnotationVaultId] = useState('')
  const [annotationFocusSection, setAnnotationFocusSection] = useState('manual')
  const [annotationPersistenceMessage, setAnnotationPersistenceMessage] = useState('')
  const [annotationAiStatus, setAnnotationAiStatus] = useState(null)
  const [annotationStage, setAnnotationStage] = useState('view')
  const [annotationPosition, setAnnotationPosition] = useState(null)
  const [annotationInitialDraft, setAnnotationInitialDraft] = useState({ manual: '', ai: '' })
  const [annotationProvenance, setAnnotationProvenance] = useState(null)
  const [annotationCloseGuard, setAnnotationCloseGuard] = useState(false)
  const [annotationArchiveTargets, setAnnotationArchiveTargets] = useState('')
  const [annotationArchiveEvidence, setAnnotationArchiveEvidence] = useState([])
  const [annotationArchiveOutcome, setAnnotationArchiveOutcome] = useState(null)
  const [annotationArchiveRunning, setAnnotationArchiveRunning] = useState(false)
  const pendingExplainIdRef = useRef(null)
  const explainControllerRef = useRef(null)
  const archiveControllerRef = useRef(null)

  const clearAnnotationEditor = () => {
    pendingExplainIdRef.current = null
    explainControllerRef.current?.abort()
    explainControllerRef.current = null
    setActiveAnnotation(null)
    setAnnotationDraft({ manual: '', ai: '' })
    setAnnotationInitialDraft({ manual: '', ai: '' })
    setAnnotationProvenance(null)
    setAnnotationAiStatus(null)
    setAnnotationStage('view')
    setAnnotationPosition(null)
    setAnnotationCloseGuard(false)
    setAnnotationArchiveTargets('')
    setAnnotationArchiveEvidence([])
    setAnnotationArchiveOutcome(null)
    setAnnotationArchiveRunning(false)
  }

  const discardAnnotationWorkbench = () => {
    clearAnnotationEditor()
    setAnnotationWorkbenchOpen(false)
  }

  const annotationHasUnsavedChanges = Boolean(activeAnnotation && (
    annotationDraft.manual !== annotationInitialDraft.manual
    || annotationDraft.ai !== annotationInitialDraft.ai
    || annotationStage === 'generating'
  ))

  const dismissAnnotationWorkbench = () => {
    if (annotationHasUnsavedChanges) {
      setAnnotationCloseGuard(true)
      return
    }
    discardAnnotationWorkbench()
  }

  useEffect(() => {
    const mobileWorkspace = window.matchMedia('(max-width: 900px)')
    const syncResponsiveDocks = (event) => {
      setLeftOpen(!event.matches)
      setRightOpen(!event.matches)
    }
    syncResponsiveDocks(mobileWorkspace)
    mobileWorkspace.addEventListener('change', syncResponsiveDocks)
    return () => mobileWorkspace.removeEventListener('change', syncResponsiveDocks)
  }, [])

  useEffect(() => {
    setSelectedNote((current) => notes.find((note) => note.id === current?.id) || notes[0] || null)
    setOpenNoteIds((current) => {
      const available = new Set(notes.map((note) => note.id))
      const valid = current.filter((id) => available.has(id))
      return valid.length ? valid : notes[0] ? [notes[0].id] : []
    })
  }, [notes])

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(dockLayout))
  }, [dockLayout])

  const outline = useMemo(() => extractMarkdownOutline(selectedNote?.body), [selectedNote])
  const tags = useMemo(() => collectVaultTags(notes), [notes])
  const knowledgeContext = useMemo(() => createKnowledgeContextFixture({
    surface: 'knowledge-sidebar',
    vaultId: notes.length ? vaultId || vaultName : '',
    vaultName,
    vaultRevision,
    activeNote: selectedNote ? { ...selectedNote, revision: selectedNote.revision || vaultRevision } : null,
    selection,
    contextRevision: `ui-${vaultRevision || '0'}-${selectedNote?.id || 'none'}-${selection?.selectionId || 'none'}`,
  }), [notes.length, vaultId, vaultName, vaultRevision, selectedNote, selection])

  useEffect(() => {
    onKnowledgeContextChange?.(knowledgeContext)
  }, [knowledgeContext, onKnowledgeContextChange])

  useEffect(() => {
    setActivePanels((current) => ({
      left: dockLayout.left.includes(current.left) ? current.left : dockLayout.left[0] || null,
      right: dockLayout.right.includes(current.right) ? current.right : dockLayout.right[0] || null,
    }))
  }, [dockLayout])

  const notesById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes])
  const openNotes = useMemo(() => openNoteIds.map((id) => notesById.get(id)).filter(Boolean), [notesById, openNoteIds])

  useEffect(() => {
    if (!annotationRuntime?.available || !vaultId || !notes.length) {
      setAnnotations([])
      setAnnotationMeta({})
      setAnnotationVaultId('')
      return undefined
    }
    const controller = new AbortController()
    let cancelled = false
    const restoreAnnotations = async () => {
      const listed = await annotationRuntime.list({ signal: controller.signal })
      if (!listed?.ok) throw new Error(listed?.error || listed?.reason || 'Annotations could not be listed.')
      const restored = await Promise.all((listed.annotations || []).map(async (entry) => {
        const loaded = await annotationRuntime.read({ path: entry.path, signal: controller.signal })
        if (!loaded?.ok || typeof loaded.content !== 'string') throw new Error(loaded?.error || `Annotation ${entry.path} could not be read.`)
        const parsed = parseAnnotationMarkdown(loaded.content)
        const note = notesById.get(parsed.source.noteId) || notes.find((candidate) => candidate.path === parsed.source.path || candidate.path.endsWith('/' + parsed.source.path))
        if (!note) return null
        const record = normalizeAnnotation({ ...parsed, relocation: relocateTextAnchor(note.body, parsed.anchor) })
        return { record, path: entry.path, revision: loaded.revision || entry.revision || null }
      }))
      if (cancelled) return
      const available = restored.filter(Boolean)
      setAnnotations(available.map(({ record }) => record))
      setAnnotationMeta(Object.fromEntries(available.map(({ record, path, revision }) => [record.id, { path, revision }])))
      setAnnotationVaultId(listed.vaultId || vaultId)
      setAnnotationPersistenceMessage('')
    }
    restoreAnnotations().catch((error) => {
      if (!cancelled && error?.name !== 'AbortError') setAnnotationPersistenceMessage(error.message)
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [annotationRuntime, notes, notesById, vaultId, vaultRevision])

  const handleSelectNote = (note, anchorId = null) => {
    if (!note) return
    setSelectedNote(note)
    setSelection(null)
    dismissAnnotationWorkbench()
    setOpenNoteIds((current) => current.includes(note.id) ? current : [...current, note.id])
    setPendingAnchor(anchorId ? { noteId: note.id, anchorId } : null)
  }

  useEffect(() => {
    if (!pendingAnchor || selectedNote?.id !== pendingAnchor.noteId) return undefined
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(pendingAnchor.anchorId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setPendingAnchor(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pendingAnchor, selectedNote])

  const handleCloseNote = (noteId) => {
    setOpenNoteIds((current) => {
      const closingIndex = current.indexOf(noteId)
      const next = current.filter((id) => id !== noteId)
      if (selectedNote?.id === noteId) {
        const nextId = next[Math.min(closingIndex, next.length - 1)]
        setSelectedNote(nextId ? notesById.get(nextId) || null : null)
        setSelection(null)
        dismissAnnotationWorkbench()
      }
      return next
    })
  }

  const handleDragStart = (event, panelId) => {
    setDraggingId(panelId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/knowledge-panel', panelId)
  }
  const handleDrop = (event, side, beforePanelId = null) => {
    event.preventDefault()
    event.stopPropagation()
    const panelId = event.dataTransfer.getData('text/knowledge-panel') || draggingId
    if (panelId) {
      setDockLayout((current) => moveDockPanel(current, panelId, side, beforePanelId === panelId ? null : beforePanelId))
      setActivePanels((current) => ({ ...current, [side]: panelId }))
    }
    setDraggingId(null)
  }
  const resetLayout = () => {
    setDockLayout(normalizeDockLayout(DEFAULT_DOCK_LAYOUT))
    setActivePanels({ left: 'files', right: 'agent' })
    setLeftOpen(true)
    setRightOpen(true)
  }

  const selectGraphNode = (node) => {
    if (node.note) handleSelectNote(node.note)
  }

  const openAnnotationEditor = (focusSection = 'manual', position = null) => {
    const anchor = knowledgeContext?.selection?.anchor || activeAnnotation?.anchor
    if (!anchor) return
    const existing = annotations.find((item) => item.source.noteId === selectedNote?.id && item.anchor.position.start === anchor.position.start && item.anchor.position.end === anchor.position.end)
    const timestamp = new Date().toISOString()
    const next = existing || normalizeAnnotation({
      schemaVersion: 1,
      id: `annotation-${selectedNote.id}-${anchor.position.start}-${anchor.position.end}`,
      source: {
        vaultId: annotationVaultId || knowledgeContext.vault.id,
        noteId: knowledgeContext.activeNote.id,
        path: knowledgeContext.activeNote.path,
        revision: knowledgeContext.activeNote.revision,
      },
      anchor,
      sections: { manual: '', ai: '' },
      archived: false,
      timestamps: { createdAt: timestamp, updatedAt: timestamp, archivedAt: null },
      relocation: relocateTextAnchor(selectedNote.body, anchor),
    })
    const migrated = migrateAnnotationToV2(next)
    setActiveAnnotation(migrated)
    setAnnotationWorkbenchOpen(true)
    setAnnotationDraft({ ...migrated.sections })
    setAnnotationInitialDraft({ ...migrated.sections })
    setAnnotationProvenance(migrated.aiProvenance)
    setAnnotationFocusSection(focusSection)
    setAnnotationStage('edit')
    setAnnotationPosition(position || { x: Math.max(8, window.innerWidth - 370), y: 72 })
    setAnnotationPersistenceMessage('')
    setAnnotationAiStatus(null)
    setAnnotationCloseGuard(false)
    return migrated
  }

  const requireExactWrittenAnnotation = async (nextAnnotation, result) => {
    if (typeof result?.path !== 'string' || !result.path || typeof result?.revision !== 'string' || !result.revision) {
      throw new Error('Runtime saved the annotation without returning its exact path and revision; formal archive is disabled.')
    }
    if (result.annotationId !== nextAnnotation.id) {
      throw new Error('Runtime returned a mismatched annotation identity; formal archive is disabled.')
    }
    const loaded = await annotationRuntime.read({ path: result.path })
    if (!loaded?.ok || typeof loaded.content !== 'string') {
      throw new Error(loaded?.error || 'Runtime saved the annotation, but its exact record could not be reread.')
    }
    if (loaded.path !== result.path || loaded.revision !== result.revision) {
      throw new Error('Runtime write/read identity did not match exactly; formal archive is disabled.')
    }
    const record = normalizeAnnotation(parseAnnotationMarkdown(loaded.content))
    if (record.id !== result.annotationId) {
      throw new Error('The reread annotation id did not match the Runtime write result; formal archive is disabled.')
    }
    return { record, metadata: { path: loaded.path, revision: loaded.revision } }
  }

  const commitAnnotationWrite = async (nextAnnotation, metadataOverride, idempotencyKey) => {
    if (!annotationRuntime?.available) throw new Error(annotationRuntime?.reason || 'Annotation persistence is unavailable.')
    const metadata = metadataOverride || annotationMeta[nextAnnotation.id] || {}
    const path = metadata.path || newAnnotationWriteTarget(nextAnnotation.id)
    const intent = createAnnotationPatchIntent(nextAnnotation, { path, expectedRevision: metadata.revision || null })
    const result = await annotationRuntime.write({ intent, approval: { status: 'approved' }, idempotencyKey })
    if (!result?.ok) throw new Error(result?.error || result?.reason || 'The annotation could not be saved.')
    const confirmed = await requireExactWrittenAnnotation(nextAnnotation, result)
    const nextMetadata = confirmed.metadata
    setAnnotations((current) => [...current.filter((item) => item.id !== confirmed.record.id), confirmed.record])
    setAnnotationMeta((current) => ({ ...current, [confirmed.record.id]: nextMetadata }))
    setActiveAnnotation(confirmed.record)
    setAnnotationWorkbenchOpen(true)
    setAnnotationDraft({ ...confirmed.record.sections })
    setAnnotationInitialDraft({ ...confirmed.record.sections })
    setAnnotationProvenance(confirmed.record.aiProvenance)
    setAnnotationStage('view')
    setAnnotationPersistenceMessage('')
    return { result, record: confirmed.record, metadata: nextMetadata }
  }

  const scheduleAnnotationStep = (callback) => {
    window.setTimeout(() => {
      Promise.resolve().then(callback).catch((error) => {
        setAnnotationPersistenceMessage(error?.message || 'The next annotation step could not be prepared.')
      })
    }, 0)
  }

  const requestAnnotationWrite = async (nextAnnotation, verb, options = {}) => {
    const descriptor = knowledgeToolDescriptors.find((item) => item.id === 'annotation')
    if (!descriptor?.available || !annotationRuntime?.available) return
    const metadata = options.metadata || annotationMeta[nextAnnotation.id] || {}
    const path = metadata.path || newAnnotationWriteTarget(nextAnnotation.id)
    const intent = createAnnotationPatchIntent(nextAnnotation, {
      path,
      expectedRevision: metadata.revision || null,
    })
    let idempotencyKey
    try {
      idempotencyKey = await createAnnotationWriteIdempotencyKey(intent, options.stage)
    } catch (error) {
      setAnnotationPersistenceMessage(error?.message || 'A stable Annotation write key could not be prepared.')
      options.onFailed?.(error)
      return
    }
    const targetScope = `${knowledgeContext.vault.name} / ${path}`
    onKnowledgeAction(descriptor, {
      prompt: `${verb} annotation for ${knowledgeContext.activeNote.title}`,
      actionTitle: verb,
      targetScope,
      idempotencyKey,
      payload: intent,
      declinedMessage: options.declinedMessage,
      onApproved: async () => {
        try {
          const persisted = await commitAnnotationWrite(nextAnnotation, metadata, idempotencyKey)
          if (options.onPersisted) scheduleAnnotationStep(() => options.onPersisted(persisted))
          return persisted
        } catch (error) {
          setAnnotationPersistenceMessage(error?.message || 'The annotation could not be saved.')
          options.onFailed?.(error)
          throw error
        }
      },
      onDeclined: () => {
        options.onDeclined?.()
      },
    })
  }

  const handleRequestSave = (annotation, draft) => {
    const timestamp = new Date().toISOString()
    const next = normalizeAnnotation({
      ...migrateAnnotationToV2(annotation),
      source: { ...annotation.source, revision: selectedNote?.revision || vaultRevision || annotation.source.revision },
      sections: { manual: draft.manual, ai: draft.ai },
      aiProvenance: draft.ai.trim() ? annotationProvenance : null,
      timestamps: { ...annotation.timestamps, updatedAt: timestamp },
    })
    void requestAnnotationWrite(next, 'Save', { stage: ANNOTATION_WRITE_STAGES.BODY })
  }

  const handleSelectionAction = async (action, position = annotationPosition) => {
    setRightOpen(true)
    setActivePanels((current) => ({ ...current, right: 'agent' }))
    const nextAnnotation = openAnnotationEditor(action === 'ai' ? 'ai' : 'manual', position)
    if (action !== 'ai' || !nextAnnotation) return
    const descriptor = knowledgeToolDescriptors.find((item) => item.id === 'explain')
    if (!descriptor?.available) return
    const controller = new AbortController()
    explainControllerRef.current = controller
    pendingExplainIdRef.current = nextAnnotation.id
    setAnnotationStage('generating')
    setAnnotationAiStatus({ kind: 'loading', message: 'Generating an explanation through the Research Run Runtime…' })
    try {
      const explainContext = knowledgeContext.selection ? knowledgeContext : {
        ...knowledgeContext,
        selection: { noteId: selectedNote.id, anchor: nextAnnotation.anchor },
      }
      const result = await onKnowledgeAction(descriptor, {
        prompt: `${descriptor.title} selected passage: ${nextAnnotation.anchor?.quote?.exact || ''}`,
        context: explainContext,
        signal: controller.signal,
        includeProvenance: true,
      })
      if (pendingExplainIdRef.current !== nextAnnotation.id || typeof result?.text !== 'string' || !result.text.trim()) return
      setAnnotationDraft((current) => ({ ...current, ai: result.text }))
      setAnnotationProvenance(result.aiProvenance)
      setAnnotationStage('review')
      setAnnotationAiStatus({ kind: 'ready', message: 'AI explanation ready for review. Saving still requires explicit approval.' })
    } catch (error) {
      if (pendingExplainIdRef.current !== nextAnnotation.id) return
      setAnnotationStage('review')
      setAnnotationAiStatus({ kind: 'error', message: error?.name === 'AbortError' ? 'AI explanation was cancelled. Nothing was saved.' : `AI explanation failed: ${error?.message || 'No completed result was returned.'}` })
    } finally {
      if (pendingExplainIdRef.current === nextAnnotation.id) pendingExplainIdRef.current = null
      if (explainControllerRef.current === controller) explainControllerRef.current = null
    }
  }

  const handleCancelAi = () => {
    pendingExplainIdRef.current = null
    explainControllerRef.current?.abort()
    explainControllerRef.current = null
    setAnnotationStage('review')
    setAnnotationAiStatus({ kind: 'error', message: 'AI explanation was cancelled. Nothing was saved.' })
  }

  const handleBackToChooser = () => {
    explainControllerRef.current?.abort()
    pendingExplainIdRef.current = null
    setAnnotationDraft({ ...annotationInitialDraft })
    setAnnotationProvenance(activeAnnotation?.aiProvenance || null)
    setAnnotationAiStatus(null)
    setAnnotationStage('choice')
    setAnnotationWorkbenchOpen(false)
  }

  const requestFormalArchiveAction = (pendingAnnotation, pendingMetadata) => {
    const descriptor = knowledgeToolDescriptors.find((item) => item.id === 'synthesis')
    if (!descriptor?.available || !actionRuntime?.available) return
    const targets = pendingAnnotation.archive.targets
    const sourceAnnotation = { id: pendingAnnotation.id, path: pendingMetadata.path, revision: pendingMetadata.revision }
    const scope = {
      vaultId: knowledgeContext.vault.id,
      target: { kind: 'vault', id: knowledgeContext.vault.id },
      expectedRevision: null,
    }
    const request = createKnowledgeArchiveActionInput({
      requestId: `${pendingAnnotation.archive.runId}:request`,
      runId: pendingAnnotation.archive.runId,
      sessionId: knowledgeSession.sessionId,
      context: knowledgeContext,
      scope,
      idempotencyKey: `${pendingAnnotation.id}:${pendingMetadata.revision}:archive:${pendingAnnotation.archive.runId}`,
      input: { operation: 'archive-annotation', sourceAnnotation, targets },
    })
    const approval = { status: 'approved', scope: request.scope, sourceAnnotation, targets }
    onKnowledgeAction(descriptor, {
      prompt: `Archive saved annotation into ${targets.length} requested knowledge target${targets.length === 1 ? '' : 's'}.`,
      actionTitle: 'Formal archive Action',
      targetScope: `${knowledgeContext.vault.name} (Vault root)`,
      idempotencyKey: request.idempotencyKey,
      payload: request,
      approvalDetails: { scope: request.scope, sourceAnnotation, targets },
      onApproved: async () => {
        const controller = new AbortController()
        archiveControllerRef.current = controller
        setAnnotationArchiveRunning(true)
        setAnnotationArchiveOutcome(null)
        setAnnotationArchiveEvidence([])
        let result
        try {
          result = await executeKnowledgeArchiveAction({ actionRuntime, request, approval, signal: controller.signal })
        } catch (error) {
          result = createKnowledgeArchiveResult(request, {
            status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
            summary: error?.message,
            targets: [],
            error: { code: error?.name === 'AbortError' ? 'archive_cancelled' : 'archive_failed', message: error?.message },
          })
        } finally {
          if (archiveControllerRef.current === controller) archiveControllerRef.current = null
          setAnnotationArchiveRunning(false)
        }
        const archive = knowledgeArchiveResultToAnnotationArchive(request, result)
        const timestamp = new Date().toISOString()
        const terminal = normalizeAnnotation({
          ...pendingAnnotation,
          archive,
          timestamps: { ...pendingAnnotation.timestamps, updatedAt: timestamp, archivedAt: archive.state === 'completed' ? timestamp : null },
        })
        setAnnotationArchiveEvidence(result.data.targets)
        setAnnotationArchiveOutcome({ status: result.status, archive, persistence: 'awaiting-approval' })
        scheduleAnnotationStep(() => requestAnnotationWrite(terminal, `Persist ${result.status} archive lifecycle`, {
          metadata: pendingMetadata,
          stage: ANNOTATION_WRITE_STAGES[`ARCHIVE_${result.status.toUpperCase()}`],
          declinedMessage: 'Terminal lifecycle persistence was cancelled. The Action result remains visible and the Annotation remains pending.',
          onPersisted: () => setAnnotationArchiveOutcome(null),
          onDeclined: () => {
            setAnnotationArchiveOutcome((current) => current && { ...current, persistence: 'declined' })
            setAnnotationPersistenceMessage('The Action result remains visible, but its terminal lifecycle write was declined. The saved annotation remains pending.')
          },
          onFailed: (error) => {
            setAnnotationArchiveOutcome((current) => current && { ...current, persistence: 'failed' })
            setAnnotationPersistenceMessage(`The Action result remains visible, but its terminal lifecycle was not persisted: ${error?.message || 'Annotation write failed.'}`)
          },
        }))
        if (result.status !== 'completed') throw new Error(result.error?.message || result.summary)
        return result
      },
      onDeclined: () => {
        setAnnotationPersistenceMessage('Formal archive Action approval was declined. No Action started; the persisted pending lifecycle remains visible.')
      },
      declinedMessage: 'Formal archive Action was cancelled. No Action started; the persisted pending lifecycle remains visible.',
    })
  }

  const handleRequestArchive = (annotation) => {
    const metadata = annotationMeta[annotation.id]
    if (!metadata?.path || !metadata?.revision) {
      setAnnotationPersistenceMessage('Reload this saved annotation before starting a formal archive so its exact Runtime path and revision are available.')
      return
    }
    let targets
    try {
      targets = normalizeAnnotationArchiveTargets(annotationArchiveTargets.split(/\r?\n/).filter((value) => value.length > 0))
    } catch (error) {
      setAnnotationPersistenceMessage(error.message)
      return
    }
    const sequence = Date.now().toString(36)
    const pending = normalizeAnnotation({
      ...migrateAnnotationToV2(annotation),
      archive: { state: 'pending', targets, runId: `${knowledgeSession.sessionId}:archive:run:${sequence}`, error: null },
      timestamps: { ...annotation.timestamps, updatedAt: new Date().toISOString(), archivedAt: null },
    })
    setAnnotationArchiveOutcome(null)
    setAnnotationPersistenceMessage('')
    requestAnnotationWrite(pending, 'Persist pending archive lifecycle', {
      metadata,
      stage: ANNOTATION_WRITE_STAGES.ARCHIVE_PENDING,
      declinedMessage: 'Pending archive persistence was cancelled. No Action started.',
      onPersisted: ({ record, metadata: confirmedMetadata }) => requestFormalArchiveAction(record, confirmedMetadata),
      onDeclined: () => setAnnotationPersistenceMessage('Pending archive persistence was declined. No Action started.'),
      onFailed: () => setAnnotationArchiveRunning(false),
    })
  }

  const handleCancelArchive = () => {
    archiveControllerRef.current?.abort()
  }

  const handleSelectPassage = (nextSelection) => {
    pendingExplainIdRef.current = null
    setSelection(nextSelection)
    dismissAnnotationWorkbench()
  }

  const handleClearSelection = () => {
    pendingExplainIdRef.current = null
    setSelection(null)
    dismissAnnotationWorkbench()
  }

  const openSavedAnnotation = (annotation) => {
    const migrated = migrateAnnotationToV2(annotation)
    setSelection({ selectionId: `${migrated.source.noteId}:${migrated.anchor.position.start}:${migrated.anchor.position.end}`, anchor: migrated.anchor })
    setActiveAnnotation(migrated)
    setAnnotationDraft({ ...migrated.sections })
    setAnnotationInitialDraft({ ...migrated.sections })
    setAnnotationProvenance(migrated.aiProvenance)
    setAnnotationFocusSection('manual')
    setAnnotationAiStatus(null)
    setAnnotationStage('view')
    setAnnotationPosition({ x: Math.max(8, window.innerWidth - 370), y: 72 })
    setAnnotationArchiveTargets(migrated.archive.targets.join('\n'))
    setAnnotationArchiveEvidence([])
    setAnnotationArchiveOutcome(null)
    setAnnotationArchiveRunning(false)
    setAnnotationPersistenceMessage('')
    setAnnotationCloseGuard(false)
    setAnnotationWorkbenchOpen(true)
  }

  const renderPanel = (panelId) => {
    if (panelId === 'files') return <FilesPanel notes={notes} selectedId={selectedNote?.id} onSelect={handleSelectNote} />
    if (panelId === 'outline') return <OutlinePanel note={selectedNote} />
    if (panelId === 'tags') return <TagsPanel tags={tags} />
    if (panelId === 'graph') return <MiniGraph graph={graph} selectedId={selectedNote?.id} onSelect={selectGraphNode} />
    if (panelId === 'web') return <WebPanel />
    if (panelId === 'agent') return <AgentConversationPanel variant="compact" session={knowledgeSession} contextSummary={knowledgeContext} descriptors={knowledgeToolDescriptors} input={knowledgeInput} onInput={onKnowledgeInput} onSubmit={onKnowledgeSubmit} onAction={onKnowledgeAction} onContinueInResearch={onContinueInResearch} approval={knowledgeApproval} onResolveApproval={onResolveKnowledgeApproval} disabled={!knowledgeContext} />
    return <PluginsPanel />
  }

  const selectedNoteAnnotations = annotations.filter((item) => item.source.noteId === selectedNote?.id)

  return <div className={`knowledge-workspace ${leftOpen ? '' : 'left-closed'} ${rightOpen ? '' : 'right-closed'} ${annotationWorkbenchOpen ? 'annotation-open' : ''}`}>
    <div className="knowledge-workspace-toolbar">
      <div className="workspace-toolbar-group">
        <button onClick={() => setLeftOpen(!leftOpen)} aria-label={`${leftOpen ? 'Hide' : 'Show'} left sidebar`}>{leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
        <div className="workspace-breadcrumb"><span>{notes.length ? 'Vault' : 'Knowledge workspace'}</span><ChevronRight size={12} /><strong>{selectedNote?.title || 'No note open'}</strong></div>
      </div>
      <div className="workspace-toolbar-group">
        {knowledgeContext?.activeNote && <span className="workspace-context-chip"><FileText size={11} />Current note: {knowledgeContext.activeNote.title}</span>}
        {knowledgeContext?.selection && <span className="workspace-context-chip selection"><Bot size={11} />Selection ready</span>}
        {provider && <button type="button" className="workspace-provider-chip" onClick={onOpenSettings} aria-label={`Switch Provider or model. Current: ${provider.providerName}, ${provider.modelName}`}><Bot size={11} /><span>{provider.providerName} · {provider.modelName}</span></button>}
        {!annotationWorkbenchOpen && selectedNoteAnnotations.length > 0 && <button type="button" onClick={() => setAnnotationWorkbenchOpen(true)} aria-label={`Show annotations workbench (${selectedNoteAnnotations.length})`}><Highlighter size={14} /><span>Annotations ({selectedNoteAnnotations.length})</span></button>}
        <span className="workspace-local-badge"><CircleDot size={10} /> Local-first</span>
        <button onClick={resetLayout} title="Reset panel layout"><RotateCcw size={14} /><span>Reset layout</span></button>
        <button onClick={() => setRightOpen(!rightOpen)} aria-label={`${rightOpen ? 'Hide' : 'Show'} right sidebar`}>{rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
      </div>
    </div>

    <div className="knowledge-layout">
      {leftOpen && <Dock side="left" panelIds={dockLayout.left} activePanelId={activePanels.left} draggingId={draggingId} onActivate={(side, panelId) => setActivePanels((current) => ({ ...current, [side]: panelId }))} onDragStart={handleDragStart} onDragEnd={() => setDraggingId(null)} onDrop={handleDrop} renderPanel={renderPanel} />}

      <main className="knowledge-center">
        <div className="knowledge-tabs" role="tablist" aria-label="Open documents">
          {openNotes.map((note) => <div className={note.id === selectedNote?.id ? 'active' : ''} role="tab" aria-selected={note.id === selectedNote?.id} key={note.id}>
            <button className="document-tab-main" onClick={() => handleSelectNote(note)}><FileText size={13} /><span>{note.title}</span><small>Markdown</small></button>
            <button className="document-tab-close" onClick={() => handleCloseNote(note.id)} aria-label={`Close ${note.title}`}><X size={12} /></button>
          </div>)}
          <button className="document-tab-add" onClick={() => { setLeftOpen(true); setActivePanels((current) => ({ ...current, left: 'files' })) }} aria-label="Browse Vault files"><Plus size={14} /></button>
        </div>
        <div className="knowledge-editor">
          {selectedNote ? <MarkdownDocument note={selectedNote} notes={notes} selection={selection} annotations={selectedNoteAnnotations} onSelectPassage={handleSelectPassage} onSelectionAction={handleSelectionAction} onClearSelection={handleClearSelection} onNavigate={handleSelectNote} onOpenAnnotation={openSavedAnnotation} aiAvailable={knowledgeToolDescriptors.find((item) => item.id === 'explain')?.available === true} aiUnavailableReason={knowledgeToolDescriptors.find((item) => item.id === 'explain')?.unavailableReason || 'AI Explain is unavailable in this Runtime.'} /> : <div className="knowledge-welcome">
            <span><BookOpen size={25} /></span>
            <h2>{notes.length ? 'Choose a document from the Files panel' : 'Your research knowledge, in one workspace'}</h2>
            <p>{notes.length ? 'Open Markdown notes as tabs and keep multiple sources ready while you research.' : 'Connect an Obsidian Vault to browse files, inspect backlinks, read Markdown, and arrange research tools around your document.'}</p>
            <button onClick={notes.length ? () => { setLeftOpen(true); setActivePanels((current) => ({ ...current, left: 'files' })) } : onConnectVault}><FolderOpen size={15} /> {notes.length ? 'Browse files' : 'Connect Vault'}</button>
          </div>}
        </div>
      </main>

      {!knowledgeApproval && annotationStage === 'choice' && <SelectionChooser selection={selection} position={annotationPosition} onAction={handleSelectionAction} onDismiss={() => setAnnotationStage('view')} aiAvailable={knowledgeToolDescriptors.find((item) => item.id === 'explain')?.available === true} aiUnavailableReason={knowledgeToolDescriptors.find((item) => item.id === 'explain')?.unavailableReason || 'AI Explain is unavailable in this Runtime.'} />}
      {!knowledgeApproval && annotationWorkbenchOpen && (activeAnnotation || selectedNoteAnnotations.length > 0) && <AnnotationEditor
        annotation={activeAnnotation}
        draft={annotationDraft}
        annotations={selectedNoteAnnotations}
        stage={annotationStage}
        position={annotationPosition}
        onDraftChange={setAnnotationDraft}
        onRequestSave={handleRequestSave}
        onRequestArchive={handleRequestArchive}
        onDismiss={dismissAnnotationWorkbench}
        onBack={handleBackToChooser}
        onEdit={() => { setAnnotationStage('edit'); setAnnotationInitialDraft({ ...activeAnnotation.sections }) }}
        onRegenerate={() => handleSelectionAction('ai', annotationPosition)}
        onCancelAi={handleCancelAi}
        onCancelArchive={handleCancelArchive}
        focusSection={annotationFocusSection}
        persistenceMessage={annotationPersistenceMessage}
        aiStatus={annotationAiStatus}
        provenance={annotationProvenance}
        provider={provider}
        onOpenSettings={onOpenSettings}
        archiveAvailable={knowledgeToolDescriptors.find((item) => item.id === 'synthesis')?.available === true}
        archiveUnavailableReason={knowledgeToolDescriptors.find((item) => item.id === 'synthesis')?.unavailableReason || actionRuntime?.reason || 'Formal archive is unavailable.'}
        archiveTargets={annotationArchiveTargets}
        onArchiveTargetsChange={setAnnotationArchiveTargets}
        archiveEvidence={annotationArchiveEvidence}
        archiveOutcome={annotationArchiveOutcome}
        archiveRunning={annotationArchiveRunning}
        closeGuard={annotationCloseGuard}
        onConfirmDiscard={discardAnnotationWorkbench}
        onKeepEditing={() => setAnnotationCloseGuard(false)}
        onReopen={openSavedAnnotation}
      />}
      {rightOpen && <Dock side="right" panelIds={dockLayout.right} activePanelId={activePanels.right} draggingId={draggingId} onActivate={(side, panelId) => setActivePanels((current) => ({ ...current, [side]: panelId }))} onDragStart={handleDragStart} onDragEnd={() => setDraggingId(null)} onDrop={handleDrop} renderPanel={renderPanel} />}
    </div>

    <footer className="knowledge-statusbar">
      <span>{graph.stats.resolvedLinks} links</span><span>{notes.length} notes</span><span>{outline.length} headings</span><span>{tags.length} tags</span><span className="statusbar-spacer" /><span><Network size={11} /> {notes.length ? 'Graph index ready' : 'No Vault connected'}</span>
    </footer>
  </div>
}
