export const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', protocol: 'Responses / Chat Completions', endpoint: 'https://api.openai.com/v1', tone: 'cyan', keyWebsite: 'https://platform.openai.com/api-keys', requiresKey: true },
  { id: 'anthropic', name: 'Anthropic', protocol: 'Anthropic Messages', endpoint: 'https://api.anthropic.com', tone: 'amber', keyWebsite: 'https://console.anthropic.com/settings/keys', requiresKey: true },
  { id: 'gemini', name: 'Google Gemini', protocol: 'Generative Language', endpoint: 'https://generativelanguage.googleapis.com', tone: 'violet', keyWebsite: 'https://aistudio.google.com/app/apikey', requiresKey: true },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'OpenAI compatible', endpoint: 'https://api.deepseek.com', tone: 'blue', keyWebsite: 'https://platform.deepseek.com/api_keys', requiresKey: true },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'Multi-provider gateway', endpoint: 'https://openrouter.ai/api/v1', tone: 'mint', keyWebsite: 'https://openrouter.ai/settings/keys', requiresKey: true },
  { id: 'compatible', name: 'OpenAI Compatible', protocol: 'Custom endpoint', endpoint: 'http://127.0.0.1:1234/v1', tone: 'slate', keyWebsite: '', requiresKey: false },
]

const CONFIG_STORAGE_KEY = 'bioresearch-os:provider-configs:v1'
const KEY_STORAGE_KEY = 'bioresearch-os:provider-session-keys:v1'

export function createDefaultProviderConfigs() {
  return Object.fromEntries(PROVIDER_PRESETS.map((provider) => [provider.id, {
    endpoint: provider.endpoint,
    enabled: false,
    models: [],
    selectedModelIds: [],
    lastFetchedAt: null,
  }]))
}

export function normalizeProviderConfigs(value) {
  const defaults = createDefaultProviderConfigs()
  if (!value || typeof value !== 'object') return defaults
  for (const provider of PROVIDER_PRESETS) {
    const saved = value[provider.id]
    if (!saved || typeof saved !== 'object') continue
    const models = Array.isArray(saved.models)
      ? saved.models.filter((model) => model && typeof model.id === 'string').map((model) => ({
        id: model.id,
        name: model.name || model.id,
        ownedBy: model.ownedBy || provider.id,
        kind: model.kind || 'chat',
        capabilities: model.capabilities && typeof model.capabilities === 'object' ? model.capabilities : { chat: (model.kind || 'chat') === 'chat' },
        ...(Array.isArray(model.methods) ? { methods: model.methods } : {}),
        ...(model.manual ? { manual: true } : {}),
      }))
      : []
    const validIds = new Set(models.map((model) => model.id))
    const selectedModelIds = Array.isArray(saved.selectedModelIds) ? saved.selectedModelIds.filter((id) => validIds.has(id)) : []
    defaults[provider.id] = {
      endpoint: typeof saved.endpoint === 'string' && saved.endpoint.trim() ? saved.endpoint : provider.endpoint,
      enabled: Boolean(saved.enabled && selectedModelIds.length),
      models,
      selectedModelIds,
      lastFetchedAt: typeof saved.lastFetchedAt === 'string' ? saved.lastFetchedAt : null,
    }
  }
  return defaults
}

export function loadProviderConfigs(storage = globalThis.window?.localStorage) {
  try {
    return normalizeProviderConfigs(JSON.parse(storage?.getItem(CONFIG_STORAGE_KEY) || 'null'))
  } catch {
    return createDefaultProviderConfigs()
  }
}

export function saveProviderConfigs(configs, storage = globalThis.window?.localStorage) {
  try {
    storage?.setItem(CONFIG_STORAGE_KEY, JSON.stringify(normalizeProviderConfigs(configs)))
  } catch {
    // Persistence is optional in restricted browser contexts.
  }
}

export function loadProviderSessionKeys(storage = globalThis.window?.sessionStorage) {
  try {
    const value = JSON.parse(storage?.getItem(KEY_STORAGE_KEY) || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export function saveProviderSessionKeys(keys, storage = globalThis.window?.sessionStorage) {
  try {
    storage?.setItem(KEY_STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // Session-only credentials can remain in component state if storage is unavailable.
  }
}

export async function fetchProviderModels({ providerId, endpoint, apiKey, signal }, fetchImpl = fetch) {
  const response = await fetchImpl('/api/providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, endpoint, apiKey }),
    signal,
  })
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
      })
    }
  }
  return models
}
