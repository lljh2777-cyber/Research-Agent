import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Atom, Bookmark, BookOpen, Check, CheckCircle2, ChevronDown, ChevronUp, CircleDot, Code2, Database, ExternalLink, FileText, GitBranch, LoaderCircle, MessageSquare, Network, Paperclip, Pause, RefreshCw, Search, Send, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { describeVaultConnection, VAULT_CONNECTION_STATUS } from '../../vaultConnection.js'
import { AGENT_PRESETS, getAgentPreset, TOOL_IDS } from '../../agentPresets.js'
import { AgentConversationPanel } from '../knowledge/AgentConversationPanel.jsx'
import { getResearchRunPresentation } from './runPresentation.js'

const stages = ['Query parsed', 'Retrieve', 'Rerank', 'Synthesize', 'Cite']
const RESEARCH_TOOL_OPTIONS = Object.freeze({
  [TOOL_IDS.VAULT_SEARCH]: { label: 'Vault retrieval', detail: 'Retrieve relevant Markdown evidence before answering.', icon: Search },
  [TOOL_IDS.VAULT_WIKILINKS]: { label: 'Wikilink graph', detail: 'Expand retrieval through related Obsidian notes.', icon: Network },
  [TOOL_IDS.WEB_SEARCH]: { label: 'Web search', detail: 'Use provider-hosted search when the selected model supports it.', icon: ExternalLink },
  [TOOL_IDS.MCP]: { label: 'MCP tools', detail: 'Expose connected research tools under the local permission policy.', icon: GitBranch },
  [TOOL_IDS.CODE_EXECUTE]: { label: 'Code execution', detail: 'Allow sandboxed analysis tools when a runtime is connected.', icon: Code2 },
  [TOOL_IDS.VAULT_WRITE]: { label: 'Vault write', detail: 'Allow approved changes to the current knowledge base.', icon: FileText },
})

function formatMessageTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ModelPicker({ selectedModel, models, onSelect, disabled = false, placement = 'top', authStatus, authBusy, modelCatalog, modelsBusy, onConnect, onLogout, onRefreshModels }) {
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
    <div className="model-picker" data-placement={placement} ref={rootRef}>
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
          <span><strong>ChatGPT account</strong><small>{authStatus?.connected ? `${modelCatalog?.models?.length || 0} models - ${modelCatalog?.source || 'discovering'}` : authStatus?.unavailable ? 'Local service offline - restart npm run dev' : 'Connect to discover available models'}</small></span>
          {authStatus?.connected ? <button className="auth-inline-button" onClick={() => { onLogout(); setOpen(false) }}>Sign out</button> : <button className="auth-inline-button" onClick={() => { onConnect(); setOpen(false) }}>{authBusy ? 'Waiting...' : authStatus?.unavailable ? 'Retry' : 'Connect'}</button>}
        </div>
        {modelCatalog?.warning && <div className="model-catalog-warning">{modelCatalog.warning}</div>}
        <div className="model-menu-note">OAuth credentials stay in the local auth service. Only retrieved Vault excerpts are sent when a connected answer model runs.</div>
      </div>}
    </div>
  )
}
function UserMessage({ message }) {
  const time = formatMessageTime(message.createdAt)
  return (
    <div className="user-message">
      <div className="message-meta">
        <span>Research question</span>
        {time && <span>{time} <Check size={13} /></span>}
      </div>
      <p>{message.text}</p>
    </div>
  )
}

