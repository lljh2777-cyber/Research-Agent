import { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  BookOpen,
  Boxes,
  CalendarClock,
  CheckCircle2,
  Cloud,
  Code2,
  Cpu,
  Database,
  Eye,
  EyeOff,
  FileText,
  HardDrive,
  Info,
  Keyboard,
  KeyRound,
  ListFilter,
  Network,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  ScanText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react'

import { DEFAULT_MODEL_CONFIG, getModelsByRole } from './modelConfig.js'
import {
  DEEPSEEK_ENDPOINT_PROFILES,
  DEEPSEEK_ENDPOINT_TYPES,
  withDeepSeekModelProfile,
} from '../shared/deepseek-provider.mjs'
import {
  BAILIAN_ENDPOINT_PROFILES,
  BAILIAN_ENDPOINT_TYPES,
  BAILIAN_REGIONS,
  getBailianRegionalEndpoints,
  withBailianModelProfile,
} from '../shared/bailian-provider.mjs'
import {
  fetchProviderModels,
  loadProviderSessionKeys,
  PROVIDER_PRESETS,
  saveProviderSessionKeys,
} from './providerConfig.js'
import { createMcpServer, MCP_TRANSPORTS } from './mcpConfig.js'

const SETTINGS_GROUPS = [
  {
    label: '模型',
    items: [
      { id: 'subscription', label: '订阅登录', icon: Sparkles },
      { id: 'providers', label: 'API Providers', icon: Cloud },
      { id: 'defaults', label: '默认模型', icon: Boxes },
      { id: 'local-models', label: '本地模型', icon: Cpu },
    ],
  },
  {
    label: '研究工具',
    items: [
      { id: 'mcp', label: 'MCP', icon: Plug },
      { id: 'skills', label: 'Skills', icon: Wrench },
      { id: 'web-search', label: '网络与文献搜索', icon: Search },
      { id: 'documents', label: '文档处理', icon: FileText },
      { id: 'ocr', label: 'OCR', icon: ScanText },
    ],
  },
  {
    label: '知识与数据',
    items: [
      { id: 'vault', label: 'Vault', icon: BookOpen },
      { id: 'retrieval', label: '检索与索引', icon: Database },
      { id: 'data', label: '数据管理', icon: HardDrive },
      { id: 'usage', label: '用量统计', icon: Network },
    ],
  },
  {
    label: '偏好',
    items: [
      { id: 'appearance', label: '外观', icon: Palette },
      { id: 'notifications', label: '通知', icon: Bell },
      { id: 'shortcuts', label: '快捷键', icon: Keyboard },
    ],
  },
  {
    label: '系统',
    items: [
      { id: 'automation', label: '自动化与定时任务', icon: CalendarClock },
      { id: 'runtime', label: '运行环境', icon: Code2 },
      { id: 'system', label: '系统与诊断', icon: Settings2 },
      { id: 'about', label: '关于', icon: Info },
    ],
  },
]

const PROVIDER_ICONS = { openai: Sparkles, anthropic: Network, gemini: Sparkles, deepseek: Search, bailian: Cloud, openrouter: Network, compatible: Code2 }
const API_PROVIDERS = PROVIDER_PRESETS.map((provider) => ({ ...provider, icon: PROVIDER_ICONS[provider.id] || Cloud }))

const FEATURE_PREVIEWS = {
  mcp: ['MCP', 'Connect research databases, filesystems, and analysis tools through local or remote MCP servers.', ['Server registry', 'Tool permission review', 'Connection health']],
  skills: ['Skills', 'Install reusable research workflows for literature review, bioinformatics, and report generation.', ['Skill catalog', 'Per-agent enablement', 'Local skill folders']],
  'web-search': ['网络与文献搜索', 'Configure literature and general web discovery independently from the answer model.', ['PubMed and Crossref', 'General web search', 'Source allowlists']],
  documents: ['文档处理', 'Choose parsers for Markdown, PDF, Office documents, tables, and structured scientific files.', ['Parser routing', 'File type rules', 'Extraction diagnostics']],
  ocr: ['OCR', 'Configure vision and OCR processing for scanned papers, figures, and supplementary files.', ['OCR engine', 'Vision fallback', 'Language detection']],
  vault: ['Vault', 'Manage connected Obsidian Vaults, synchronization, indexing scope, and excluded paths.', ['Connected folders', 'Auto sync', 'Exclusion rules']],
  data: ['数据管理', 'Inspect local storage, export settings, and prepare future encrypted backups.', ['Local storage', 'Export and restore', 'Cache cleanup']],
  usage: ['用量统计', 'Track requests and estimated model usage without mixing it into provider credentials.', ['Requests by model', 'Latency and failures', 'Cost estimates']],
  appearance: ['外观', 'Control theme, interface density, typography, and sidebar behavior.', ['Theme', 'Density', 'Editor typography']],
  notifications: ['通知', 'Choose which long-running research jobs may send completion or failure notifications.', ['Pipeline completion', 'Indexing failures', 'Scheduled reports']],
  shortcuts: ['快捷键', 'Define keyboard shortcuts for navigation, search, new research sessions, and command actions.', ['Global search', 'New research session', 'Command palette']],
  automation: ['自动化与定时任务', 'Schedule recurring literature searches, Vault audits, and research briefings.', ['Schedules', 'Run history', 'Failure policy']],
  runtime: ['运行环境', 'Inspect local Python, R, Node.js, Ollama, and analysis-tool availability.', ['Runtime detection', 'Package health', 'Working directories']],
  system: ['系统与诊断', 'Review application health, logs, privacy controls, and local-service connectivity.', ['Health checks', 'Diagnostic logs', 'Privacy controls']],
  about: ['关于', 'BioResearch OS is an AGPL-3.0 local-first research workspace.', ['Version information', 'Open-source licenses', 'Update channel']],
}

function SettingsPageHeader({ eyebrow, title, description, children }) {
  return <header className="settings-page-header">
    <div><span>{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>
    {children && <div className="settings-page-actions">{children}</div>}
  </header>
}

function SubscriptionPage({ authStatus, authBusy, authError, modelCatalog, modelsBusy, onConnect, onLogout, onRefreshModels }) {
  const models = modelCatalog?.models || []
  return <div className="settings-page">
    <SettingsPageHeader eyebrow="Model access" title="订阅登录" description="Use an existing AI subscription without mixing account authentication with API Provider credentials." />
    <section className={`subscription-card ${authStatus?.connected ? 'connected' : ''}`}>
      <div className="subscription-brand"><span><Sparkles size={20} /></span><div><strong>ChatGPT</strong><small>当前唯一支持的订阅登录方式</small></div></div>
      <div className="subscription-status"><i /><span>{authStatus?.connected ? `Connected${authStatus.planType ? ` · ${authStatus.planType}` : ''}` : authStatus?.unavailable ? 'Local service offline' : authStatus?.pending ? 'Waiting for browser login' : 'Not connected'}</span></div>
      <p>登录凭据由本地认证服务处理。Research Agent 只在执行所选任务时发送必要的提示和 Vault 证据。</p>
      <div className="subscription-actions">
        {authStatus?.connected
          ? <><button className="settings-secondary-button" onClick={() => onRefreshModels(true)} disabled={modelsBusy}><RefreshCw className={modelsBusy ? 'spin' : ''} size={14} /> Refresh models</button><button className="settings-danger-button" onClick={onLogout}>Sign out</button></>
          : <button className="settings-primary-button" onClick={onConnect} disabled={authBusy}>{authBusy ? 'Waiting for login…' : authStatus?.unavailable ? 'Retry local service' : 'Connect ChatGPT'}</button>}
      </div>
      {authError && <div className="settings-inline-error" role="alert">{authError}</div>}
      <div className="settings-security-note">Official Codex OAuth · PKCE localhost callback · credentials stored in the OS keyring</div>
    </section>

    <section className="settings-section-block">
      <div className="settings-section-heading"><div><h3>Discovered models</h3><p>Models are read from the connected account instead of being hard-coded in the app.</p></div><span>{models.length} available</span></div>
      {models.length ? <div className="discovered-model-list">{models.slice(0, 10).map((model) => <div key={model.id}><span><CheckCircle2 size={13} /><strong>{model.name || model.id}</strong></span><small>{model.id}</small></div>)}</div> : <div className="settings-empty-state"><Cloud size={22} /><strong>No account model catalog</strong><span>Connect ChatGPT to discover the models available to this account.</span></div>}
    </section>
  </div>
}

function ProviderNavigation({ query, onQueryChange, selectedId, onSelect, configs }) {
  const filteredProviders = useMemo(() => API_PROVIDERS.filter((provider) => `${provider.name} ${provider.protocol}`.toLowerCase().includes(query.trim().toLowerCase())), [query])
  return <aside className="settings-secondary-navigation" aria-label="API provider navigation">
    <div className="settings-secondary-search">
      <label className="settings-search"><Search size={15} /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search providers…" /></label>
      <button aria-label="Clear provider search" title="Clear provider search" onClick={() => onQueryChange('')} disabled={!query}><ListFilter size={15} /></button>
    </div>
    <div className="provider-list">
      {filteredProviders.map((provider) => {
        const Icon = provider.icon
        return <button className={provider.id === selectedId ? 'active' : ''} onClick={() => onSelect(provider.id)} key={provider.id}>
          <span className={`provider-icon ${provider.tone}`}><Icon size={15} /></span>
          <div><strong>{provider.name}</strong><small>{provider.protocol}</small></div>
          <i className={configs?.[provider.id]?.enabled ? 'enabled' : ''} aria-hidden="true" />
        </button>
      })}
      {!filteredProviders.length && <div className="provider-list-empty">No matching providers</div>}
    </div>
    <button className="provider-add-button" onClick={() => { onQueryChange(''); onSelect('compatible') }}><Plus size={15} />Add provider</button>
  </aside>
}

function DeepSeekEndpointSettings({ config, onUpdate }) {
  const profiles = Object.values(DEEPSEEK_ENDPOINT_PROFILES)
  const updateEndpoint = (endpointType, patch) => {
    const endpoints = {
      ...config.endpoints,
      [endpointType]: { ...config.endpoints[endpointType], ...patch },
    }
    onUpdate({
      endpoints,
      ...(endpointType === DEEPSEEK_ENDPOINT_TYPES.CHAT && patch.baseUrl ? { endpoint: patch.baseUrl } : {}),
      ...(patch.enabled === false && config.defaultEndpointType === endpointType ? { defaultEndpointType: 'auto' } : {}),
    })
  }
  return <section className="deepseek-endpoint-section">
    <div className="deepseek-endpoint-heading">
      <div><span>Request routing</span><h3>DeepSeek interfaces</h3><p>Keep one credential and choose how each model reaches DeepSeek. Auto mode respects the model endpoint matrix.</p></div>
      <button className={config.defaultEndpointType === 'auto' ? 'active' : ''} aria-pressed={config.defaultEndpointType === 'auto'} onClick={() => onUpdate({ defaultEndpointType: 'auto' })}><Sparkles size={14} /><span><strong>Auto route</strong><small>Recommended</small></span></button>
    </div>
    <div className="deepseek-endpoint-list">
      {profiles.map((profile) => {
        const endpoint = config.endpoints[profile.id]
        const isDefault = config.defaultEndpointType === profile.id
        return <article className={`${endpoint.enabled ? 'enabled' : 'disabled'} ${isDefault ? 'default' : ''}`} key={profile.id}>
          <header><span><Network size={15} /></span><div><strong>{profile.label}</strong><small>{profile.description}</small></div><i>{profile.maturity}</i></header>
          <div className="deepseek-endpoint-controls">
            <input value={endpoint.baseUrl} onChange={(event) => updateEndpoint(profile.id, { baseUrl: event.target.value })} aria-label={`${profile.label} base URL`} spellCheck="false" />
            <button className="settings-secondary-button" onClick={() => updateEndpoint(profile.id, { baseUrl: profile.defaultBaseUrl })} disabled={endpoint.baseUrl === profile.defaultBaseUrl}>Reset</button>
          </div>
          <footer>
            <label><input type="checkbox" checked={endpoint.enabled} onChange={(event) => updateEndpoint(profile.id, { enabled: event.target.checked })} /><span>{endpoint.enabled ? 'Enabled' : 'Disabled'}</span></label>
            <code>/{profile.route}</code>
            <button className={isDefault ? 'active' : ''} aria-pressed={isDefault} onClick={() => onUpdate({ defaultEndpointType: profile.id })} disabled={!endpoint.enabled}>{isDefault ? 'Default' : profile.id === DEEPSEEK_ENDPOINT_TYPES.RESPONSES ? 'Use manually' : 'Set as default'}</button>
          </footer>
        </article>
      })}
    </div>
  </section>
}

function DeepSeekThinkingSettings({ config, onUpdate }) {
  const modes = [
    ['auto', 'Auto', 'Use the model default'],
    ['enabled', 'On', 'Always return reasoning'],
    ['disabled', 'Off', 'Answer without reasoning'],
  ]
  const efforts = [
    ['auto', 'Auto'],
    ['low', 'Low'],
    ['high', 'High'],
    ['max', 'Max'],
  ]
  return <section className="deepseek-thinking-section">
    <div className="deepseek-thinking-copy">
      <span>Reasoning control</span>
      <h3>Thinking mode</h3>
      <p>Applied to DeepSeek Chat, Responses, and Anthropic requests with protocol-specific parameters. Sampling controls are omitted while thinking is active.</p>
    </div>
    <fieldset>
      <legend>Mode</legend>
      <div className="deepseek-segmented-control">
        {modes.map(([value, label, detail]) => <button type="button" className={config.thinkingMode === value ? 'active' : ''} aria-pressed={config.thinkingMode === value} onClick={() => onUpdate({ thinkingMode: value })} key={value}><strong>{label}</strong><small>{detail}</small></button>)}
      </div>
    </fieldset>
    <fieldset>
      <legend>Reasoning effort</legend>
      <div className="deepseek-effort-control">
        {efforts.map(([value, label]) => <button type="button" className={config.reasoningEffort === value ? 'active' : ''} aria-pressed={config.reasoningEffort === value} onClick={() => onUpdate({ reasoningEffort: value })} disabled={config.thinkingMode === 'disabled'} key={value}>{label}</button>)}
      </div>
      <small>DeepSeek maps effort by model; V4 Pro may promote Low to High. Auto keeps the provider default.</small>
    </fieldset>
  </section>
}

function BailianEndpointSettings({ config, onUpdate }) {
  const updateEndpoint = (endpointType, patch) => onUpdate({
    endpoints: { ...config.endpoints, [endpointType]: { ...config.endpoints[endpointType], ...patch } },
    ...(endpointType === BAILIAN_ENDPOINT_TYPES.OPENAI && patch.baseUrl ? { endpoint: patch.baseUrl } : {}),
    ...(patch.enabled === false && config.defaultEndpointType === endpointType ? { defaultEndpointType: 'auto' } : {}),
  })
  const applyRegionalEndpoints = () => {
    const regional = getBailianRegionalEndpoints(config.region, config.workspaceId)
    if (!regional) return
    onUpdate({
      endpoints: Object.fromEntries(Object.entries(config.endpoints).map(([type, endpoint]) => [type, { ...endpoint, baseUrl: regional[type] }])),
      endpoint: regional[BAILIAN_ENDPOINT_TYPES.OPENAI],
    })
  }
  const regionNeedsWorkspace = BAILIAN_REGIONS[config.region]?.requiresWorkspace
  const regionalReady = !regionNeedsWorkspace || Boolean(config.workspaceId.trim())
  return <section className="deepseek-endpoint-section">
    <div className="deepseek-endpoint-heading">
      <div><span>Request routing</span><h3>Model Studio interfaces</h3><p>Use DashScope for native Qwen capabilities or the OpenAI-compatible interface for portable Agent integrations. API keys and endpoints must belong to the same region.</p></div>
      <button className={config.defaultEndpointType === 'auto' ? 'active' : ''} aria-pressed={config.defaultEndpointType === 'auto'} onClick={() => onUpdate({ defaultEndpointType: 'auto' })}><Sparkles size={14} /><span><strong>Auto route</strong><small>Native first</small></span></button>
    </div>
    <div className="bailian-region-controls">
      <label><span>Region</span><select value={config.region} onChange={(event) => onUpdate({ region: event.target.value })}>{Object.values(BAILIAN_REGIONS).map((region) => <option value={region.id} key={region.id}>{region.label}</option>)}</select></label>
      <label><span>Workspace ID</span><input value={config.workspaceId} onChange={(event) => onUpdate({ workspaceId: event.target.value.trim() })} placeholder={config.region === 'us-east-1' ? 'Not required in this region' : 'Required for workspace endpoint'} spellCheck="false" /></label>
      <button className="settings-secondary-button" onClick={applyRegionalEndpoints} disabled={!regionalReady}>Apply regional endpoints</button>
      <small>{regionNeedsWorkspace && !regionalReady ? 'This region requires a Workspace ID.' : 'Workspace domains are recommended for lower latency and higher stability.'}</small>
    </div>
    <div className="deepseek-endpoint-list bailian-endpoint-list">
      {Object.values(BAILIAN_ENDPOINT_PROFILES).map((profile) => {
        const endpoint = config.endpoints[profile.id]
        const isDefault = config.defaultEndpointType === profile.id
        return <article className={`${endpoint.enabled ? 'enabled' : 'disabled'} ${isDefault ? 'default' : ''}`} key={profile.id}>
          <header><span><Network size={15} /></span><div><strong>{profile.label}</strong><small>{profile.description}</small></div><i>{profile.id === BAILIAN_ENDPOINT_TYPES.DASHSCOPE ? 'native' : 'compatible'}</i></header>
          <div className="deepseek-endpoint-controls"><input value={endpoint.baseUrl} onChange={(event) => updateEndpoint(profile.id, { baseUrl: event.target.value })} aria-label={`${profile.label} base URL`} spellCheck="false" /><button className="settings-secondary-button" onClick={() => updateEndpoint(profile.id, { baseUrl: profile.defaultBaseUrl })} disabled={endpoint.baseUrl === profile.defaultBaseUrl}>Reset</button></div>
          <footer><label><input type="checkbox" checked={endpoint.enabled} onChange={(event) => updateEndpoint(profile.id, { enabled: event.target.checked })} /><span>{endpoint.enabled ? 'Enabled' : 'Disabled'}</span></label><code>/{profile.route}</code><button className={isDefault ? 'active' : ''} aria-pressed={isDefault} onClick={() => onUpdate({ defaultEndpointType: profile.id })} disabled={!endpoint.enabled}>{isDefault ? 'Default' : 'Set as default'}</button></footer>
        </article>
      })}
    </div>
  </section>
}

function BailianThinkingSettings({ config, onUpdate }) {
  return <section className="deepseek-thinking-section">
    <div className="deepseek-thinking-copy"><span>Qwen controls</span><h3>Thinking and built-in search</h3><p>Hybrid-thinking Qwen models stream reasoning separately from the final answer. Responses uses reasoning effort; other interfaces use thinking mode and budget.</p></div>
    <fieldset><legend>Thinking mode</legend><div className="deepseek-segmented-control">{[
      ['auto', 'Auto', 'Use model default'], ['enabled', 'On', 'Stream reasoning'], ['disabled', 'Off', 'Direct answer'],
    ].map(([value, label, detail]) => <button type="button" className={config.thinkingMode === value ? 'active' : ''} aria-pressed={config.thinkingMode === value} onClick={() => onUpdate({ thinkingMode: value })} key={value}><strong>{label}</strong><small>{detail}</small></button>)}</div></fieldset>
    <fieldset><legend>Thinking budget and Responses effort</legend><div className="bailian-thinking-budget"><input type="number" min="1" max="65536" value={config.thinkingBudget} disabled={config.thinkingMode !== 'enabled'} onChange={(event) => onUpdate({ thinkingBudget: Math.max(1, Math.min(65536, Number(event.target.value) || 8192)) })} /><span>tokens</span></div><select value={config.reasoningEffort} onChange={(event) => onUpdate({ reasoningEffort: event.target.value })} aria-label="Bailian Responses reasoning effort"><option value="auto">Responses effort: provider default</option>{['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => <option value={effort} key={effort}>{`Responses effort: ${effort}`}</option>)}</select></fieldset>
    <fieldset><legend>Provider extensions</legend><label className="bailian-search-toggle"><input type="checkbox" checked={config.enableWebSearch} onChange={(event) => onUpdate({ enableWebSearch: event.target.checked })} />Enable built-in web search</label>{config.enableWebSearch && <><select value={config.searchStrategy} onChange={(event) => onUpdate({ searchStrategy: event.target.value })} aria-label="Bailian web search strategy">{['turbo', 'max', 'agent', 'agent_max'].map((strategy) => <option value={strategy} key={strategy}>{strategy}</option>)}</select><label className="bailian-search-toggle"><input type="checkbox" checked={config.returnSearchSources} onChange={(event) => onUpdate({ returnSearchSources: event.target.checked })} />Return sources and inline citations</label></>}<label className="bailian-search-toggle"><input type="checkbox" checked={config.enableSessionCache} onChange={(event) => onUpdate({ enableSessionCache: event.target.checked })} />Enable Responses session cache header</label><label className="bailian-search-toggle"><input type="checkbox" checked={config.storeResponses} onChange={(event) => onUpdate({ storeResponses: event.target.checked })} />Store Responses for retrievable IDs (7 days)</label></fieldset>
  </section>
}

function ProvidersPage({ selectedId, configs, onChange }) {
  const selected = API_PROVIDERS.find((provider) => provider.id === selectedId) || API_PROVIDERS[0]
  const SelectedIcon = selected.icon
  const config = configs[selected.id]
  const [apiKeys, setApiKeys] = useState(loadProviderSessionKeys)
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelsBusy, setModelsBusy] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [modelQuery, setModelQuery] = useState('')
  const [manualModelId, setManualModelId] = useState('')
  const [showManualModel, setShowManualModel] = useState(false)
  const apiKey = apiKeys[selected.id] || ''
  const selectedIds = new Set(config.selectedModelIds)
  const filteredModels = useMemo(
    () => config.models.filter((model) => `${model.name} ${model.id} ${model.kind}`.toLowerCase().includes(modelQuery.trim().toLowerCase())),
    [config.models, modelQuery],
  )

  useEffect(() => {
    setShowApiKey(false)
    setFeedback(null)
    setModelQuery('')
    setShowManualModel(false)
    setManualModelId('')
  }, [selected.id])

  const updateConfig = (patch) => onChange({
    ...configs,
    [selected.id]: { ...config, ...patch },
  })

  const updateApiKey = (value) => {
    const next = { ...apiKeys, [selected.id]: value }
    setApiKeys(next)
    saveProviderSessionKeys(next)
    setFeedback(null)
  }

  const handleFetchModels = async (purpose = 'fetch') => {
    const discoveryEndpoint = selected.id === 'deepseek'
      ? config.endpoints[DEEPSEEK_ENDPOINT_TYPES.CHAT].baseUrl
      : selected.id === 'bailian' ? config.endpoints[BAILIAN_ENDPOINT_TYPES.OPENAI].baseUrl : config.endpoint
    if (!discoveryEndpoint.trim()) {
      setFeedback({ type: 'error', message: 'Enter an API endpoint first.' })
      return
    }
    if (selected.requiresKey && !apiKey.trim()) {
      setFeedback({ type: 'error', message: 'Enter an API key before fetching models.' })
      return
    }
    setModelsBusy(true)
    setFeedback(null)
    try {
      const result = await fetchProviderModels({ providerId: selected.id, endpoint: discoveryEndpoint, apiKey })
      const manualModels = config.models.filter((model) => model.manual && !result.models.some((remote) => remote.id === model.id))
      const nextModels = [...result.models, ...manualModels]
      const nextIds = new Set(nextModels.map((model) => model.id))
      const nextSelectedModelIds = config.selectedModelIds.filter((id) => nextIds.has(id))
      updateConfig({
        models: nextModels,
        selectedModelIds: nextSelectedModelIds,
        enabled: config.enabled && nextSelectedModelIds.length > 0,
        lastFetchedAt: result.fetchedAt,
      })
      setFeedback({
        type: 'success',
        message: purpose === 'verify'
          ? result.catalogSource === 'official-fallback'
            ? `Endpoint reached but does not expose a model-list route. Loaded ${result.models.length} official Qwen3.5 profiles; the API key will be validated on the first request.`
            : `Connection verified. ${result.models.length} models are available.`
          : result.catalogSource === 'official-fallback'
            ? `Loaded ${result.models.length} official Qwen3.5 profiles because this endpoint does not expose a model catalog.`
            : `Fetched ${result.models.length} models from ${selected.name}.`,
      })
    } catch (error) {
      setFeedback({ type: 'error', message: error.message || 'Could not fetch the model list.' })
    } finally {
      setModelsBusy(false)
    }
  }

  const toggleModel = (modelId) => {
    const removing = selectedIds.has(modelId)
    const nextSelected = removing
      ? config.selectedModelIds.filter((id) => id !== modelId)
      : [...config.selectedModelIds, modelId]
    updateConfig({ selectedModelIds: nextSelected, enabled: nextSelected.length ? (removing ? config.enabled : true) : false })
  }

  const selectAllChatModels = () => {
    const chatIds = config.models.filter((model) => model.kind === 'chat').map((model) => model.id)
    const nextSelected = [...new Set([...config.selectedModelIds, ...chatIds])]
    updateConfig({ selectedModelIds: nextSelected, enabled: nextSelected.length ? true : config.enabled })
  }

  const addManualModel = () => {
    const id = manualModelId.trim()
    if (!id) return
    if (config.models.some((model) => model.id === id)) {
      setFeedback({ type: 'error', message: `${id} is already in this provider.` })
      return
    }
    const manualModel = { id, name: id, ownedBy: selected.id, kind: 'chat', manual: true, capabilities: { chat: true } }
    updateConfig({
      models: [...config.models, selected.id === 'deepseek' ? withDeepSeekModelProfile(manualModel) : selected.id === 'bailian' ? withBailianModelProfile(manualModel) : manualModel],
      selectedModelIds: [...config.selectedModelIds, id],
      enabled: true,
    })
    setManualModelId('')
    setShowManualModel(false)
    setFeedback({ type: 'success', message: `Added ${id} manually.` })
  }

  return <div className="settings-page provider-settings-page">
    <header className="provider-page-header">
      <span className={`provider-icon provider-icon-large ${selected.tone}`}><SelectedIcon size={21} /></span>
      <div><span>API Provider</span><h2>{selected.name}</h2><p>{selected.protocol}</p></div>
      <label className={`provider-enable-toggle ${config.enabled ? 'enabled' : ''}`} title={config.selectedModelIds.length ? 'Enable this provider in model selectors' : 'Add at least one model first'}><input type="checkbox" checked={config.enabled} disabled={!config.selectedModelIds.length} onChange={(event) => updateConfig({ enabled: event.target.checked })} /><span /><small>{config.enabled ? 'Enabled' : 'Disabled'}</small></label>
    </header>

    <section className="provider-config-section">
      <div className="provider-field-heading"><div><KeyRound size={16} /><span><strong>API credentials</strong><small>Kept only for this browser session in the web milestone.</small></span></div>{selected.keyWebsite ? <a className="settings-text-link" href={selected.keyWebsite} target="_blank" rel="noreferrer">Get API key</a> : <span className="provider-field-status">Optional</span>}</div>
      <div className="provider-input-row provider-key-row"><div className="provider-secret-input"><input type={showApiKey ? 'text' : 'password'} value={apiKey} onChange={(event) => updateApiKey(event.target.value)} placeholder={selected.requiresKey ? 'Enter API key' : 'Optional for local servers'} autoComplete="off" aria-label="API key" /><button onClick={() => setShowApiKey((current) => !current)} aria-label={showApiKey ? 'Hide API key' : 'Show API key'}>{showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div><button className="settings-secondary-button" onClick={() => handleFetchModels('verify')} disabled={modelsBusy || (selected.requiresKey && !apiKey.trim())}>{modelsBusy ? <RefreshCw className="spin" size={14} /> : <ShieldCheck size={14} />}Verify</button></div>
      {!['deepseek', 'bailian'].includes(selected.id) ? <>
        <div className="provider-field-heading"><div><Cloud size={16} /><span><strong>API endpoint</strong><small>Override the default endpoint for gateways or compatible services.</small></span></div><span className="provider-field-status">{config.endpoint === selected.endpoint ? 'Default' : 'Custom'}</span></div>
        <div className="provider-input-row"><input value={config.endpoint} onChange={(event) => updateConfig({ endpoint: event.target.value })} aria-label="API endpoint" spellCheck="false" /><button className="settings-secondary-button" onClick={() => updateConfig({ endpoint: selected.endpoint })} disabled={config.endpoint === selected.endpoint}>Reset</button></div>
      </> : <div className="provider-field-heading deepseek-shared-key-note"><div><Cloud size={16} /><span><strong>Shared credential</strong><small>The same {selected.id === 'deepseek' ? 'DeepSeek' : 'Model Studio'} API key is used across all enabled request interfaces below.</small></span></div><span className="provider-field-status">{selected.id === 'deepseek' ? '3 profiles' : '4 profiles'}</span></div>}
    </section>

    {selected.id === 'deepseek' && <><DeepSeekEndpointSettings config={config} onUpdate={updateConfig} /><DeepSeekThinkingSettings config={config} onUpdate={updateConfig} /></>}
    {selected.id === 'bailian' && <><BailianEndpointSettings config={config} onUpdate={updateConfig} /><BailianThinkingSettings config={config} onUpdate={updateConfig} /></>}

    {feedback && <div className={`provider-feedback ${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.type === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}<span>{feedback.message}</span></div>}

    <section className="provider-model-section">
      <div className="provider-model-heading"><div><strong>Models</strong><small>{config.models.length ? `${config.selectedModelIds.length} added · ${config.models.length} discovered${config.lastFetchedAt ? ` · updated ${new Date(config.lastFetchedAt).toLocaleString()}` : ''}` : 'Fetch the live catalog, then choose which models appear in Research.'}</small></div><div className="provider-model-actions"><button className="settings-secondary-button" onClick={() => setShowManualModel((current) => !current)}><Plus size={14} />Add manually</button><button className="settings-primary-button" onClick={() => handleFetchModels('fetch')} disabled={modelsBusy || (selected.requiresKey && !apiKey.trim())}><RefreshCw className={modelsBusy ? 'spin' : ''} size={14} />{modelsBusy ? 'Fetching…' : 'Fetch model list'}</button></div></div>
      {showManualModel && <div className="provider-manual-model"><input value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addManualModel() }} placeholder="Model ID, e.g. organization/model-name" autoFocus /><button className="settings-primary-button" onClick={addManualModel} disabled={!manualModelId.trim()}>Add model</button></div>}
      {config.models.length ? <div className="provider-model-catalog">
        <div className="provider-model-tools"><label className="settings-search"><Search size={14} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Search discovered models…" /></label><button className="settings-text-button" onClick={selectAllChatModels}>Add all chat models</button></div>
        <div className="provider-model-list" aria-label={`${selected.name} model list`}>
          {filteredModels.map((model) => {
            const capabilityLabels = Object.entries(model.capabilities || {}).filter(([key, enabled]) => enabled && !['chat', 'embeddings'].includes(key)).map(([key]) => key === 'webSearch' ? 'web' : key)
            const endpointProfiles = selected.id === 'bailian' ? BAILIAN_ENDPOINT_PROFILES : DEEPSEEK_ENDPOINT_PROFILES
            const endpointLabels = (model.endpointTypes || []).map((endpointType) => endpointProfiles[endpointType]?.shortLabel).filter(Boolean)
            return <div className={selectedIds.has(model.id) ? 'selected' : ''} key={model.id}><span className={`provider-model-kind ${model.kind}`}>{model.kind}</span><div><strong>{model.name}</strong><small>{model.id}{model.manual ? ' · manual' : ''}{capabilityLabels.length ? ` · ${capabilityLabels.join(' · ')}` : ''}</small>{endpointLabels.length > 0 && <span className="provider-model-endpoints">{endpointLabels.map((label) => <i key={label}>{label}</i>)}</span>}</div><button onClick={() => toggleModel(model.id)} disabled={model.kind !== 'chat'}>{selectedIds.has(model.id) ? 'Remove' : model.kind === 'chat' ? 'Add' : 'Not used yet'}</button></div>
          })}
          {!filteredModels.length && <div className="provider-model-no-results">No models match “{modelQuery}”.</div>}
        </div>
      </div> : <div className="provider-model-empty"><span><Database size={20} /></span><div><strong>No model catalog yet</strong><small>Enter this provider's credentials and fetch the current model list. Research Agent does not hard-code versioned model names.</small></div></div>}
      <div className="provider-capability-grid">
        <div><span>Model discovery</span><strong>Dynamic catalog</strong></div>
        <div><span>Authentication</span><strong>{selected.requiresKey ? 'API key' : 'Optional API key'}</strong></div>
        <div><span>Protocol</span><strong>{selected.protocol}</strong></div>
        <div><span>Web credential storage</span><strong>Session only</strong></div>
      </div>
    </section>

    <div className="provider-security-note"><ShieldCheck size={16} /><span><strong>Web-first safety boundary</strong>API keys are sent only to the local adapter for provider requests and cleared when the browser session ends. The desktop build will move them into the operating system secure store.</span></div>
  </div>
}

function ModelSelect({ label, description, value, onChange, options, includeNone = false }) {
  return <label className="settings-select-row"><span><strong>{label}</strong><small>{description}</small></span><select value={value} onChange={(event) => onChange(event.target.value)}>{includeNone && <option value="none">Not configured</option>}{options.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></label>
}

function DefaultModelsPage({ config, chatModels, onSave }) {
  const [draft, setDraft] = useState(config)
  const [saved, setSaved] = useState(false)
  const embeddingModels = getModelsByRole('embedding')
  const rerankModels = getModelsByRole('rerank')
  useEffect(() => setDraft(config), [config])
  const update = (key, value) => { setSaved(false); setDraft((current) => ({ ...current, [key]: value })) }
  const handleSave = () => { onSave(draft); setSaved(true) }

  return <div className="settings-page">
    <SettingsPageHeader eyebrow="Model roles" title="默认模型" description="Assign models by responsibility. Smart routing remains available when no fixed model should be forced.">
      <button className="settings-primary-button" onClick={handleSave}>{saved ? 'Saved' : 'Save changes'}</button>
    </SettingsPageHeader>
    <section className="settings-form-card">
      <ModelSelect label="Answer and synthesis" description="Used for chat, evidence synthesis, and citation-safe research answers." value={draft.chatModelId} onChange={(value) => update('chatModelId', value)} options={chatModels} />
      <ModelSelect label="Embedding" description="Creates semantic vectors for Vault retrieval." value={draft.embeddingModelId} onChange={(value) => update('embeddingModelId', value)} options={embeddingModels} includeNone />
      <ModelSelect label="Reranker" description="Reorders retrieved evidence before answer generation." value={draft.rerankModelId} onChange={(value) => update('rerankModelId', value)} options={rerankModels} includeNone />
    </section>
    <button className="settings-text-button" onClick={() => { setSaved(false); setDraft(DEFAULT_MODEL_CONFIG) }}>Restore defaults</button>
  </div>
}

function LocalModelsPage() {
  const runtimes = [
    { name: 'Ollama', endpoint: 'http://localhost:11434', detail: 'Local model runner and model catalog' },
    { name: 'LM Studio', endpoint: 'http://localhost:1234/v1', detail: 'OpenAI-compatible local inference server' },
  ]
  return <div className="settings-page">
    <SettingsPageHeader eyebrow="Private inference" title="本地模型" description="Local runtimes stay distinct from cloud API Providers and subscription accounts." />
    <div className="local-runtime-grid">{runtimes.map((runtime) => <section key={runtime.name}><span><Cpu size={19} /></span><div><h3>{runtime.name}</h3><p>{runtime.detail}</p><code>{runtime.endpoint}</code></div><small>Not detected</small></section>)}</div>
    <div className="provider-security-note"><Code2 size={16} /><span><strong>Runtime detection</strong>The web client will ask the local adapter to detect services. Direct browser probing is intentionally avoided.</span></div>
  </div>
}

function RetrievalSettingsPage({ config, onSave }) {
  const [draft, setDraft] = useState(config)
  const [saved, setSaved] = useState(false)
  useEffect(() => setDraft(config), [config])
  const update = (key, value) => { setSaved(false); setDraft((current) => ({ ...current, [key]: value })) }
  return <div className="settings-page">
    <SettingsPageHeader eyebrow="Current Vault" title="检索与索引" description="These settings affect how connected Markdown notes become evidence for the research agent.">
      <button className="settings-primary-button" onClick={() => { onSave(draft); setSaved(true) }}>{saved ? 'Saved' : 'Save changes'}</button>
    </SettingsPageHeader>
    <section className="settings-form-card">
      <label className="settings-select-row"><span><strong>Document parser</strong><small>Preserve headings, frontmatter, wikilinks, and source paths.</small></span><select value={draft.parserId} onChange={(event) => update('parserId', event.target.value)}><option value="markdown">Markdown-aware parser</option><option value="plain-text">Plain text fallback</option></select></label>
      <label className="settings-range-row"><span><strong>Top K evidence</strong><small>Maximum candidate chunks passed into synthesis.</small></span><output>{draft.topK}</output><input type="range" min="1" max="50" value={draft.topK} onChange={(event) => update('topK', Number(event.target.value))} /></label>
      <label className="settings-number-row"><span><strong>Chunk size</strong><small>Target characters per evidence chunk.</small></span><input type="number" min="200" max="4000" step="50" value={draft.chunkSize} onChange={(event) => update('chunkSize', Number(event.target.value))} /></label>
      <label className="settings-number-row"><span><strong>Chunk overlap</strong><small>Context carried across adjacent chunks.</small></span><input type="number" min="0" max="1000" step="20" value={draft.chunkOverlap} onChange={(event) => update('chunkOverlap', Number(event.target.value))} /></label>
      <label className="settings-toggle-row"><span><strong>Hybrid search</strong><small>Combine lexical and future vector retrieval.</small></span><input type="checkbox" checked={draft.hybridSearch} onChange={(event) => update('hybridSearch', event.target.checked)} /></label>
      <label className="settings-toggle-row"><span><strong>Require citations</strong><small>Keep note paths attached to generated answers.</small></span><input type="checkbox" checked={draft.citations} onChange={(event) => update('citations', event.target.checked)} /></label>
    </section>
  </div>
}

function McpSettingsPage({ config, onChange, runtime, runtimeBusy, runtimeError, onConnectServer, onDisconnectServer, vaultNoteCount }) {
  const [showAddServer, setShowAddServer] = useState(false)
  const [draftServer, setDraftServer] = useState({ name: '', transport: 'streamable-http', endpoint: '', command: '', argumentsText: '' })
  const runtimeById = useMemo(() => new Map((runtime?.sessions || []).map((session) => [session.server.id, session])), [runtime?.sessions])
  const updatePermissions = (effect, value) => onChange({ ...config, permissions: { ...config.permissions, [effect]: value } })
  const updateServer = (id, patch) => onChange({
    ...config,
    servers: config.servers.map((server) => server.id === id ? { ...server, ...patch } : server),
  })
  const removeServer = async (id) => {
    if (runtimeById.has(id)) await onDisconnectServer(id)
    onChange({ ...config, servers: config.servers.filter((server) => server.id !== id) })
  }
  const target = draftServer.transport === 'stdio' ? draftServer.command : draftServer.endpoint
  const addServer = () => {
    if (!draftServer.name.trim() || !target.trim()) return
    onChange({ ...config, servers: [...config.servers, createMcpServer({ ...draftServer, args: draftServer.argumentsText.split('\n').map((arg) => arg.trim()).filter(Boolean) })] })
    setDraftServer({ name: '', transport: 'streamable-http', endpoint: '', command: '', argumentsText: '' })
    setShowAddServer(false)
  }

  return <div className="settings-page mcp-settings-page">
    <SettingsPageHeader eyebrow="Tool runtime" title="MCP" description="Register research tools behind one permission boundary. External servers connect through the trusted local runtime instead of the browser process.">
      <button className="settings-primary-button" onClick={() => setShowAddServer((current) => !current)}><Plus size={14} />{showAddServer ? 'Cancel' : 'Add server'}</button>
    </SettingsPageHeader>

    <div className="provider-security-note"><ShieldCheck size={16} /><span><strong>Local runtime safety boundary</strong>Connections and tool calls run through the local adapter. STDIO launch requires confirmation, write tools require one-time approval, and destructive tools remain blocked.</span></div>
    {runtimeError && <div className="settings-inline-error" role="alert">{runtimeError}</div>}

    <section className="settings-section-block mcp-policy-section">
      <div className="settings-section-heading"><div><h3>Tool permissions</h3><p>The policy is enforced before tools are advertised to a model and again before execution.</p></div><span>Local policy</span></div>
      <div className="mcp-policy-grid">
        <label><span><strong>Read tools</strong><small>Search, inspect, and retrieve research material.</small></span><select value={config.permissions.read} onChange={(event) => updatePermissions('read', event.target.value)}><option value="allow">Allow automatically</option><option value="deny">Deny</option></select></label>
        <label><span><strong>Write tools</strong><small>Create or update files after an explicit confirmation flow.</small></span><select value={config.permissions.write} onChange={(event) => updatePermissions('write', event.target.value)}><option value="ask">Ask every time</option><option value="deny">Deny</option></select></label>
        <label><span><strong>Destructive tools</strong><small>Delete, overwrite, or execute irreversible operations.</small></span><select value="deny" disabled><option value="deny">Always deny</option></select></label>
      </div>
    </section>

    {showAddServer && <section className="settings-form-card mcp-add-form">
      <label><span><strong>Server name</strong><small>A recognizable local label; credentials are not stored here.</small></span><input value={draftServer.name} onChange={(event) => setDraftServer((current) => ({ ...current, name: event.target.value }))} placeholder="e.g. Bioinformatics tools" /></label>
      <label><span><strong>Transport</strong><small>STDIO is desktop-only. Prefer Streamable HTTP for new remote servers.</small></span><select value={draftServer.transport} onChange={(event) => setDraftServer((current) => ({ ...current, transport: event.target.value }))}>{MCP_TRANSPORTS.map((transport) => <option value={transport.id} key={transport.id}>{transport.label}</option>)}</select></label>
      <label><span><strong>{draftServer.transport === 'stdio' ? 'Executable' : 'Endpoint'}</strong><small>{draftServer.transport === 'stdio' ? 'The exact executable launched without a shell.' : 'The MCP server URL. Authentication will be handled by the local runtime.'}</small></span><input value={target} onChange={(event) => setDraftServer((current) => ({ ...current, [current.transport === 'stdio' ? 'command' : 'endpoint']: event.target.value }))} placeholder={draftServer.transport === 'stdio' ? 'npx' : 'https://localhost:3001/mcp'} spellCheck="false" /></label>
      {draftServer.transport === 'stdio' && <label><span><strong>Arguments</strong><small>One argument per line, passed directly without shell parsing.</small></span><textarea value={draftServer.argumentsText} onChange={(event) => setDraftServer((current) => ({ ...current, argumentsText: event.target.value }))} placeholder={'--yes\n@example/mcp-server'} spellCheck="false" /></label>}
      <div className="mcp-form-actions"><button className="settings-secondary-button" onClick={() => setShowAddServer(false)}>Cancel</button><button className="settings-primary-button" onClick={addServer} disabled={!draftServer.name.trim() || !target.trim()}>Save disabled server</button></div>
    </section>}

    <section className="settings-section-block">
      <div className="settings-section-heading"><div><h3>Tool servers</h3><p>Built-in tools are available immediately. External servers connect and discover tools through the local adapter.</p></div><span>{config.servers.length + 1} registered</span></div>
      <div className="mcp-server-list">
        <article className="mcp-server-card builtin"><span className="mcp-server-icon"><Database size={18} /></span><div><header><strong>Research Vault</strong><i>Built-in</i></header><p>Read-only hybrid search over the connected Obsidian Vault.</p><small>{vaultNoteCount ? `${vaultNoteCount} notes indexed` : 'Connect a Vault to enable search_vault'} · 1 read tool</small></div><span className={`mcp-server-state ${vaultNoteCount ? 'ready' : ''}`}>{vaultNoteCount ? 'Ready' : 'Waiting'}</span></article>
        {config.servers.map((server) => {
          const session = runtimeById.get(server.id)
          const connected = session?.state === 'connected'
          const toolSummary = connected ? `${session.tools.length} tools · ${session.tools.filter((tool) => tool.effect === 'read').length} read · ${session.tools.filter((tool) => tool.effect === 'write').length} approval` : session?.error || 'Ready to connect through the local runtime'
          return <article className={`mcp-server-card ${connected ? 'connected' : ''}`} key={server.id}><span className="mcp-server-icon"><Plug size={18} /></span><div><header><strong>{server.name}</strong><i>{MCP_TRANSPORTS.find((transport) => transport.id === server.transport)?.label || server.transport}</i></header><p>{server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.endpoint}</p><small>{toolSummary}</small></div><div className="mcp-server-actions"><label><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(server.id, { enabled: event.target.checked })} disabled={connected} /><span>{server.enabled ? 'Enabled' : 'Disabled'}</span></label>{connected ? <button className="settings-secondary-button" onClick={() => onDisconnectServer(server.id)} disabled={runtimeBusy === server.id}>Disconnect</button> : <button className="settings-primary-button" onClick={() => onConnectServer(server)} disabled={!server.enabled || runtimeBusy === server.id}>{runtimeBusy === server.id ? 'Connecting…' : 'Connect'}</button>}<button className="settings-text-button" onClick={() => removeServer(server.id)} disabled={runtimeBusy === server.id}>Remove</button></div></article>
        })}
        {!config.servers.length && <div className="settings-empty-state mcp-empty-state"><Plug size={22} /><strong>No external MCP servers</strong><span>Add one now; it remains disabled until you explicitly enable and connect it.</span></div>}
      </div>
    </section>
  </div>
}

function FeaturePreviewPage({ pageId }) {
  const [title, description, features] = FEATURE_PREVIEWS[pageId] || FEATURE_PREVIEWS.system
  return <div className="settings-page">
    <SettingsPageHeader eyebrow="Settings roadmap" title={title} description={description} />
    <section className="feature-preview-card"><span><Settings2 size={23} /></span><div><strong>Settings surface prepared</strong><p>This category is part of the new settings architecture. Functional controls will be added with the corresponding runtime capability.</p><ul>{features.map((feature) => <li key={feature}><CheckCircle2 size={13} />{feature}</li>)}</ul></div></section>
  </div>
}

export default function SettingsWorkspace({ authStatus, authBusy, authError, modelCatalog, modelsBusy, onConnectChatgpt, onLogoutChatgpt, onRefreshModels, chatModels, modelConfig, onSaveModelConfig, providerConfigs, onSaveProviderConfigs, mcpConfig, onSaveMcpConfig, mcpRuntime, mcpRuntimeBusy, mcpRuntimeError, onConnectMcpServer, onDisconnectMcpServer, vaultNoteCount }) {
  const [activePage, setActivePage] = useState('providers')
  const [providerQuery, setProviderQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState(API_PROVIDERS[0].id)
  let content
  if (activePage === 'subscription') content = <SubscriptionPage authStatus={authStatus} authBusy={authBusy} authError={authError} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnect={onConnectChatgpt} onLogout={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
  else if (activePage === 'providers') content = <ProvidersPage selectedId={selectedProviderId} configs={providerConfigs} onChange={onSaveProviderConfigs} />
  else if (activePage === 'defaults') content = <DefaultModelsPage config={modelConfig} chatModels={chatModels} onSave={onSaveModelConfig} />
  else if (activePage === 'local-models') content = <LocalModelsPage />
  else if (activePage === 'mcp') content = <McpSettingsPage config={mcpConfig} onChange={onSaveMcpConfig} runtime={mcpRuntime} runtimeBusy={mcpRuntimeBusy} runtimeError={mcpRuntimeError} onConnectServer={onConnectMcpServer} onDisconnectServer={onDisconnectMcpServer} vaultNoteCount={vaultNoteCount} />
  else if (activePage === 'retrieval') content = <RetrievalSettingsPage config={modelConfig} onSave={onSaveModelConfig} />
  else content = <FeaturePreviewPage pageId={activePage} />

  const hasSecondaryNavigation = activePage === 'providers'

  return <div className={`settings-workspace ${hasSecondaryNavigation ? 'has-secondary-navigation' : ''}`}>
    <aside className="settings-navigation" aria-label="Settings navigation">
      <div className="settings-navigation-title"><Settings2 size={17} /><strong>Settings</strong></div>
      {SETTINGS_GROUPS.map((group) => <section key={group.label}><span>{group.label}</span>{group.items.map((item) => { const Icon = item.icon; return <button className={activePage === item.id ? 'active' : ''} onClick={() => setActivePage(item.id)} key={item.id}><Icon size={15} /><span>{item.label}</span></button> })}</section>)}
    </aside>
    {hasSecondaryNavigation && <ProviderNavigation query={providerQuery} onQueryChange={setProviderQuery} selectedId={selectedProviderId} onSelect={setSelectedProviderId} configs={providerConfigs} />}
    <main className="settings-content" key={activePage === 'providers' ? `${activePage}:${selectedProviderId}` : activePage}>{content}</main>
  </div>
}
