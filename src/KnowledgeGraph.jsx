import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
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
import { collectVaultTags, DEFAULT_DOCK_LAYOUT, extractMarkdownOutline, moveDockPanel, normalizeDockLayout } from './knowledgeWorkspace.js'

const LAYOUT_KEY = 'bioresearch-os:knowledge-dock-layout'

const PANEL_META = {
  files: { title: 'Files', icon: FolderOpen },
  outline: { title: 'Outline', icon: LayoutPanelTop },
  tags: { title: 'Tags', icon: Tag },
  graph: { title: 'Local graph', icon: Network },
  web: { title: 'Web browser', icon: Globe2 },
  plugins: { title: 'Research tools', icon: Boxes },
}

function loadDockLayout() {
  try {
    return normalizeDockLayout(JSON.parse(window.localStorage.getItem(LAYOUT_KEY)))
  } catch {
    return normalizeDockLayout(DEFAULT_DOCK_LAYOUT)
  }
}

function MarkdownDocument({ note }) {
  const blocks = useMemo(() => {
    if (!note?.body) return []
    const lines = note.body.split(/\r?\n/)
    const output = []
    let paragraph = []
    let code = []
    let inCode = false
    let inComment = false
    const flushParagraph = () => {
      if (paragraph.length) output.push({ type: 'paragraph', value: paragraph.join(' ') })
      paragraph = []
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
          output.push({ type: 'code', value: code.join('\n') })
          code = []
        }
        inCode = !inCode
        continue
      }
      if (inCode) {
        code.push(line)
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        flushParagraph()
        const isRepeatedTitle = heading[1].length === 1 && heading[2].trim() === note.title.trim() && output.length === 0
        if (!isRepeatedTitle) output.push({ type: 'heading', level: heading[1].length, value: heading[2], id: `heading-${index}` })
      } else if (/^[-*]\s+/.test(line)) {
        flushParagraph()
        output.push({ type: 'list', value: line.replace(/^[-*]\s+/, '') })
      } else if (/^>\s?/.test(line)) {
        flushParagraph()
        output.push({ type: 'quote', value: line.replace(/^>\s?/, '') })
      } else if (!line.trim()) {
        flushParagraph()
      } else {
        paragraph.push(line.trim())
      }
    }
    flushParagraph()
    return output
  }, [note])

  if (!note) return null
  const metadata = Object.entries(note.frontmatter || {}).filter(([, value]) => value !== '' && value != null)
  return (
    <article className="knowledge-document">
      <div className="document-path">{note.path}</div>
      <h1>{note.title}</h1>
      {metadata.length > 0 && <dl className="document-properties">
        {metadata.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}
      </dl>}
      <div className="document-markdown">
        {blocks.map((block, index) => {
          if (block.type === 'heading') {
            const Heading = `h${Math.min(6, block.level + 1)}`
            return <Heading id={block.id} key={`${block.id}-${index}`}>{block.value}</Heading>
          }
          if (block.type === 'list') return <div className="document-list-item" key={index}><CircleDot size={9} /> <span>{block.value}</span></div>
          if (block.type === 'quote') return <blockquote key={index}>{block.value}</blockquote>
          if (block.type === 'code') return <pre key={index}><code>{block.value}</code></pre>
          return <p key={index}>{block.value}</p>
        })}
      </div>
    </article>
  )
}

function FilesPanel({ notes, selectedId, onSelect }) {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const grouped = new Map()
    notes.filter((note) => !normalized || `${note.title} ${note.path}`.toLowerCase().includes(normalized)).forEach((note) => {
      const parts = note.path.split('/')
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : 'Vault root'
      if (!grouped.has(folder)) grouped.set(folder, [])
      grouped.get(folder).push(note)
    })
    return [...grouped.entries()]
  }, [notes, query])
  return <div className="files-panel-content">
    <label className="dock-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" /></label>
    <div className="file-tree">
      {groups.map(([folder, files]) => <div className="file-group" key={folder}>
        <div className="file-folder"><ChevronDown size={12} /><Folder size={13} /><span>{folder}</span></div>
        {files.map((note) => <button className={note.id === selectedId ? 'selected' : ''} onClick={() => onSelect(note)} key={note.id}><FileText size={13} /><span>{note.title}</span></button>)}
      </div>)}
      {!notes.length && <div className="dock-empty">Connect a Vault to browse Markdown files.</div>}
      {notes.length > 0 && groups.length === 0 && <div className="dock-empty">No matching notes.</div>}
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
      <g>{graph.nodes.map((node) => <circle className={`type-${node.type} ${node.id === selectedId ? 'selected' : ''}`} role="button" tabIndex="0" aria-label={node.title} key={node.id} cx={node.x} cy={node.y} r={Math.max(8, node.radius)} onClick={() => onSelect(node)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect(node) }} />)}</g>
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

