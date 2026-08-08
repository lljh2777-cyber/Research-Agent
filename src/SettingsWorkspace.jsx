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

const API_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', protocol: 'Responses / Chat Completions', endpoint: 'https://api.openai.com/v1', icon: Sparkles, tone: 'cyan' },
  { id: 'anthropic', name: 'Anthropic', protocol: 'Anthropic Messages', endpoint: 'https://api.anthropic.com', icon: Network, tone: 'amber' },
  { id: 'gemini', name: 'Google Gemini', protocol: 'Generative Language', endpoint: 'https://generativelanguage.googleapis.com', icon: Sparkles, tone: 'violet' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'OpenAI compatible', endpoint: 'https://api.deepseek.com', icon: Search, tone: 'blue' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'Multi-provider gateway', endpoint: 'https://openrouter.ai/api/v1', icon: Network, tone: 'mint' },
  { id: 'compatible', name: 'OpenAI Compatible', protocol: 'Custom endpoint', endpoint: 'User supplied', icon: Code2, tone: 'slate' },
]

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
      <div className="subscription-status"><i /><span>{authStatus?.connected ? 'Connected' : authStatus?.unavailable ? 'Local service offline' : 'Not connected'}</span></div>
      <p>登录凭据由本地认证服务处理。Research Agent 只在执行所选任务时发送必要的提示和 Vault 证据。</p>
      <div className="subscription-actions">
        {authStatus?.connected
          ? <><button className="settings-secondary-button" onClick={() => onRefreshModels(true)} disabled={modelsBusy}><RefreshCw className={modelsBusy ? 'spin' : ''} size={14} /> Refresh models</button><button className="settings-danger-button" onClick={onLogout}>Sign out</button></>
          : <button className="settings-primary-button" onClick={onConnect} disabled={authBusy}>{authBusy ? 'Waiting for login…' : authStatus?.unavailable ? 'Retry local service' : 'Connect ChatGPT'}</button>}
      </div>
      {authError && <div className="settings-inline-error" role="alert">{authError}</div>}
    </section>

    <section className="settings-section-block">
      <div className="settings-section-heading"><div><h3>Discovered models</h3><p>Models are read from the connected account instead of being hard-coded in the app.</p></div><span>{models.length} available</span></div>
      {models.length ? <div className="discovered-model-list">{models.slice(0, 10).map((model) => <div key={model.id}><span><CheckCircle2 size={13} /><strong>{model.name || model.id}</strong></span><small>{model.id}</small></div>)}</div> : <div className="settings-empty-state"><Cloud size={22} /><strong>No account model catalog</strong><span>Connect ChatGPT to discover the models available to this account.</span></div>}
    </section>
  </div>
}

function ProviderNavigation({ query, onQueryChange, selectedId, onSelect }) {
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
          <i aria-hidden="true" />
        </button>
      })}
      {!filteredProviders.length && <div className="provider-list-empty">No matching providers</div>}
    </div>
    <button className="provider-add-button" onClick={() => { onQueryChange(''); onSelect('compatible') }}><Plus size={15} />Add provider</button>
  </aside>
}

function ProvidersPage({ selectedId }) {
  const selected = API_PROVIDERS.find((provider) => provider.id === selectedId) || API_PROVIDERS[0]
  const SelectedIcon = selected.icon
  const [endpoint, setEndpoint] = useState(selected.endpoint)
  useEffect(() => setEndpoint(selected.endpoint), [selected.endpoint])

  return <div className="settings-page provider-settings-page">
    <header className="provider-page-header">
      <span className={`provider-icon provider-icon-large ${selected.tone}`}><SelectedIcon size={21} /></span>
      <div><span>API Provider</span><h2>{selected.name}</h2><p>{selected.protocol}</p></div>
      <label className="provider-enable-toggle"><input type="checkbox" disabled /><span /><small>Disabled</small></label>
    </header>

    <section className="provider-config-section">
      <div className="provider-field-heading"><div><KeyRound size={16} /><span><strong>API credentials</strong><small>Credentials will be encrypted by the desktop secure store.</small></span></div><button className="settings-text-button" disabled>Get API key</button></div>
      <div className="provider-input-row"><input type="password" value="desktop-secure-store" readOnly disabled aria-label="API key" /><button className="settings-secondary-button" disabled>Verify</button></div>
      <div className="provider-field-heading"><div><Cloud size={16} /><span><strong>API endpoint</strong><small>Override the default endpoint for gateways or compatible services.</small></span></div><span className="provider-field-status">Default</span></div>
      <div className="provider-input-row"><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} aria-label="API endpoint" /><button className="settings-secondary-button" onClick={() => setEndpoint(selected.endpoint)}>Reset</button></div>
    </section>

    <section className="provider-model-section">
      <div className="provider-model-heading"><div><strong>Models</strong><small>Fetched from the provider after a successful connection.</small></div><button className="settings-secondary-button" disabled><RefreshCw size={14} />Fetch model list</button></div>
      <div className="provider-model-empty"><span><Database size={20} /></span><div><strong>No model catalog yet</strong><small>Configure this provider, then fetch the model list automatically instead of maintaining hard-coded model names.</small></div></div>
      <div className="provider-capability-grid">
        <div><span>Model discovery</span><strong>Dynamic catalog</strong></div>
        <div><span>Authentication</span><strong>API key</strong></div>
        <div><span>Protocol</span><strong>{selected.protocol}</strong></div>
        <div><span>Storage</span><strong>Desktop secure store</strong></div>
      </div>
    </section>

    <div className="provider-security-note"><ShieldCheck size={16} /><span><strong>Web-first safety boundary</strong>API keys are not stored in this web milestone. The navigation and provider schema are ready; credential entry becomes available with encrypted desktop storage.</span></div>
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

export default function SettingsWorkspace({ authStatus, authBusy, authError, modelCatalog, modelsBusy, onConnectChatgpt, onLogoutChatgpt, onRefreshModels, chatModels, modelConfig, onSaveModelConfig }) {
  const [activePage, setActivePage] = useState('providers')
  const [providerQuery, setProviderQuery] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState(API_PROVIDERS[0].id)
  let content
  if (activePage === 'subscription') content = <SubscriptionPage authStatus={authStatus} authBusy={authBusy} authError={authError} modelCatalog={modelCatalog} modelsBusy={modelsBusy} onConnect={onConnectChatgpt} onLogout={onLogoutChatgpt} onRefreshModels={onRefreshModels} />
  else if (activePage === 'providers') content = <ProvidersPage selectedId={selectedProviderId} />
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
    {hasSecondaryNavigation && <ProviderNavigation query={providerQuery} onQueryChange={setProviderQuery} selectedId={selectedProviderId} onSelect={setSelectedProviderId} />}
    <main className="settings-content">{content}</main>
  </div>
}
