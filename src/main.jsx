import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowRight,
  Atom,
  Bookmark,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  FileText,
  FlaskConical,
  GitBranch,
  Layers3,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Network,
  Paperclip,
  Pause,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
import { buildVaultIndex, getVaultName, parseVaultDirectory, parseVaultFiles } from './vault.js'
import { loadVaultHandle, loadVaultSnapshot, saveVaultHandle, saveVaultSnapshot } from './vaultStorage.js'
import './styles.css'

const navItems = [
  { id: 'research', label: 'Research', icon: MessageSquare },
  { id: 'graph', label: 'Knowledge Graph', icon: Network },
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch },
  { id: 'runs', label: 'Runs', icon: PlayCircle },
]

const sampleLinkedNotes = [
  { title: 'Spatial transcriptomics', type: 'concept', path: 'wiki/concepts/spatial-transcriptomics.md' },
  { title: 'CellChat', type: 'method', path: 'wiki/methods/cellchat.md' },
  { title: 'scRNA-seq QC', type: 'method', path: 'wiki/methods/scrna-seq-qc.md' },
  { title: 'CosMx SMI protocols', type: 'method', path: 'wiki/methods/cosmx-smi-protocols.md' },
  { title: 'MERFISH', type: 'method', path: 'wiki/methods/merfish.md' },
]

const sampleSources = [
  { name: 'Spatial_transcriptomics.md', kind: 'note' },
  { name: 'CosMx_SMI_protocols.md', kind: 'note' },
  { name: 'MERFISH.md', kind: 'note' },
  { name: 'Slide-seqV2.md', kind: 'note' },
  { name: 'DBiT-seq.md', kind: 'note' },
  { name: 'Nature_2023_Benchmark_ST.pdf', kind: 'paper' },
]

const initialMessages = [
  {
    id: 'user-1',
    role: 'user',
    text: 'Which spatial transcriptomics methods are used for tumor niche analysis?',
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    text: 'Spatial transcriptomics methods widely used for tumor niche analysis include Visium (10x Genomics), CosMx SMI, MERFISH, seqFISH+, Slide-seqV2, and DBiT-seq. These platforms vary in spatial resolution, throughput, and gene coverage, making them suitable for complementary niches and scales.',
    bullets: [
      ['Visium (10x Genomics)', 'whole-transcriptome capture at ~55 μm spot size, commonly used for broad compartment mapping.', 'Spatial transcriptomics'],
      ['CosMx SMI', 'subcellular-resolution RNA detection with high plex capability, useful for cell-cell interaction studies.', 'CosMx SMI protocols'],
      ['MERFISH', 'multiplexed smFISH with subcellular resolution and high gene coverage.', 'MERFISH'],
      ['seqFISH+', 'highly multiplexed smFISH with improved sensitivity and speed.', 'seqFISH+'],
      ['Slide-seqV2', 'bead-based method with high resolution (~10 μm) and whole-transcriptome coverage.', 'Slide-seqV2'],
      ['DBiT-seq', 'combinatorial indexing for large-scale, cost-effective spatial profiling.', 'DBiT-seq'],
    ],
    closing: 'Choose methods based on the biological question, required resolution, and available resources. See linked notes for protocols and benchmarking.',
  },
]

const stages = ['Query parsed', 'Retrieve', 'Rerank', 'Synthesize', 'Cite']

function responseForQuestion(question) {
  if (question.toLowerCase().includes('cellchat')) {
    return {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      text: 'CellChat adds a ligand-receptor communication layer to spatial transcriptomics. Spatial measurements show where cell populations are located; CellChat models which populations may be signaling to each other based on ligand-receptor expression.',
      bullets: [
        ['Spatial context', 'use coordinates or annotated regions to constrain communication partners to biologically plausible neighborhoods.', 'Spatial transcriptomics'],
        ['Interaction scoring', 'compare incoming and outgoing signaling patterns across cell types or tumor niches.', 'CellChat'],
        ['Validation', 'cross-check predicted interactions against expression, imaging, perturbation, or pathology evidence before treating them as mechanisms.', 'CellChat validation'],
      ],
      closing: 'A practical workflow is to infer communication with CellChat, project significant pairs back onto tissue neighborhoods, and preserve the supporting notes and thresholds in the vault.',
    }
  }
  return {
    id: `assistant-${Date.now()}`,
    role: 'assistant',
    text: 'The vault has retrieved a focused set of methods and protocol notes for this question. The next step is to compare the candidates against your tissue, resolution, and validation requirements.',
    bullets: [
      ['Retrieved context', 'the answer is grounded in the linked method and benchmark notes.', 'Spatial transcriptomics'],
      ['Recommended next step', 'narrow the comparison using tissue type, resolution, and available assay budget.', 'Research planning'],
    ],
    closing: 'I can turn this into a reproducible comparison table or an analysis plan in the next run.',
  }
}

