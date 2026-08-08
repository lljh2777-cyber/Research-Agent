export const BAILIAN_ENDPOINT_TYPES = Object.freeze({
  DASHSCOPE: 'dashscope-generation',
  OPENAI: 'openai-chat-completions',
  RESPONSES: 'openai-responses',
  ANTHROPIC: 'anthropic-messages',
})

export const BAILIAN_REGIONS = Object.freeze({
  'cn-beijing': Object.freeze({ id: 'cn-beijing', label: 'China (Beijing)', workspaceHost: 'cn-beijing.maas.aliyuncs.com', legacyHost: 'dashscope.aliyuncs.com' }),
  'ap-southeast-1': Object.freeze({ id: 'ap-southeast-1', label: 'Singapore', workspaceHost: 'ap-southeast-1.maas.aliyuncs.com', legacyHost: 'dashscope-intl.aliyuncs.com' }),
  'us-east-1': Object.freeze({ id: 'us-east-1', label: 'US (Virginia)', fixedHost: 'dashscope-us.aliyuncs.com' }),
  'eu-central-1': Object.freeze({ id: 'eu-central-1', label: 'Germany (Frankfurt)', workspaceHost: 'eu-central-1.maas.aliyuncs.com', requiresWorkspace: true }),
  'ap-northeast-1': Object.freeze({ id: 'ap-northeast-1', label: 'Japan (Tokyo)', workspaceHost: 'ap-northeast-1.maas.aliyuncs.com', requiresWorkspace: true }),
})

export const BAILIAN_ENDPOINT_PROFILES = Object.freeze({
  [BAILIAN_ENDPOINT_TYPES.DASHSCOPE]: Object.freeze({
    id: BAILIAN_ENDPOINT_TYPES.DASHSCOPE,
    label: 'DashScope native',
    shortLabel: 'DashScope',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    route: 'services/aigc/{text|multimodal}-generation/generation',
    description: 'Native Qwen format. Selects text or multimodal generation by model capability.',
  }),
  [BAILIAN_ENDPOINT_TYPES.OPENAI]: Object.freeze({
    id: BAILIAN_ENDPOINT_TYPES.OPENAI,
    label: 'OpenAI Chat Completions',
    shortLabel: 'Chat',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    route: 'chat/completions',
    description: 'Portable OpenAI Chat format with Qwen thinking, tools, search, and streaming extensions.',
  }),
  [BAILIAN_ENDPOINT_TYPES.RESPONSES]: Object.freeze({
    id: BAILIAN_ENDPOINT_TYPES.RESPONSES,
    label: 'OpenAI Responses',
    shortLabel: 'Responses',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    route: 'responses',
    description: 'Response IDs, built-in tools, reasoning effort, and optional server-side session cache.',
  }),
  [BAILIAN_ENDPOINT_TYPES.ANTHROPIC]: Object.freeze({
    id: BAILIAN_ENDPOINT_TYPES.ANTHROPIC,
    label: 'Anthropic Messages',
    shortLabel: 'Anthropic',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    route: 'v1/messages',
    description: 'Anthropic Messages compatibility with thinking blocks, tools, and cache-aware usage.',
  }),
})

export const BAILIAN_OFFICIAL_MODELS = Object.freeze([
  { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'qwen3.5-plus-2026-02-15', name: 'Qwen3.5 Plus (2026-02-15)', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
  { id: 'qwen3.5-flash-2026-02-23', name: 'Qwen3.5 Flash (2026-02-23)', contextWindowTokens: 1_000_000, maxOutputTokens: 65_536 },
])

function normalizeWorkspaceId(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/[./].*$/, '')
}

export function getBailianRegionalEndpoints(regionId = 'cn-beijing', workspaceId = '') {
  const region = BAILIAN_REGIONS[regionId] || BAILIAN_REGIONS['cn-beijing']
  const workspace = normalizeWorkspaceId(workspaceId)
  if (region.requiresWorkspace && !workspace) return null
  const host = region.fixedHost || (workspace ? `${workspace}.${region.workspaceHost}` : region.legacyHost)
  if (!host) return null
  const origin = `https://${host}`
  return {
    [BAILIAN_ENDPOINT_TYPES.DASHSCOPE]: `${origin}/api/v1`,
    [BAILIAN_ENDPOINT_TYPES.OPENAI]: `${origin}/compatible-mode/v1`,
    [BAILIAN_ENDPOINT_TYPES.RESPONSES]: `${origin}/compatible-mode/v1`,
    [BAILIAN_ENDPOINT_TYPES.ANTHROPIC]: `${origin}/apps/anthropic`,
  }
}

