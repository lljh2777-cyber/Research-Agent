import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Info,
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
  X,
} from 'lucide-react'
import { buildVaultIndex, getVaultName, parseVaultDirectory, parseVaultFiles } from './vault.js'
import KnowledgeGraphSection from './KnowledgeGraph.jsx'
import { PipelinesSection, RunsSection } from './PipelineWorkspace.jsx'
import { loadLocalVault } from './localVault.js'
import { chatgptCatalogToModels, DEFAULT_MODEL_CONFIG, getModelById, getModelsByRole, loadModelConfig, MODEL_REGISTRY, saveModelConfig } from './modelConfig.js'
import { executePipeline, loadPipelineRuns, savePipelineRuns } from './pipelineEngine.js'
import { buildEvidenceSystemMessage, buildEvidenceUserContext, buildRetrievalIndex, evidenceSources, retrieveEvidence } from './retrieval.js'
import { loadVaultHandle, loadVaultSnapshot, saveVaultHandle, saveVaultSnapshot } from './vaultStorage.js'
import { AUTH_SERVICE_UNAVAILABLE, getAuthStatus, getChatgptModels, logoutChatgpt, startChatgptLogin, streamChatgptResponse, waitForChatgptAuth } from './authClient.js'
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
const EMPTY_CHATGPT_CATALOG = {
  connected: false,
  source: 'disconnected',
  stale: false,
  fetchedAt: null,
  defaultModelId: null,
  models: [],
  warning: '',
}

function responseForQuestion(question, packet) {
  const evidence = packet?.evidence || []
  return {
    id: `assistant-${Date.now()}`,
    role: 'assistant',
    text: evidence.length
      ? `Retrieved ${evidence.length} relevant Vault evidence chunk${evidence.length === 1 ? '' : 's'} for “${question}”. This model profile is not connected to a live provider yet, so no unsupported synthesis was generated.`
      : 'Vault 中未找到足够依据。No relevant Markdown evidence matched this question, and this model profile is not connected to a live provider.',
    bullets: [],
    closing: 'Choose a ChatGPT-backed answer model to synthesize the retrieved evidence with inline citations.',
    evidence,
  }
}

function LogoMark() {
  return (
    <div className="logo-mark" aria-hidden="true">
      <Atom size={25} strokeWidth={1.7} />
    </div>
  )
}

function ModelPicker({ selectedModel, models, onSelect, disabled = false, authStatus, authBusy, modelCatalog, modelsBusy, onConnect, onLogout, onRefreshModels }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="model-picker" ref={rootRef}>
      <button className="model-select" onClick={() => setOpen(!open)} disabled={disabled} aria-haspopup="menu" aria-expanded={open}>
        <span>{selectedModel.name}</span><ChevronDown size={14} />
      </button>
      {open && <div className="model-menu" role="menu" aria-label="Research model">
        <div className="model-menu-heading">
          <span>Research model</span>
          <button onClick={() => onRefreshModels(true)} disabled={!authStatus?.connected || modelsBusy} aria-label="Refresh available models" title="Refresh models from this ChatGPT account">
            <RefreshCw className={modelsBusy ? 'spin' : ''} size={12} />
          </button>
        </div>
        {models.map((model) => {
          const ready = model.authProvider === 'chatgpt' ? authStatus?.connected : model.ready
          return <button className={`model-option ${model.id === selectedModel.id ? 'selected' : ''}`} key={model.id} onClick={() => { onSelect(model.id); setOpen(false) }} role="menuitem" disabled={!ready && !model.authProvider}>
            <span className="model-option-main"><strong>{model.name}</strong><small>{model.provider}</small></span>
            <span className={`model-readiness ${ready ? 'ready' : ''}`}>{ready ? 'ready' : model.authProvider ? 'connect' : 'later'}</span>
          </button>
        })}
        <div className="model-menu-account">
          <span className={`auth-dot ${authStatus?.connected ? 'connected' : ''}`} />
          <span><strong>ChatGPT account</strong><small>{authStatus?.connected ? `${modelCatalog?.models?.length || 0} models · ${modelCatalog?.source || 'discovering'}` : authStatus?.unavailable ? 'Local service offline · restart npm run dev' : 'Connect to discover available models'}</small></span>
          {authStatus?.connected ? <button className="auth-inline-button" onClick={() => { onLogout(); setOpen(false) }}>Sign out</button> : <button className="auth-inline-button" onClick={() => { onConnect(); setOpen(false) }}>{authBusy ? 'Waiting…' : authStatus?.unavailable ? 'Retry' : 'Connect'}</button>}
        </div>
        {modelCatalog?.warning && <div className="model-catalog-warning">{modelCatalog.warning}</div>}
        <div className="model-menu-note">OAuth credentials stay in the local auth service. Only retrieved Vault excerpts are sent when a connected answer model runs.</div>
      </div>}
    </div>
  )
}