function LogoMark() {
  return (
    <div className="logo-mark" aria-hidden="true">
      <Atom size={25} strokeWidth={1.7} />
    </div>
  )
}

function Sidebar({ activeSection, setActiveSection, onConnectVault, onSyncVault, vaultName, vaultNoteCount, syncState }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <LogoMark />
        <span>BioResearch OS</span>
      </div>

      <nav className="main-nav" aria-label="Primary navigation">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            className={`nav-item ${activeSection === id ? 'active' : ''}`}
            key={id}
            onClick={() => setActiveSection(id)}
          >
            <Icon size={18} strokeWidth={1.7} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button className="workspace-switcher" onClick={onConnectVault} aria-label="Connect Obsidian vault" title="Connect an Obsidian vault folder">
          <span className="workspace-icon"><FlaskConical size={17} /></span>
          <span className="workspace-copy">
            <strong>{vaultName || 'Tumor Niche Workspace'}</strong>
            <small>{vaultName ? `${vaultNoteCount} Markdown notes` : 'vault: tumor-niche · click to connect'}</small>
          </span>
          <ChevronDown size={16} />
        </button>
        {vaultName && <button className="settings-link sync-link" onClick={onSyncVault} disabled={syncState === 'syncing'}><RefreshCw className={syncState === 'syncing' ? 'spin' : ''} size={15} /> {syncState === 'syncing' ? 'Syncing vault' : syncState === 'needs-permission' ? 'Reconnect vault' : 'Sync vault'}</button>}
        <button className="settings-link"><Settings2 size={16} /> Settings</button>
      </div>
    </aside>
  )
}

function UserMessage({ text }) {
  return (
    <div className="user-message">
      <div className="message-meta">
        <span>Research question</span>
        <span>10:24 AM <Check size={13} /></span>
      </div>
      <p>{text}</p>
    </div>
  )
}

function AssistantMessage({ message, running }) {
  return (
    <article className="assistant-message">
      <div className="assistant-avatar"><Sparkles size={17} /></div>
      <div className="assistant-content">
        <div className="assistant-title-row">
          <strong>Research agent</strong>
          {running && <span className="live-label"><span className="live-dot" /> composing</span>}
        </div>
        <p>{message.text}</p>
        <ul>
          {message.bullets.map(([name, detail, link]) => (
            <li key={name}>
              <strong>{name}</strong>: {detail} <a href={`#${link.replaceAll(' ', '-')}`}>[[{link}]]</a>
            </li>
          ))}
        </ul>
        <p>{message.closing}</p>
        <div className="message-actions">
          <button aria-label="Helpful"><ThumbsUp size={15} /></button>
          <button aria-label="Not helpful"><ThumbsDown size={15} /></button>
          <button aria-label="Copy"><FileText size={15} /></button>
          <button aria-label="Bookmark"><Bookmark size={15} /></button>
          <span className="message-time">10:24 AM <span>·</span> 6 sources <ChevronDown size={14} /></span>
        </div>
      </div>
    </article>
  )
}