export function createBailianEndpoints(regionId, workspaceId) {
  const regional = getBailianRegionalEndpoints(regionId, workspaceId)
  return Object.fromEntries(Object.values(BAILIAN_ENDPOINT_PROFILES).map((profile) => [profile.id, {
    enabled: true,
    baseUrl: regional?.[profile.id] || profile.defaultBaseUrl,
  }]))
}

export function normalizeBailianEndpoints(value, legacyEndpoint, regionId, workspaceId) {
  const defaults = createBailianEndpoints(regionId, workspaceId)
  for (const profile of Object.values(BAILIAN_ENDPOINT_PROFILES)) {
    const saved = value?.[profile.id]
    if (!saved || typeof saved !== 'object') continue
    defaults[profile.id] = {
      enabled: saved.enabled !== false,
      baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl.trim() ? saved.baseUrl : defaults[profile.id].baseUrl,
    }
  }
  if (!value && typeof legacyEndpoint === 'string' && legacyEndpoint.trim()) {
    defaults[BAILIAN_ENDPOINT_TYPES.OPENAI].baseUrl = legacyEndpoint
    defaults[BAILIAN_ENDPOINT_TYPES.RESPONSES].baseUrl = legacyEndpoint
  }
  return defaults
}

export function normalizeBailianOptions(config = {}) {
  const thinkingMode = ['auto', 'enabled', 'disabled'].includes(config.thinkingMode) ? config.thinkingMode : 'auto'
  const budget = Number(config.thinkingBudget)
  const reasoningEffort = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort) ? config.reasoningEffort : 'auto'
  const searchStrategy = ['turbo', 'max', 'agent', 'agent_max'].includes(config.searchStrategy) ? config.searchStrategy : 'turbo'
  return {
    thinkingMode,
    thinkingBudget: Number.isInteger(budget) && budget >= 1 && budget <= 65_536 ? budget : 8_192,
    reasoningEffort,
    enableWebSearch: Boolean(config.enableWebSearch),
    searchStrategy,
    returnSearchSources: config.returnSearchSources !== false,
    enableSessionCache: Boolean(config.enableSessionCache),
    storeResponses: Boolean(config.storeResponses),
  }
}

export const normalizeBailianThinking = normalizeBailianOptions

export function getBailianRuntimeOptions(config = {}) {
  const normalized = normalizeBailianOptions(config)
  return {
    ...(normalized.thinkingMode !== 'auto' ? { thinkingEnabled: normalized.thinkingMode === 'enabled' } : {}),
    ...(normalized.thinkingMode === 'enabled' ? { thinkingBudget: normalized.thinkingBudget } : {}),
    ...(normalized.reasoningEffort !== 'auto' ? { reasoningEffort: normalized.reasoningEffort } : {}),
    ...(normalized.enableWebSearch ? {
      enableWebSearch: true,
      searchStrategy: normalized.searchStrategy,
      returnSearchSources: normalized.returnSearchSources,
    } : {}),
    ...(normalized.enableSessionCache ? { enableSessionCache: true } : {}),
    storeResponses: normalized.storeResponses,
  }
}

export function getBailianModelProfile(modelId) {
  const id = String(modelId || '').toLowerCase()
  const official = BAILIAN_OFFICIAL_MODELS.find((model) => model.id === id)
  const qwen35 = /^qwen3\.5-(plus|flash)(-|$)/.test(id)
  const vision = qwen35 || /(^|[-_.])(vl|omni)([-_.]|$)/.test(id)
  const qwen = /^qwen/i.test(id)
  const anthropicThirdParty = /^(deepseek-v4|deepseek-v3\.2|kimi-k2|glm-(4\.6|4\.7|5)|minimax-m2)/i.test(id)
  const endpointTypes = [BAILIAN_ENDPOINT_TYPES.DASHSCOPE, BAILIAN_ENDPOINT_TYPES.OPENAI]
  if (qwen) endpointTypes.push(BAILIAN_ENDPOINT_TYPES.RESPONSES)
  if (qwen || anthropicThirdParty) endpointTypes.push(BAILIAN_ENDPOINT_TYPES.ANTHROPIC)
  return {
    endpointTypes,
    preferredEndpointType: BAILIAN_ENDPOINT_TYPES.DASHSCOPE,
    nativeRoute: vision ? 'multimodal-generation' : 'text-generation',
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
  const endpoints = normalizeBailianEndpoints(config?.endpoints, config?.endpoint, config?.region, config?.workspaceId)
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