function KnowledgeSettingsModal({ config, onClose, onSave }) {
  const [draft, setDraft] = useState(config)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const embeddingModels = getModelsByRole('embedding')
  const rerankModels = getModelsByRole('rerank')

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const modelOption = (model) => <option key={model.id} value={model.id}>{model.name} · {model.provider}</option>

  return (
    <div className="settings-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label="Knowledge base settings">
        <header className="settings-modal-header">
          <div><span className="settings-modal-kicker">Retrieval profile</span><h2>Knowledge base settings</h2><p>Configure how research notes become evidence for the agent.</p></div>
          <button className="note-preview-close" onClick={onClose} aria-label="Close knowledge base settings"><X size={18} /></button>
        </header>
        <div className="settings-modal-body">
          <label className="setting-field"><span>Document processing <Info size={14} /></span><select value={draft.parserId} onChange={(event) => update('parserId', event.target.value)}><option value="markdown">Markdown-aware parser</option><option value="plain-text">Plain text fallback</option></select><small>Preserves frontmatter, headings, wikilinks, formulas, and source paths.</small></label>
          <label className="setting-field"><span>Embedding model <Info size={14} /></span><select value={draft.embeddingModelId} onChange={(event) => update('embeddingModelId', event.target.value)}><option value="none">Not configured</option>{embeddingModels.map(modelOption)}</select><small>Used when building the vector index for the connected Vault.</small></label>
          <label className="setting-field"><span>Rerank model <Info size={14} /></span><select value={draft.rerankModelId} onChange={(event) => update('rerankModelId', event.target.value)}><option value="none">Disabled</option>{rerankModels.map(modelOption)}</select><small>Optional cross-encoder pass after the first retrieval.</small></label>
          <label className="setting-range"><span><strong>Top K evidence chunks</strong><output>{draft.topK}</output></span><input type="range" min="1" max="50" value={draft.topK} onChange={(event) => update('topK', Number(event.target.value))} /><small><span>1</span><span>50</span></small></label>
          <button className="advanced-toggle" onClick={() => setAdvancedOpen(!advancedOpen)}><strong>Advanced settings</strong>{advancedOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button>
          {advancedOpen && <div className="advanced-settings">
            <label className="inline-setting"><span>Chunk size</span><input type="number" min="200" max="4000" step="50" value={draft.chunkSize} onChange={(event) => update('chunkSize', Number(event.target.value))} /></label>
            <label className="inline-setting"><span>Chunk overlap</span><input type="number" min="0" max="1000" step="20" value={draft.chunkOverlap} onChange={(event) => update('chunkOverlap', Number(event.target.value))} /></label>
            <label className="setting-range"><span><strong>Similarity threshold</strong><output>{draft.similarityThreshold.toFixed(2)}</output></span><input type="range" min="0" max="1" step="0.05" value={draft.similarityThreshold} onChange={(event) => update('similarityThreshold', Number(event.target.value))} /><small><span>0.00</span><span>1.00</span></small></label>
            <label className="toggle-setting"><span><strong>Hybrid search</strong><small>Combine keyword and vector retrieval.</small></span><input type="checkbox" checked={draft.hybridSearch} onChange={(event) => update('hybridSearch', event.target.checked)} /></label>
            <label className="toggle-setting"><span><strong>Require source citations</strong><small>Keep note paths attached to generated answers.</small></span><input type="checkbox" checked={draft.citations} onChange={(event) => update('citations', event.target.checked)} /></label>
          </div>}
        </div>
        <footer className="settings-modal-footer"><button className="text-button" onClick={() => setDraft(DEFAULT_MODEL_CONFIG)}>Restore defaults</button><button className="primary-button" onClick={() => onSave(draft)}>Save settings</button></footer>
      </section>
    </div>
  )
}

function Sidebar({ activeSection, setActiveSection, onConnectVault, onSyncVault, onOpenSettings, vaultName, vaultNoteCount, syncState, vaultSource, localAdapterState, authStatus, authBusy, onConnectChatgpt, onLogoutChatgpt, authError }) {
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
            aria-label={label}
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
        {vaultSource === 'local-adapter' && <div className={`adapter-status ${localAdapterState}`}><Database size={14} /><span>{localAdapterState === 'ready' ? 'Local adapter online' : 'Local adapter offline'}</span>{localAdapterState === 'ready' && <small>auto sync 15s</small>}</div>}
        <div className={`account-status ${authStatus?.connected ? 'connected' : ''}`}>
          <Sparkles size={14} />
          <span>{authStatus?.connected ? 'ChatGPT connected' : authStatus?.unavailable ? 'Local ChatGPT service offline' : 'ChatGPT not connected'}</span>
          <button onClick={authStatus?.connected ? onLogoutChatgpt : onConnectChatgpt} disabled={authBusy}>{authStatus?.connected ? 'Sign out' : authBusy ? 'Waiting…' : authStatus?.unavailable ? 'Retry' : 'Connect'}</button>
        </div>
        {authError && <small className="auth-error" role="alert">{authError}</small>}
        <button className="settings-link" onClick={onOpenSettings}><Settings2 size={16} /> Settings</button>
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

function AssistantMessage({ message, running, onOpenNote }) {
  const evidence = message.evidence || []
  const sourceCount = new Set(evidence.map((item) => item.noteId)).size
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
          {(message.bullets || []).map(([name, detail, link]) => (
            <li key={name}>
              <strong>{name}</strong>: {detail} <a href={`#${link.replaceAll(' ', '-')}`}>[[{link}]]</a>
            </li>
          ))}
        </ul>
        <p>{message.closing}</p>
        {evidence.length > 0 && <div className="answer-evidence" aria-label="Answer evidence">
          {evidence.map((item, index) => <button key={item.id} onClick={() => onOpenNote({
            ...item,
            body: item.excerpt,
            frontmatter: { retrieval: item.relationship, score: item.score },
          })} title={item.path}><span>[{index + 1}]</span>{item.title}</button>)}
        </div>}
        <div className="message-actions">
          <button aria-label="Helpful"><ThumbsUp size={15} /></button>
          <button aria-label="Not helpful"><ThumbsDown size={15} /></button>
          <button aria-label="Copy"><FileText size={15} /></button>
          <button aria-label="Bookmark"><Bookmark size={15} /></button>
          <span className="message-time">10:24 AM <span>·</span> {sourceCount || 6} sources <ChevronDown size={14} /></span>
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

function Composer({ value, setValue, onSubmit, disabled, selectedModel, models, onSelectModel, authStatus, authBusy, modelCatalog, modelsBusy, onConnectChatgpt, onLogoutChatgpt, onRefreshModels }) {
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
            <ModelPicker selectedModel={selectedModel} models={models} onSelect={onSelectModel} disabled={disabled} authStatus={authStatus} authBusy={authBusy} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnect={onConnectChatgpt} onLogout={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
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

function RetrievalPath({ activeStage, vaultName, topK, rerankLabel, packet, answerMode }) {
  const evidenceCount = packet?.evidence?.length || 0
  const retrieval = packet?.retrieval
  const query = packet?.question || 'Ask a question to retrieve evidence'
  const path = [
    ['Query', query, packet ? 'done' : 'current'],
    [`BM25 + Wikilinks (top-k=${topK})`, vaultName ? `vault: ${vaultName}` : 'no Vault connected', packet ? 'done' : 'current'],
    ['Graph expansion', packet ? `${retrieval?.graphExpanded || 0} one-hop result${retrieval?.graphExpanded === 1 ? '' : 's'} · rerank: ${rerankLabel}` : 'waiting for a query', packet ? 'done' : 'current'],
    [`Selected (${evidenceCount} chunks)`, packet ? `${retrieval?.candidateCount || 0} lexical candidates` : 'no evidence selected yet', packet ? 'done' : 'current'],
    ['Answer model', packet ? activeStage >= 4 ? answerMode === 'chatgpt' ? 'Cited answer generated' : 'Retrieval preview only' : 'Agent working...' : 'waiting for evidence', packet && activeStage >= 4 ? 'done' : 'current'],
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

function Sources({ sources, onOpenNote }) {
  return (
    <section className="inspector-section sources-section">
      <div className="inspector-heading"><span>Sources ({sources.length})</span><ChevronUp size={15} /></div>
      <div className="source-list">
        {sources.map((source, index) => (
          <button className="source-row" key={source.path || source.name} onClick={() => source.note && onOpenNote(source.note)} disabled={!source.note} title={source.path || source.name}>
            <span className="source-index">{index + 1}</span><FileText size={15} /><span className="source-name">{source.name}</span><span className={`source-kind ${source.kind}`}>{source.kind}</span>
          </button>
        ))}
        {sources.length === 0 && <div className="source-empty">No evidence retrieved yet.</div>}
      </div>
      <button className="show-more">Show all sources <ChevronDown size={15} /></button>
    </section>
  )
}

function Inspector({ activeStage, running, onPause, linkedNotes, sources, vaultName, topK, rerankLabel, packet, answerMode, onOpenNote }) {
  return (
    <aside className="inspector">
      <div className="inspector-title"><BookOpen size={18} /> <span>Knowledge context</span><ChevronUp size={16} /></div>
      <LinkedNotes notes={linkedNotes} onOpenNote={onOpenNote} />
      <RetrievalPath activeStage={activeStage} vaultName={vaultName} topK={topK} rerankLabel={rerankLabel} packet={packet} answerMode={answerMode} />
      <AgentStatus activeStage={activeStage} running={running} onPause={onPause} />
      <Sources sources={sources} onOpenNote={onOpenNote} />
    </aside>
  )
}

function EmptyGraphSection({ onConnectVault }) {
  return <div className="empty-section"><div className="empty-icon"><Layers3 size={26} /></div><h2>Knowledge Graph</h2><p>Connect an Obsidian Vault to map papers, methods, datasets, and concepts from local wikilinks.</p><button className="primary-button" onClick={onConnectVault}><Plus size={16} /> Connect Vault</button></div>
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
  const [vaultSource, setVaultSource] = useState('sample')
  const [localAdapterState, setLocalAdapterState] = useState('checking')
  const [localRevision, setLocalRevision] = useState('')
  const [syncState, setSyncState] = useState('idle')
  const [selectedNote, setSelectedNote] = useState(null)
  const [modelConfig, setModelConfig] = useState(DEFAULT_MODEL_CONFIG)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [authStatus, setAuthStatus] = useState({ provider: 'chatgpt', connected: false, pending: false })
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [modelCatalog, setModelCatalog] = useState(EMPTY_CHATGPT_CATALOG)
  const [modelsBusy, setModelsBusy] = useState(false)
  const [runMode, setRunMode] = useState('mock')
  const [answerMode, setAnswerMode] = useState('sample')
  const [retrievalPacket, setRetrievalPacket] = useState(null)
  const [pipelineRuns, setPipelineRuns] = useState(loadPipelineRuns)
  const [pipelineRunningId, setPipelineRunningId] = useState(null)
  const [selectedPipelineRunId, setSelectedPipelineRunId] = useState(null)
  const vaultInputRef = useRef(null)
  const requestAbortRef = useRef(null)
  const pipelineRunTimerRef = useRef(null)

  const vaultIndex = useMemo(() => buildVaultIndex(vaultNotes), [vaultNotes])
  const retrievalIndex = useMemo(
    () => buildRetrievalIndex(vaultNotes, { chunkSize: modelConfig.chunkSize, chunkOverlap: modelConfig.chunkOverlap }),
    [vaultNotes, modelConfig.chunkSize, modelConfig.chunkOverlap],
  )
  const staticChatModels = useMemo(() => getModelsByRole('chat'), [])
  const chatModels = useMemo(() => {
    const smartModel = staticChatModels.find((model) => model.id === 'smart-default')
    const futureModels = staticChatModels.filter((model) => model.id !== 'smart-default')
    const discoveredModels = chatgptCatalogToModels(modelCatalog.models)
    return [smartModel, ...discoveredModels, ...futureModels].filter(Boolean)
  }, [modelCatalog.models, staticChatModels])
  const selectedModel = useMemo(() => getModelById(modelConfig.chatModelId, chatModels), [chatModels, modelConfig.chatModelId])
  const rerankModel = useMemo(() => MODEL_REGISTRY.find((model) => model.id === modelConfig.rerankModelId), [modelConfig.rerankModelId])
  const notesById = useMemo(() => new Map(vaultNotes.map((note) => [note.id, note])), [vaultNotes])
  const retrievedNotes = useMemo(() => {
    const seen = new Set()
    return (retrievalPacket?.evidence || []).flatMap((item) => {
      if (seen.has(item.noteId)) return []
      seen.add(item.noteId)
      return notesById.has(item.noteId) ? [notesById.get(item.noteId)] : []
    })
  }, [notesById, retrievalPacket])
  const retrievedSources = useMemo(() => evidenceSources(retrievalPacket).map((source) => ({
    ...source,
    note: notesById.get(source.id) || null,
  })), [notesById, retrievalPacket])
  const vaultSources = useMemo(() => vaultIndex.sources.map((source) => ({
    ...source,
    note: notesById.get(source.id) || null,
  })), [notesById, vaultIndex.sources])
  const inspectorNotes = retrievalPacket ? retrievedNotes : vaultIndex.notes.length ? vaultIndex.linkedNotes : sampleLinkedNotes
  const inspectorSources = retrievalPacket ? retrievedSources : vaultSources.length ? vaultSources : sampleSources

  const applyVault = async (notes, nextVaultName, { handle = null, source = 'manual', revision = '' } = {}) => {
    if (!notes.length) {
      setSyncState('empty')
      return false
    }
    setVaultNotes(notes)
    setVaultName(nextVaultName)
    setVaultHandle(handle)
    setVaultSource(source)
    setLocalRevision(revision)
    setRetrievalPacket(null)
    setAnswerMode('sample')
    await saveVaultSnapshot({ vaultName: nextVaultName, notes, source, revision })
    if (handle) await saveVaultHandle(handle)
    setSyncState(source === 'local-adapter' || handle ? 'ready' : 'manual')
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
      return applyVault(notes, handle.name || getVaultName(notes), { handle, source: 'browser-handle' })
    } catch {
      setSyncState('error')
      return false
    }
  }

  const syncFromLocalAdapter = async (silent = false) => {
    if (!silent) setSyncState('syncing')
    try {
      const payload = await loadLocalVault({ revision: localRevision, timeout: silent ? 1800 : 2200 })
      setLocalAdapterState('ready')
      if (payload.unchanged) {
        setSyncState('ready')
        return true
      }
      const notes = payload.notes || []
      if (!notes.length) {
        setVaultNotes([])
        setVaultName(payload.vaultName || 'local-vault')
        setVaultHandle(null)
        setVaultSource('local-adapter')
        setLocalRevision(payload.revision || '')
        setRetrievalPacket(null)
        setAnswerMode('sample')
        await saveVaultSnapshot({ vaultName: payload.vaultName || 'local-vault', notes: [], source: 'local-adapter', revision: payload.revision || '' })
        setSyncState('empty')
        return true
      }
      return applyVault(notes, payload.vaultName || getVaultName(notes), { source: 'local-adapter', revision: payload.revision || '' })
    } catch {
      setLocalAdapterState('offline')
      if (!silent) setSyncState('error')
      return false
    }
  }

  const handleConnectVault = async () => {
    if (await syncFromLocalAdapter()) return
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
    if (vaultSource === 'local-adapter') {
      await syncFromLocalAdapter()
    } else if (vaultHandle) {
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
      await applyVault(notes, getVaultName(notes), { source: 'manual' })
    } finally {
      event.target.value = ''
    }
  }

  useEffect(() => {
    setModelConfig(loadModelConfig())
  }, [])

  const refreshChatgptModels = useCallback(async (force = false) => {
    setModelsBusy(true)
    try {
      const catalog = await getChatgptModels({ force })
      setModelCatalog({ ...EMPTY_CHATGPT_CATALOG, ...catalog, warning: catalog.warning || '' })
      if (catalog.connected === false) {
        setAuthStatus((current) => ({ ...current, connected: false, type: null, expiresAt: null }))
      }
      return catalog
    } catch (error) {
      setModelCatalog((current) => ({ ...current, warning: error.message || 'Could not discover ChatGPT models.' }))
      return null
    } finally {
      setModelsBusy(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getAuthStatus().then((status) => {
      if (!cancelled) setAuthStatus(status)
    }).catch(() => {
      if (!cancelled) setAuthStatus({ provider: 'chatgpt', connected: false, pending: false, unavailable: true })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!authStatus.connected) {
      setModelCatalog(EMPTY_CHATGPT_CATALOG)
      return
    }
    void refreshChatgptModels(false)
  }, [authStatus.connected, refreshChatgptModels])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadVaultSnapshot(), loadVaultHandle()]).then(async ([snapshot, handle]) => {
      if (cancelled) return
      const localSynced = await syncFromLocalAdapter(true)
      if (localSynced || cancelled) return
      if (handle) {
        setVaultHandle(handle)
        const synced = await syncFromHandle(handle)
        if (synced || cancelled) return
      }
      if (snapshot?.notes?.length && !cancelled) {
        setVaultNotes(snapshot.notes)
        setVaultName(snapshot.vaultName || getVaultName(snapshot.notes))
        setVaultSource(snapshot.source || (handle ? 'browser-handle' : 'manual'))
        setLocalRevision(snapshot.revision || '')
        setSyncState(handle ? 'needs-permission' : 'manual')
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (vaultSource !== 'local-adapter') return undefined
    const timer = window.setInterval(() => syncFromLocalAdapter(true), 15000)
    return () => window.clearInterval(timer)
  }, [vaultSource, localRevision])

  useEffect(() => {
    if (!running || runMode !== 'mock') return undefined
    setActiveStage(0)
    const timers = stages.map((_, index) => setTimeout(() => setActiveStage(index), (index + 1) * 620))
    const finish = setTimeout(() => {
      setActiveStage(5)
      setMessages((current) => [...current, responseForQuestion(pendingQuestion, retrievalPacket)])
      setPendingQuestion('')
      setRunning(false)
    }, 3900)
    return () => {
      timers.forEach(clearTimeout)
      clearTimeout(finish)
    }
  }, [running, pendingQuestion, retrievalPacket, runMode])

  useEffect(() => () => {
    if (pipelineRunTimerRef.current) window.clearTimeout(pipelineRunTimerRef.current)
  }, [])

  const activeTitle = useMemo(() => navItems.find((item) => item.id === activeSection)?.label || 'Research', [activeSection])

  const handleConnectChatgpt = async () => {
    if (authBusy || authStatus.connected) return authStatus
    setAuthBusy(true)
    setAuthError('')
    setAuthStatus((current) => ({ ...current, pending: true }))
    try {
      await startChatgptLogin()
      const nextStatus = await waitForChatgptAuth()
      setAuthStatus(nextStatus)
      return nextStatus
    } catch (error) {
      setAuthError(error.message || 'ChatGPT connection failed')
      setAuthStatus((current) => ({ ...current, pending: false, unavailable: error.code === AUTH_SERVICE_UNAVAILABLE || current.unavailable }))
      return null
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogoutChatgpt = async () => {
    setAuthError('')
    try {
      const nextStatus = await logoutChatgpt()
      setAuthStatus(nextStatus)
    } catch (error) {
      setAuthError(error.message || 'Could not sign out')
    }
  }

  const submitQuestion = async () => {
    const question = input.trim()
    if (!question || running) return
    const packet = retrieveEvidence(retrievalIndex, question, {
      topK: modelConfig.topK,
      similarityThreshold: modelConfig.similarityThreshold,
    })
    setRetrievalPacket(packet)
    let chatgptConnected = authStatus.connected
    if (selectedModel.authProvider === 'chatgpt' && !chatgptConnected) {
      const connected = await handleConnectChatgpt()
      chatgptConnected = Boolean(connected?.connected)
      if (!chatgptConnected) return
    }
    const live = (selectedModel.authProvider === 'chatgpt' || selectedModel.id === 'smart-default') && chatgptConnected
    setAnswerMode(live ? 'chatgpt' : 'retrieval-only')
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', text: question }])
    setInput('')
    if (live) {
      const assistantId = `assistant-${Date.now()}`
      const controller = new AbortController()
      requestAbortRef.current = controller
      setRunMode('live')
      setActiveStage(3)
      setRunning(true)
      setMessages((current) => [...current, {
        id: assistantId,
        role: 'assistant',
        text: '',
        bullets: [],
        closing: '',
        evidence: packet.evidence,
      }])
      let streamedText = ''
      let renderFrame = 0
      const flushStreamedText = () => {
        renderFrame = 0
        setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, text: streamedText } : message))
      }
      try {
        const history = messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-20)
          .map((message) => ({
            role: message.role,
            content: [message.text, message.closing].filter(Boolean).join('\n\n'),
          }))
        let activeCatalog = modelCatalog
        if (selectedModel.id === 'smart-default' && !activeCatalog.defaultModelId) {
          activeCatalog = await refreshChatgptModels(false) || activeCatalog
        }
        const result = await streamChatgptResponse({
          model: selectedModel.id === 'smart-default' ? activeCatalog.defaultModelId || 'gpt-5.4' : selectedModel.id,
          messages: [
            { role: 'system', content: buildEvidenceSystemMessage(packet, { citations: modelConfig.citations }) },
            ...history,
            { role: 'user', content: buildEvidenceUserContext(packet) },
            { role: 'user', content: question },
          ],
          signal: controller.signal,
          onDelta: (delta) => {
            streamedText += delta
            setActiveStage(4)
            if (!renderFrame) renderFrame = window.requestAnimationFrame(flushStreamedText)
          },
        })
        if (renderFrame) window.cancelAnimationFrame(renderFrame)
        setActiveStage(5)
        setMessages((current) => current.map((message) => message.id === assistantId ? {
          ...message,
          text: result.text || streamedText || 'The provider returned an empty response.',
          closing: `Generated with ${result.model} through the connected ChatGPT subscription · ${packet.evidence.length} Vault evidence chunk${packet.evidence.length === 1 ? '' : 's'}.`,
        } : message))
      } catch (error) {
        if (renderFrame) window.cancelAnimationFrame(renderFrame)
        setActiveStage(5)
        setMessages((current) => current.map((message) => message.id === assistantId ? {
          ...message,
          text: streamedText || message.text || (error.name === 'AbortError' ? 'Generation stopped.' : `The connected model could not complete this request: ${error.message}`),
          closing: error.name === 'AbortError' ? 'The partial response was kept.' : 'Check the ChatGPT connection and try again.',
        } : message))
      } finally {
        if (requestAbortRef.current === controller) requestAbortRef.current = null
        setRunning(false)
        setRunMode('mock')
      }
      return
    }
    setRunMode('mock')
    setPendingQuestion(question)
    setRunning(true)
  }

  const handleModelSelect = async (chatModelId) => {
    const model = getModelById(chatModelId, chatModels)
    if (model.authProvider === 'chatgpt' && !authStatus.connected) {
      const connected = await handleConnectChatgpt()
      if (!connected?.connected) return
    }
    setModelConfig((current) => {
      const next = { ...current, chatModelId }
      saveModelConfig(next)
      return next
    })
  }

  const handlePause = () => {
    requestAbortRef.current?.abort()
    setActiveStage(5)
    setRunning(false)
  }

  const handleSettingsSave = (nextConfig) => {
    setModelConfig(nextConfig)
    saveModelConfig(nextConfig)
    setSettingsOpen(false)
  }

  const handleRunPipeline = useCallback((pipelineId) => {
    if (!vaultNotes.length || pipelineRunTimerRef.current) return
    const startedAt = new Date().toISOString()
    setPipelineRunningId(pipelineId)
    pipelineRunTimerRef.current = window.setTimeout(() => {
      try {
        const run = executePipeline(pipelineId, {
          vaultName: vaultName || getVaultName(vaultNotes),
          notes: vaultNotes,
          vaultIndex,
          retrievalIndex,
          chunkSize: modelConfig.chunkSize,
        }, { startedAt })
        setPipelineRuns((current) => {
          const next = [run, ...current]
          savePipelineRuns(next)
          return next
        })
        setSelectedPipelineRunId(run.id)
      } finally {
        pipelineRunTimerRef.current = null
        setPipelineRunningId(null)
      }
    }, 700)
  }, [modelConfig.chunkSize, retrievalIndex, vaultIndex, vaultName, vaultNotes])

  const handleViewPipelineRun = (runId) => {
    setSelectedPipelineRunId(runId)
    setActiveSection('runs')
  }

  const handleNewChat = () => {
    requestAbortRef.current?.abort()
    setMessages([])
    setInput('')
    setPendingQuestion('')
    setRetrievalPacket(null)
    setRunning(false)
    setAnswerMode('sample')
    setActiveSection('research')
  }

  const ActiveSectionIcon = navItems.find((item) => item.id === activeSection)?.icon || MessageSquare

  return (
    <div className="app-shell">
      <Sidebar
        activeSection={activeSection}
        setActiveSection={setActiveSection}
        onConnectVault={handleConnectVault}
        onSyncVault={handleSyncVault}
        onOpenSettings={() => setSettingsOpen(true)}
        vaultName={vaultName}
        vaultNoteCount={vaultIndex.notes.length}
        syncState={syncState}
        vaultSource={vaultSource}
        localAdapterState={localAdapterState}
        authStatus={authStatus}
        authBusy={authBusy}
        onConnectChatgpt={handleConnectChatgpt}
        onLogoutChatgpt={handleLogoutChatgpt}
        authError={authError}
      />
      <input ref={vaultInputRef} className="visually-hidden" type="file" webkitdirectory="true" directory="true" multiple onChange={handleVaultSelection} />
      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-title"><ActiveSectionIcon size={21} /><span>{activeSection === 'research' ? 'Ask your research vault' : activeTitle}</span></div>
          <div className="topbar-actions"><button className="new-chat" onClick={handleNewChat}>New chat <Plus size={17} /></button><button className="icon-button mobile-settings-button" onClick={() => setSettingsOpen(true)} aria-label="Open knowledge settings"><Settings2 size={18} /></button><button className="icon-button" aria-label="More options"><MoreHorizontal size={19} /></button></div>
        </header>

        {activeSection === 'graph' ? (vaultIndex.notes.length ? <KnowledgeGraphSection index={vaultIndex} onOpenNote={setSelectedNote} /> : <EmptyGraphSection onConnectVault={handleConnectVault} />) : activeSection === 'pipelines' ? (
          <PipelinesSection vaultName={vaultName} noteCount={vaultNotes.length} runs={pipelineRuns} runningPipelineId={pipelineRunningId} onRun={handleRunPipeline} onViewRun={handleViewPipelineRun} onConnectVault={handleConnectVault} />
        ) : activeSection === 'runs' ? (
          <RunsSection runs={pipelineRuns} selectedRunId={selectedPipelineRunId} onSelectRun={setSelectedPipelineRunId} />
        ) : (
          <div className="workspace-content">
            <div className="chat-column">
              <div className="conversation">
                {messages.map((message) => message.role === 'user' ? <UserMessage text={message.text} key={message.id} /> : <AssistantMessage message={message} running={running} onOpenNote={setSelectedNote} key={message.id} />)}
              </div>
              <EvidenceTrail activeStage={activeStage} />
              <Composer value={input} setValue={setInput} onSubmit={submitQuestion} disabled={running} selectedModel={selectedModel} models={chatModels} onSelectModel={handleModelSelect} authStatus={authStatus} authBusy={authBusy} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnectChatgpt={handleConnectChatgpt} onLogoutChatgpt={handleLogoutChatgpt} onRefreshModels={refreshChatgptModels} />
            </div>
            <Inspector activeStage={activeStage} running={running} onPause={handlePause} linkedNotes={inspectorNotes} sources={inspectorSources} vaultName={vaultName} topK={modelConfig.topK} rerankLabel={rerankModel?.name || 'Disabled by profile'} packet={retrievalPacket} answerMode={answerMode} onOpenNote={setSelectedNote} />
          </div>
        )}
      </main>
      {selectedNote && <NotePreview note={selectedNote} onClose={() => setSelectedNote(null)} />}
      {settingsOpen && <KnowledgeSettingsModal config={modelConfig} onClose={() => setSettingsOpen(false)} onSave={handleSettingsSave} />}
    </div>
  )
}

export default App

createRoot(document.getElementById('root')).render(<App />)