export default function KnowledgeGraphSection({ index, onConnectVault }) {
  const graph = useMemo(() => createKnowledgeGraph(index), [index])
  const notes = index?.notes || []
  const [selectedNote, setSelectedNote] = useState(() => notes[0] || null)
  const [openNoteIds, setOpenNoteIds] = useState(() => notes[0] ? [notes[0].id] : [])
  const [dockLayout, setDockLayout] = useState(loadDockLayout)
  const [activePanels, setActivePanels] = useState({ left: 'files', right: 'graph' })
  const [draggingId, setDraggingId] = useState(null)
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)

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

  useEffect(() => {
    setActivePanels((current) => ({
      left: dockLayout.left.includes(current.left) ? current.left : dockLayout.left[0] || null,
      right: dockLayout.right.includes(current.right) ? current.right : dockLayout.right[0] || null,
    }))
  }, [dockLayout])

  const notesById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes])
  const openNotes = useMemo(() => openNoteIds.map((id) => notesById.get(id)).filter(Boolean), [notesById, openNoteIds])

  const handleSelectNote = (note) => {
    if (!note) return
    setSelectedNote(note)
    setOpenNoteIds((current) => current.includes(note.id) ? current : [...current, note.id])
  }

  const handleCloseNote = (noteId) => {
    setOpenNoteIds((current) => {
      const closingIndex = current.indexOf(noteId)
      const next = current.filter((id) => id !== noteId)
      if (selectedNote?.id === noteId) {
        const nextId = next[Math.min(closingIndex, next.length - 1)]
        setSelectedNote(nextId ? notesById.get(nextId) || null : null)
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
    setActivePanels({ left: 'files', right: 'graph' })
    setLeftOpen(true)
    setRightOpen(true)
  }

  const selectGraphNode = (node) => {
    if (node.note) handleSelectNote(node.note)
  }

  const renderPanel = (panelId) => {
    if (panelId === 'files') return <FilesPanel notes={notes} selectedId={selectedNote?.id} onSelect={handleSelectNote} />
    if (panelId === 'outline') return <OutlinePanel note={selectedNote} />
    if (panelId === 'tags') return <TagsPanel tags={tags} />
    if (panelId === 'graph') return <MiniGraph graph={graph} selectedId={selectedNote?.id} onSelect={selectGraphNode} />
    if (panelId === 'web') return <WebPanel />
    return <PluginsPanel />
  }

  return <div className={`knowledge-workspace ${leftOpen ? '' : 'left-closed'} ${rightOpen ? '' : 'right-closed'}`}>
    <div className="knowledge-workspace-toolbar">
      <div className="workspace-toolbar-group">
        <button onClick={() => setLeftOpen(!leftOpen)} aria-label={`${leftOpen ? 'Hide' : 'Show'} left sidebar`}>{leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
        <div className="workspace-breadcrumb"><span>{notes.length ? 'Vault' : 'Knowledge workspace'}</span><ChevronRight size={12} /><strong>{selectedNote?.title || 'No note open'}</strong></div>
      </div>
      <div className="workspace-toolbar-group">
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
            <button className="document-tab-main" onClick={() => setSelectedNote(note)}><FileText size={13} /><span>{note.title}</span><small>Markdown</small></button>
            <button className="document-tab-close" onClick={() => handleCloseNote(note.id)} aria-label={`Close ${note.title}`}><X size={12} /></button>
          </div>)}
          <button className="document-tab-add" onClick={() => { setLeftOpen(true); setActivePanels((current) => ({ ...current, left: 'files' })) }} aria-label="Browse Vault files"><Plus size={14} /></button>
        </div>
        <div className="knowledge-editor">
          {selectedNote ? <MarkdownDocument note={selectedNote} /> : <div className="knowledge-welcome">
            <span><BookOpen size={25} /></span>
            <h2>{notes.length ? 'Choose a document from the Files panel' : 'Your research knowledge, in one workspace'}</h2>
            <p>{notes.length ? 'Open Markdown notes as tabs and keep multiple sources ready while you research.' : 'Connect an Obsidian Vault to browse files, inspect backlinks, read Markdown, and arrange research tools around your document.'}</p>
            <button onClick={notes.length ? () => { setLeftOpen(true); setActivePanels((current) => ({ ...current, left: 'files' })) } : onConnectVault}><FolderOpen size={15} /> {notes.length ? 'Browse files' : 'Connect Vault'}</button>
          </div>}
        </div>
      </main>

      {rightOpen && <Dock side="right" panelIds={dockLayout.right} activePanelId={activePanels.right} draggingId={draggingId} onActivate={(side, panelId) => setActivePanels((current) => ({ ...current, [side]: panelId }))} onDragStart={handleDragStart} onDragEnd={() => setDraggingId(null)} onDrop={handleDrop} renderPanel={renderPanel} />}
    </div>

    <footer className="knowledge-statusbar">
      <span>{graph.stats.resolvedLinks} links</span><span>{notes.length} notes</span><span>{outline.length} headings</span><span>{tags.length} tags</span><span className="statusbar-spacer" /><span><Network size={11} /> Graph index ready</span>
    </footer>
  </div>
}
