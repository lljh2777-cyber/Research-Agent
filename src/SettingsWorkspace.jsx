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
  fetchProviderModels,
  loadProviderSessionKeys,
  PROVIDER_PRESETS,
  saveProviderSessionKeys,
} from './providerConfig.js'

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

const PROVIDER_ICONS = { openai: Sparkles, anthropic: Network, gemini: Sparkles, deepseek: Search, openrouter: Network, compatible: Code2 }
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
      : config.endpoint
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
          ? `Connection verified. ${result.models.length} models are available.`
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
      models: [...config.models, selected.id === 'deepseek' ? withDeepSeekModelProfile(manualModel) : manualModel],
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
      {selected.id !== 'deepseek' ? <>
        <div className="provider-field-heading"><div><Cloud size={16} /><span><strong>API endpoint</strong><small>Override the default endpoint for gateways or compatible services.</small></span></div><span className="provider-field-status">{config.endpoint === selected.endpoint ? 'Default' : 'Custom'}</span></div>
        <div className="provider-input-row"><input value={config.endpoint} onChange={(event) => updateConfig({ endpoint: event.target.value })} aria-label="API endpoint" spellCheck="false" /><button className="settings-secondary-button" onClick={() => updateConfig({ endpoint: selected.endpoint })} disabled={config.endpoint === selected.endpoint}>Reset</button></div>
      </> : <div className="provider-field-heading deepseek-shared-key-note"><div><Cloud size={16} /><span><strong>Shared credential</strong><small>The same DeepSeek API key is used across all enabled request interfaces below.</small></span></div><span className="provider-field-status">3 profiles</span></div>}
    </section>

    {selected.id === 'deepseek' && <><DeepSeekEndpointSettings config={config} onUpdate={updateConfig} /><DeepSeekThinkingSettings config={config} onUpdate={updateConfig} /></>}

    {feedback && <div className={`provider-feedback ${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.type === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}<span>{feedback.message}</span></div>}

    <section className="provider-model-section">
      <div className="provider-model-heading"><div><strong>Models</strong><small>{config.models.length ? `${config.selectedModelIds.length} added · ${config.models.length} discovered${config.lastFetchedAt ? ` · updated ${new Date(config.lastFetchedAt).toLocaleString()}` : ''}` : 'Fetch the live catalog, then choose which models appear in Research.'}</small></div><div className="provider-model-actions"><button className="settings-secondary-button" onClick={() => setShowManualModel((current) => !current)}><Plus size={14} />Add manually</button><button className="settings-primary-button" onClick={() => handleFetchModels('fetch')} disabled={modelsBusy || (selected.requiresKey && !apiKey.trim())}><RefreshCw className={modelsBusy ? 'spin' : ''} size={14} />{modelsBusy ? 'Fetching…' : 'Fetch model list'}</button></div></div>
      {showManualModel && <div className="provider-manual-model"><input value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') addManualModel() }} placeholder="Model ID, e.g. organization/model-name" autoFocus /><button className="settings-primary-button" onClick={addManualModel} disabled={!manualModelId.trim()}>Add model</button></div>}
      {config.models.length ? <div className="provider-model-catalog">
        <div className="provider-model-tools"><label className="settings-search"><Search size={14} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Search discovered models…" /></label><button className="settings-text-button" onClick={selectAllChatModels}>Add all chat models</button></div>
        <div className="provider-model-list" aria-label={`${selected.name} model list`}>
          {filteredModels.map((model) => {
            const capabilityLabels = Object.entries(model.capabilities || {}).filter(([key, enabled]) => enabled && !['chat', 'embeddings'].includes(key)).map(([key]) => key === 'webSearch' ? 'web' : key)
            const endpointLabels = (model.endpointTypes || []).map((endpointType) => DEEPSEEK_ENDPOINT_PROFILES[endpointType]?.shortLabel).filter(Boolean)
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

function FeaturePreviewPage({ pageId }) {
  const [title, description, features] = FEATURE_PREVIEWS[pageId] || FEATURE_PREVIEWS.system
  return <div className="settings-page">
    <SettingsPageHeader eyebrow="Settings roadmap" title={title} description={description} />
    <section className="feature-preview-card"><span><Settings2 size={23} /></span><div><strong>Settings surface prepared</strong><p>This category is part of the new settings architecture. Functional controls will be added with the corresponding runtime capability.</p><ul>{features.map((feature) => <li key={feature}><CheckCircle2 size={13} />{feature}</li>)}</ul></div></section>
  </div>
}

export default function SettingsWorkspace({ authStatus, authBusy, authError, modelCatalog, modelsBusy, onConnectChatgpt, onLogoutChatgpt, onRefreshModels, chatModels, modelConfig, onSaveModelConfig, providerConfigs, onSaveProviderConfigs }) {
  const [activePage, setActivePage] = useState('providers')
  const [providerQuery, setProviderQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState(API_PROVIDERS[0].id)
  let content
  if (activePage === 'subscription') content = <SubscriptionPage authStatus={authStatus} authBusy={authBusy} authError={authError} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnect={onConnectChatgpt} onLogout={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
  else if (activePage === 'providers') content = <ProvidersPage selectedId={selectedProviderId} configs={providerConfigs} onChange={onSaveProviderConfigs} />
  else if (activePage === 'defaults') content = <DefaultModelsPage config={modelConfig} chatModels={chatModels} onSave={onSaveModelConfig} />
  else if (activePage === 'local-models') content = <LocalModelsPage />
  else if (activePage === 'retrieval') content = <RetrievalSettingsPage config={modelConfig} onSave={onSaveModelConfig} />
  else content = <FeaturePreviewPage pageId={activePage} />

  const hasSecondaryNavigation = activePage === 'providers'

  return <div className={`settings-workspace ${hasSecondaryNavigation ? 'has-secondary-navigation' : ''}`}>
    <aside className="settings-navigation" aria-label="Settings navigation">
      <div className="settings-navigation-title"><Settings2 size={17} /><strong>Settings</strong></div>
      {SETTINGS_GROUPS.map((group) => <section key={group.label}><span>{group.label}</span>{group.items.map((item) => { const Icon = item.icon; return <button className={activePage === item.id ? 'active' : ''} onClick={() => setActivePage(item.id)} key={item.id}><Icon size={15} /><span>{item.label}</span></button> })}</section>)}
    </aside>
    {hasSecondaryNavigation && <ProviderNavigation query={providerQuery} onQueryChange={setProviderQuery} selectedId={selectedProviderId} onSelect={setSelectedProviderId} configs={providerConfigs} />}
    <main className="settings-content">{content}</main>
  </div>
}
