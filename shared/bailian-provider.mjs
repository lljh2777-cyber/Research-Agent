export const BAILIAN_ENDPOINT_TYPES = Object.freeze({
  DASHSCOPE: 'dashscope-generation',
  OPENAI: 'openai-chat-completions',
})

export const BAILIAN_ENDPOINT_PROFILES = Object.freeze({
  [BAILIAN_ENDPOINT_TYPES.DASHSCOPE]: Object.freeze({
    id: BAILIAN_ENDPOINT_TYPES.DASHSCOPE,
    label: 'DashScope native',
    shortLabel: 'DashScope',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    route: 'services/aigc/multimodal-generation/generation',
    description: 'Native Qwen multimodal request format with incremental output, thinking, tools, and provider extensions.',
  }),
  [BAILIAN_ENDPOINT_TYPES.OPENAI]: Object.freeze({
    id: BAILIAN_ENDPOINT_TYPES.OPENAI,
    label: 'OpenAI compatible',
    shortLabel: 'OpenAI',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    route: 'chat/completions',
    description: 'OpenAI Chat Completions compatibility for simple integrations and shared Agent tooling.',
  }),
})

export const BAILIAN_OFFICIAL_MODELS = Object.freeze([
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'qwen3.5-plus-2026-02-15', name: 'Qwen3.5 Plus (2026-02-15)', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'qwen3.5-flash-2026-02-23', name: 'Qwen3.5 Flash (2026-02-23)', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
])

export function createBailianEndpoints() {
  return Object.fromEntries(Object.values(BAILIAN_ENDPOINT_PROFILES).map((profile) => [profile.id, {
    enabled: true,
    baseUrl: profile.defaultBaseUrl,
  }]))
}

export function normalizeBailianEndpoints(value, legacyEndpoint) {
  const defaults = createBailianEndpoints()
  for (const profile of Object.values(BAILIAN_ENDPOINT_PROFILES)) {
    const saved = value?.[profile.id]
    if (!saved || typeof saved !== 'object') continue
    defaults[profile.id] = {
      enabled: saved.enabled !== false,
      baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl.trim() ? saved.baseUrl : profile.defaultBaseUrl,
    }
  }
  if (!value && typeof legacyEndpoint === 'string' && legacyEndpoint.trim()) {
    defaults[BAILIAN_ENDPOINT_TYPES.OPENAI].baseUrl = legacyEndpoint
  }
  return defaults
}

export function normalizeBailianThinking(config = {}) {
  const thinkingMode = ['auto', 'enabled', 'disabled'].includes(config.thinkingMode) ? config.thinkingMode : 'auto'
  const budget = Number(config.thinkingBudget)
  return {
    thinkingMode,
    thinkingBudget: Number.isInteger(budget) && budget >= 1 && budget <= 65_536 ? budget : 8_192,
    enableWebSearch: Boolean(config.enableWebSearch),
  }
}

export function getBailianRuntimeOptions(config = {}) {
  const normalized = normalizeBailianThinking(config)
  return {
    ...(normalized.thinkingMode !== 'auto' ? { thinkingEnabled: normalized.thinkingMode === 'enabled' } : {}),
    ...(normalized.thinkingMode === 'enabled' ? { thinkingBudget: normalized.thinkingBudget } : {}),
    ...(normalized.enableWebSearch ? { enableWebSearch: true } : {}),
  }
}

export function getBailianModelProfile(modelId) {
  const id = String(modelId || '').toLowerCase()
  const official = BAILIAN_OFFICIAL_MODELS.find((model) => model.id === id)
  const qwen35 = /^qwen3\.5-(plus|flash)(-|$)/.test(id)
  return {
    endpointTypes: [BAILIAN_ENDPOINT_TYPES.DASHSCOPE, BAILIAN_ENDPOINT_TYPES.OPENAI],
    preferredEndpointType: BAILIAN_ENDPOINT_TYPES.DASHSCOPE,
    contextWindowTokens: official?.contextWindowTokens,
    maxOutputTokens: official?.maxOutputTokens,
    capabilities: qwen35 ? { chat: true, embeddings: false, reasoning: true, vision: true, tools: true, webSearch: true } : null,
  }
}

export function withBailianModelProfile(model) {
  const profile = getBailianModelProfile(model?.id)
  return {
    ...model,
    endpointTypes: profile.endpointTypes,
    preferredEndpointType: profile.preferredEndpointType,
    ...(profile.contextWindowTokens ? { contextWindowTokens: profile.contextWindowTokens } : {}),
    ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
    capabilities: profile.capabilities || model.capabilities,
  }
}

export function resolveBailianEndpoint(config, model) {
  const endpoints = normalizeBailianEndpoints(config?.endpoints, config?.endpoint)
  const profile = getBailianModelProfile(model?.id || model)
  const requested = config?.defaultEndpointType === 'auto' || !isBailianEndpointType(config?.defaultEndpointType)
    ? profile.preferredEndpointType
    : config.defaultEndpointType
  const chosen = endpoints[requested]?.enabled
    ? requested
    : profile.endpointTypes.find((type) => endpoints[type]?.enabled)
  if (!chosen) return null
  return { endpointType: chosen, endpoint: endpoints[chosen].baseUrl, automatic: config?.defaultEndpointType === 'auto', fellBack: chosen !== requested }
}

export function isBailianEndpointType(value) {
  return Object.values(BAILIAN_ENDPOINT_TYPES).includes(value)
}