function AssistantMessage({ message, running, onOpenNote }) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const evidence = message.evidence || []
  const sourceCount = new Set(evidence.map((item) => item.noteId)).size
  const reasoning = message.reasoning || ''
  const toolTrace = message.toolTrace || []
  const toolCallCount = toolTrace.reduce((total, round) => total + round.results.length, 0)
  const time = formatMessageTime(message.createdAt)
  return (
    <article className="assistant-message" data-run-id={message.runId || undefined}>
      <div className="assistant-avatar"><Sparkles size={17} /></div>
      <div className="assistant-content">
        <div className="assistant-title-row">
          <strong>Research agent</strong>
          {running && <span className="live-label"><span className="live-dot" /> composing</span>}
        </div>
        {reasoning && <section className={`reasoning-panel ${reasoningOpen ? 'open' : ''}`}>
          <button type="button" onClick={() => setReasoningOpen((current) => !current)} aria-expanded={reasoningOpen}>
            <span><Sparkles size={13} /><strong>{running ? 'Thinking' : 'Reasoning'}</strong><small>{reasoning.length.toLocaleString()} characters</small></span>
            {reasoningOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {reasoningOpen && <pre>{reasoning}</pre>}
        </section>}
        {toolTrace.length > 0 && <section className="tool-activity" aria-label="Research tool activity">
          <div><Search size={13} /><strong>Vault tools</strong><small>{toolCallCount} call{toolCallCount === 1 ? '' : 's'}</small></div>
          {toolTrace.flatMap((round) => round.results).map((result) => <div className={result.isError ? 'error' : ''} key={result.id}><span>{result.isError ? 'Failed' : 'Complete'}</span><strong>{result.name}</strong><p>{result.summary}</p></div>)}
        </section>}
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
          <span className="message-time">{time ? <>{time} <span> / </span> </> : null}{sourceCount} source{sourceCount === 1 ? '' : 's'} <ChevronDown size={14} /></span>
        </div>
      </div>
    </article>
  )
}