function EvidenceTrail({ activeStage }) {
  return (
    <section className="evidence-trail">
      <div className="section-label-row">
        <span><ChevronDown size={15} /> Evidence trail</span>
        <ChevronUp size={15} />
      </div>
      <div className="stage-row">
        {stages.map((stage, index) => {
          const complete = index < activeStage
          const current = index === activeStage
          return (
            <div className="stage-wrap" key={stage}>
              <div className={`stage ${complete ? 'complete' : ''} ${current ? 'current' : ''}`}>
                {complete ? <CheckCircle2 size={14} /> : current ? <LoaderCircle className="spin" size={14} /> : <CircleDot size={14} />}
                <span>{stage}</span>
              </div>
              {index < stages.length - 1 && <ArrowRight className="stage-arrow" size={14} />}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Composer({ value, setValue, onSubmit, disabled }) {
  const textareaRef = useRef(null)
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a follow-up about your research..."
          rows={2}
          disabled={disabled}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button aria-label="Attach file"><Paperclip size={18} /></button>
            <button aria-label="Add note"><BookOpen size={18} /></button>
            <button aria-label="Insert code"><Code2 size={18} /></button>
          </div>
          <div className="composer-submit">
            <button className="model-select">Smart (Default) <ChevronDown size={14} /></button>
            <button className="send-button" onClick={onSubmit} disabled={disabled || !value.trim()} aria-label="Send question">
              {disabled ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
            </button>
          </div>
        </div>
      </div>
      <div className="drop-zone">Drop files, notes, or questions here to add context <span>Future tools and widgets will appear here</span></div>
    </div>
  )
}

function LinkedNotes({ notes, onOpenNote }) {
  const [expanded, setExpanded] = useState(false)
  const visibleNotes = expanded ? notes : notes.slice(0, 5)
  const noteCountLabel = notes === sampleLinkedNotes ? 12 : notes.length
  return (
    <section className="inspector-section linked-notes">
      <div className="inspector-heading"><span>Linked notes</span><ChevronUp size={15} /></div>
      <div className="note-list">
        {visibleNotes.map((note) => (
          <div className="note-row" key={note.title}>
            <FileText size={16} />
            <span>{note.title}</span>
            <button onClick={() => onOpenNote(note)}>Open linked note <ExternalLink size={13} /></button>
          </div>
        ))}
      </div>
      <button className="show-more" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Show fewer linked notes' : `Show all ${noteCountLabel} linked notes`} <ChevronDown size={15} />
      </button>
    </section>
  )
}

function NotePreview({ note, onClose }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const metadata = Object.entries(note.frontmatter || {})
  return (
    <div className="note-preview-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="note-preview" role="dialog" aria-modal="true" aria-label={`Preview ${note.title}`}>
        <header className="note-preview-header">
          <div>
            <span className="note-preview-type">{note.type || 'note'}</span>
            <h2>{note.title}</h2>
            <p>{note.path}</p>
          </div>
          <button className="note-preview-close" onClick={onClose} aria-label="Close note preview">×</button>
        </header>
        <div className="note-preview-body">
          {metadata.length > 0 && <div className="note-metadata">{metadata.map(([key, value]) => <span key={key}><strong>{key}</strong>{Array.isArray(value) ? value.join(', ') : String(value)}</span>)}</div>}
          <pre>{note.body || 'This sample note does not have a local Markdown body yet.'}</pre>
        </div>
      </section>
    </div>
  )
}

function RetrievalPath({ activeStage, vaultName }) {
  const path = [
    ['Query', 'Which spatial transcriptomics methods...', 'done'],
    ['Vector search (top-k=50)', vaultName ? `vault: ${vaultName}` : 'vault: tumor-niche', 'done'],
    ['Reranking', 'bge-reranker-large', 'done'],
    ['Selected (6 sources)', 'see sources below', 'done'],
    ['Synthesis', activeStage >= 4 ? 'Answer generated' : 'Agent working...', activeStage >= 4 ? 'done' : 'current'],
  ]
  return (
    <section className="inspector-section retrieval-path">
      <div className="inspector-heading"><span>Retrieval path</span><ChevronUp size={15} /></div>
      <div className="path-list">
        {path.map(([title, detail, status], index) => (
          <div className="path-row" key={title}>
            <div className={`path-icon ${status}`}>
              {status === 'done' ? <Check size={12} /> : <CircleDot size={12} />}
            </div>
            <div><strong>{title}</strong><small>{detail}</small></div>
            {index < path.length - 1 && <span className="path-line" />}
          </div>
        ))}
      </div>
    </section>
  )
}

function AgentStatus({ activeStage, running, onPause }) {
  const percentage = running ? Math.min(91, Math.round(((activeStage + 0.7) / stages.length) * 100)) : 100
  return (
    <section className="inspector-section agent-status">
      <div className="inspector-heading"><span>Agent status</span><ChevronUp size={15} /></div>
      <div className="status-line"><span className="live-dot" /> <strong>{running ? 'Agent running' : 'Agent ready'}</strong><span className="run-id">Run #1024</span>{running && <button onClick={onPause} aria-label="Pause run"><Pause size={15} /></button>}</div>
      <div className="run-card">
        <div className="run-icon"><Atom size={18} /></div>
        <div className="run-copy"><strong>Research agent</strong><span>{running ? 'Synthesizing answer and citing sources...' : 'Ready for the next question'}</span></div>
        <span className="run-percent">{percentage}%</span>
      </div>
      <div className="progress-track"><span style={{ width: `${percentage}%` }} /></div>
      <div className="run-metrics"><span><small>Started</small>10:24:12 AM</span><span><small>Elapsed</small>{running ? '00:00:18' : '00:00:24'}</span><span><small>ETA</small>{running ? '~00:00:07' : 'Complete'}</span></div>
      <button className="full-run">View full run details <ArrowRight size={15} /></button>
    </section>
  )
}

function Sources({ sources }) {
  return (
    <section className="inspector-section sources-section">
      <div className="inspector-heading"><span>Sources ({sources.length})</span><ChevronUp size={15} /></div>
      <div className="source-list">
        {sources.map((source, index) => (
          <div className="source-row" key={source.name}>
            <span className="source-index">{index + 1}</span><FileText size={15} /><span className="source-name">{source.name}</span><span className={`source-kind ${source.kind}`}>{source.kind}</span>
          </div>
        ))}
      </div>
      <button className="show-more">Show all sources <ChevronDown size={15} /></button>
    </section>
  )
}

function Inspector({ activeStage, running, onPause, linkedNotes, sources, vaultName, onOpenNote }) {
  return (
    <aside className="inspector">
      <div className="inspector-title"><BookOpen size={18} /> <span>Knowledge context</span><ChevronUp size={16} /></div>
      <LinkedNotes notes={linkedNotes} onOpenNote={onOpenNote} />
      <RetrievalPath activeStage={activeStage} vaultName={vaultName} />
      <AgentStatus activeStage={activeStage} running={running} onPause={onPause} />
      <Sources sources={sources} />
    </aside>
  )
}

function KnowledgeGraphSection({ index, onOpenNote }) {
  const visibleEdges = index.edges.slice(0, 10)
  return (
    <div className="graph-section">
      <div className="graph-header">
        <div>
          <span className="graph-kicker"><Network size={16} /> Local wikilink graph</span>
          <h2>Knowledge Graph</h2>
          <p>Parsed from Markdown notes in the connected Obsidian vault.</p>
        </div>
        <div className="graph-summary"><strong>{index.notes.length}</strong><span>notes</span><strong>{index.edges.length}</strong><span>links</span></div>
      </div>
      <div className="graph-grid">
        <section className="graph-panel">
          <div className="graph-panel-heading"><span>Link paths</span><small>first {visibleEdges.length} edges</small></div>
          {visibleEdges.length ? visibleEdges.map((edge, index) => (
            <div className="edge-row" key={`${edge.source.path}-${edge.target.path}-${index}`}>
              <span className="edge-node">{edge.source.title}</span>
              <GitBranch size={15} />
              <span className={`edge-node ${edge.target.missing ? 'missing' : ''}`}>{edge.target.title}</span>
            </div>
          )) : <div className="graph-empty">No `[[wikilinks]]` were found yet.</div>}
        </section>
        <section className="graph-panel">
          <div className="graph-panel-heading"><span>Vault notes</span><small>Markdown index</small></div>
          <div className="graph-note-list">
            {index.notes.slice(0, 12).map((note) => (
              <button className="graph-note-row" key={note.path} onClick={() => onOpenNote(note)}><FileText size={15} /><span>{note.title}</span><small>{note.type}</small></button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function EmptySection({ section }) {
  const copy = {
    graph: ['Knowledge Graph', 'A navigable map of your papers, methods, datasets, and concepts will live here.'],
    pipelines: ['Pipelines', 'Turn repeatable research workflows into inspectable, resumable agent runs.'],
    runs: ['Runs', 'Every agent task will leave a trace: inputs, tools, sources, changes, and verification.'],
  }[section]
  return <div className="empty-section"><div className="empty-icon"><Layers3 size={26} /></div><h2>{copy[0]}</h2><p>{copy[1]}</p><button className="primary-button"><Plus size={16} /> Create workspace item</button></div>
}

function App() {
  const [activeSection, setActiveSection] = useState('research')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState(initialMessages)
  const [running, setRunning] = useState(false)
  const [activeStage, setActiveStage] = useState(5)
  const [pendingQuestion, setPendingQuestion] = useState('')
  const [vaultNotes, setVaultNotes] = useState([])
  const [vaultName, setVaultName] = useState('')
  const [vaultHandle, setVaultHandle] = useState(null)
  const [syncState, setSyncState] = useState('idle')
  const [selectedNote, setSelectedNote] = useState(null)
  const vaultInputRef = useRef(null)

  const vaultIndex = useMemo(() => buildVaultIndex(vaultNotes), [vaultNotes])
  const inspectorNotes = vaultIndex.notes.length ? vaultIndex.linkedNotes : sampleLinkedNotes
  const inspectorSources = vaultIndex.sources.length ? vaultIndex.sources : sampleSources

  const applyVault = async (notes, nextVaultName, handle = null) => {
    if (!notes.length) {
      setSyncState('empty')
      return false
    }
    setVaultNotes(notes)
    setVaultName(nextVaultName)
    setVaultHandle(handle)
    await saveVaultSnapshot({ vaultName: nextVaultName, notes })
    if (handle) await saveVaultHandle(handle)
    setSyncState(handle ? 'ready' : 'manual')
    return true
  }

  const syncFromHandle = async (handle, requestPermission = false) => {
    if (!handle) return false
    let permission = 'granted'
    if (handle.queryPermission) permission = await handle.queryPermission({ mode: 'read' })
    if (permission !== 'granted' && requestPermission && handle.requestPermission) {
      permission = await handle.requestPermission({ mode: 'read' })
    }
    if (permission !== 'granted') {
      setSyncState('needs-permission')
      return false
    }
    setSyncState('syncing')
    try {
      const notes = await parseVaultDirectory(handle)
      return applyVault(notes, handle.name || getVaultName(notes), handle)
    } catch {
      setSyncState('error')
      return false
    }
  }

  const handleConnectVault = async () => {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' })
        await syncFromHandle(handle, true)
        return
      } catch (error) {
        if (error?.name === 'AbortError') return
      }
    }
    vaultInputRef.current?.click()
  }

  const handleSyncVault = async () => {
    if (vaultHandle) {
      await syncFromHandle(vaultHandle, true)
    } else {
      await handleConnectVault()
    }
  }

  const handleVaultSelection = async (event) => {
    try {
      const notes = await parseVaultFiles(event.target.files || [])
      if (!notes.length) {
        setSyncState('empty')
        return
      }
      await applyVault(notes, getVaultName(notes))
    } finally {
      event.target.value = ''
    }
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([loadVaultSnapshot(), loadVaultHandle()]).then(async ([snapshot, handle]) => {
      if (cancelled) return
      if (handle) {
        setVaultHandle(handle)
        const synced = await syncFromHandle(handle)
        if (synced || cancelled) return
      }
      if (snapshot?.notes?.length && !cancelled) {
        setVaultNotes(snapshot.notes)
        setVaultName(snapshot.vaultName || getVaultName(snapshot.notes))
        setSyncState(handle ? 'needs-permission' : 'manual')
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!running) return undefined
    setActiveStage(0)
    const timers = stages.map((_, index) => setTimeout(() => setActiveStage(index), (index + 1) * 620))
    const finish = setTimeout(() => {
      setActiveStage(5)
      setMessages((current) => [...current, responseForQuestion(pendingQuestion)])
      setPendingQuestion('')
      setRunning(false)
    }, 3900)
    return () => {
      timers.forEach(clearTimeout)
      clearTimeout(finish)
    }
  }, [running, pendingQuestion])

  const activeTitle = useMemo(() => navItems.find((item) => item.id === activeSection)?.label || 'Research', [activeSection])

  const submitQuestion = () => {
    const question = input.trim()
    if (!question || running) return
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: question }])
    setInput('')
    setPendingQuestion(question)
    setRunning(true)
  }

  return (
    <div className="app-shell">
      <Sidebar
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        onConnectVault={handleConnectVault}
        onSyncVault={handleSyncVault}
        vaultName={vaultName}
        vaultNoteCount={vaultIndex.notes.length}
        syncState={syncState}
      />
      <input ref={vaultInputRef} className="visually-hidden" type="file" webkitdirectory="true" directory="true" multiple onChange={handleVaultSelection} />
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-title"><MessageSquare size={21} /><span>{activeSection === 'research' ? 'Ask your research vault' : activeTitle}</span></div>
          <div className="topbar-actions"><button className="new-chat">New chat <Plus size={17} /></button><button className="icon-button" aria-label="More options"><MoreHorizontal size={19} /></button></div>
        </header>

        {activeSection !== 'research' ? (activeSection === 'graph' && vaultIndex.notes.length ? <KnowledgeGraphSection index={vaultIndex} onOpenNote={setSelectedNote} /> : <EmptySection section={activeSection} />) : (
          <div className="workspace-content">
            <div className="chat-column">
              <div className="conversation">
                {messages.map((message) => message.role === 'user' ? <UserMessage text={message.text} key={message.id} /> : <AssistantMessage message={message} running={running} key={message.id} />)}
              </div>
              <EvidenceTrail activeStage={activeStage} />
              <Composer value={input} setValue={setInput} onSubmit={submitQuestion} disabled={running} />
            </div>
            <Inspector activeStage={activeStage} running={running} onPause={() => setRunning(false)} linkedNotes={inspectorNotes} sources={inspectorSources} vaultName={vaultName} onOpenNote={setSelectedNote} />
          </div>
        )}
      </main>
      {selectedNote && <NotePreview note={selectedNote} onClose={() => setSelectedNote(null)} />}
    </div>
  )
}

export default App

createRoot(document.getElementById('root')).render(<App />)
