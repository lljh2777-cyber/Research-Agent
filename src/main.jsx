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
  LoaderCircle,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pause,
  PlayCircle,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react'
import { buildVaultIndex, getVaultName, parseVaultDirectory, parseVaultFiles } from './vault.js'
import KnowledgeGraphSection from './KnowledgeGraph.jsx'
import { PipelinesSection, RunsSection } from './PipelineWorkspace.jsx'
import SettingsWorkspace from './SettingsWorkspace.jsx'
import { loadLocalVault } from './localVault.js'
import { chatgptCatalogToModels, getModelById, getModelsByRole, loadModelConfig, MODEL_REGISTRY, saveModelConfig } from './modelConfig.js'
import { getProviderSessionKey, hydrateProviderSessionKeys, loadProviderConfigs, providerConfigsToModels, saveProviderConfigs } from './providerConfig.js'
import { getDeepSeekRuntimeOptions } from '../shared/deepseek-provider.mjs'
import { getBailianRuntimeOptions } from '../shared/bailian-provider.mjs'
import { streamProviderResponse } from './providerRuntimeClient.js'
import { buildConversationContext, compactTokenCount, providerUsageSummary } from './conversationContext.js'
import { runProviderAgent } from './providerAgent.js'
import { loadMcpConfig, saveMcpConfig } from './mcpConfig.js'
import { createResearchToolEntries, createToolRegistry } from './toolRegistry.js'
import {
  bootstrapMcpRuntime,
  callMcpTool,
  connectMcpServer,
  createExternalMcpToolEntries,
  disconnectMcpServer,
  formatMcpToolResult,
  parseMcpCallArguments,
} from './mcpRuntimeClient.js'
import { executePipeline, loadPipelineRuns, savePipelineRuns } from './pipelineEngine.js'
import { buildEvidenceSystemMessage, buildEvidenceUserContext, buildRetrievalIndex, evidenceSources, retrieveEvidence } from './retrieval.js'
import { loadVaultHandle, loadVaultSnapshot, saveVaultHandle, saveVaultSnapshot } from './vaultStorage.js'
import { AUTH_SERVICE_UNAVAILABLE, getAuthStatus, getChatgptModels, logoutChatgpt, startChatgptLogin, streamChatgptResponse, waitForChatgptAuth } from './authClient.js'
import { loadRuntimeManifest } from './runtime/client.js'
import { closeWorkspaceTab, createWorkspaceTab, findReusableTab, MAX_WORKSPACE_TABS, researchTabTitle, titleFromQuestion } from './workspaceTabs.js'
import {
  AGENT_PRESETS,
  createConversationConfigSnapshot,
  createRunSnapshot,
  getAgentPreset,
  TOOL_IDS,
  updateConversationIdentity,
  updateConversationKnowledgeScopes,
  updateConversationModel,
  updateConversationSystemPrompt,
  updateConversationTools,
} from './agentPresets.js'
import './styles.css'

const navItems = [
  { id: 'research', label: 'Research', icon: MessageSquare },
  { id: 'graph', label: 'Knowledge Graph', icon: Network },
  { id: 'pipelines', label: 'Pipelines', icon: GitBranch },
  { id: 'runs', label: 'Runs', icon: PlayCircle },
]

const SIDEBAR_COLLAPSED_KEY = 'bioresearch-os:sidebar-collapsed'
const INITIAL_RESEARCH_TAB_ID = 'research-initial'
const DEFAULT_AGENT_PRESET = getAgentPreset('biologist')
const DEFAULT_RESEARCH_TAB_TITLE = researchTabTitle(DEFAULT_AGENT_PRESET.shortName, 'New research')

const RESEARCH_TOOL_OPTIONS = Object.freeze({
  [TOOL_IDS.VAULT_SEARCH]: { label: 'Vault retrieval', detail: 'Retrieve relevant Markdown evidence before answering.', icon: Search },
  [TOOL_IDS.VAULT_WIKILINKS]: { label: 'Wikilink graph', detail: 'Expand retrieval through related Obsidian notes.', icon: Network },
  [TOOL_IDS.WEB_SEARCH]: { label: 'Web search', detail: 'Use provider-hosted search when the selected model supports it.', icon: ExternalLink },
  [TOOL_IDS.MCP]: { label: 'MCP tools', detail: 'Expose connected research tools under the local permission policy.', icon: GitBranch },
  [TOOL_IDS.CODE_EXECUTE]: { label: 'Code execution', detail: 'Allow sandboxed analysis tools when a runtime is connected.', icon: Code2 },
  [TOOL_IDS.VAULT_WRITE]: { label: 'Vault write', detail: 'Allow approved changes to the current knowledge base.', icon: FileText },
})

function createResearchSession({ messages = [], modelId = 'smart-default', knowledgeBaseId = '' } = {}) {
  const configSnapshot = createConversationConfigSnapshot({
    conversationOverrides: {
      model: { mode: modelId === 'smart-default' ? 'auto' : 'fixed', providerId: null, modelId, endpointType: null },
      knowledgeScopes: knowledgeBaseId ? [{ vaultId: knowledgeBaseId, paths: [], tags: [] }] : [],
    },
  })
  return {
    phase: 'setup',
    conversationTitle: 'New research',
    input: '',
    messages,
    running: false,
    activeStage: messages.length ? 5 : 0,
    pendingQuestion: '',
    runMode: 'mock',
    answerMode: messages.length ? 'sample' : 'idle',
    retrievalPacket: null,
    configSnapshot,
    runSnapshots: [],
  }
}

function modelReference(model) {
  return {
    mode: model.id === 'smart-default' ? 'auto' : 'fixed',
    providerId: model.providerId || model.authProvider || null,
    modelId: model.id,
    apiModelId: model.apiModelId || model.id,
    endpointType: model.endpointType || null,
  }
}

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
          <span><strong>ChatGPT account</strong><small>{authStatus?.connected ? `${modelCatalog?.models?.length || 0} models · ${modelCatalog?.source || 'discovering'}` : authStatus?.unavailable ? 'Local service offline · restart npm run dev' : 'Connect to discover available models'}</small></span>
          {authStatus?.connected ? <button className="auth-inline-button" onClick={() => { onLogout(); setOpen(false) }}>Sign out</button> : <button className="auth-inline-button" onClick={() => { onConnect(); setOpen(false) }}>{authBusy ? 'Waiting…' : authStatus?.unavailable ? 'Retry' : 'Connect'}</button>}
        </div>
        {modelCatalog?.warning && <div className="model-catalog-warning">{modelCatalog.warning}</div>}
        <div className="model-menu-note">OAuth credentials stay in the local auth service. Only retrieved Vault excerpts are sent when a connected answer model runs.</div>
      </div>}
    </div>
  )
}

