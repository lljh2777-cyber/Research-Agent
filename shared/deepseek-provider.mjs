export const DEEPSEEK_ENDPOINT_TYPES = Object.freeze({
  CHAT: 'openai-chat-completions',
  RESPONSES: 'openai-responses',
  ANTHROPIC: 'anthropic-messages',
})

export const DEEPSEEK_ENDPOINT_PROFILES = Object.freeze({
  [DEEPSEEK_ENDPOINT_TYPES.CHAT]: Object.freeze({
    id: DEEPSEEK_ENDPOINT_TYPES.CHAT,
    label: 'DeepSeek native (Chat Completions)',
    shortLabel: 'DeepSeek native',
    adapterFamily: 'deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    route: 'chat/completions',
    description: 'Official DeepSeek request path with thinking, reasoning effort, and tool-call extensions.',
    maturity: 'Recommended',
  }),
  [DEEPSEEK_ENDPOINT_TYPES.RESPONSES]: Object.freeze({
    id: DEEPSEEK_ENDPOINT_TYPES.RESPONSES,
    label: 'OpenAI Responses',
    shortLabel: 'Responses',
    adapterFamily: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    route: 'responses',
    description: 'Official Responses API for Codex-style event streams and hosted tools. Currently limited to DeepSeek V4 Flash.',
    maturity: 'V4 Flash only',
  }),
  [DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC]: Object.freeze({
    id: DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC,
    label: 'Anthropic Messages',
    shortLabel: 'Anthropic',
    adapterFamily: 'anthropic',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    route: 'v1/messages',
    description: 'Anthropic-compatible request format for DeepSeek V4 Pro and V4 Flash.',
    maturity: 'Compatibility',
  }),
})

const ALL_ENDPOINT_TYPES = Object.keys(DEEPSEEK_ENDPOINT_PROFILES)

export function createDeepSeekEndpoints() {
  return Object.fromEntries(ALL_ENDPOINT_TYPES.map((endpointType) => [endpointType, {
    baseUrl: DEEPSEEK_ENDPOINT_PROFILES[endpointType].defaultBaseUrl,
    enabled: DEEPSEEK_ENDPOINT_PROFILES[endpointType].defaultEnabled !== false,
  }]))
}

export function normalizeDeepSeekEndpoints(value, legacyEndpoint) {
  const defaults = createDeepSeekEndpoints()
  const saved = value && typeof value === 'object' ? value : {}
  for (const endpointType of ALL_ENDPOINT_TYPES) {
    const endpoint = saved[endpointType]
    if (!endpoint || typeof endpoint !== 'object') continue
    defaults[endpointType] = {
      baseUrl: typeof endpoint.baseUrl === 'string' && endpoint.baseUrl.trim()
        ? endpoint.baseUrl
        : defaults[endpointType].baseUrl,
      enabled: endpoint.enabled !== false,
    }
  }
  if (!value && typeof legacyEndpoint === 'string' && legacyEndpoint.trim()) {
    defaults[DEEPSEEK_ENDPOINT_TYPES.CHAT].baseUrl = legacyEndpoint
    defaults[DEEPSEEK_ENDPOINT_TYPES.RESPONSES].baseUrl = legacyEndpoint
  }
  return defaults
}

export function getDeepSeekModelProfile(modelId) {
  const id = String(modelId || '').trim().toLowerCase()
  if (id === 'deepseek-v4-flash' || id.startsWith('deepseek-v4-flash[')) {
    return {
      endpointTypes: [DEEPSEEK_ENDPOINT_TYPES.CHAT, DEEPSEEK_ENDPOINT_TYPES.RESPONSES, DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC],
      preferredEndpointType: DEEPSEEK_ENDPOINT_TYPES.CHAT,
      capabilities: { reasoning: true, tools: true, webSearch: false },
    }
  }
  if (id === 'deepseek-v4-pro' || id.startsWith('deepseek-v4-pro[')) {
    return {
      endpointTypes: [DEEPSEEK_ENDPOINT_TYPES.CHAT, DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC],
      preferredEndpointType: DEEPSEEK_ENDPOINT_TYPES.CHAT,
      capabilities: { reasoning: true, tools: true, webSearch: false },
    }
  }
  if (id === 'deepseek-reasoner') {
    return {
      endpointTypes: [DEEPSEEK_ENDPOINT_TYPES.CHAT],
      preferredEndpointType: DEEPSEEK_ENDPOINT_TYPES.CHAT,
      capabilities: { reasoning: true, tools: false, webSearch: false },
    }
  }
  return {
    endpointTypes: [DEEPSEEK_ENDPOINT_TYPES.CHAT],
    preferredEndpointType: DEEPSEEK_ENDPOINT_TYPES.CHAT,
    capabilities: { reasoning: false, tools: false, webSearch: false },
  }
}

export function withDeepSeekModelProfile(model) {
  const profile = getDeepSeekModelProfile(model?.id)
  return {
    ...model,
    endpointTypes: profile.endpointTypes,
    preferredEndpointType: profile.preferredEndpointType,
    capabilities: { ...(model?.capabilities || {}), ...profile.capabilities },
  }
}

export function resolveDeepSeekEndpoint(config, model) {
  const endpoints = normalizeDeepSeekEndpoints(config?.endpoints, config?.endpoint)
  const profile = getDeepSeekModelProfile(model?.id || model)
  const configuredDefault = config?.defaultEndpointType || 'auto'
  const candidates = configuredDefault === 'auto'
    ? profile.endpointTypes
    : [configuredDefault, ...profile.endpointTypes.filter((endpointType) => endpointType !== configuredDefault)]
  const endpointType = candidates.find((candidate) => (
    profile.endpointTypes.includes(candidate)
    && endpoints[candidate]?.enabled
    && endpoints[candidate]?.baseUrl?.trim()
  ))
  if (!endpointType) return null
  return {
    endpointType,
    endpoint: endpoints[endpointType].baseUrl,
    automatic: configuredDefault === 'auto' || configuredDefault !== endpointType,
    fellBack: configuredDefault !== 'auto' && configuredDefault !== endpointType,
  }
}

const THINKING_MODES = new Set(['auto', 'enabled', 'disabled'])
const REASONING_EFFORTS = new Set(['auto', 'low', 'high', 'max'])

export function normalizeDeepSeekThinking(config = {}) {
  return {
    thinkingMode: THINKING_MODES.has(config.thinkingMode) ? config.thinkingMode : 'auto',
    reasoningEffort: REASONING_EFFORTS.has(config.reasoningEffort) ? config.reasoningEffort : 'auto',
  }
}

export function getDeepSeekRuntimeOptions(config = {}) {
  const normalized = normalizeDeepSeekThinking(config)
  return {
    ...(normalized.thinkingMode === 'auto' ? {} : { thinkingEnabled: normalized.thinkingMode === 'enabled' }),
    ...(normalized.reasoningEffort === 'auto' ? {} : { reasoningEffort: normalized.reasoningEffort }),
  }
}

export function isDeepSeekEndpointType(value) {
  return ALL_ENDPOINT_TYPES.includes(value)
}
