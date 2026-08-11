import {
  createDeepSeekEndpoints,
  DEEPSEEK_ENDPOINT_TYPES,
  isDeepSeekEndpointType,
  normalizeDeepSeekEndpoints,
  normalizeDeepSeekThinking,
  resolveDeepSeekEndpoint,
  withDeepSeekModelProfile,
} from '../shared/deepseek-provider.mjs'
import {
  BAILIAN_ENDPOINT_TYPES,
  createBailianEndpoints,
  isBailianEndpointType,
  normalizeBailianEndpoints,
  normalizeBailianOptions,
  resolveBailianEndpoint,
  withBailianModelProfile,
} from '../shared/bailian-provider.mjs'
import { SILICONFLOW_PROVIDER_DESCRIPTOR } from '../shared/siliconflow-provider.mjs'
import { getRuntimeAdapter } from './runtime/adapter.js'

export const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', protocol: 'Responses / Chat Completions', endpoint: 'https://api.openai.com/v1', tone: 'cyan', keyWebsite: 'https://platform.openai.com/api-keys', requiresKey: true },
  { id: 'anthropic', name: 'Anthropic', protocol: 'Anthropic Messages', endpoint: 'https://api.anthropic.com', tone: 'amber', keyWebsite: 'https://console.anthropic.com/settings/keys', requiresKey: true },
  { id: 'gemini', name: 'Google Gemini', protocol: 'Generative Language', endpoint: 'https://generativelanguage.googleapis.com', tone: 'violet', keyWebsite: 'https://aistudio.google.com/app/apikey', requiresKey: true },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'Native / compatibility endpoints', endpoint: 'https://api.deepseek.com', tone: 'blue', keyWebsite: 'https://platform.deepseek.com/api_keys', requiresKey: true },
  { id: 'bailian', name: 'Alibaba Cloud Model Studio', protocol: 'DashScope / OpenAI Chat / Responses / Anthropic', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tone: 'cyan', keyWebsite: 'https://bailian.console.aliyun.com/?tab=model#/api-key', requiresKey: true },
  { id: SILICONFLOW_PROVIDER_DESCRIPTOR.id, name: SILICONFLOW_PROVIDER_DESCRIPTOR.name, protocol: SILICONFLOW_PROVIDER_DESCRIPTOR.protocolLabel, endpoint: SILICONFLOW_PROVIDER_DESCRIPTOR.defaultBaseUrl, tone: 'violet', keyWebsite: 'https://cloud.siliconflow.cn/account/ak', requiresKey: true },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'Multi-provider gateway', endpoint: 'https://openrouter.ai/api/v1', tone: 'mint', keyWebsite: 'https://openrouter.ai/settings/keys', requiresKey: true },
  { id: 'compatible', name: 'OpenAI Compatible', protocol: 'Custom endpoint', endpoint: 'http://127.0.0.1:1234/v1', tone: 'slate', keyWebsite: '', requiresKey: false },
]

const CONFIG_STORAGE_KEY = 'bioresearch-os:provider-configs:v1'
const KEY_STORAGE_KEY = 'bioresearch-os:provider-session-keys:v1'
const DEEPSEEK_CONFIG_VERSION = 3
const BAILIAN_CONFIG_VERSION = 2
export const DESKTOP_STORED_KEY = '__stored_in_os_keychain__'
let desktopProviderKeys = {}
let desktopProviderKeysHydration

function credentialAdapter() {
  return getRuntimeAdapter().credentials
}

function normalizeProviderKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([providerId, key]) => (
    typeof key === 'string' && key ? [[providerId, key]] : []
  )))
}

export function createDefaultProviderConfigs() {
  return Object.fromEntries(PROVIDER_PRESETS.map((provider) => {
    const config = {
      endpoint: provider.endpoint,
      enabled: false,
      models: [],
      selectedModelIds: [],
      lastFetchedAt: null,
    }
    if (provider.id === 'deepseek') {
      config.defaultEndpointType = 'auto'
      config.endpoints = createDeepSeekEndpoints()
      config.schemaVersion = DEEPSEEK_CONFIG_VERSION
      Object.assign(config, normalizeDeepSeekThinking())
    }
    if (provider.id === 'bailian') {
      config.region = 'cn-beijing'
      config.workspaceId = ''
      config.defaultEndpointType = 'auto'
      config.endpoints = createBailianEndpoints(config.region, config.workspaceId)
      config.schemaVersion = BAILIAN_CONFIG_VERSION
      Object.assign(config, normalizeBailianOptions())
    }
    return [provider.id, config]
  }))
}