function Sidebar({ activeSection, setActiveSection, collapsed, onToggleCollapsed, onConnectVault, onSyncVault, onOpenSettings, vaultName, vaultNoteCount, syncState, vaultSource, localAdapterState, authStatus, authBusy, onConnectChatgpt, onLogoutChatgpt, authError }) {
  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="brand">
        <LogoMark />
        <span>BioResearch OS</span>
        <button className="sidebar-collapse" onClick={onToggleCollapsed} aria-label={collapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>

      <nav className="main-nav" aria-label="Primary navigation">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            className={`nav-item ${activeSection === id ? 'active' : ''}`}
            key={id}
            aria-label={label}
            title={collapsed ? label : undefined}
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
        {vaultName && <button className="settings-link sync-link" onClick={onSyncVault} disabled={syncState === 'syncing'} title={collapsed ? (syncState === 'needs-permission' ? 'Reconnect vault' : 'Sync vault') : undefined}><RefreshCw className={syncState === 'syncing' ? 'spin' : ''} size={15} /><span>{syncState === 'syncing' ? 'Syncing vault' : syncState === 'needs-permission' ? 'Reconnect vault' : 'Sync vault'}</span></button>}
        {vaultSource === 'local-adapter' && <div className={`adapter-status ${localAdapterState}`} title={collapsed ? (localAdapterState === 'ready' ? 'Local adapter online' : 'Local adapter offline') : undefined}><Database size={14} /><span>{localAdapterState === 'ready' ? 'Local adapter online' : 'Local adapter offline'}</span>{localAdapterState === 'ready' && <small>auto sync 15s</small>}</div>}
        <div className={`account-status ${authStatus?.connected ? 'connected' : ''}`} title={collapsed ? (authStatus?.connected ? 'ChatGPT connected' : 'ChatGPT not connected') : undefined}>
          <Sparkles size={14} />
          <span>{authStatus?.connected ? 'ChatGPT connected' : authStatus?.unavailable ? 'Local ChatGPT service offline' : 'ChatGPT not connected'}</span>
          <button onClick={authStatus?.connected ? onLogoutChatgpt : onConnectChatgpt} disabled={authBusy}>{authStatus?.connected ? 'Sign out' : authBusy ? 'Waiting…' : authStatus?.unavailable ? 'Retry' : 'Connect'}</button>
        </div>
        {authError && <small className="auth-error" role="alert">{authError}</small>}
        <button className={`settings-link ${activeSection === 'settings' ? 'active' : ''}`} onClick={onOpenSettings} title={collapsed ? 'Settings' : undefined}><Settings2 size={16} /><span>Settings</span></button>
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
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const evidence = message.evidence || []
  const sourceCount = new Set(evidence.map((item) => item.noteId)).size
  const reasoning = message.reasoning || ''
  const toolTrace = message.toolTrace || []
  const toolCallCount = toolTrace.reduce((total, round) => total + round.results.length, 0)
  return (
    <article className="assistant-message">
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
          <span className="message-time">10:24 AM <span>·</span> {sourceCount || 6} sources <ChevronDown size={14} /></span>
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
            <small>{(config.systemPrompt || '').length} / 6000 · saved in this conversation snapshot</small>
          </div>
        </section>
        <section className="research-config-block">
          <div className="research-config-heading"><span><Atom size={16} />Model</span><small>Temporary for this conversation</small></div>
          <div className="research-model-choice">
            <div><strong>{selectedModel.name}</strong><small>{selectedModel.provider} · {selectedModel.detail || 'Research model'}</small></div>
            <ModelPicker selectedModel={selectedModel} models={models} onSelect={onSelectModel} placement="bottom" authStatus={authStatus} authBusy={authBusy} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnect={onConnectChatgpt} onLogout={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
          </div>
        </section>
        <section className="research-config-block">
          <div className="research-config-heading"><span><Database size={16} />Knowledge base</span><small>Evidence boundary</small></div>
          <div className="knowledge-scope-options">
            <button type="button" className={!hasVaultScope ? 'selected' : ''} aria-pressed={!hasVaultScope} onClick={() => onSelectVault(false)}><span><strong>No Vault</strong><small>Use model knowledge and enabled external tools only.</small></span>{!hasVaultScope && <Check size={15} />}</button>
            {vaultName ? <button type="button" className={hasVaultScope ? 'selected' : ''} aria-pressed={hasVaultScope} onClick={() => onSelectVault(true)}><Database size={18} /><span><strong>{vaultName}</strong><small>{vaultNoteCount} Markdown notes · read-only evidence</small></span>{hasVaultScope && <Check size={15} />}</button>
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

function RetrievalPath({ activeStage, vaultName, topK, rerankLabel, packet, answerMode, wikilinksEnabled }) {
  const evidenceCount = packet?.evidence?.length || 0
  const retrieval = packet?.retrieval
  const query = packet?.question || 'Ask a question to retrieve evidence'
  const path = [
    ['Query', query, packet ? 'done' : 'current'],
    [`${wikilinksEnabled ? 'BM25 + Wikilinks' : 'BM25'} (top-k=${topK})`, vaultName ? `vault: ${vaultName}` : 'no Vault connected', packet ? 'done' : 'current'],
    ['Graph expansion', wikilinksEnabled ? packet ? `${retrieval?.graphExpanded || 0} one-hop result${retrieval?.graphExpanded === 1 ? '' : 's'} · rerank: ${rerankLabel}` : 'waiting for a query' : 'Disabled for this conversation', packet || !wikilinksEnabled ? 'done' : 'current'],
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

function AgentStatus({ activeStage, running, hasActivity, onPause }) {
  const percentage = hasActivity ? running ? Math.min(91, Math.round(((activeStage + 0.7) / stages.length) * 100)) : 100 : 0
  return (
    <section className="inspector-section agent-status">
      <div className="inspector-heading"><span>Agent status</span><ChevronUp size={15} /></div>
      <div className="status-line"><span className="live-dot" /> <strong>{running ? 'Agent running' : 'Agent ready'}</strong>{hasActivity && <span className="run-id">Current run</span>}{running && <button onClick={onPause} aria-label="Pause run"><Pause size={15} /></button>}</div>
      <div className="run-card">
        <div className="run-icon"><Atom size={18} /></div>
        <div className="run-copy"><strong>Research agent</strong><span>{running ? 'Synthesizing answer and citing sources...' : hasActivity ? 'Run complete' : 'Ready for your first question'}</span></div>
        {hasActivity && <span className="run-percent">{percentage}%</span>}
      </div>
      <div className="progress-track"><span style={{ width: `${percentage}%` }} /></div>
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

function Inspector({ activeStage, running, hasActivity, onPause, linkedNotes, sources, vaultName, topK, rerankLabel, packet, answerMode, wikilinksEnabled, onOpenNote }) {
  return (
    <aside className="inspector">
      <div className="inspector-title"><BookOpen size={18} /> <span>Knowledge context</span><ChevronUp size={16} /></div>
      <LinkedNotes notes={linkedNotes} onOpenNote={onOpenNote} />
      <RetrievalPath activeStage={activeStage} vaultName={vaultName} topK={topK} rerankLabel={rerankLabel} packet={packet} answerMode={answerMode} wikilinksEnabled={wikilinksEnabled} />
      <AgentStatus activeStage={activeStage} running={running} hasActivity={hasActivity} onPause={onPause} />
      <Sources sources={sources} onOpenNote={onOpenNote} />
    </aside>
  )
}

const workspaceTabOptions = [
  { kind: 'research', label: 'Research', description: 'Start an independent conversation', icon: MessageSquare, tone: 'slate' },
  { kind: 'graph', label: 'Knowledge graph', description: 'Explore the current research Vault', icon: Network, tone: 'mint' },
  { kind: 'pipelines', label: 'Pipelines', description: 'Run deterministic local workflows', icon: GitBranch, tone: 'blue' },
  { kind: 'runs', label: 'Runs', description: 'Inspect pipeline history and results', icon: PlayCircle, tone: 'violet' },
  { kind: 'settings', label: 'Settings', description: 'Configure models and research tools', icon: Settings2, tone: 'amber' },
]

function iconForTab(kind) {
  if (kind === 'graph') return Network
  if (kind === 'pipelines') return GitBranch
  if (kind === 'runs') return PlayCircle
  if (kind === 'settings') return Settings2
  if (kind === 'launcher') return Rocket
  return MessageSquare
}

function WorkspaceTabs({ tabs, activeTabId, onSelect, onClose, onCreate }) {
  const scrollRef = useRef(null)

  useEffect(() => {
    const activeElement = [...(scrollRef.current?.children || [])].find((element) => element.dataset.workspaceTabId === activeTabId)
    activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  return (
    <div className="workspace-tabs" aria-label="Open workspaces">
      <div className="workspace-tab-scroll" role="tablist" aria-label="Workspace tabs" ref={scrollRef}>
        {tabs.map((tab) => {
          const Icon = iconForTab(tab.kind)
          const active = tab.id === activeTabId
          return <div className={`workspace-tab ${active ? 'active' : ''}`} data-workspace-tab-id={tab.id} key={tab.id}>
            <button className="workspace-tab-main" type="button" role="tab" aria-selected={active} title={tab.title} onClick={() => onSelect(tab.id)}>
              <Icon size={14} /><span>{tab.title}</span>
            </button>
            <button className="workspace-tab-close" type="button" aria-label={`Close ${tab.title}`} title={`Close ${tab.title}`} onClick={() => onClose(tab.id)}>
              <X size={13} />
            </button>
          </div>
        })}
        <div className="workspace-tab-add">
          <button type="button" aria-label="Open launcher" title="Open launcher" onClick={() => onCreate('launcher')} disabled={tabs.length >= MAX_WORKSPACE_TABS && !tabs.some((tab) => tab.kind === 'launcher')}>
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceLauncher({ onOpen }) {
  return (
    <section className="workspace-launcher" aria-labelledby="workspace-launcher-title">
      <div className="workspace-launcher-inner">
        <div className="workspace-launcher-heading">
          <span className="eyebrow">Workspace launcher</span>
          <h2 id="workspace-launcher-title">Applications</h2>
          <p>Open another research surface without closing your current work.</p>
        </div>
        <div className="workspace-launcher-grid">
          {workspaceTabOptions.map(({ kind, label, description, icon: Icon, tone }) => <button type="button" key={kind} onClick={() => onOpen(kind, { forceNew: kind === 'research' || kind === 'graph' })}>
            <span className={`workspace-launcher-icon ${tone}`}><Icon size={25} /></span>
            <span><strong>{label}</strong><small>{description}</small></span>
          </button>)}
        </div>
      </div>
    </section>
  )
}

function App() {
  const [workspaceTabs, setWorkspaceTabs] = useState(() => [createWorkspaceTab('research', { id: INITIAL_RESEARCH_TAB_ID, title: DEFAULT_RESEARCH_TAB_TITLE })])
  const [activeTabId, setActiveTabId] = useState(INITIAL_RESEARCH_TAB_ID)
  const [researchSessions, setResearchSessions] = useState(() => {
    const defaults = loadModelConfig()
    return { [INITIAL_RESEARCH_TAB_ID]: createResearchSession({ modelId: defaults.chatModelId }) }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
  const [vaultNotes, setVaultNotes] = useState([])
  const [vaultName, setVaultName] = useState('')
  const [vaultHandle, setVaultHandle] = useState(null)
  const [vaultSource, setVaultSource] = useState('sample')
  const [localAdapterState, setLocalAdapterState] = useState('checking')
  const [localRevision, setLocalRevision] = useState('')
  const [syncState, setSyncState] = useState('idle')
  const [selectedNote, setSelectedNote] = useState(null)
  const [modelConfig, setModelConfig] = useState(loadModelConfig)
  const [providerConfigs, setProviderConfigs] = useState(loadProviderConfigs)
  const [providerCredentialsRevision, setProviderCredentialsRevision] = useState(0)
  const [mcpConfig, setMcpConfig] = useState(loadMcpConfig)
  const [mcpRuntime, setMcpRuntime] = useState({ sessions: [] })
  const [mcpRuntimeBusy, setMcpRuntimeBusy] = useState('')
  const [mcpRuntimeError, setMcpRuntimeError] = useState('')
  const [pendingToolApproval, setPendingToolApproval] = useState(null)
  const [runtimeManifest, setRuntimeManifest] = useState(null)
  const [authStatus, setAuthStatus] = useState({ provider: 'chatgpt', connected: false, pending: false })
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [modelCatalog, setModelCatalog] = useState(EMPTY_CHATGPT_CATALOG)
  const [modelsBusy, setModelsBusy] = useState(false)
  const [pipelineRuns, setPipelineRuns] = useState(loadPipelineRuns)
  const [pipelineRunningId, setPipelineRunningId] = useState(null)
  const [selectedPipelineRunId, setSelectedPipelineRunId] = useState(null)
  const vaultInputRef = useRef(null)
  const requestAbortRef = useRef(null)
  const pipelineRunTimerRef = useRef(null)
  const mockRunTimersRef = useRef(new Map())
  const toolApprovalResolverRef = useRef(null)

  const activeTab = workspaceTabs.find((tab) => tab.id === activeTabId) || workspaceTabs[0]
  const activeSection = activeTab?.kind || 'launcher'
  const runtimeCapabilities = runtimeManifest?.capabilities
  const runtimeReady = Boolean(runtimeCapabilities)
  const supportsLoopbackMcp = ['loopback', 'desktop-loopback'].includes(runtimeCapabilities?.mcp)
  const supportsChatgptSubscription = runtimeCapabilities?.chatgptSubscriptionOAuth === true
  const supportsLocalVault = runtimeCapabilities?.localVault.available === true
  const supportsLoopbackVault = runtimeCapabilities?.localVault.adapters.includes('loopback-adapter') === true
  const activeResearchSession = researchSessions[activeTabId] || createResearchSession({ modelId: modelConfig.chatModelId, knowledgeBaseId: vaultName })
  const { phase, input, messages, running, activeStage, answerMode, retrievalPacket } = activeResearchSession
  const activeHasVaultScope = Boolean(vaultName && activeResearchSession.configSnapshot?.knowledgeScopes?.some((scope) => scope.vaultId === vaultName))
  const anyResearchRunning = Object.values(researchSessions).some((session) => session.running)

  const updateResearchSession = useCallback((tabId, updater) => {
    setResearchSessions((current) => {
      const session = current[tabId] || createResearchSession()
      const nextSession = typeof updater === 'function' ? updater(session) : { ...session, ...updater }
      return { ...current, [tabId]: nextSession }
    })
  }, [])

  const setActiveResearchField = useCallback((field, valueOrUpdater) => {
    updateResearchSession(activeTabId, (session) => ({
      ...session,
      [field]: typeof valueOrUpdater === 'function' ? valueOrUpdater(session[field]) : valueOrUpdater,
    }))
  }, [activeTabId, updateResearchSession])

  const setInput = useCallback((value) => setActiveResearchField('input', value), [setActiveResearchField])

  useEffect(() => {
    let cancelled = false
    loadRuntimeManifest().then((manifest) => {
      if (!cancelled) setRuntimeManifest(manifest)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (runtimeCapabilities?.credentials.providerApiKeys !== 'os-keychain') return undefined
    let cancelled = false
    hydrateProviderSessionKeys().then(() => {
      if (!cancelled) setProviderCredentialsRevision((current) => current + 1)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [runtimeCapabilities?.credentials.providerApiKeys])

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    let cancelled = false
    if (supportsLoopbackMcp) {
      bootstrapMcpRuntime().then((status) => { if (!cancelled) setMcpRuntime(status) }).catch(() => {})
    }
    return () => {
      cancelled = true
      toolApprovalResolverRef.current?.(false)
      toolApprovalResolverRef.current = null
    }
  }, [supportsLoopbackMcp])

  const requestToolApproval = useCallback(({ entry, call }) => new Promise((resolve) => {
    toolApprovalResolverRef.current?.(false)
    toolApprovalResolverRef.current = resolve
    setPendingToolApproval({
      serverName: entry.serverName || entry.source,
      displayName: entry.displayName || entry.definition.name,
      arguments: call.arguments || '{}',
    })
  }), [])

  const resolveToolApproval = useCallback((approved) => {
    const resolve = toolApprovalResolverRef.current
    toolApprovalResolverRef.current = null
    setPendingToolApproval(null)
    resolve?.(approved)
  }, [])

  const vaultIndex = useMemo(() => buildVaultIndex(vaultNotes), [vaultNotes])
  const retrievalIndex = useMemo(
    () => buildRetrievalIndex(vaultNotes, { chunkSize: modelConfig.chunkSize, chunkOverlap: modelConfig.chunkOverlap }),
    [vaultNotes, modelConfig.chunkSize, modelConfig.chunkOverlap],
  )
  const externalMcpEntries = useMemo(() => createExternalMcpToolEntries(mcpRuntime.sessions, async ({ call, approved, serverId, toolName }) => {
    try {
      const payload = await callMcpTool({
        serverId,
        toolName,
        arguments: parseMcpCallArguments(call),
        confirmWrite: async () => approved,
      })
      return formatMcpToolResult(call, payload)
    } catch (error) {
      return { id: call?.id || '', name: call?.name || toolName, arguments: call?.arguments || '{}', isError: true, summary: error.message, content: JSON.stringify({ error: error.message }) }
    }
  }), [mcpRuntime.sessions])
  const researchToolRegistry = useMemo(() => {
    const enabledTools = new Set(activeResearchSession.configSnapshot?.enabledTools || [])
    const builtins = enabledTools.has(TOOL_IDS.VAULT_SEARCH) && activeHasVaultScope && retrievalIndex?.chunks?.length ? createResearchToolEntries(retrievalIndex) : []
    const external = enabledTools.has(TOOL_IDS.MCP) ? externalMcpEntries : []
    return createToolRegistry([...builtins, ...external], mcpConfig.permissions, { requestApproval: requestToolApproval })
  }, [activeHasVaultScope, activeResearchSession.configSnapshot?.enabledTools, externalMcpEntries, mcpConfig.permissions, requestToolApproval, retrievalIndex])
  const staticChatModels = useMemo(() => getModelsByRole('chat'), [])
  const chatModels = useMemo(() => {
    const smartModel = staticChatModels.find((model) => model.id === 'smart-default')
    const futureModels = staticChatModels.filter((model) => model.id !== 'smart-default')
    const discoveredModels = chatgptCatalogToModels(modelCatalog.models)
    const apiModels = providerConfigsToModels(providerConfigs)
    return [smartModel, ...discoveredModels, ...apiModels, ...futureModels].filter(Boolean)
  }, [modelCatalog.models, providerConfigs, staticChatModels])
  const activeChatModelId = activeResearchSession.configSnapshot?.model?.modelId || modelConfig.chatModelId
  const selectedModel = useMemo(() => getModelById(activeChatModelId, chatModels), [activeChatModelId, chatModels])
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
  const inspectorNotes = activeHasVaultScope ? retrievalPacket ? retrievedNotes : vaultIndex.notes.length ? vaultIndex.linkedNotes : [] : []
  const inspectorSources = activeHasVaultScope ? retrievalPacket ? retrievedSources : vaultSources : []

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
    setResearchSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, { ...session, retrievalPacket: null, answerMode: 'idle' }])))
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
        setResearchSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, { ...session, retrievalPacket: null, answerMode: 'idle' }])))
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
    if (!runtimeReady) return undefined
    let cancelled = false
    if (!supportsChatgptSubscription) {
      setAuthStatus({ provider: 'chatgpt', connected: false, pending: false, unavailable: true })
      return () => { cancelled = true }
    }
    getAuthStatus().then((status) => {
      if (!cancelled) setAuthStatus(status)
    }).catch(() => {
      if (!cancelled) setAuthStatus({ provider: 'chatgpt', connected: false, pending: false, unavailable: true })
    })
    return () => { cancelled = true }
  }, [runtimeReady, supportsChatgptSubscription])

  useEffect(() => {
    if (!authStatus.connected) {
      setModelCatalog(EMPTY_CHATGPT_CATALOG)
      return
    }
    void refreshChatgptModels(false)
  }, [authStatus.connected, refreshChatgptModels])

  useEffect(() => {
    if (!runtimeReady) return undefined
    let cancelled = false
    Promise.all([loadVaultSnapshot(), loadVaultHandle()]).then(async ([snapshot, handle]) => {
      if (cancelled) return
      const localSynced = supportsLoopbackVault
        ? await syncFromLocalAdapter(true)
        : false
      if (localSynced || cancelled) return
      if (supportsLocalVault && handle) {
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
  }, [runtimeReady, supportsLocalVault, supportsLoopbackVault])

  useEffect(() => {
    if (!supportsLoopbackVault || vaultSource !== 'local-adapter') return undefined
    const timer = window.setInterval(() => syncFromLocalAdapter(true), 15000)
    return () => window.clearInterval(timer)
  }, [supportsLoopbackVault, vaultSource, localRevision])

  useEffect(() => {
    Object.entries(researchSessions).forEach(([tabId, session]) => {
      if (!session.running || session.runMode !== 'mock' || mockRunTimersRef.current.has(tabId)) return
      updateResearchSession(tabId, { activeStage: 0 })
      const timers = stages.map((_, index) => window.setTimeout(() => {
        updateResearchSession(tabId, { activeStage: index })
      }, (index + 1) * 620))
      const finish = window.setTimeout(() => {
        updateResearchSession(tabId, (current) => ({
          ...current,
          activeStage: 5,
          messages: [...current.messages, responseForQuestion(current.pendingQuestion, current.retrievalPacket)],
          pendingQuestion: '',
          running: false,
        }))
        mockRunTimersRef.current.delete(tabId)
      }, 3900)
      mockRunTimersRef.current.set(tabId, [...timers, finish])
    })
  }, [researchSessions, updateResearchSession])

  useEffect(() => () => {
    if (pipelineRunTimerRef.current) window.clearTimeout(pipelineRunTimerRef.current)
    mockRunTimersRef.current.forEach((timers) => timers.forEach((timer) => window.clearTimeout(timer)))
  }, [])

  const openWorkspaceTab = useCallback((kind, { forceNew = false } = {}) => {
    const reusable = forceNew
      ? null
      : (kind === 'research' || kind === 'graph'
        ? [...workspaceTabs].reverse().find((tab) => tab.kind === kind)
        : findReusableTab(workspaceTabs, kind))
    if (reusable) {
      setActiveTabId(reusable.id)
      return reusable.id
    }
    if (workspaceTabs.length >= MAX_WORKSPACE_TABS) return activeTabId
    const graphBaseTitle = vaultName || 'Knowledge graph'
    const matchingGraphs = kind === 'graph' ? workspaceTabs.filter((tab) => tab.kind === 'graph' && tab.vaultName === graphBaseTitle).length : 0
    const tab = createWorkspaceTab(kind, {
      vaultName: kind === 'graph' ? graphBaseTitle : '',
      title: kind === 'research'
        ? DEFAULT_RESEARCH_TAB_TITLE
        : kind === 'graph' && matchingGraphs ? `${graphBaseTitle} ${matchingGraphs + 1}` : undefined,
    })
    setWorkspaceTabs((current) => [...current, tab])
    if (kind === 'research') {
      setResearchSessions((current) => ({
        ...current,
        [tab.id]: createResearchSession({ modelId: modelConfig.chatModelId, knowledgeBaseId: vaultName }),
      }))
    }
    setActiveTabId(tab.id)
    return tab.id
  }, [activeTabId, modelConfig.chatModelId, vaultName, workspaceTabs])

  const handleSelectTab = useCallback((tabId) => {
    setActiveTabId(tabId)
  }, [])

  const handleCloseTab = useCallback((tabId) => {
    const closingSession = researchSessions[tabId]
    if (closingSession?.running) requestAbortRef.current?.abort()
    const timers = mockRunTimersRef.current.get(tabId) || []
    timers.forEach((timer) => window.clearTimeout(timer))
    mockRunTimersRef.current.delete(tabId)
    const result = closeWorkspaceTab(workspaceTabs, activeTabId, tabId)
    if (result.tabs === workspaceTabs) return
    setWorkspaceTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    setResearchSessions((current) => {
      const next = { ...current }
      delete next[tabId]
      return next
    })
  }, [activeTabId, researchSessions, workspaceTabs])

  const handleOpenSection = useCallback((kind) => {
    openWorkspaceTab(kind)
  }, [openWorkspaceTab])

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

  const handleSelectAgent = (agentId) => {
    const preset = getAgentPreset(agentId)
    updateResearchSession(activeTabId, (session) => {
      const nextConfig = createConversationConfigSnapshot({
        agentId,
        conversationOverrides: {
          model: session.configSnapshot?.model,
          knowledgeScopes: session.configSnapshot?.knowledgeScopes,
        },
      })
      return {
        ...session,
        configSnapshot: updateConversationTools(nextConfig, nextConfig.enabledTools.filter((toolId) => {
          if (toolId === TOOL_IDS.WEB_SEARCH) return Boolean(selectedModel.capabilities?.webSearch)
          if ([TOOL_IDS.MCP, TOOL_IDS.CODE_EXECUTE].includes(toolId)) return Boolean(selectedModel.capabilities?.tools)
          return true
        })),
      }
    })
    setWorkspaceTabs((current) => current.map((tab) => tab.id === activeTabId
      ? { ...tab, title: researchTabTitle(preset.shortName || preset.name, activeResearchSession.conversationTitle) }
      : tab))
  }

  const handleUpdateAgentIdentity = (identityPatch) => {
    const identity = { ...(activeResearchSession.configSnapshot?.identity || {}), ...identityPatch }
    updateResearchSession(activeTabId, (session) => ({
      ...session,
      configSnapshot: updateConversationIdentity(session.configSnapshot, identityPatch),
    }))
    setWorkspaceTabs((current) => current.map((tab) => tab.id === activeTabId
      ? { ...tab, title: researchTabTitle(identity.shortName || identity.name, activeResearchSession.conversationTitle) }
      : tab))
  }

  const handleUpdateAgentSystemPrompt = (systemPrompt) => {
    updateResearchSession(activeTabId, (session) => ({
      ...session,
      configSnapshot: updateConversationSystemPrompt(session.configSnapshot, systemPrompt),
    }))
  }

  const handleResetAgentSystemPrompt = () => {
    const preset = getAgentPreset(activeResearchSession.configSnapshot?.source?.agentId)
    handleUpdateAgentSystemPrompt(preset.systemPrompt)
  }

  const handleSelectResearchVault = (enabled) => {
    const scopes = enabled && vaultName ? [{ vaultId: vaultName, paths: [], tags: [] }] : []
    updateResearchSession(activeTabId, (session) => ({
      ...session,
      configSnapshot: updateConversationKnowledgeScopes(session.configSnapshot, scopes),
    }))
  }

  const handleToggleResearchTool = (toolId, enabled) => {
    updateResearchSession(activeTabId, (session) => {
      const current = new Set(session.configSnapshot?.enabledTools || [])
      if (enabled) current.add(toolId)
      else current.delete(toolId)
      return { ...session, configSnapshot: updateConversationTools(session.configSnapshot, [...current]) }
    })
  }

  const handleStartResearch = () => {
    const identity = activeResearchSession.configSnapshot?.identity
    updateResearchSession(activeTabId, { phase: 'conversation' })
    setWorkspaceTabs((current) => current.map((tab) => tab.id === activeTabId
      ? { ...tab, title: researchTabTitle(identity?.shortName || identity?.name, activeResearchSession.conversationTitle) }
      : tab))
  }

  const handleEditResearchSetup = () => {
    if (activeResearchSession.messages.length) return
    updateResearchSession(activeTabId, { phase: 'setup' })
  }

  const submitQuestion = async () => {
    if (activeSection !== 'research' || phase !== 'conversation' || anyResearchRunning) return
    const sessionId = activeTabId
    const session = researchSessions[sessionId] || createResearchSession()
    const question = session.input.trim()
    if (!question) return
    const enabledTools = new Set(session.configSnapshot?.enabledTools || [])
    const hasVaultScope = Boolean(vaultName && session.configSnapshot?.knowledgeScopes?.some((scope) => scope.vaultId === vaultName))
    const packet = retrieveEvidence(enabledTools.has(TOOL_IDS.VAULT_SEARCH) && hasVaultScope ? retrievalIndex : null, question, {
      topK: modelConfig.topK,
      similarityThreshold: modelConfig.similarityThreshold,
      expandWikilinks: enabledTools.has(TOOL_IDS.VAULT_WIKILINKS),
    })
    const evidenceContext = buildEvidenceUserContext(packet)
    updateResearchSession(sessionId, { retrievalPacket: packet })
    let chatgptConnected = authStatus.connected
    if (selectedModel.authProvider === 'chatgpt' && !chatgptConnected) {
      const connected = await handleConnectChatgpt()
      chatgptConnected = Boolean(connected?.connected)
      if (!chatgptConnected) return
    }
    const apiProvider = selectedModel.authProvider === 'api'
    const live = apiProvider || ((selectedModel.authProvider === 'chatgpt' || selectedModel.id === 'smart-default') && chatgptConnected)
    const runSnapshot = createRunSnapshot(session.configSnapshot, {
      resolvedModel: {
        ...modelReference(selectedModel),
        requestedModelId: session.configSnapshot?.model?.modelId || selectedModel.id,
      },
    })
    const conversationTitle = titleFromQuestion(question)
    setWorkspaceTabs((current) => current.map((tab) => tab.id === sessionId
      ? { ...tab, title: researchTabTitle(session.configSnapshot?.identity?.shortName || session.configSnapshot?.identity?.name, conversationTitle) }
      : tab))
    updateResearchSession(sessionId, (current) => ({
      ...current,
      conversationTitle,
      answerMode: live ? 'chatgpt' : 'retrieval-only',
      messages: [...current.messages, { id: `user-${Date.now()}`, role: 'user', text: question, evidenceContext }],
      input: '',
      runSnapshots: [...(current.runSnapshots || []), runSnapshot],
    }))
    if (live) {
      const assistantId = `assistant-${Date.now()}`
      const controller = new AbortController()
      requestAbortRef.current = controller
      updateResearchSession(sessionId, (current) => ({
        ...current,
        runMode: 'live',
        activeStage: 3,
        running: true,
        messages: [...current.messages, { id: assistantId, role: 'assistant', text: '', reasoning: '', toolTrace: [], bullets: [], closing: '', evidence: packet.evidence }],
      }))
      let streamedText = ''
      let streamedReasoning = ''
      const toolTrace = []
      let renderFrame = 0
      const flushStreamedText = () => {
        renderFrame = 0
        updateResearchSession(sessionId, (current) => ({ ...current, messages: current.messages.map((message) => message.id === assistantId ? { ...message, text: streamedText, reasoning: streamedReasoning } : message) }))
      }
      try {
        const contextPlan = buildConversationContext({
          history: session.messages,
          systemMessage: `${session.configSnapshot?.systemPrompt || ''}\n\n${buildEvidenceSystemMessage(packet, { citations: modelConfig.citations })}`.trim(),
          evidenceContext,
          question,
          contextWindowTokens: selectedModel.contextWindowTokens,
          maxOutputTokens: 4_096,
        })
        const messages = contextPlan.messages
        const onDelta = (delta) => {
          streamedText += delta
          updateResearchSession(sessionId, { activeStage: 4 })
          if (!renderFrame) renderFrame = window.requestAnimationFrame(flushStreamedText)
        }
        const onReasoningDelta = (delta) => {
          streamedReasoning += delta
          updateResearchSession(sessionId, { activeStage: 3 })
          if (!renderFrame) renderFrame = window.requestAnimationFrame(flushStreamedText)
        }
        let result
        if (apiProvider) {
          const providerConfig = providerConfigs[selectedModel.providerId]
          if (!providerConfig) throw new Error(`Provider configuration is missing for ${selectedModel.provider}.`)
          const tools = selectedModel.capabilities?.tools ? researchToolRegistry.definitions : []
          const baseProviderOptions = selectedModel.providerId === 'deepseek'
            ? getDeepSeekRuntimeOptions(providerConfig)
            : selectedModel.providerId === 'bailian' ? getBailianRuntimeOptions(providerConfig) : null
          const providerOptions = baseProviderOptions ? {
            ...baseProviderOptions,
            enableWebSearch: enabledTools.has(TOOL_IDS.WEB_SEARCH) && baseProviderOptions.enableWebSearch,
            maxOutputTokens: 4_096,
          } : undefined
          const providerApiKey = await getProviderSessionKey(selectedModel.providerId)
          const agentOutput = await runProviderAgent({
            messages,
            tools,
            request: (agentMessages) => streamProviderResponse({
              providerId: selectedModel.providerId,
              endpoint: selectedModel.endpoint || providerConfig.endpoint,
              endpointType: selectedModel.endpointType,
              apiKey: providerApiKey,
              model: selectedModel.apiModelId,
              messages: agentMessages,
              tools,
              options: providerOptions,
              signal: controller.signal,
              onDelta,
              onReasoningDelta,
              onEvent: (event) => {
                if (event === 'web_search.status') updateResearchSession(sessionId, { activeStage: 2 })
              },
            }),
            executeTool: (call) => researchToolRegistry.execute(call),
            onToolRound: (_round, trace) => {
              toolTrace.splice(0, toolTrace.length, ...trace)
              streamedText = ''
              updateResearchSession(sessionId, (current) => ({
                ...current,
                activeStage: 3,
                messages: current.messages.map((message) => message.id === assistantId ? { ...message, text: '', reasoning: streamedReasoning, toolTrace: [...toolTrace] } : message),
              }))
            },
          })
          result = agentOutput.result
        } else {
          let activeCatalog = modelCatalog
          if (selectedModel.id === 'smart-default' && !activeCatalog.defaultModelId) {
            activeCatalog = await refreshChatgptModels(false) || activeCatalog
          }
          result = await streamChatgptResponse({
            model: selectedModel.id === 'smart-default' ? activeCatalog.defaultModelId : selectedModel.id,
            messages,
            signal: controller.signal,
            onDelta,
          })
        }
        if (renderFrame) window.cancelAnimationFrame(renderFrame)
        const usage = providerUsageSummary(result.usage)
        const contextLabel = `Context ${compactTokenCount(contextPlan.estimatedInputTokens)}/${compactTokenCount(contextPlan.inputBudgetTokens)}`
        const omittedLabel = contextPlan.omittedTurns ? ` · ${contextPlan.omittedTurns} older turn${contextPlan.omittedTurns === 1 ? '' : 's'} omitted` : ''
        const cacheLabel = apiProvider && selectedModel.providerId === 'deepseek' && usage && usage.hitTokens !== null
          ? ` · cache ${compactTokenCount(usage.hitTokens)} hit${usage.missTokens !== null ? ` / ${compactTokenCount(usage.missTokens)} miss` : ''}`
          : ''
        updateResearchSession(sessionId, (current) => ({
          ...current,
          activeStage: 5,
          runSnapshots: (current.runSnapshots || []).map((snapshot) => snapshot.id === runSnapshot.id
            ? { ...snapshot, model: { ...snapshot.model, modelId: result.model || snapshot.model.modelId } }
            : snapshot),
          messages: current.messages.map((message) => message.id === assistantId ? {
            ...message,
            text: result.text || streamedText || 'The provider returned an empty response.',
            reasoning: streamedReasoning || result.reasoning,
            toolTrace: [...toolTrace],
            usage: result.usage || null,
            contextPlan: { estimatedInputTokens: contextPlan.estimatedInputTokens, inputBudgetTokens: contextPlan.inputBudgetTokens, retainedTurns: contextPlan.retainedTurns, omittedTurns: contextPlan.omittedTurns },
            closing: `Generated with ${result.model} through ${apiProvider ? selectedModel.provider : 'the connected ChatGPT subscription'} · ${packet.evidence.length} Vault evidence chunk${packet.evidence.length === 1 ? '' : 's'}${result.webSearchEvents?.length ? ' · hosted web search used' : ''}. ${contextLabel}${omittedLabel}${cacheLabel}.`,
          } : message),
        }))
      } catch (error) {
        if (renderFrame) window.cancelAnimationFrame(renderFrame)
        updateResearchSession(sessionId, (current) => ({
          ...current,
          activeStage: 5,
          messages: current.messages.map((message) => message.id === assistantId ? {
            ...message,
            text: streamedText || message.text || (error.name === 'AbortError' ? 'Generation stopped.' : `The connected model could not complete this request: ${error.message}`),
            reasoning: streamedReasoning || message.reasoning,
            toolTrace: [...toolTrace],
            closing: error.name === 'AbortError' ? 'The partial response was kept.' : `Check the ${apiProvider ? `${selectedModel.provider} API configuration` : 'ChatGPT connection'} and try again.`,
          } : message),
        }))
      } finally {
        if (requestAbortRef.current === controller) requestAbortRef.current = null
        updateResearchSession(sessionId, { running: false, runMode: 'mock' })
      }
      return
    }
    updateResearchSession(sessionId, { runMode: 'mock', pendingQuestion: question, running: true })
  }

  const handleModelSelect = async (chatModelId) => {
    const model = getModelById(chatModelId, chatModels)
    if (model.authProvider === 'chatgpt' && !authStatus.connected) {
      const connected = await handleConnectChatgpt()
      if (!connected?.connected) return
    }
    updateResearchSession(activeTabId, (session) => ({
      ...session,
      configSnapshot: updateConversationTools(
        updateConversationModel(session.configSnapshot, modelReference(model)),
        (session.configSnapshot?.enabledTools || []).filter((toolId) => {
          if (toolId === TOOL_IDS.WEB_SEARCH) return Boolean(model.capabilities?.webSearch)
          if ([TOOL_IDS.MCP, TOOL_IDS.CODE_EXECUTE].includes(toolId)) return Boolean(model.capabilities?.tools)
          return true
        }),
      ),
    }))
  }

  const handlePause = () => {
    requestAbortRef.current?.abort()
    updateResearchSession(activeTabId, { activeStage: 5, running: false })
  }

  const handleSettingsSave = (nextConfig) => {
    setModelConfig(nextConfig)
    saveModelConfig(nextConfig)
  }

  const handleProviderConfigsSave = (nextConfigs) => {
    setProviderConfigs(nextConfigs)
    saveProviderConfigs(nextConfigs)
  }

  const handleMcpConfigSave = (nextConfig) => {
    const normalized = saveMcpConfig(nextConfig)
    setMcpConfig(normalized)
  }

  const handleConnectMcpServer = async (server) => {
    if (server.transport === 'stdio' && !window.confirm(`Launch the local MCP executable once?\n\n${server.command}\n${(server.args || []).join(' ')}`)) return
    setMcpRuntimeBusy(server.id)
    setMcpRuntimeError('')
    try {
      setMcpRuntime(await connectMcpServer(server))
    } catch (error) {
      setMcpRuntimeError(error.message)
      bootstrapMcpRuntime().then(setMcpRuntime).catch(() => {})
    } finally {
      setMcpRuntimeBusy('')
    }
  }

  const handleDisconnectMcpServer = async (serverId) => {
    setMcpRuntimeBusy(serverId)
    setMcpRuntimeError('')
    try {
      setMcpRuntime(await disconnectMcpServer(serverId))
    } catch (error) {
      setMcpRuntimeError(error.message)
    } finally {
      setMcpRuntimeBusy('')
    }
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
    openWorkspaceTab('runs')
  }

  return (
    <div className="app-shell">
      <Sidebar
        activeSection={activeSection}
        setActiveSection={handleOpenSection}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
        onConnectVault={handleConnectVault}
        onSyncVault={handleSyncVault}
        onOpenSettings={() => handleOpenSection('settings')}
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
        <header className="topbar workspace-topbar">
          <WorkspaceTabs tabs={workspaceTabs} activeTabId={activeTabId} onSelect={handleSelectTab} onClose={handleCloseTab} onCreate={(kind) => openWorkspaceTab(kind, { forceNew: kind === 'research' || kind === 'graph' })} />
          <div className="topbar-actions"><button className="icon-button mobile-settings-button" onClick={() => handleOpenSection('settings')} aria-label="Open settings"><Settings2 size={18} /></button></div>
        </header>

        {activeSection === 'launcher' ? <WorkspaceLauncher onOpen={openWorkspaceTab} /> : activeSection === 'settings' ? <SettingsWorkspace key={`settings-${providerCredentialsRevision}`} authStatus={authStatus} authBusy={authBusy} authError={authError} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnectChatgpt={handleConnectChatgpt} onLogoutChatgpt={handleLogoutChatgpt} onRefreshModels={refreshChatgptModels} chatModels={chatModels} modelConfig={modelConfig} onSaveModelConfig={handleSettingsSave} providerConfigs={providerConfigs} onSaveProviderConfigs={handleProviderConfigsSave} mcpConfig={mcpConfig} onSaveMcpConfig={handleMcpConfigSave} mcpRuntime={mcpRuntime} mcpRuntimeBusy={mcpRuntimeBusy} mcpRuntimeError={mcpRuntimeError} onConnectMcpServer={handleConnectMcpServer} onDisconnectMcpServer={handleDisconnectMcpServer} vaultNoteCount={vaultNotes.length} /> : activeSection === 'graph' ? <KnowledgeGraphSection key={activeTabId} index={vaultIndex} onConnectVault={handleConnectVault} /> : activeSection === 'pipelines' ? (
          <PipelinesSection vaultName={vaultName} noteCount={vaultNotes.length} runs={pipelineRuns} runningPipelineId={pipelineRunningId} onRun={handleRunPipeline} onViewRun={handleViewPipelineRun} onConnectVault={handleConnectVault} />
        ) : activeSection === 'runs' ? (
          <RunsSection runs={pipelineRuns} selectedRunId={selectedPipelineRunId} onSelectRun={setSelectedPipelineRunId} />
        ) : phase === 'setup' ? (
          <ResearchSetup
            config={activeResearchSession.configSnapshot}
            selectedModel={selectedModel}
            models={chatModels}
            vaultName={vaultName}
            vaultNoteCount={vaultNotes.length}
            mcpConnected={mcpRuntime.sessions.length > 0}
            authStatus={authStatus}
            authBusy={authBusy}
            modelCatalog={modelCatalog}
            modelsBusy={modelsBusy}
            onSelectAgent={handleSelectAgent}
            onUpdateIdentity={handleUpdateAgentIdentity}
            onUpdateSystemPrompt={handleUpdateAgentSystemPrompt}
            onResetSystemPrompt={handleResetAgentSystemPrompt}
            onSelectModel={handleModelSelect}
            onSelectVault={handleSelectResearchVault}
            onToggleTool={handleToggleResearchTool}
            onConnectVault={handleConnectVault}
            onConnectChatgpt={handleConnectChatgpt}
            onLogoutChatgpt={handleLogoutChatgpt}
            onRefreshModels={refreshChatgptModels}
            onStart={handleStartResearch}
          />
        ) : (
          <div className="workspace-content">
            <div className="chat-column">
              <ResearchContextBar config={activeResearchSession.configSnapshot} selectedModel={selectedModel} vaultName={vaultName} mcpConnected={mcpRuntime.sessions.length > 0} canEdit={messages.length === 0} onEdit={handleEditResearchSetup} />
              <div className="conversation">
                {messages.length === 0 && <div className="conversation-empty"><Sparkles size={22} /><strong>Start a research conversation</strong><span>Ask a question or add Vault context below.</span></div>}
                {messages.map((message) => message.role === 'user' ? <UserMessage text={message.text} key={message.id} /> : <AssistantMessage message={message} running={running} onOpenNote={setSelectedNote} key={message.id} />)}
              </div>
              <EvidenceTrail activeStage={activeStage} running={running} hasActivity={messages.length > 0 || Boolean(retrievalPacket)} />
              <Composer value={input} setValue={setInput} onSubmit={submitQuestion} disabled={anyResearchRunning} selectedModel={selectedModel} models={chatModels} onSelectModel={handleModelSelect} authStatus={authStatus} authBusy={authBusy} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnectChatgpt={handleConnectChatgpt} onLogoutChatgpt={handleLogoutChatgpt} onRefreshModels={refreshChatgptModels} />
            </div>
            <Inspector activeStage={activeStage} running={running} hasActivity={messages.length > 0 || Boolean(retrievalPacket)} onPause={handlePause} linkedNotes={inspectorNotes} sources={inspectorSources} vaultName={activeHasVaultScope ? vaultName : ''} topK={modelConfig.topK} rerankLabel={rerankModel?.name || 'Disabled by profile'} packet={retrievalPacket} answerMode={answerMode} wikilinksEnabled={activeHasVaultScope && activeResearchSession.configSnapshot?.enabledTools?.includes(TOOL_IDS.VAULT_WIKILINKS)} onOpenNote={setSelectedNote} />
          </div>
        )}
      </main>
      {selectedNote && <NotePreview note={selectedNote} onClose={() => setSelectedNote(null)} />}
      <ToolApprovalDialog approval={pendingToolApproval} onResolve={resolveToolApproval} />
    </div>
  )
}

export default App

createRoot(document.getElementById('root')).render(<App />)
