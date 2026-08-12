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
import { buildVaultIndex, getVaultName } from './vault.js'
import KnowledgeGraphSection from './KnowledgeGraph.jsx'
import { PipelinesSection, RunsSection } from './PipelineWorkspace.jsx'
import SettingsWorkspace from './SettingsWorkspace.jsx'
import { chatgptCatalogToModels, getModelById, getModelsByRole, loadModelConfig, saveModelConfig } from './modelConfig.js'
import { getProviderSessionKey, hydrateProviderSessionKeys, loadProviderConfigs, providerConfigsToModels, providerConfigsToRetrievalModels, saveProviderConfigs } from './providerConfig.js'
import { getDeepSeekRuntimeOptions } from '../shared/deepseek-provider.mjs'
import { getBailianRuntimeOptions } from '../shared/bailian-provider.mjs'
import { streamProviderResponse } from './providerRuntimeClient.js'
import { buildConversationContext, compactTokenCount, providerUsageSummary } from './conversationContext.js'
import { cancelResearchRun, executeResearchRun, reattachResearchRun, resumeResearchRun } from './research/client.js'
import {
  executeKnowledgeReadRun,
  knowledgeReadCapabilityState,
  requireCompletedKnowledgeReadText,
} from './research/knowledgeReadRun.js'
import {
  RESEARCH_RUN_EVENT,
  applyResearchRunEvent,
  createResearchRunRecord,
  isTerminalResearchRunStatus,
} from './research/runProtocol.js'
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
import { buildEvidenceSystemMessage, buildEvidenceUserContext, buildRetrievalIndex, evidenceSources } from './retrieval.js'
import { retrieveHybridEvidence } from './researchRetrieval.js'
import {
  createRetrievalIndexBuildInput,
  createRetrievalIndexIdentity,
  normalizeLifecycleResult,
  reasonMessage,
  safeProgress,
  validateReadyRetrievalIndex,
} from './retrievalIndexLifecycle.js'
import { loadVaultHandle, loadVaultSnapshot, saveVaultHandle, saveVaultSnapshot } from './vaultStorage.js'
import { describeVaultConnection, VAULT_CONNECTION_STATUS } from './vaultConnection.js'
import { AUTH_SERVICE_UNAVAILABLE, getAuthStatus, getChatgptModels, logoutChatgpt, startChatgptLogin, streamChatgptResponse, waitForChatgptAuth } from './authClient.js'
import { loadRuntimeManifest } from './runtime/client.js'
import { getRuntimeAdapter } from './runtime/adapter.js'
import VaultFallbackPicker, { VAULT_PICKER_ERROR_CODE } from './runtime/VaultFallbackPicker.jsx'
import { closeWorkspaceTab, createWorkspaceTab, findReusableTab, MAX_WORKSPACE_TABS, researchTabTitle, titleFromQuestion } from './workspaceTabs.js'
import { clearWorkspaceSnapshot, createWorkspaceSnapshot, loadWorkspaceSnapshot, saveWorkspaceSnapshot } from './workspacePersistence.js'
import { createDataBackup, createLocalDataSummary, parseDataBackup, serializeDataBackup } from './dataManagement.js'
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
import { ResearchWorkspace } from './features/research/ResearchWorkspace.jsx'
import { availableKnowledgeCapabilitiesFromRuntime, createKnowledgeAgentSessionFixture, createKnowledgeToolFixtures } from './features/knowledge/fixtures.js'
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
const PERSISTED_RESEARCH_RUN_EVENTS = new Set([
  RESEARCH_RUN_EVENT.RUN_STARTED,
  RESEARCH_RUN_EVENT.MODEL_STARTED,
  RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
  RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED,
  RESEARCH_RUN_EVENT.TOOL_ROUND_COMPLETED,
  RESEARCH_RUN_EVENT.RUN_COMPLETED,
  RESEARCH_RUN_EVENT.RUN_FAILED,
  RESEARCH_RUN_EVENT.RUN_CANCELLED,
])

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
    pendingRunId: '',
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
    createdAt: new Date().toISOString(),
    text: evidence.length
      ? `Retrieved ${evidence.length} relevant Vault evidence chunk${evidence.length === 1 ? '' : 's'} for "${question}". This model profile is not connected to a live provider yet, so no unsupported synthesis was generated.`
      : 'No relevant Markdown evidence matched this question, and this model profile is not connected to a live provider.',
    bullets: [],
    closing: 'Choose a ChatGPT-backed answer model to synthesize the retrieved evidence with inline citations.',
    evidence,
  }
}

function createRetrievalRuntime({ runtimeAdapter, providerConfigs, retrievalModels, modelConfig }) {
  const byId = new Map(retrievalModels.map((model) => [model.id, model]))
  const selectedEmbedding = byId.get(modelConfig.embeddingModelId) || null
  const selectedReranker = byId.get(modelConfig.rerankModelId) || null

  const capability = (model, operation, label) => {
    const providerConfig = model ? providerConfigs[model.providerId] : null
    const available = Boolean(model && providerConfig?.endpoint && model.apiModelId)
    const execute = async (input = {}) => {
      if (!available) return { ok: false, code: `${operation}_unavailable`, error: `${label} is not configured.` }
      const apiKey = await getProviderSessionKey(model.providerId)
      if (operation === 'embedding') {
        return runtimeAdapter.providers.embed({
          providerId: model.providerId,
          endpoint: model.endpoint || providerConfig.endpoint,
          apiKey,
          model: model.apiModelId,
          input: input.query,
          signal: input.signal,
        })
      }
      return runtimeAdapter.providers.rerank({
        providerId: model.providerId,
        endpoint: model.endpoint || providerConfig.endpoint,
        apiKey,
        model: model.apiModelId,
        query: input.query,
        candidates: Array.isArray(input.candidates) ? input.candidates.slice(0, 50) : [],
        top_n: Math.min(50, Array.isArray(input.candidates) ? input.candidates.length : 0),
        signal: input.signal,
      })
    }
    return {
      available,
      reason: available ? null : `${label} is not configured from an account-visible Runtime model.`,
      [operation === 'embedding' ? 'embed' : 'rerank']: execute,
    }
  }

  return {
    embedding: capability(selectedEmbedding, 'embedding', 'Embedding'),
    rerank: capability(selectedReranker, 'rerank', 'Reranker'),
    selectedEmbedding,
    selectedReranker,
  }
}

function formatMessageTime(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
}

function LogoMark() {
  return (
    <div className="logo-mark" aria-hidden="true">
      <Atom size={25} strokeWidth={1.7} />
    </div>
  )
}