export function normalizeProviderConfigs(value) {
  const defaults = createDefaultProviderConfigs()
  if (!value || typeof value !== 'object') return defaults
  for (const provider of PROVIDER_PRESETS) {
    const saved = value[provider.id]
    if (!saved || typeof saved !== 'object') continue
    let models = Array.isArray(saved.models)
      ? saved.models.filter((model) => model && typeof model.id === 'string').map((model) => ({
        id: model.id,
        name: model.name || model.id,
        ownedBy: model.ownedBy || provider.id,
        kind: model.kind || 'chat',
        capabilities: model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : { chat: (model.kind || 'chat') === 'chat' },
        ...(Array.isArray(model.methods) ? { methods: model.methods } : {}),
        ...(Array.isArray(model.endpointTypes) ? { endpointTypes: model.endpointTypes.filter((type) => isDeepSeekEndpointType(type) || isBailianEndpointType(type)) } : {}),
        ...(isDeepSeekEndpointType(model.preferredEndpointType) || isBailianEndpointType(model.preferredEndpointType) ? { preferredEndpointType: model.preferredEndpointType } : {}),
        ...(Number.isFinite(model.contextWindowTokens) ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(Number.isFinite(model.maxOutputTokens) ? { maxOutputTokens: model.maxOutputTokens } : {}),
        ...(model.manual ? { manual: true } : {}),
      }))
      : []
    if (provider.id === 'deepseek') models = models.map(withDeepSeekModelProfile)
    if (provider.id === 'bailian') models = models.map(withBailianModelProfile)
    const validIds = new Set(models.map((model) => model.id))
    const selectedModelIds = Array.isArray(saved.selectedModelIds) ? saved.selectedModelIds.filter((id) => validIds.has(id)) : []
    const normalized = {
      endpoint: typeof saved.endpoint === 'string' && saved.endpoint.trim() ? saved.endpoint : provider.endpoint,
      enabled: Boolean(saved.enabled && selectedModelIds.length),
      models,
      selectedModelIds,
      lastFetchedAt: typeof saved.lastFetchedAt === 'string' ? saved.lastFetchedAt : null,
    }
    if (provider.id === 'deepseek') {
      normalized.defaultEndpointType = saved.defaultEndpointType === 'auto' || isDeepSeekEndpointType(saved.defaultEndpointType)
        ? saved.defaultEndpointType
        : 'auto'
      normalized.endpoints = normalizeDeepSeekEndpoints(saved.endpoints, normalized.endpoint)
      const savedSchemaVersion = Number.isFinite(Number(saved.schemaVersion)) ? Number(saved.schemaVersion) : 0
      if (savedSchemaVersion < 2) {
        normalized.endpoints[DEEPSEEK_ENDPOINT_TYPES.RESPONSES].enabled = true
      }
      normalized.schemaVersion = DEEPSEEK_CONFIG_VERSION
      Object.assign(normalized, normalizeDeepSeekThinking(saved))
      normalized.endpoint = normalized.endpoints[DEEPSEEK_ENDPOINT_TYPES.CHAT].baseUrl
    }
    if (provider.id === 'bailian') {
      normalized.region = typeof saved.region === 'string' ? saved.region : 'cn-beijing'
      normalized.workspaceId = typeof saved.workspaceId === 'string' ? saved.workspaceId.trim() : ''
      normalized.defaultEndpointType = saved.defaultEndpointType === 'auto' || isBailianEndpointType(saved.defaultEndpointType)
        ? saved.defaultEndpointType
        : 'auto'
      normalized.endpoints = normalizeBailianEndpoints(saved.endpoints, normalized.endpoint, normalized.region, normalized.workspaceId)
      const savedSchemaVersion = Number.isFinite(Number(saved.schemaVersion)) ? Number(saved.schemaVersion) : 0
      if (savedSchemaVersion < BAILIAN_CONFIG_VERSION) {
        normalized.endpoints[BAILIAN_ENDPOINT_TYPES.RESPONSES].enabled = true
        normalized.endpoints[BAILIAN_ENDPOINT_TYPES.ANTHROPIC].enabled = true
      }
      normalized.schemaVersion = BAILIAN_CONFIG_VERSION
      Object.assign(normalized, normalizeBailianOptions(saved))
      normalized.endpoint = normalized.endpoints[BAILIAN_ENDPOINT_TYPES.OPENAI].baseUrl
    }
    defaults[provider.id] = normalized
  }
  return defaults
}

export function loadProviderConfigs(storage) {
  try {
    const serialized = storage
      ? storage.getItem(CONFIG_STORAGE_KEY)
      : getRuntimeAdapter().storage.readLocal(CONFIG_STORAGE_KEY)
    return normalizeProviderConfigs(JSON.parse(serialized || 'null'))
  } catch {
    return createDefaultProviderConfigs()
  }
}

export function saveProviderConfigs(configs, storage) {
  try {
    const serialized = JSON.stringify(normalizeProviderConfigs(configs))
    if (storage) storage.setItem(CONFIG_STORAGE_KEY, serialized)
    else getRuntimeAdapter().storage.writeLocal(CONFIG_STORAGE_KEY, serialized)
  } catch {
    // Persistence is optional in restricted browser contexts.
  }
}

export function loadProviderSessionKeys(storage) {
  const credentials = credentialAdapter()
  if (credentials.mode === 'os-keychain') return { ...desktopProviderKeys }
  try {
    return normalizeProviderKeys(JSON.parse(credentials.read(KEY_STORAGE_KEY, storage) || '{}'))
  } catch {
    return {}
  }
}

export function providerCredentialEndpoints(providerId, config) {
  if (!config || typeof config !== 'object') return []
  if (['deepseek', 'bailian'].includes(providerId)) {
    return [...new Set(Object.values(config.endpoints || {}).map((endpoint) => endpoint?.baseUrl).filter(Boolean))]
  }
  return config.endpoint ? [config.endpoint] : []
}

export function saveProviderSessionKeys(keys, storage, endpointScopes = {}) {
  const normalized = normalizeProviderKeys(keys)
  const credentials = credentialAdapter()
  if (credentials.mode === 'os-keychain') {
    const previous = desktopProviderKeys
    desktopProviderKeys = normalized
    const providerIds = new Set([...Object.keys(previous), ...Object.keys(normalized)].filter((providerId) => previous[providerId] !== normalized[providerId]))
    return Promise.all([...providerIds].map((providerId) => (
      normalized[providerId] === DESKTOP_STORED_KEY
        ? Promise.resolve()
        : normalized[providerId]
        ? credentials.setProviderKey(providerId, normalized[providerId], endpointScopes[providerId] || [])
        : credentials.deleteProviderKey(providerId)
    ))).then(() => {
      desktopProviderKeys = Object.fromEntries(Object.entries(desktopProviderKeys).map(([providerId, value]) => [
        providerId,
        value ? DESKTOP_STORED_KEY : value,
      ]))
    })
  }
  try {
    credentials.write(KEY_STORAGE_KEY, JSON.stringify(normalized), storage)
  } catch {
    // Session-only credentials can remain in component state if storage is unavailable.
  }
  return Promise.resolve()
}

export async function hydrateProviderSessionKeys(providerIds = PROVIDER_PRESETS.map((provider) => provider.id), credentials = credentialAdapter()) {
  if (!credentials || credentials.mode === 'session') return loadProviderSessionKeys()
  desktopProviderKeysHydration = Promise.all(providerIds.map(async (providerId) => [providerId, await credentials.hasProviderKey(providerId) ? DESKTOP_STORED_KEY : '']))
    .then((entries) => {
      desktopProviderKeys = normalizeProviderKeys(Object.fromEntries(entries))
      return { ...desktopProviderKeys }
    })
  return desktopProviderKeysHydration
}

export async function getProviderSessionKey(providerId) {
  if (credentialAdapter().mode === 'os-keychain') {
    await (desktopProviderKeysHydration || hydrateProviderSessionKeys())
    return ''
  }
  return loadProviderSessionKeys()[providerId] || ''
}

export async function fetchProviderModels({ providerId, endpoint, apiKey, signal }, fetchImpl) {
  const request = {
    providerId,
    endpoint,
    apiKey: credentialAdapter().mode === 'os-keychain' && apiKey === DESKTOP_STORED_KEY ? '' : apiKey,
    signal,
  }
  const { signal: requestSignal, ...requestBody } = request
  const response = fetchImpl
    ? await fetchImpl('/api/providers/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), signal: requestSignal,
    })
    : await getRuntimeAdapter().providers.discoverModels(request)
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : {}
  if (!response.ok) {
    if (response.status === 404 && !payload.error) {
      throw new Error('Local provider adapter is unavailable. Restart Research Agent with `npm run dev`.')
    }
    throw new Error(payload.error || `Model discovery failed (${response.status}).`)
  }
  return payload
}