function EvidenceTrail({ activeStage, running, hasActivity }) {
  return (
    <section className="evidence-trail">
      <div className="section-label-row">
        <span><ChevronDown size={15} /> Evidence trail</span>
        <ChevronUp size={15} />
      </div>
      <div className="stage-row">
        {stages.map((stage, index) => {
          const complete = hasActivity && index < activeStage
          const current = running && index === activeStage
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
  const fileInputRef = useRef(null)
  const dragDepthRef = useRef(0)
  const [attachments, setAttachments] = useState([])
  const [isDragging, setIsDragging] = useState(false)

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList ?? [])
    if (incoming.length === 0) return
    setAttachments((current) => {
      const filesByIdentity = new Map(current.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]))
      incoming.forEach((file) => filesByIdentity.set(`${file.name}:${file.size}:${file.lastModified}`, file))
      return Array.from(filesByIdentity.values())
    })
  }

  const handleDragEnter = (event) => {
    event.preventDefault()
    dragDepthRef.current += 1
    setIsDragging(true)
  }

  const handleDragLeave = (event) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }

  const handleDrop = (event) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)
    addFiles(event.dataTransfer.files)
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }
  return (
    <div className="composer-wrap">
      <div
        className={`composer ${isDragging ? 'drag-active' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          onChange={(event) => {
            addFiles(event.target.files)
            event.target.value = ''
          }}
          tabIndex={-1}
          aria-hidden="true"
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a follow-up about your research..."
          rows={2}
          disabled={disabled}
        />
        <div className="composer-context" aria-live="polite">
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((file) => (
                <span className="attachment-chip" key={`${file.name}:${file.size}:${file.lastModified}`}>
                  <FileText size={13} />
                  <span>{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setAttachments((current) => current.filter((item) => item !== file))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span className="composer-drop-hint"><Paperclip size={13} />Drop files here to add research context</span>
          )}
        </div>
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button" aria-label="Attach file" onClick={() => fileInputRef.current?.click()}><Paperclip size={18} /></button>
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
    </div>
  )
}

function ResearchSetup({
  config,
  selectedModel,
  models,
  vaultName,
  vaultNoteCount,
  vaultSyncState,
  mcpConnected,
  authStatus,
  authBusy,
  modelCatalog,
  modelsBusy,
  onSelectAgent,
  onUpdateIdentity,
  onUpdateSystemPrompt,
  onResetSystemPrompt,
  onSelectModel,
  onSelectVault,
  onToggleTool,
  onConnectVault,
  onConnectChatgpt,
  onLogoutChatgpt,
  onRefreshModels,
  onStart,
}) {
  const selectedAgent = getAgentPreset(config.source?.agentId)
  const identity = config.identity || { name: selectedAgent.name, shortName: selectedAgent.shortName || selectedAgent.name }
  const enabledTools = new Set(config.enabledTools || [])
  const hasVaultScope = Boolean(vaultName && config.knowledgeScopes?.some((scope) => scope.vaultId === vaultName))
  const vaultPresentation = describeVaultConnection({ vaultName, noteCount: vaultNoteCount, syncState: vaultSyncState })

  const toolAvailability = (toolId) => {
    if (toolId.startsWith('vault.') && !hasVaultScope) return vaultName ? 'Select the current Vault first' : 'Connect a Vault first'
    if (toolId === TOOL_IDS.WEB_SEARCH && !selectedModel.capabilities?.webSearch) return 'Not supported by this model'
    if (toolId === TOOL_IDS.MCP && !mcpConnected) return 'No MCP server connected'
    if (toolId === TOOL_IDS.CODE_EXECUTE) return 'Code runtime coming later'
    if (toolId === TOOL_IDS.VAULT_WRITE) return 'Write workflow coming later'
    return ''
  }
  const enabledToolCount = [...enabledTools].filter((toolId) => !toolAvailability(toolId)).length
  const canStart = Boolean(identity.name?.trim() && identity.shortName?.trim() && config.systemPrompt?.trim())

  return <section className="research-setup" aria-labelledby="research-setup-title">
    <header className="research-setup-header">
      <div><span className="eyebrow">New research</span><h2 id="research-setup-title">Configure your research workspace</h2><p>Choose a scientific role, model, evidence scope, and the tools this conversation may use.</p></div>
      <div className="research-setup-snapshot"><ShieldCheck size={16} /><span><strong>Conversation snapshot</strong><small>These settings stay with this tab and will not change when a preset is edited later.</small></span></div>
    </header>
    <div className="research-setup-layout">
      <aside className="agent-preset-panel">
        <div className="research-setup-section-title"><span>Agent preset</span><small>{AGENT_PRESETS.length} built in</small></div>
        <div className="agent-preset-list">
          {AGENT_PRESETS.map((preset) => <button type="button" className={preset.id === selectedAgent.id ? 'selected' : ''} aria-pressed={preset.id === selectedAgent.id} onClick={() => onSelectAgent(preset.id)} key={preset.id}>
            <span className="agent-preset-icon"><Atom size={18} /></span>
            <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
            {preset.id === selectedAgent.id && <Check size={15} />}
          </button>)}
        </div>
      </aside>
      <div className="research-setup-config">
        <section className="research-config-block agent-identity-block">
          <div className="research-config-heading"><span><Sparkles size={16} />Agent identity</span><small>Editable for this conversation</small></div>
          <div className="agent-identity-grid">
            <label><span>Agent name</span><input value={identity.name || ''} maxLength={48} onChange={(event) => onUpdateIdentity({ name: event.target.value })} placeholder="Biologist" /></label>
            <label><span>Short name</span><input value={identity.shortName || ''} maxLength={16} onChange={(event) => onUpdateIdentity({ shortName: event.target.value })} placeholder="Bio" /></label>
          </div>
          <div className="system-prompt-field">
            <div><label htmlFor="research-agent-system-prompt">System prompt</label><button type="button" onClick={onResetSystemPrompt}><RefreshCw size={11} />Restore preset</button></div>
            <textarea id="research-agent-system-prompt" value={config.systemPrompt || ''} maxLength={6000} rows={4} onChange={(event) => onUpdateSystemPrompt(event.target.value)} placeholder="Describe how this agent should reason, use evidence, and format its answer." />
            <small>{(config.systemPrompt || '').length} / 6000 - saved in this conversation snapshot</small>
          </div>
        </section>
        <section className="research-config-block">
          <div className="research-config-heading"><span><Atom size={16} />Model</span><small>Temporary for this conversation</small></div>
          <div className="research-model-choice">
            <div><strong>{selectedModel.name}</strong><small>{selectedModel.provider} - {selectedModel.detail || 'Research model'}</small></div>
            <ModelPicker selectedModel={selectedModel} models={models} onSelect={onSelectModel} placement="bottom" authStatus={authStatus} authBusy={authBusy} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnect={onConnectChatgpt} onLogout={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
          </div>
        </section>
        <section className="research-config-block">
          <div className="research-config-heading"><span><Database size={16} />Knowledge base</span><small>Evidence boundary</small></div>
          <div className="knowledge-scope-options">
            <button type="button" className={!hasVaultScope ? 'selected' : ''} aria-pressed={!hasVaultScope} onClick={() => onSelectVault(false)}><span><strong>No Vault</strong><small>Use model knowledge and enabled external tools only.</small></span>{!hasVaultScope && <Check size={15} />}</button>
            {vaultName ? <button type="button" className={hasVaultScope ? 'selected' : ''} aria-pressed={hasVaultScope} onClick={() => onSelectVault(true)}><Database size={18} /><span><strong>{vaultPresentation.title}</strong><small>{vaultPresentation.status === VAULT_CONNECTION_STATUS.CACHED ? vaultPresentation.detail : `${vaultPresentation.detail} - read-only evidence`}</small></span>{hasVaultScope && <Check size={15} />}</button>
              : <button type="button" className="connect-vault-option" onClick={onConnectVault}><Database size={18} /><span><strong>Connect an Obsidian Vault</strong><small>Select a local knowledge-base folder.</small></span><ArrowRight size={15} /></button>}
          </div>
        </section>
        <section className="research-config-block research-tools-block">
          <div className="research-config-heading"><span><GitBranch size={16} />Tools</span><small>{enabledToolCount} enabled</small></div>
          <div className="research-tool-options">
            {(config.allowedTools || []).map((toolId) => {
              const option = RESEARCH_TOOL_OPTIONS[toolId]
              if (!option) return null
              const unavailable = toolAvailability(toolId)
              const Icon = option.icon
              const checked = enabledTools.has(toolId) && !unavailable
              return <button type="button" className={checked ? 'selected' : ''} aria-pressed={checked} disabled={Boolean(unavailable)} title={unavailable || option.detail} onClick={() => onToggleTool(toolId, !checked)} key={toolId}>
                <Icon size={17} /><span><strong>{option.label}</strong><small>{unavailable || option.detail}</small></span><span className="research-tool-check">{checked ? <Check size={13} /> : null}</span>
              </button>
            })}
          </div>
        </section>
      </div>
    </div>
    <footer className="research-setup-footer">
      <div><span>{identity.name || selectedAgent.name}</span><span>{identity.shortName || selectedAgent.shortName}</span><span>{selectedModel.name}</span><span>{hasVaultScope ? vaultName : 'No Vault'}</span><span>{enabledToolCount} tools</span></div>
      <button className="research-start-button" type="button" onClick={onStart} disabled={!canStart} title={canStart ? 'Start conversation' : 'Agent name, short name, and system prompt are required'}><MessageSquare size={16} />Start conversation<ArrowRight size={15} /></button>
    </footer>
  </section>
}

function ResearchContextBar({ config, selectedModel, vaultName, mcpConnected, canEdit, onEdit }) {
  const agent = getAgentPreset(config.source?.agentId)
  const identity = config.identity || { name: agent.name }
  const hasVault = Boolean(vaultName && config.knowledgeScopes?.some((scope) => scope.vaultId === vaultName))
  const enabledToolCount = (config.enabledTools || []).filter((toolId) => {
    if (toolId.startsWith('vault.')) return hasVault
    if (toolId === TOOL_IDS.WEB_SEARCH) return Boolean(selectedModel.capabilities?.webSearch)
    if (toolId === TOOL_IDS.MCP) return mcpConnected
    if ([TOOL_IDS.CODE_EXECUTE, TOOL_IDS.VAULT_WRITE].includes(toolId)) return false
    return true
  }).length
  return <div className="research-context-bar" aria-label="Conversation configuration">
    <span><Atom size={14} />{identity.name || agent.name}</span><span>{selectedModel.name}</span><span><Database size={14} />{hasVault ? vaultName : 'No Vault'}</span><span><GitBranch size={14} />{enabledToolCount} tools</span>
    {canEdit && <button type="button" onClick={onEdit}>Edit setup</button>}
  </div>
}

function LinkedNotes({ notes, onOpenNote }) {
  const [expanded, setExpanded] = useState(false)
  const visibleNotes = expanded ? notes : notes.slice(0, 5)
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
        {visibleNotes.length === 0 && <div className="source-empty">No linked notes yet.</div>}
      </div>
      {notes.length > 5 && <button className="show-more" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Show fewer linked notes' : `Show all ${notes.length} linked notes`} <ChevronDown size={15} />
      </button>}
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
          <button className="note-preview-close" onClick={onClose} aria-label="Close note preview">x</button>
        </header>
        <div className="note-preview-body">
          {metadata.length > 0 && <div className="note-metadata">{metadata.map(([key, value]) => <span key={key}><strong>{key}</strong>{Array.isArray(value) ? value.join(', ') : String(value)}</span>)}</div>}
          <pre>{note.body || 'This sample note does not have a local Markdown body yet.'}</pre>
        </div>
      </section>
    </div>
  )
}

function ToolApprovalDialog({ approval, onResolve }) {
  if (!approval) return null
  return <div className="tool-approval-backdrop">
    <section className="tool-approval-dialog" role="dialog" aria-modal="true" aria-labelledby="tool-approval-title">
      <span className="tool-approval-icon"><ShieldCheck size={22} /></span>
      <div><span className="eyebrow">Tool permission</span><h2 id="tool-approval-title">Allow this write operation?</h2><p><strong>{approval.serverName}</strong> wants to run <code>{approval.displayName}</code>. Review the arguments before allowing this one call.</p></div>
      <pre>{approval.arguments}</pre>
      <div className="tool-approval-actions"><button className="settings-secondary-button" onClick={() => onResolve(false)}>Cancel</button><button className="settings-primary-button" onClick={() => onResolve(true)}><Check size={14} />Allow once</button></div>
    </section>
  </div>
}

function RetrievalPath({ vaultName, topK, embeddingLabel, rerankLabel, retrievalIndexState, packet, wikilinksEnabled, presentation }) {
  const evidenceCount = packet?.evidence?.length || 0
  const retrieval = packet?.retrieval
  const mode = retrieval?.mode || 'lexical'
  const degradation = packet?.error?.code || ''
  const query = packet?.question || 'Ask a question to retrieve evidence'
  const path = [
    ['Query', query, packet ? 'done' : 'current'],
    [`${mode === 'hybrid' ? 'Hybrid' : 'BM25'}${wikilinksEnabled ? ' + Wikilinks' : ''} (top-k=${topK})`, vaultName ? `vault: ${vaultName}` : 'no Vault connected', packet ? 'done' : 'current'],
    ['Index and remote stages', packet ? `${retrievalIndexState}; embedding: ${embeddingLabel}; reranker: ${rerankLabel}${degradation ? `; degraded: ${degradation}` : ''}` : 'waiting for a query', packet ? (degradation ? 'current' : 'done') : 'current'],
    ['Graph expansion', wikilinksEnabled ? packet ? `${retrieval?.graphExpanded || 0} one-hop result${retrieval?.graphExpanded === 1 ? '' : 's'} - rerank: ${rerankLabel}` : 'waiting for a query' : 'Disabled for this conversation', packet || !wikilinksEnabled ? 'done' : 'current'],
    [`Selected (${evidenceCount} chunks)`, packet ? `${retrieval?.candidateCount || 0} lexical candidates` : 'no evidence selected yet', packet ? 'done' : 'current'],
    ['Answer model', presentation.answerDetail, presentation.answerStatus],
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

function AgentStatus({ running, hasActivity, onPause, presentation }) {
  const canPause = running && !presentation.terminalStatus
  return (
    <section className="inspector-section agent-status">
      <div className="inspector-heading"><span>Agent status</span><ChevronUp size={15} /></div>
      <div className="status-line"><span className={`live-dot ${presentation.terminalStatus || ''}`} /> <strong>{presentation.agentLabel}</strong>{hasActivity && <span className="run-id">Current run</span>}{canPause && <button onClick={onPause} aria-label="Pause run"><Pause size={15} /></button>}</div>
      <div className="run-card">
        <div className="run-icon"><Atom size={18} /></div>
        <div className="run-copy"><strong>Research agent</strong><span>{presentation.runDetail}</span></div>
        {hasActivity && presentation.progressLabel && <span className="run-percent">{presentation.progressLabel}</span>}
      </div>
      <div className="progress-track"><span style={{ width: `${presentation.progress}%` }} /></div>
      {hasActivity && <button className="full-run">View full run details <ArrowRight size={15} /></button>}
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
      {sources.length > 5 && <button className="show-more">Show all sources <ChevronDown size={15} /></button>}
    </section>
  )
}

function Inspector({ activeStage, running, hasActivity, onPause, linkedNotes, sources, vaultName, topK, embeddingLabel, rerankLabel, retrievalIndexState, packet, answerMode, runStatus, wikilinksEnabled, onOpenNote }) {
  const presentation = getResearchRunPresentation({ runStatus, running, hasActivity, activeStage, stageCount: stages.length, packet, answerMode })
  return (
    <aside className="inspector">
      <div className="inspector-title"><BookOpen size={18} /> <span>Knowledge context</span><ChevronUp size={16} /></div>
      <LinkedNotes notes={linkedNotes} onOpenNote={onOpenNote} />
      <RetrievalPath vaultName={vaultName} topK={topK} embeddingLabel={embeddingLabel} rerankLabel={rerankLabel} retrievalIndexState={retrievalIndexState} packet={packet} wikilinksEnabled={wikilinksEnabled} presentation={presentation} />
      <AgentStatus running={running} hasActivity={hasActivity} onPause={onPause} presentation={presentation} />
      <Sources sources={sources} onOpenNote={onOpenNote} />
    </aside>
  )
}

export function ResearchWorkspace({ phase, setupProps, conversationProps, knowledgePanelProps, note, onCloseNote, approval, onResolveApproval }) {
  if (knowledgePanelProps) return <div className="knowledge-research-surface">
    <AgentConversationPanel variant="full" {...knowledgePanelProps} />
  </div>
  if (phase === 'setup') return <ResearchSetup {...setupProps} />
  const { config, selectedModel, vaultName, mcpConnected, canEdit, onEdit, messages, running, activeStage, retrievalPacket, input, setInput, onSubmit, disabled, models, authStatus, authBusy, modelCatalog, modelsBusy, onSelectModel, onConnectChatgpt, onLogoutChatgpt, onRefreshModels, onOpenNote, linkedNotes, sources, topK, embeddingLabel, rerankLabel, retrievalIndexState, answerMode, runStatus, wikilinksEnabled, onPause } = conversationProps
  const hasActivity = messages.length > 0 || Boolean(retrievalPacket)
  return <>
    <div className="workspace-content">
      <div className="chat-column">
        <ResearchContextBar config={config} selectedModel={selectedModel} vaultName={vaultName} mcpConnected={mcpConnected} canEdit={canEdit} onEdit={onEdit} />
        {retrievalPacket?.error && <section className="source-empty" role="alert" aria-live="assertive">
          Evidence retrieval failed: {retrievalPacket.error.message || String(retrievalPacket.error)}
        </section>}
        <div className="conversation">
          {messages.length === 0 && <div className="conversation-empty"><Sparkles size={22} /><strong>Start a research conversation</strong><span>Ask a question or add Vault context below.</span></div>}
          {messages.map((message) => message.role === 'user' ? <UserMessage message={message} key={message.id} /> : <AssistantMessage message={message} running={running} onOpenNote={onOpenNote} key={message.id} />)}
        </div>
        <EvidenceTrail activeStage={activeStage} running={running} hasActivity={hasActivity} />
        <Composer value={input} setValue={setInput} onSubmit={onSubmit} disabled={disabled} selectedModel={selectedModel} models={models} onSelectModel={onSelectModel} authStatus={authStatus} authBusy={authBusy} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnectChatgpt={onConnectChatgpt} onLogoutChatgpt={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
      </div>
      <Inspector activeStage={activeStage} running={running} hasActivity={hasActivity} onPause={onPause} linkedNotes={linkedNotes} sources={sources} vaultName={vaultName} topK={topK} embeddingLabel={embeddingLabel} rerankLabel={rerankLabel} retrievalIndexState={retrievalIndexState} packet={retrievalPacket} answerMode={answerMode} runStatus={runStatus} wikilinksEnabled={wikilinksEnabled} onOpenNote={onOpenNote} />
    </div>
    {note && <NotePreview note={note} onClose={onCloseNote} />}
    <ToolApprovalDialog approval={approval} onResolve={onResolveApproval} />
  </>
}