function Sidebar({ activeSection, setActiveSection, collapsed, onToggleCollapsed, onConnectVault, onSyncVault, onOpenSettings, vaultName, vaultNoteCount, syncState, vaultFeedback, vaultSource, localAdapterState, authStatus, authBusy, onConnectChatgpt, onLogoutChatgpt, authError }) {
  const vaultPresentation = describeVaultConnection({ vaultName, noteCount: vaultNoteCount, syncState })
  const hasVault = vaultPresentation.status !== VAULT_CONNECTION_STATUS.DISCONNECTED
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
        <button className={`workspace-switcher ${vaultPresentation.status}`} onClick={onConnectVault} aria-label={vaultPresentation.actionLabel} title={collapsed ? vaultPresentation.actionLabel : undefined}>
          <span className="workspace-icon"><FlaskConical size={17} /></span>
          <span className="workspace-copy">
            <strong>{vaultPresentation.title}</strong>
            <small>{vaultPresentation.detail}</small>
          </span>
          <ChevronDown size={16} />
        </button>
        {hasVault && <button className="settings-link sync-link" onClick={onSyncVault} disabled={syncState === 'syncing'} title={collapsed ? vaultPresentation.syncLabel : undefined}><RefreshCw className={syncState === 'syncing' ? 'spin' : ''} size={15} /><span>{vaultPresentation.syncLabel}</span></button>}
        {vaultFeedback && <div className={`vault-feedback ${vaultFeedback.kind}`} role={vaultFeedback.kind === 'error' ? 'alert' : 'status'}>
          <span>{vaultFeedback.message}</span>
          {vaultFeedback.retry && <button type="button" onClick={onConnectVault}>Retry</button>}
        </div>}
        {vaultSource === 'local-adapter' && <div className={`adapter-status ${localAdapterState}`} title={collapsed ? (localAdapterState === 'ready' ? 'Local adapter online' : 'Local adapter offline') : undefined}><Database size={14} /><span>{localAdapterState === 'ready' ? 'Local adapter online' : 'Local adapter offline'}</span>{localAdapterState === 'ready' && <small>auto sync 15s</small>}</div>}
        <div className={`account-status ${authStatus?.connected ? 'connected' : ''}`} title={collapsed ? (authStatus?.connected ? 'ChatGPT connected' : 'ChatGPT not connected') : undefined}>
          <Sparkles size={14} />
          <span>{authStatus?.connected ? 'ChatGPT connected' : authStatus?.unavailable ? 'Local ChatGPT service offline' : 'ChatGPT not connected'}</span>
          <button onClick={authStatus?.connected ? onLogoutChatgpt : onConnectChatgpt} disabled={authBusy}>{authStatus?.connected ? 'Sign out' : authBusy ? 'Waiting...' : authStatus?.unavailable ? 'Retry' : 'Connect'}</button>
        </div>
        {authError && <small className="auth-error" role="alert">{authError}</small>}
        <button className={`settings-link ${activeSection === 'settings' ? 'active' : ''}`} onClick={onOpenSettings} title={collapsed ? 'Settings' : undefined}><Settings2 size={16} /><span>Settings</span></button>
      </div>
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
  const runtimeAdapter = useMemo(() => getRuntimeAdapter(), [])
  const [workspaceTabs, setWorkspaceTabs] = useState(() => [createWorkspaceTab('research', { id: INITIAL_RESEARCH_TAB_ID, title: DEFAULT_RESEARCH_TAB_TITLE })])
  const [activeTabId, setActiveTabId] = useState(INITIAL_RESEARCH_TAB_ID)
  const [researchSessions, setResearchSessions] = useState(() => {
    const defaults = loadModelConfig()
    return { [INITIAL_RESEARCH_TAB_ID]: createResearchSession({ modelId: defaults.chatModelId }) }
  })
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
  const [vaultNotes, setVaultNotes] = useState([])
  const [vaultName, setVaultName] = useState('')
  const [vaultHandle, setVaultHandle] = useState(null)
  const [vaultCapabilityId, setVaultCapabilityId] = useState('')
  const [vaultSource, setVaultSource] = useState('none')
  const [localAdapterState, setLocalAdapterState] = useState('checking')
  const [localRevision, setLocalRevision] = useState('')
  const [syncState, setSyncState] = useState('idle')
  const [vaultFeedback, setVaultFeedback] = useState(null)
  const [selectedNote, setSelectedNote] = useState(null)
  const [modelConfig, setModelConfig] = useState(loadModelConfig)
  const [providerConfigs, setProviderConfigs] = useState(loadProviderConfigs)
  const [providerCredentialsRevision, setProviderCredentialsRevision] = useState(0)
  const [mcpConfig, setMcpConfig] = useState(loadMcpConfig)
  const [mcpRuntime, setMcpRuntime] = useState({ sessions: [] })
  const [mcpRuntimeBusy, setMcpRuntimeBusy] = useState('')
  const [mcpRuntimeError, setMcpRuntimeError] = useState('')
  const [pendingToolApproval, setPendingToolApproval] = useState(null)
  const [knowledgeAgentSession, setKnowledgeAgentSession] = useState(() => createKnowledgeAgentSessionFixture())
  const [knowledgeAgentInput, setKnowledgeAgentInput] = useState('')
  const [knowledgeApproval, setKnowledgeApproval] = useState(null)
  const [runtimeManifest, setRuntimeManifest] = useState(null)
  const [authStatus, setAuthStatus] = useState({ provider: 'chatgpt', connected: false, pending: false })
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [modelCatalog, setModelCatalog] = useState(EMPTY_CHATGPT_CATALOG)
  const [modelsBusy, setModelsBusy] = useState(false)
  const [pipelineRuns, setPipelineRuns] = useState(loadPipelineRuns)
  const [pipelineRunningId, setPipelineRunningId] = useState(null)
  const [selectedPipelineRunId, setSelectedPipelineRunId] = useState(null)
  const [retrievalIndexLifecycle, setRetrievalIndexLifecycle] = useState({ state: 'unavailable', identity: null, progress: null, reason: 'no_embedding_model', message: reasonMessage('no_embedding_model') })
  const [readyRetrievalIndex, setReadyRetrievalIndex] = useState(null)
  const vaultInputRef = useRef(null)
  const requestAbortControllersRef = useRef(new Map())
  const pipelineRunTimerRef = useRef(null)
  const mockRunTimersRef = useRef(new Map())
  const toolApprovalResolverRef = useRef(null)
  const knowledgeApprovalCallbackRef = useRef(null)
  const knowledgeApprovalDeclineCallbackRef = useRef(null)
  const knowledgeApprovalResolvingRef = useRef(false)
  const reattachedResearchRunsRef = useRef(new Set())
  const researchToolRegistryRef = useRef(null)
  const retrievalIndexOperationRef = useRef({ generation: 0, identity: null, controller: null, timer: null, building: false })

  useEffect(() => {
    let cancelled = false
    loadWorkspaceSnapshot().then((snapshot) => {
      if (cancelled || !snapshot) return
      setWorkspaceTabs(snapshot.tabs)
      setActiveTabId(snapshot.activeTabId)
      setResearchSessions(snapshot.sessions)
    }).finally(() => {
      if (!cancelled) setWorkspaceHydrated(true)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!workspaceHydrated) return undefined
    const timer = window.setTimeout(() => {
      void saveWorkspaceSnapshot({ tabs: workspaceTabs, activeTabId, sessions: researchSessions })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [activeTabId, researchSessions, workspaceHydrated, workspaceTabs])

  const activeTab = workspaceTabs.find((tab) => tab.id === activeTabId) || workspaceTabs[0]
  const activeSection = activeTab?.kind || 'launcher'
  const runtimeCapabilities = runtimeManifest?.capabilities
  const runtimeReady = Boolean(runtimeCapabilities)
  const supportsLoopbackMcp = ['loopback', 'desktop-loopback'].includes(runtimeCapabilities?.mcp)
  const supportsChatgptSubscription = runtimeCapabilities?.chatgptSubscriptionOAuth === true
  const supportsDesktopVault = runtimeCapabilities?.localVault.preferred === 'desktop-ipc'
  const supportsBrowserPickerVault = runtimeCapabilities?.localVault.adapters.includes('browser-picker') === true
  const supportsLoopbackVault = runtimeCapabilities?.localVault.adapters.includes('loopback-adapter') === true
  const supportsResearchRunReattach = runtimeCapabilities?.researchRuns === 'loopback-event-buffer'
  const supportsLoopbackResearchExecution = runtimeCapabilities?.researchExecution === 'loopback-provider'
  const activeResearchSession = researchSessions[activeTabId] || createResearchSession({ modelId: modelConfig.chatModelId, knowledgeBaseId: vaultName })
  const availableKnowledgeCapabilities = useMemo(
    () => availableKnowledgeCapabilitiesFromRuntime(runtimeCapabilities),
    [runtimeCapabilities],
  )
  const knowledgeToolDescriptors = useMemo(() => createKnowledgeToolFixtures({
    context: knowledgeAgentSession.context,
    availableCapabilities: availableKnowledgeCapabilities,
  }), [availableKnowledgeCapabilities, knowledgeAgentSession.context])
  const { phase, input, messages, running, activeStage, answerMode, retrievalPacket } = activeResearchSession
  const runStatus = activeResearchSession.runSnapshots?.at(-1)?.status
  const activeHasVaultScope = Boolean(vaultName && activeResearchSession.configSnapshot?.knowledgeScopes?.some((scope) => scope.vaultId === vaultName))
  const anyResearchRunning = Object.values(researchSessions).some((session) => session.running)
  const dataActionBlocked = anyResearchRunning || Boolean(pipelineRunningId)
  const supportsDesktopDataFiles = runtimeAdapter.dataFiles.native
  const localDataSummary = useMemo(() => createLocalDataSummary({
    workspace: { tabs: workspaceTabs, activeTabId, sessions: researchSessions },
    pipelineRuns,
    vaultNoteCount: vaultNotes.length,
  }), [activeTabId, pipelineRuns, researchSessions, vaultNotes.length, workspaceTabs])

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
    if (!workspaceHydrated || !supportsResearchRunReattach) return undefined
    const candidates = []
    for (const [tabId, session] of Object.entries(researchSessions)) {
      for (const snapshot of session.runSnapshots || []) {
        if (snapshot.error?.code !== 'run_interrupted' || reattachedResearchRunsRef.current.has(snapshot.id)) continue
        reattachedResearchRunsRef.current.add(snapshot.id)
        candidates.push({ tabId, runId: snapshot.id })
      }
    }
    if (!candidates.length) return undefined
    let cancelled = false
    Promise.all(candidates.map(async ({ tabId, runId }) => {
      try {
        let attachment = await reattachResearchRun(runId)
        if (!isTerminalResearchRunStatus(attachment.run.status)) {
          if (attachment.run.executionOwner === 'loopback' && tabId === activeTabId) {
            try {
              await resumeResearchRun({
                runId,
                executeTool: (call, context) => {
                  if (!researchToolRegistryRef.current) throw new Error('Research tools are not ready after workspace restoration.')
                  return researchToolRegistryRef.current.execute(call, context)
                },
              })
            } catch { /* terminal state is recovered from the event log below */ }
            attachment = await reattachResearchRun(runId)
          }
          if (!isTerminalResearchRunStatus(attachment.run.status)) {
            const stopped = await cancelResearchRun(runId)
            attachment = { ...attachment, run: stopped.run || attachment.run }
          }
        }
        return { tabId, runId, attachment }
      } catch {
        return null
      }
    })).then((recoveries) => {
      if (cancelled) return
      setResearchSessions((current) => {
        let next = current
        for (const recovery of recoveries.filter(Boolean)) {
          const session = next[recovery.tabId]
          if (!session) continue
          let replayedText = ''
          let replayedReasoning = ''
          let replayedToolTrace = []
          let completedResult = null
          for (const envelope of recovery.attachment.events || []) {
            const event = envelope.event || envelope
            if (event.type === RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA) replayedText += event.delta || ''
            if (event.type === RESEARCH_RUN_EVENT.MODEL_REASONING_DELTA) replayedReasoning += event.delta || ''
            if (event.type === RESEARCH_RUN_EVENT.TOOL_ROUND_COMPLETED) {
              replayedText = ''
              replayedToolTrace = event.toolTrace || replayedToolTrace
            }
            if (event.type === RESEARCH_RUN_EVENT.RUN_COMPLETED) completedResult = event.result || completedResult
          }
          const updated = {
            ...session,
            messages: session.messages.map((message) => message.runId === recovery.runId ? {
              ...message,
              text: completedResult?.text || replayedText || message.text || (recovery.attachment.run.status === 'cancelled'
                ? 'This research run was interrupted before completion. You can retry the question.'
                : ''),
              reasoning: completedResult?.reasoning || replayedReasoning || message.reasoning,
              toolTrace: replayedToolTrace.length ? replayedToolTrace : message.toolTrace,
            } : message),
            runSnapshots: (session.runSnapshots || []).map((snapshot) => snapshot.id === recovery.runId
              ? { ...snapshot, ...recovery.attachment.run }
              : snapshot),
          }
          next = { ...next, [recovery.tabId]: updated }
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [activeTabId, researchSessions, supportsResearchRunReattach, workspaceHydrated])

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
  researchToolRegistryRef.current = researchToolRegistry
  const staticChatModels = useMemo(() => getModelsByRole('chat'), [])
  const chatModels = useMemo(() => {
    const smartModel = staticChatModels.find((model) => model.id === 'smart-default')
    const futureModels = staticChatModels.filter((model) => model.id !== 'smart-default')
    const discoveredModels = chatgptCatalogToModels(modelCatalog.models)
    const apiModels = providerConfigsToModels(providerConfigs)
    return [smartModel, ...discoveredModels, ...apiModels, ...futureModels].filter(Boolean)
  }, [modelCatalog.models, providerConfigs, staticChatModels])
  const retrievalModels = useMemo(() => providerConfigsToRetrievalModels(providerConfigs), [providerConfigs])
  const retrievalRuntime = useMemo(() => createRetrievalRuntime({ runtimeAdapter, providerConfigs, retrievalModels, modelConfig }), [modelConfig, providerConfigs, retrievalModels, runtimeAdapter])
  const retrievalIndexIdentityResult = useMemo(() => createRetrievalIndexIdentity({
    vaultId: activeHasVaultScope ? (vaultCapabilityId || vaultName) : '',
    vaultRevision: activeHasVaultScope ? localRevision : '',
    chunkSize: modelConfig.chunkSize,
    chunkOverlap: modelConfig.chunkOverlap,
    embeddingModel: retrievalRuntime.selectedEmbedding,
  }), [activeHasVaultScope, localRevision, modelConfig.chunkOverlap, modelConfig.chunkSize, retrievalRuntime.selectedEmbedding, vaultCapabilityId, vaultName])
  const retrievalIndexIdentity = retrievalIndexIdentityResult.ok ? retrievalIndexIdentityResult.identity : null
  const embeddingLabel = retrievalRuntime.selectedEmbedding?.name || 'Not used'
  const rerankLabel = retrievalRuntime.selectedReranker?.name || 'Not used'

  const applyRetrievalIndexResult = useCallback(async (result, identity, generation, signal) => {
    if (retrievalIndexOperationRef.current.generation !== generation) return
    const view = normalizeLifecycleResult(result, identity, 'failed')
    if (view.state === 'ready') {
      const readResult = await Promise.resolve()
        .then(() => runtimeAdapter.retrievalIndexes.read({ identity, signal }))
        .catch(() => ({ ok: false, state: 'failed', identity, error: { code: 'storage_failed' } }))
      if (retrievalIndexOperationRef.current.generation !== generation) return
      if (readResult?.state !== 'ready') {
        setReadyRetrievalIndex(null)
        setRetrievalIndexLifecycle(normalizeLifecycleResult(readResult, identity, 'failed'))
        return
      }
      const validated = validateReadyRetrievalIndex(readResult, identity)
      if (validated.ok) {
        setReadyRetrievalIndex({
          state: 'ready',
          identity: readResult.identity,
          index: validated.index,
          vectors: validated.vectors,
          provenance: readResult.provenance,
        })
        setRetrievalIndexLifecycle({ ...normalizeLifecycleResult(readResult, identity, 'ready'), state: 'ready', reason: null, message: null })
        return
      }
      setReadyRetrievalIndex(null)
      setRetrievalIndexLifecycle({ state: 'degraded', identity, progress: null, reason: validated.code, message: reasonMessage(validated.code) })
      return
    }
    setReadyRetrievalIndex(null)
    setRetrievalIndexLifecycle(view)
  }, [runtimeAdapter])

  const refreshRetrievalIndex = useCallback(async ({ identity = retrievalIndexIdentity, generation = retrievalIndexOperationRef.current.generation, signal = retrievalIndexOperationRef.current.controller?.signal, forceStatus = false } = {}) => {
    if (!identity) {
      const code = retrievalIndexIdentityResult.ok ? 'vault_chunks_unavailable' : retrievalIndexIdentityResult.code
      setReadyRetrievalIndex(null)
      setRetrievalIndexLifecycle({ state: 'unavailable', identity: null, progress: null, reason: code, message: reasonMessage(code) })
      return
    }
    const operation = retrievalIndexOperationRef.current
    const method = forceStatus || operation.lastState !== 'building' ? runtimeAdapter.retrievalIndexes.status : runtimeAdapter.retrievalIndexes.progress
    const result = await Promise.resolve()
      .then(() => method({ identity, signal }))
      .catch(() => ({ ok: false, state: 'failed', identity, error: { code: 'storage_failed' } }))
    if (retrievalIndexOperationRef.current.generation !== generation) return
    await applyRetrievalIndexResult(result, identity, generation, signal)
    if (retrievalIndexOperationRef.current.generation !== generation) return
    const nextState = result?.state
    operation.lastState = nextState
    if (nextState === 'building') {
      operation.timer = window.setTimeout(() => void refreshRetrievalIndex({ identity, generation, signal }), 500)
    }
  }, [applyRetrievalIndexResult, retrievalIndexIdentity, retrievalIndexIdentityResult, runtimeAdapter])

  const startRetrievalIndexBuild = useCallback(async (rebuild = false) => {
    const identity = retrievalIndexIdentity
    if (!identity) {
      const code = retrievalIndexIdentityResult.ok ? 'vault_chunks_unavailable' : retrievalIndexIdentityResult.code
      setRetrievalIndexLifecycle({ state: 'unavailable', identity: null, progress: null, reason: code, message: reasonMessage(code) })
      return
    }
    if (retrievalRuntime.embedding.available !== true) {
      setRetrievalIndexLifecycle({ state: 'unavailable', identity, progress: null, reason: 'embedding_capability_unavailable', message: reasonMessage('embedding_capability_unavailable') })
      return
    }
    const buildInput = createRetrievalIndexBuildInput({
      identity,
      retrievalIndex,
      remoteEmbeddingConsent: modelConfig.remoteEmbeddingConsent === true,
    })
    if (!buildInput.ok) {
      setRetrievalIndexLifecycle({ state: 'unavailable', identity, progress: null, reason: buildInput.code, message: reasonMessage(buildInput.code) })
      return
    }
    const previous = retrievalIndexOperationRef.current
    previous.controller?.abort()
    const generation = previous.generation + 1
    const controller = new AbortController()
    retrievalIndexOperationRef.current = { generation, identity, controller, timer: null, building: true, lastState: 'building' }
    setReadyRetrievalIndex(null)
    setRetrievalIndexLifecycle({ state: 'building', identity, progress: { completed: 0, total: buildInput.input.chunks.length, batches: 0 }, reason: null, message: null })
    const embeddingModel = retrievalRuntime.selectedEmbedding
    const providerConfig = embeddingModel ? providerConfigs[embeddingModel.providerId] : null
    let apiKey = ''
    try {
      apiKey = embeddingModel ? await getProviderSessionKey(embeddingModel.providerId) : ''
    } catch {
      if (retrievalIndexOperationRef.current.generation !== generation) return
      retrievalIndexOperationRef.current.building = false
      setRetrievalIndexLifecycle({ state: 'failed', identity, progress: null, reason: 'authentication_failed', message: reasonMessage('authentication_failed') })
      return
    }
    const provider = embeddingModel && providerConfig?.endpoint ? {
      endpoint: embeddingModel.endpoint || providerConfig.endpoint,
      apiKey,
    } : null
    if (retrievalIndexOperationRef.current.generation !== generation) return
    const method = rebuild ? runtimeAdapter.retrievalIndexes.rebuild : runtimeAdapter.retrievalIndexes.build
    const buildPromise = Promise.resolve().then(() => method({
      ...buildInput.input,
      provider,
      signal: controller.signal,
      onProgress: (progress) => {
        if (retrievalIndexOperationRef.current.generation !== generation) return
        setRetrievalIndexLifecycle({ state: 'building', identity, progress: safeProgress(progress), reason: null, message: null })
      },
    }))
    retrievalIndexOperationRef.current.timer = window.setTimeout(() => void refreshRetrievalIndex({ identity, generation, signal: controller.signal }), 500)
    const result = await buildPromise.catch((error) => ({ ok: false, state: controller.signal.aborted ? 'cancelled' : 'failed', identity, error: { code: controller.signal.aborted ? 'cancelled' : error?.code } }))
    if (retrievalIndexOperationRef.current.generation !== generation) return
    if (retrievalIndexOperationRef.current.timer) window.clearTimeout(retrievalIndexOperationRef.current.timer)
    retrievalIndexOperationRef.current.timer = null
    retrievalIndexOperationRef.current.building = false
    await applyRetrievalIndexResult(result, identity, generation, controller.signal)
  }, [applyRetrievalIndexResult, modelConfig.remoteEmbeddingConsent, providerConfigs, refreshRetrievalIndex, retrievalIndex, retrievalIndexIdentity, retrievalIndexIdentityResult, retrievalRuntime.embedding.available, retrievalRuntime.selectedEmbedding, runtimeAdapter])

  const cancelRetrievalIndexBuild = useCallback(async () => {
    const operation = retrievalIndexOperationRef.current
    if (!operation.identity) return
    const identity = operation.identity
    const generation = operation.generation
    operation.controller?.abort()
    if (operation.timer) window.clearTimeout(operation.timer)
    const nextGeneration = generation + 1
    retrievalIndexOperationRef.current = { ...operation, generation: nextGeneration, timer: null, building: false, lastState: 'cancelled' }
    const result = await Promise.resolve()
      .then(() => runtimeAdapter.retrievalIndexes.cancel({ identity }))
      .catch(() => ({ ok: false, state: 'cancelled', identity, error: { code: 'cancelled' } }))
    if (retrievalIndexOperationRef.current.generation !== nextGeneration) return
    setReadyRetrievalIndex(null)
    const cancelState = result?.state === 'failed' && result?.error?.code !== 'cancelled' ? 'failed' : 'cancelled'
    const normalized = normalizeLifecycleResult(result, identity, 'cancelled')
    setRetrievalIndexLifecycle({ ...normalized, state: cancelState, ...(cancelState === 'cancelled' ? { reason: 'cancelled', message: reasonMessage('cancelled') } : {}) })
  }, [runtimeAdapter])

  useEffect(() => {
    const previous = retrievalIndexOperationRef.current
    previous.controller?.abort()
    if (previous.timer) window.clearTimeout(previous.timer)
    if (previous.building && previous.identity) void runtimeAdapter.retrievalIndexes.cancel({ identity: previous.identity }).catch(() => {})
    const generation = previous.generation + 1
    const controller = new AbortController()
    retrievalIndexOperationRef.current = { generation, identity: retrievalIndexIdentity, controller, timer: null, building: false, lastState: null }
    setReadyRetrievalIndex(null)
    if (!retrievalIndexIdentity || modelConfig.remoteEmbeddingConsent !== true) {
      const code = !retrievalIndexIdentity ? (retrievalIndexIdentityResult.ok ? 'vault_chunks_unavailable' : retrievalIndexIdentityResult.code) : 'remote_consent_required'
      setRetrievalIndexLifecycle({ state: 'unavailable', identity: retrievalIndexIdentity, progress: null, reason: code, message: reasonMessage(code) })
      return () => {
        controller.abort()
        if (retrievalIndexOperationRef.current.generation === generation) retrievalIndexOperationRef.current.generation += 1
      }
    }
    void refreshRetrievalIndex({ identity: retrievalIndexIdentity, generation, signal: controller.signal, forceStatus: true })
    return () => {
      controller.abort()
      if (retrievalIndexOperationRef.current.timer) window.clearTimeout(retrievalIndexOperationRef.current.timer)
      if (retrievalIndexOperationRef.current.generation === generation && retrievalIndexOperationRef.current.building && retrievalIndexIdentity) {
        void runtimeAdapter.retrievalIndexes.cancel({ identity: retrievalIndexIdentity }).catch(() => {})
      }
      if (retrievalIndexOperationRef.current.generation === generation) retrievalIndexOperationRef.current.generation += 1
    }
  }, [modelConfig.remoteEmbeddingConsent, refreshRetrievalIndex, retrievalIndexIdentity, retrievalIndexIdentityResult, runtimeAdapter])

  const retrievalIndexState = retrievalIndexLifecycle.state
  const activeChatModelId = activeResearchSession.configSnapshot?.model?.modelId || modelConfig.chatModelId
  const selectedModel = useMemo(() => getModelById(activeChatModelId, chatModels), [activeChatModelId, chatModels])
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
    note: notesById.get(source.noteId || source.id) || null,
    citations: (retrievalPacket?.evidence || [])
      .filter((item) => item.sourceId === source.id || item.noteId === source.noteId)
      .map((item) => ({ chunkId: item.chunkId, heading: item.citation?.heading || item.chunk?.heading || item.heading || null, excerpt: item.excerpt || '' })),
  })), [notesById, retrievalPacket])
  const vaultSources = useMemo(() => vaultIndex.sources.map((source) => ({
    ...source,
    note: notesById.get(source.id) || null,
  })), [notesById, vaultIndex.sources])
  const inspectorNotes = activeHasVaultScope ? retrievalPacket ? retrievedNotes : vaultIndex.notes.length ? vaultIndex.linkedNotes : [] : []
  const inspectorSources = activeHasVaultScope ? retrievalPacket ? retrievedSources : vaultSources : []

  const applyVault = async (notes, nextVaultName, { capabilityId = '', handle = null, source = 'manual', revision = '' } = {}) => {
    setVaultNotes(notes)
    setVaultName(nextVaultName)
    setVaultHandle(handle)
    setVaultCapabilityId(capabilityId)
    setVaultSource(source)
    setLocalRevision(revision)
    setResearchSessions((current) => Object.fromEntries(Object.entries(current).map(([id, session]) => [id, { ...session, retrievalPacket: null, answerMode: 'idle' }])))
    await saveVaultSnapshot({ vaultName: nextVaultName, notes, source, revision })
    if (handle) await saveVaultHandle(handle)
    setSyncState(notes.length ? (source === 'local-adapter' || source === 'desktop-ipc' || handle ? 'ready' : 'manual') : 'empty')
    return true
  }

  const syncFromDesktopVault = async (silent = false) => {
    if (!vaultCapabilityId) return false
    if (!silent) setSyncState('syncing')
    try {
      const payload = await runtimeAdapter.vault.syncDesktop({ vaultId: vaultCapabilityId, revision: localRevision })
      if (payload.unchanged) {
        setSyncState('ready')
        return true
      }
      return applyVault(payload.notes || [], payload.vaultName || vaultName || 'local-vault', {
        capabilityId: payload.vaultId,
        source: 'desktop-ipc',
        revision: payload.revision || '',
      })
    } catch {
      setVaultCapabilityId('')
      setSyncState(silent ? 'needs-permission' : 'error')
      return false
    }
  }

  const syncFromHandle = async (handle, requestPermission = false) => {
    if (!handle) return false
    setSyncState('syncing')
    try {
      const payload = await runtimeAdapter.vault.syncDirectory(handle, { requestPermission })
      if (payload.permission !== 'granted') {
        setSyncState('needs-permission')
        return false
      }
      return applyVault(payload.notes, payload.vaultName, { handle: payload.handle, source: 'browser-handle' })
    } catch {
      setSyncState('error')
      return false
    }
  }

  const syncFromLocalAdapter = async (silent = false) => {
    if (!silent) setSyncState('syncing')
    try {
      const payload = await runtimeAdapter.vault.loadLoopback({ revision: localRevision, timeout: silent ? 1800 : 2200 })
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
    setVaultFeedback(null)
    if (supportsDesktopVault) {
      if (!runtimeAdapter.vault.hasDesktopBridge) {
        setSyncState('error')
        return
      }
      setSyncState('syncing')
      try {
        const payload = await runtimeAdapter.vault.selectDesktop()
        if (payload?.cancelled) {
          setSyncState(vaultNotes.length ? 'needs-permission' : 'manual')
          return
        }
        await applyVault(payload.notes || [], payload.vaultName || 'local-vault', {
          capabilityId: payload.vaultId,
          source: 'desktop-ipc',
          revision: payload.revision || '',
        })
      } catch {
        setSyncState('error')
      }
      return
    }
    if (supportsBrowserPickerVault && runtimeAdapter.vault.canSelectDirectory) {
      try {
        const selection = await runtimeAdapter.vault.selectDirectory()
        if (selection.handle) await syncFromHandle(selection.handle, true)
        return
      } catch (error) {
        if (error?.name === 'AbortError') return
      }
    }
    if (supportsLoopbackVault && await syncFromLocalAdapter()) return
    vaultInputRef.current?.open()
  }

  const handleSyncVault = async () => {
    if (vaultSource === 'desktop-ipc' && vaultCapabilityId) {
      await syncFromDesktopVault()
    } else if (vaultSource === 'local-adapter') {
      await syncFromLocalAdapter()
    } else if (vaultHandle) {
      await syncFromHandle(vaultHandle, true)
    } else {
      await handleConnectVault()
    }
  }

  const handleVaultSelection = async (files) => {
    const previousSyncState = syncState
    setVaultFeedback(null)
    setSyncState('syncing')
    try {
      const { notes, vaultName: selectedVaultName } = await runtimeAdapter.vault.parseSelectedFiles(files)
      if (!notes.length) {
        setSyncState(vaultNotes.length ? previousSyncState : 'empty')
        setVaultFeedback({
          kind: 'empty',
          message: vaultNotes.length
            ? 'No Markdown files were found. The current Vault was kept.'
            : 'No Markdown files were found in that folder.',
          retry: true,
        })
        return { status: 'empty' }
      }
      await applyVault(notes, selectedVaultName, { source: 'manual' })
      setVaultFeedback({ kind: 'success', message: `Connected ${selectedVaultName} with ${notes.length} Markdown note${notes.length === 1 ? '' : 's'}.` })
      return { status: 'selected', notes, vaultName: selectedVaultName }
    } catch (error) {
      setSyncState(vaultNotes.length ? previousSyncState : 'error')
      setVaultFeedback({
        kind: 'error',
        message: vaultNotes.length
          ? 'The folder could not be read. The current Vault was kept.'
          : 'The folder could not be read. Try selecting it again.',
        retry: true,
      })
      return { status: 'failed', error }
    }
  }

  const handleVaultSelectionCancelled = () => {
    setVaultFeedback({
      kind: 'cancelled',
      message: vaultNotes.length ? 'Folder selection cancelled. The current Vault was kept.' : 'Folder selection cancelled.',
      retry: true,
    })
  }

  const handleVaultSelectionError = (error) => {
    const selectionNotDelivered = error?.code === VAULT_PICKER_ERROR_CODE
    setVaultFeedback({
      kind: 'error',
      message: selectionNotDelivered
        ? vaultNotes.length
          ? 'The browser did not deliver the selected folder. The current Vault was kept. Try again or use an available Runtime Vault connection.'
          : 'The browser did not deliver the selected folder. Try again or use an available Runtime Vault connection.'
        : 'The folder could not be processed. Try selecting it again.',
      retry: true,
    })
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
      const localSynced = !supportsDesktopVault && !supportsBrowserPickerVault && supportsLoopbackVault
        ? await syncFromLocalAdapter(true)
        : false
      if (localSynced || cancelled) return
      if (supportsBrowserPickerVault && handle) {
        setVaultHandle(handle)
        const synced = await syncFromHandle(handle)
        if (synced || cancelled) return
      }
      if (snapshot?.notes?.length && !cancelled) {
        setVaultNotes(snapshot.notes)
        setVaultName(snapshot.vaultName || getVaultName(snapshot.notes))
        setVaultSource(snapshot.source || (handle ? 'browser-handle' : 'manual'))
        setLocalRevision(snapshot.revision || '')
        setSyncState('needs-permission')
      }
    })
    return () => { cancelled = true }
  }, [runtimeReady, supportsBrowserPickerVault, supportsDesktopVault, supportsLoopbackVault])

  useEffect(() => {
    if (!supportsDesktopVault || !vaultCapabilityId) return undefined
    return runtimeAdapter.vault.onDesktopChanged(({ vaultId }) => {
      if (vaultId === vaultCapabilityId) void syncFromDesktopVault(true)
    })
  }, [supportsDesktopVault, vaultCapabilityId, localRevision])

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
      const response = { ...responseForQuestion(session.pendingQuestion, session.retrievalPacket), runId: session.pendingRunId }
      const runSnapshot = (session.runSnapshots || []).find((snapshot) => snapshot.id === session.pendingRunId)
      const execution = executeResearchRun({
        runId: session.pendingRunId,
        sessionId: tabId,
        model: runSnapshot?.model,
        policy: runSnapshot?.policy || session.configSnapshot?.loopPolicy,
        evidenceCount: runSnapshot?.evidenceCount || 0,
        messages: [{ role: 'user', content: session.pendingQuestion }],
        request: () => new Promise((resolve) => {
          const finish = window.setTimeout(() => resolve({ text: response.text, model: 'offline-retrieval' }), 3900)
          mockRunTimersRef.current.set(tabId, [...(mockRunTimersRef.current.get(tabId) || timers), finish])
        }),
      })
      mockRunTimersRef.current.set(tabId, timers)
      void execution.then(() => {
        updateResearchSession(tabId, (current) => ({
          ...current,
          activeStage: 5,
          messages: current.messages.map((message) => message.runId === session.pendingRunId
            ? { ...response, id: message.id, createdAt: message.createdAt }
            : message),
          runSnapshots: (current.runSnapshots || []).map((snapshot) => snapshot.id === current.pendingRunId
            ? applyResearchRunEvent(snapshot, {
              type: RESEARCH_RUN_EVENT.RUN_COMPLETED,
              runId: snapshot.id,
              iteration: 1,
            })
            : snapshot),
          pendingQuestion: '',
          pendingRunId: '',
          running: false,
        }))
        requestAbortControllersRef.current.delete(tabId)
        mockRunTimersRef.current.delete(tabId)
      }).catch((error) => {
        updateResearchSession(tabId, (current) => ({
          ...current,
          activeStage: 5,
          messages: current.messages.map((message) => message.runId === session.pendingRunId
            ? { ...response, id: message.id, createdAt: message.createdAt, text: `The offline research run could not complete: ${error.message}` }
            : message),
          runSnapshots: (current.runSnapshots || []).map((snapshot) => snapshot.id === current.pendingRunId
            ? applyResearchRunEvent(snapshot, { type: RESEARCH_RUN_EVENT.RUN_FAILED, runId: snapshot.id, error: { message: error.message } })
            : snapshot),
          pendingQuestion: '',
          pendingRunId: '',
          running: false,
        }))
        requestAbortControllersRef.current.delete(tabId)
        mockRunTimersRef.current.delete(tabId)
      })
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
    if (closingSession?.running) requestAbortControllersRef.current.get(tabId)?.abort()
    requestAbortControllersRef.current.delete(tabId)
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

  const handleKnowledgeContextChange = useCallback((context) => {
    setKnowledgeAgentSession((current) => current.context === context ? current : { ...current, context })
  }, [])

  const executeKnowledgeRead = useCallback(async (descriptor, prompt, context, signal) => {
    const capability = knowledgeReadCapabilityState(runtimeCapabilities, descriptor.toolId)
    if (!capability.available || !supportsLoopbackResearchExecution) {
      throw new Error(capability.reason || 'Knowledge Read execution is unavailable in this Runtime.')
    }
    if (selectedModel.authProvider !== 'api') {
      throw new Error('Select a configured API Provider model before using Knowledge Explain.')
    }
    const providerConfig = providerConfigs[selectedModel.providerId]
    if (!providerConfig) throw new Error(`Provider configuration is missing for ${selectedModel.provider}.`)

    const cursor = knowledgeAgentSession.cursor + 1
    const sessionId = knowledgeAgentSession.sessionId
    const requestId = `${sessionId}:${descriptor.toolId}:request:${cursor}`
    const runId = `${sessionId}:${descriptor.toolId}:run:${cursor}`
    const currentContext = context || knowledgeAgentSession.context
    const input = descriptor.toolId === 'knowledge.query' ? { query: prompt } : { question: prompt }
    const baseProviderOptions = selectedModel.providerId === 'deepseek'
      ? getDeepSeekRuntimeOptions(providerConfig)
      : selectedModel.providerId === 'bailian' ? getBailianRuntimeOptions(providerConfig) : null
    const providerOptions = baseProviderOptions ? { ...baseProviderOptions, enableWebSearch: false, maxOutputTokens: 4_096 } : undefined
    const providerRequest = {
      providerId: selectedModel.providerId,
      endpoint: selectedModel.endpoint || providerConfig.endpoint,
      endpointType: selectedModel.endpointType,
      apiKey: await getProviderSessionKey(selectedModel.providerId),
      model: selectedModel.apiModelId,
      options: providerOptions,
    }

    setKnowledgeAgentSession((current) => ({
      ...current,
      runId,
      cursor,
      runStatus: 'running',
      messages: [...current.messages, { id: `knowledge-user-${cursor}`, role: 'user', text: prompt }],
    }))

    try {
      const output = await executeKnowledgeReadRun({
        toolId: descriptor.toolId,
        requestId,
        sessionId,
        runId,
        context: currentContext,
        input,
        model: selectedModel.apiModelId,
        signal,
        executeRun: (runOptions) => executeResearchRun({
          ...runOptions,
          execution: {
            kind: 'provider',
            ...providerRequest,
            messages: runOptions.messages,
            tools: [],
            knowledgeRead: runOptions.knowledgeReadRequest,
          },
        }),
      })
      const text = requireCompletedKnowledgeReadText(output)
      setKnowledgeAgentSession((current) => ({
        ...current,
        runId,
        runStatus: 'completed',
        messages: [...current.messages, { id: `knowledge-assistant-${cursor}`, role: 'assistant', text }],
      }))
      return {
        text,
        aiProvenance: {
          providerId: selectedModel.providerId,
          modelId: selectedModel.apiModelId,
          generatedAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      setKnowledgeAgentSession((current) => ({
        ...current,
        runId,
        runStatus: error?.name === 'AbortError' ? 'cancelled' : 'failed',
        messages: [...current.messages, {
          id: `knowledge-assistant-${cursor}`,
          role: 'assistant',
          text: error?.name === 'AbortError' ? 'Knowledge Read was cancelled. No changes were made.' : `Knowledge Read failed: ${error?.message || 'No completed result was returned.'}`,
        }],
      }))
      throw error
    }
  }, [knowledgeAgentSession, providerConfigs, runtimeCapabilities, selectedModel, supportsLoopbackResearchExecution])

  const handleKnowledgeAction = useCallback((descriptor, options = {}) => {
    if (!descriptor?.available) return
    const prompt = options.prompt || `${descriptor.title} the current note.`
    if (['knowledge.query', 'knowledge.explain'].includes(descriptor.toolId)) {
      return executeKnowledgeRead(descriptor, prompt, options.context, options.signal)
        .then((result) => options.includeProvenance ? result : result.text)
    }
    if (descriptor.effect === 'read') return
    const currentContext = knowledgeAgentSession.context
    if (!currentContext?.activeNote) return
    const targetScope = options.targetScope || `${currentContext.vault.name} / ${currentContext.activeNote.path}`
    const idempotencyKey = options.idempotencyKey || `${knowledgeAgentSession.sessionId}:${descriptor.toolId}:${knowledgeAgentSession.cursor + 1}`
    knowledgeApprovalCallbackRef.current = options.onApproved || null
    knowledgeApprovalDeclineCallbackRef.current = options.onDeclined || null
    setKnowledgeApproval({
      toolId: descriptor.toolId,
      actionTitle: options.actionTitle || descriptor.title,
      targetScope,
      idempotencyKey,
      prompt,
      payload: options.payload || null,
      approvalDetails: options.approvalDetails || null,
      declinedMessage: options.declinedMessage || null,
    })
    setKnowledgeAgentSession((current) => ({ ...current, runId: current.runId || `knowledge-run-${current.cursor + 1}`, runStatus: 'waiting-approval' }))
  }, [executeKnowledgeRead, knowledgeAgentSession])

  const resolveKnowledgeApproval = useCallback(async (approved) => {
    if (!knowledgeApproval || knowledgeApprovalResolvingRef.current) return
    knowledgeApprovalResolvingRef.current = true
    const callback = knowledgeApprovalCallbackRef.current
    const declineCallback = knowledgeApprovalDeclineCallbackRef.current
    knowledgeApprovalCallbackRef.current = null
    knowledgeApprovalDeclineCallbackRef.current = null
    let completed = approved
    let failureMessage = ''
    if (approved) {
      try {
        await callback?.()
      } catch (error) {
        completed = false
        failureMessage = error?.message || 'The approved write failed.'
      }
    } else {
      try {
        await declineCallback?.()
      } catch (error) {
        failureMessage = error?.message || 'The cancellation callback failed.'
      }
    }
    setKnowledgeAgentSession((current) => {
      const cursor = current.cursor + 1
      return {
        ...current,
        cursor,
        runStatus: completed ? 'completed' : approved ? 'failed' : 'cancelled',
        messages: [
          ...current.messages,
          { id: `knowledge-user-${cursor}`, role: 'user', text: knowledgeApproval.prompt },
          { id: `knowledge-assistant-${cursor}`, role: 'assistant', text: completed ? `${knowledgeApproval.actionTitle} completed for ${knowledgeApproval.targetScope}.` : approved ? `${knowledgeApproval.actionTitle} failed: ${failureMessage}` : knowledgeApproval.declinedMessage || `${knowledgeApproval.actionTitle} was cancelled. No Vault changes were made.` },
        ],
      }
    })
    setKnowledgeApproval(null)
    knowledgeApprovalResolvingRef.current = false
  }, [knowledgeApproval])

  const submitKnowledgeQuestion = useCallback((question) => {
    const query = knowledgeToolDescriptors.find((descriptor) => descriptor.id === 'query')
    if (query?.available) void executeKnowledgeRead(query, question, knowledgeAgentSession.context).catch(() => {})
    setKnowledgeAgentInput('')
  }, [executeKnowledgeRead, knowledgeAgentSession.context, knowledgeToolDescriptors])

  const continueKnowledgeInResearch = useCallback(() => {
    const researchTabId = openWorkspaceTab('research')
    updateResearchSession(researchTabId, (session) => ({ ...session, phase: 'conversation', knowledgeCurator: true }))
  }, [openWorkspaceTab, updateResearchSession])

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
    const controller = new AbortController()
    requestAbortControllersRef.current.set(sessionId, controller)
    const useRemoteVector = Boolean(readyRetrievalIndex && modelConfig.remoteEmbeddingConsent === true)
    const packet = await retrieveHybridEvidence(question, {
      lexicalIndex: enabledTools.has(TOOL_IDS.VAULT_SEARCH) && hasVaultScope ? retrievalIndex : null,
      vectorIndex: enabledTools.has(TOOL_IDS.VAULT_SEARCH) && hasVaultScope && useRemoteVector ? readyRetrievalIndex : null,
      requestedIndexIdentity: enabledTools.has(TOOL_IDS.VAULT_SEARCH) && hasVaultScope ? retrievalIndexIdentity : null,
      runtime: retrievalRuntime,
      topK: modelConfig.topK,
      signal: controller.signal,
      useVector: useRemoteVector,
      useReranker: useRemoteVector && modelConfig.rerankModelId !== 'none',
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
    const configRunSnapshot = createRunSnapshot(session.configSnapshot, {
      resolvedModel: {
        ...modelReference(selectedModel),
        requestedModelId: session.configSnapshot?.model?.modelId || selectedModel.id,
      },
    })
    const runSnapshot = {
      ...configRunSnapshot,
      ...createResearchRunRecord({
        id: configRunSnapshot.id,
        sessionId,
        createdAt: configRunSnapshot.createdAt,
        model: configRunSnapshot.model,
        policy: configRunSnapshot.loopPolicy,
        evidenceCount: packet.evidence.length,
      }),
    }
    const conversationTitle = titleFromQuestion(question)
    setWorkspaceTabs((current) => current.map((tab) => tab.id === sessionId
      ? { ...tab, title: researchTabTitle(session.configSnapshot?.identity?.shortName || session.configSnapshot?.identity?.name, conversationTitle) }
      : tab))
    updateResearchSession(sessionId, (current) => ({
      ...current,
      conversationTitle,
      answerMode: live ? 'chatgpt' : 'retrieval-only',
      messages: [...current.messages, { id: `user-${Date.now()}`, role: 'user', text: question, evidenceContext, createdAt: new Date().toISOString() }],
      input: '',
      runSnapshots: [...(current.runSnapshots || []), live
        ? runSnapshot
        : applyResearchRunEvent(runSnapshot, { type: RESEARCH_RUN_EVENT.RUN_STARTED, runId: runSnapshot.id, iteration: 1 })],
    }))
    if (live) {
      const assistantId = `assistant-${Date.now()}`
      updateResearchSession(sessionId, (current) => ({
        ...current,
        runMode: 'live',
        activeStage: 3,
        running: true,
        messages: [...current.messages, { id: assistantId, runId: runSnapshot.id, role: 'assistant', text: '', reasoning: '', toolTrace: [], bullets: [], closing: '', evidence: packet.evidence, createdAt: new Date().toISOString() }],
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
        const handleRunEvent = (event) => {
          if (event.type === RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA) {
            streamedText += event.delta
            updateResearchSession(sessionId, { activeStage: 4 })
            if (!renderFrame) renderFrame = window.requestAnimationFrame(flushStreamedText)
          } else if (event.type === RESEARCH_RUN_EVENT.MODEL_REASONING_DELTA) {
            streamedReasoning += event.delta
            updateResearchSession(sessionId, { activeStage: 3 })
            if (!renderFrame) renderFrame = window.requestAnimationFrame(flushStreamedText)
          } else if (event.type === RESEARCH_RUN_EVENT.PROVIDER_EVENT && event.event === 'web_search.status') {
            updateResearchSession(sessionId, { activeStage: 2 })
          } else if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED) {
            updateResearchSession(sessionId, { activeStage: 2 })
          } else if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED) {
            updateResearchSession(sessionId, { activeStage: 3 })
          } else if (event.type === RESEARCH_RUN_EVENT.TOOL_ROUND_COMPLETED) {
            toolTrace.splice(0, toolTrace.length, ...(event.toolTrace || []))
            streamedText = ''
            updateResearchSession(sessionId, (current) => ({
              ...current,
              activeStage: 3,
              messages: current.messages.map((message) => message.id === assistantId ? { ...message, text: '', reasoning: streamedReasoning, toolTrace: [...toolTrace] } : message),
            }))
          }
          if (PERSISTED_RESEARCH_RUN_EVENTS.has(event.type)) {
            updateResearchSession(sessionId, (current) => ({
              ...current,
              runSnapshots: (current.runSnapshots || []).map((snapshot) => snapshot.id === runSnapshot.id
                ? applyResearchRunEvent(snapshot, event)
                : snapshot),
            }))
          }
        }
        let result
        let agentOutput
        let tools = []
        let request
        let execution
        if (apiProvider) {
          const providerConfig = providerConfigs[selectedModel.providerId]
          if (!providerConfig) throw new Error(`Provider configuration is missing for ${selectedModel.provider}.`)
          tools = selectedModel.capabilities?.tools ? researchToolRegistry.definitions : []
          const baseProviderOptions = selectedModel.providerId === 'deepseek'
            ? getDeepSeekRuntimeOptions(providerConfig)
            : selectedModel.providerId === 'bailian' ? getBailianRuntimeOptions(providerConfig) : null
          const providerOptions = baseProviderOptions ? {
            ...baseProviderOptions,
            enableWebSearch: enabledTools.has(TOOL_IDS.WEB_SEARCH) && baseProviderOptions.enableWebSearch,
            maxOutputTokens: 4_096,
          } : undefined
          const providerApiKey = await getProviderSessionKey(selectedModel.providerId)
          const providerRequest = {
              providerId: selectedModel.providerId,
              endpoint: selectedModel.endpoint || providerConfig.endpoint,
              endpointType: selectedModel.endpointType,
              apiKey: providerApiKey,
              model: selectedModel.apiModelId,
              tools,
              options: providerOptions,
          }
          if (supportsLoopbackResearchExecution) {
            execution = { kind: 'provider', ...providerRequest, messages }
          } else {
            request = (agentMessages, runtimeContext) => streamProviderResponse({
              ...providerRequest,
              messages: agentMessages,
              signal: controller.signal,
              onDelta: (delta) => runtimeContext.onEvent(RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, { delta }),
              onReasoningDelta: (delta) => runtimeContext.onEvent(RESEARCH_RUN_EVENT.MODEL_REASONING_DELTA, { delta }),
              onEvent: (event, payload) => runtimeContext.onEvent(RESEARCH_RUN_EVENT.PROVIDER_EVENT, { event, payload }),
            })
          }
        } else {
          let activeCatalog = modelCatalog
          if (selectedModel.id === 'smart-default' && !activeCatalog.defaultModelId) {
            activeCatalog = await refreshChatgptModels(false) || activeCatalog
          }
          const chatgptModel = selectedModel.id === 'smart-default' ? activeCatalog.defaultModelId : selectedModel.id
          request = (agentMessages, runtimeContext) => streamChatgptResponse({
            model: chatgptModel,
            messages: agentMessages,
            signal: controller.signal,
            onDelta: (delta) => runtimeContext.onEvent(RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, { delta }),
          })
        }
        agentOutput = await executeResearchRun({
          runId: runSnapshot.id,
          sessionId,
          model: runSnapshot.model,
          messages,
          tools,
          request,
          executeTool: tools.length ? (call) => researchToolRegistry.execute(call) : undefined,
          policy: session.configSnapshot?.loopPolicy,
          evidenceCount: packet.evidence.length,
          signal: controller.signal,
          onEvent: handleRunEvent,
          execution,
        })
        result = agentOutput.result
        if (renderFrame) window.cancelAnimationFrame(renderFrame)
        const usage = providerUsageSummary(result.usage)
        const contextLabel = `Context ${compactTokenCount(contextPlan.estimatedInputTokens)}/${compactTokenCount(contextPlan.inputBudgetTokens)}`
        const omittedLabel = contextPlan.omittedTurns ? ` - ${contextPlan.omittedTurns} older turn${contextPlan.omittedTurns === 1 ? '' : 's'} omitted` : ''
        const cacheLabel = apiProvider && selectedModel.providerId === 'deepseek' && usage && usage.hitTokens !== null
          ? ` - cache ${compactTokenCount(usage.hitTokens)} hit${usage.missTokens !== null ? ` / ${compactTokenCount(usage.missTokens)} miss` : ''}`
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
            closing: `Generated with ${result.model} through ${apiProvider ? selectedModel.provider : 'the connected ChatGPT subscription'} - ${agentOutput.iterations} model pass${agentOutput.iterations === 1 ? '' : 'es'} - ${packet.evidence.length} Vault evidence chunk${packet.evidence.length === 1 ? '' : 's'}${result.webSearchEvents?.length ? ' - hosted web search used' : ''}. ${contextLabel}${omittedLabel}${cacheLabel}.`,
          } : message),
        }))
      } catch (error) {
        if (renderFrame) window.cancelAnimationFrame(renderFrame)
        updateResearchSession(sessionId, (current) => ({
          ...current,
          activeStage: 5,
          runSnapshots: (current.runSnapshots || []).map((snapshot) => snapshot.id === runSnapshot.id
            ? applyResearchRunEvent(snapshot, {
              type: error.name === 'AbortError' ? RESEARCH_RUN_EVENT.RUN_CANCELLED : RESEARCH_RUN_EVENT.RUN_FAILED,
              runId: runSnapshot.id,
              error: { name: error.name || 'Error', message: error.message || 'Research run failed.' },
            })
            : snapshot),
          messages: current.messages.map((message) => message.id === assistantId ? {
            ...message,
            text: streamedText || message.text || (error.name === 'AbortError' ? 'Generation stopped.' : `The connected model could not complete this request: ${error.message}`),
            reasoning: streamedReasoning || message.reasoning,
            toolTrace: [...toolTrace],
            closing: error.name === 'AbortError' ? 'The partial response was kept.' : `Check the ${apiProvider ? `${selectedModel.provider} API configuration` : 'ChatGPT connection'} and try again.`,
          } : message),
        }))
      } finally {
        if (requestAbortControllersRef.current.get(sessionId) === controller) requestAbortControllersRef.current.delete(sessionId)
        updateResearchSession(sessionId, { running: false, runMode: 'mock' })
      }
      return
    }
    updateResearchSession(sessionId, (current) => ({
      ...current,
      runMode: 'mock',
      pendingQuestion: question,
      pendingRunId: runSnapshot.id,
      running: true,
      messages: [...current.messages, {
        id: `assistant-${Date.now()}`,
        runId: runSnapshot.id,
        role: 'assistant',
        text: '',
        reasoning: '',
        toolTrace: [],
        bullets: [],
        closing: '',
        evidence: packet.evidence,
        createdAt: new Date().toISOString(),
      }],
    }))
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
    requestAbortControllersRef.current.get(activeTabId)?.abort()
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

  const handleExportLocalData = async () => {
    const backup = createDataBackup({
      workspace: { tabs: workspaceTabs, activeTabId, sessions: researchSessions },
      modelConfig,
      providerConfigs,
      mcpConfig,
      pipelineRuns,
    }, { appVersion: runtimeManifest?.appVersion || '0.1.0' })
    const serialized = serializeDataBackup(backup)
    const date = backup.createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10)
    const fileName = `bioresearch-os-backup-${date}.json`
    return runtimeAdapter.dataFiles.saveBackup({ fileName, content: serialized })
  }

  const handleImportLocalData = async (serialized) => {
    if (dataActionBlocked) throw new Error('Stop the active research or Pipeline run before importing local data.')
    const backup = parseDataBackup(serialized)
    const { workspace, modelConfig: nextModelConfig, providerConfigs: nextProviderConfigs, mcpConfig: nextMcpConfig, pipelineRuns: nextPipelineRuns } = backup.data
    await saveWorkspaceSnapshot(workspace)
    saveModelConfig(nextModelConfig)
    saveProviderConfigs(nextProviderConfigs)
    const savedMcpConfig = saveMcpConfig(nextMcpConfig)
    savePipelineRuns(nextPipelineRuns)
    setWorkspaceTabs(workspace.tabs)
    setActiveTabId(workspace.activeTabId)
    setResearchSessions(workspace.sessions)
    setModelConfig(nextModelConfig)
    setProviderConfigs(nextProviderConfigs)
    setMcpConfig(savedMcpConfig)
    setPipelineRuns(nextPipelineRuns)
    setSelectedPipelineRunId(null)
    return createLocalDataSummary({ workspace, pipelineRuns: nextPipelineRuns, vaultNoteCount: vaultNotes.length })
  }

  const handleImportLocalDataFromDesktop = async () => {
    const selection = await runtimeAdapter.dataFiles.openBackup()
    if (selection.cancelled) return selection
    const summary = await handleImportLocalData(selection.content)
    return { ...summary, cancelled: false, fileName: selection.fileName }
  }

  const handleClearLocalHistory = async () => {
    if (dataActionBlocked) throw new Error('Stop the active research or Pipeline run before clearing local history.')
    const remainingTabs = workspaceTabs.filter((tab) => tab.kind !== 'research')
    const nextActiveTabId = remainingTabs.some((tab) => tab.id === activeTabId) ? activeTabId : remainingTabs[0]?.id || null
    const cleanWorkspace = createWorkspaceSnapshot({ tabs: remainingTabs, activeTabId: nextActiveTabId, sessions: {} })
    await clearWorkspaceSnapshot()
    await saveWorkspaceSnapshot(cleanWorkspace)
    savePipelineRuns([])
    setWorkspaceTabs(cleanWorkspace.tabs)
    setActiveTabId(cleanWorkspace.activeTabId)
    setResearchSessions({})
    setPipelineRuns([])
    setSelectedPipelineRunId(null)
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
        vaultFeedback={vaultFeedback}
        vaultSource={vaultSource}
        localAdapterState={localAdapterState}
        authStatus={authStatus}
        authBusy={authBusy}
        onConnectChatgpt={handleConnectChatgpt}
        onLogoutChatgpt={handleLogoutChatgpt}
        authError={authError}
      />
      <VaultFallbackPicker ref={vaultInputRef} enabled={supportsBrowserPickerVault} onSelect={handleVaultSelection} onCancel={handleVaultSelectionCancelled} onError={handleVaultSelectionError} />
      <main className="main-shell">
        <header className="topbar workspace-topbar">
          <WorkspaceTabs tabs={workspaceTabs} activeTabId={activeTabId} onSelect={handleSelectTab} onClose={handleCloseTab} onCreate={(kind) => openWorkspaceTab(kind, { forceNew: kind === 'research' || kind === 'graph' })} />
          <div className="topbar-actions"><button className="icon-button mobile-settings-button" onClick={() => handleOpenSection('settings')} aria-label="Open settings"><Settings2 size={18} /></button></div>
        </header>

        {activeSection === 'launcher' ? <WorkspaceLauncher onOpen={openWorkspaceTab} /> : activeSection === 'settings' ? <SettingsWorkspace key={`settings-${providerCredentialsRevision}`} authStatus={authStatus} authBusy={authBusy} authError={authError} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnectChatgpt={handleConnectChatgpt} onLogoutChatgpt={handleLogoutChatgpt} onRefreshModels={refreshChatgptModels} chatModels={chatModels} retrievalModels={retrievalModels} modelConfig={modelConfig} onSaveModelConfig={handleSettingsSave} retrievalIndexLifecycle={retrievalIndexLifecycle} onBuildRetrievalIndex={() => startRetrievalIndexBuild(false)} onCancelRetrievalIndex={cancelRetrievalIndexBuild} onRebuildRetrievalIndex={() => startRetrievalIndexBuild(true)} onRefreshRetrievalIndex={() => refreshRetrievalIndex({ forceStatus: true })} providerConfigs={providerConfigs} onSaveProviderConfigs={handleProviderConfigsSave} mcpConfig={mcpConfig} onSaveMcpConfig={handleMcpConfigSave} mcpRuntime={mcpRuntime} mcpRuntimeBusy={mcpRuntimeBusy} mcpRuntimeError={mcpRuntimeError} onConnectMcpServer={handleConnectMcpServer} onDisconnectMcpServer={handleDisconnectMcpServer} vaultNoteCount={vaultNotes.length} dataSummary={localDataSummary} dataActionBlocked={dataActionBlocked} runtimeTarget={runtimeManifest?.target} useNativeDataFiles={supportsDesktopDataFiles} onExportData={handleExportLocalData} onImportData={handleImportLocalData} onImportDataFromDesktop={handleImportLocalDataFromDesktop} onClearHistory={handleClearLocalHistory} /> : activeSection === 'graph' ? <KnowledgeGraphSection
          key={activeTabId}
          index={vaultIndex}
          onConnectVault={handleConnectVault}
          vaultId={vaultCapabilityId || vaultName}
          vaultName={vaultName}
          vaultRevision={localRevision}
          knowledgeSession={knowledgeAgentSession}
          knowledgeInput={knowledgeAgentInput}
          onKnowledgeInput={setKnowledgeAgentInput}
          knowledgeToolDescriptors={knowledgeToolDescriptors}
          knowledgeApproval={knowledgeApproval}
          onKnowledgeAction={handleKnowledgeAction}
          onKnowledgeSubmit={submitKnowledgeQuestion}
          onResolveKnowledgeApproval={resolveKnowledgeApproval}
          onContinueInResearch={continueKnowledgeInResearch}
          onKnowledgeContextChange={handleKnowledgeContextChange}
          annotationRuntime={runtimeAdapter.annotations}
          actionRuntime={runtimeAdapter.actions}
          provider={selectedModel ? {
            providerId: selectedModel.providerId || selectedModel.authProvider || 'unknown',
            providerName: selectedModel.provider || selectedModel.authProvider || 'Provider',
            modelId: selectedModel.apiModelId || selectedModel.id,
            modelName: selectedModel.name || selectedModel.apiModelId || selectedModel.id,
          } : null}
          onOpenSettings={() => handleOpenSection('settings')}
        /> : activeSection === 'pipelines' ? (
          <PipelinesSection vaultName={vaultName} noteCount={vaultNotes.length} runs={pipelineRuns} runningPipelineId={pipelineRunningId} onRun={handleRunPipeline} onViewRun={handleViewPipelineRun} onConnectVault={handleConnectVault} />
        ) : activeSection === 'runs' ? (
          <RunsSection runs={pipelineRuns} selectedRunId={selectedPipelineRunId} onSelectRun={setSelectedPipelineRunId} />
        ) : (
          <ResearchWorkspace
            phase={phase}
            knowledgePanelProps={activeResearchSession.knowledgeCurator ? { session: knowledgeAgentSession, contextSummary: knowledgeAgentSession.context, descriptors: knowledgeToolDescriptors, input: knowledgeAgentInput, onInput: setKnowledgeAgentInput, onSubmit: submitKnowledgeQuestion, onAction: handleKnowledgeAction, approval: knowledgeApproval, onResolveApproval: resolveKnowledgeApproval, disabled: !knowledgeAgentSession.context } : null}
            setupProps={{ config: activeResearchSession.configSnapshot, selectedModel, models: chatModels, vaultName, vaultNoteCount: vaultNotes.length, vaultSyncState: syncState, mcpConnected: mcpRuntime.sessions.length > 0, authStatus, authBusy, modelCatalog, modelsBusy, onSelectAgent: handleSelectAgent, onUpdateIdentity: handleUpdateAgentIdentity, onUpdateSystemPrompt: handleUpdateAgentSystemPrompt, onResetSystemPrompt: handleResetAgentSystemPrompt, onSelectModel: handleModelSelect, onSelectVault: handleSelectResearchVault, onToggleTool: handleToggleResearchTool, onConnectVault: handleConnectVault, onConnectChatgpt: handleConnectChatgpt, onLogoutChatgpt: handleLogoutChatgpt, onRefreshModels: refreshChatgptModels, onStart: handleStartResearch }}
             conversationProps={{ config: activeResearchSession.configSnapshot, selectedModel, vaultName: activeHasVaultScope ? vaultName : '', mcpConnected: mcpRuntime.sessions.length > 0, canEdit: messages.length === 0, onEdit: handleEditResearchSetup, messages, running, activeStage, retrievalPacket, input, setInput, onSubmit: submitQuestion, disabled: anyResearchRunning, models: chatModels, authStatus, authBusy, modelCatalog, modelsBusy, onSelectModel: handleModelSelect, onConnectChatgpt: handleConnectChatgpt, onLogoutChatgpt: handleLogoutChatgpt, onRefreshModels: refreshChatgptModels, onOpenNote: setSelectedNote, linkedNotes: inspectorNotes, sources: inspectorSources, topK: modelConfig.topK, embeddingLabel, rerankLabel, retrievalIndexState, retrievalIndexLifecycle, answerMode, runStatus, wikilinksEnabled: activeHasVaultScope && activeResearchSession.configSnapshot?.enabledTools?.includes(TOOL_IDS.VAULT_WIKILINKS), onPause: handlePause }}
            note={selectedNote}
            onCloseNote={() => setSelectedNote(null)}
            approval={pendingToolApproval}
            onResolveApproval={resolveToolApproval}
          />
        )}
      </main>
    </div>
  )
}

export default App

createRoot(document.getElementById('root')).render(<App />)