export function providerConfigsToModels(configs) {
  const presets = new Map(PROVIDER_PRESETS.map((provider) => [provider.id, provider]))
  const models = []
  for (const [providerId, config] of Object.entries(normalizeProviderConfigs(configs))) {
    if (!config.enabled) continue
    const provider = presets.get(providerId)
    const selected = new Set(config.selectedModelIds)
    for (const model of config.models) {
      if (!selected.has(model.id) || model.kind !== 'chat') continue
      const resolvedEndpoint = providerId === 'deepseek'
        ? resolveDeepSeekEndpoint(config, model)
        : providerId === 'bailian' ? resolveBailianEndpoint(config, model) : null
      if ((providerId === 'deepseek' || providerId === 'bailian') && !resolvedEndpoint) continue
      models.push({
        id: `api:${providerId}:${model.id}`,
        apiModelId: model.id,
        name: model.name || model.id,
        provider: provider?.name || providerId,
        providerId,
        authProvider: 'api',
        role: 'chat',
        detail: `Discovered from ${provider?.name || providerId}.`,
        ready: true,
        discovered: true,
        capabilities: model.capabilities || { chat: true },
        ...((providerId === 'deepseek' || providerId === 'bailian') ? {
          endpoint: resolvedEndpoint.endpoint,
          endpointType: resolvedEndpoint.endpointType,
          endpointAutomatic: resolvedEndpoint.automatic,
          endpointFellBack: resolvedEndpoint.fellBack,
          endpointTypes: model.endpointTypes,
          contextWindowTokens: model.contextWindowTokens,
          maxOutputTokens: model.maxOutputTokens,
        } : {}),
      })
    }
  }
  return models
}
