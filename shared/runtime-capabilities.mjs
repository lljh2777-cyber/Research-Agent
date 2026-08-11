import {
  MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
  RUNTIME_ACTION_CAPABILITIES,
  RUNTIME_ANNOTATION_CONTENT_MAX_BYTES,
  RUNTIME_ANNOTATION_REQUEST_MAX_BYTES,
} from './runtime-action-contracts.mjs'

export const BUILD_MODES = Object.freeze({
  DEVELOPMENT: 'development',
  TEST: 'test',
  PRODUCTION: 'production',
})

export const RUNTIME_TARGETS = Object.freeze({
  LOCAL_WEB: 'local-web',
  VITE_WEB: 'vite-web',
  DESKTOP: 'desktop',
  HOSTED_WEB: 'hosted-web',
})

const BUILD_MODE_VALUES = new Set(Object.values(BUILD_MODES))
const RUNTIME_TARGET_VALUES = new Set(Object.values(RUNTIME_TARGETS))
const KNOWLEDGE_READ_CAPABILITIES = Object.freeze(['knowledge.query', 'knowledge.explain'])
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KNOWLEDGE_READ_PROVIDER_IDS = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'bailian', 'openrouter', 'compatible'])

const CAPABILITY_PROFILES = Object.freeze({
  [RUNTIME_TARGETS.LOCAL_WEB]: Object.freeze({
    localVault: Object.freeze({
      available: true,
      adapters: Object.freeze(['browser-picker', 'loopback-adapter']),
      preferred: 'browser-picker',
    }),
    credentials: Object.freeze({
      providerApiKeys: 'session',
      subscriptionOAuth: 'os-keychain',
    }),
    chatgptSubscriptionOAuth: true,
    providerTransport: 'loopback',
    researchRuns: 'loopback-event-buffer',
    researchExecution: 'loopback-provider',
    mcp: 'loopback',
  }),
  [RUNTIME_TARGETS.VITE_WEB]: Object.freeze({
    localVault: Object.freeze({
      available: true,
      adapters: Object.freeze(['browser-picker']),
      preferred: 'browser-picker',
    }),
    credentials: Object.freeze({
      providerApiKeys: 'session',
      subscriptionOAuth: false,
    }),
    chatgptSubscriptionOAuth: false,
    providerTransport: 'loopback',
    researchRuns: 'loopback-event-buffer',
    researchExecution: 'loopback-provider',
    mcp: 'loopback',
  }),
  [RUNTIME_TARGETS.DESKTOP]: Object.freeze({
    localVault: Object.freeze({
      available: true,
      adapters: Object.freeze(['desktop-ipc']),
      preferred: 'desktop-ipc',
    }),
    credentials: Object.freeze({
      providerApiKeys: 'os-keychain',
      subscriptionOAuth: 'os-keychain',
    }),
    chatgptSubscriptionOAuth: true,
    providerTransport: 'desktop-ipc',
    researchRuns: 'loopback-event-buffer',
    researchExecution: 'renderer-provider-ipc',
    mcp: 'desktop-loopback',
  }),
  [RUNTIME_TARGETS.HOSTED_WEB]: Object.freeze({
    localVault: Object.freeze({
      available: false,
      adapters: Object.freeze([]),
      preferred: null,
    }),
    credentials: Object.freeze({
      providerApiKeys: 'server-encrypted',
      subscriptionOAuth: false,
    }),
    chatgptSubscriptionOAuth: false,
    providerTransport: 'hosted-backend',
    researchRuns: false,
    researchExecution: false,
    mcp: false,
  }),
})

function unavailableReason(target, surface) {
  if (target === RUNTIME_TARGETS.LOCAL_WEB) return 'Local Vault root is not configured.'
  if (target === RUNTIME_TARGETS.VITE_WEB) return 'Vite-only Web does not expose local ' + surface + '.'
  if (target === RUNTIME_TARGETS.DESKTOP) return 'Desktop ' + surface + ' is not implemented in this round.'
  return 'Hosted Web does not expose local ' + surface + '.'
}

function isHttpEndpoint(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

function hasExecutableKnowledgeReadService(value) {
  const provider = value?.provider
  const researchRun = value?.researchRun
  return Boolean(
    provider?.selected === true
    && PROVIDER_ID_PATTERN.test(provider.providerId || '')
    && KNOWLEDGE_READ_PROVIDER_IDS.has(provider.providerId)
    && typeof provider.model === 'string'
    && provider.model.trim()
    && provider.model.length <= 256
    && isHttpEndpoint(provider.endpoint)
    && (provider.credential === 'available'
      || (provider.providerId === 'compatible' && provider.credential === 'not-required'))
    && researchRun?.executable === true
    && researchRun.transport === 'research-run',
  )
}

function optionalRuntimeServices(target, services = {}) {
  const local = target === RUNTIME_TARGETS.LOCAL_WEB
  const annotationsAvailable = local && services.annotations === true
  const actionsAvailable = local && services.actions === true
  const knowledgeReadsAvailable = local && hasExecutableKnowledgeReadService(services.knowledgeReads)
  return {
    knowledgeReads: Object.freeze({
      available: knowledgeReadsAvailable,
      transport: knowledgeReadsAvailable ? 'research-run' : false,
      capabilities: Object.freeze(Object.fromEntries(
        KNOWLEDGE_READ_CAPABILITIES.map((capability) => [capability, knowledgeReadsAvailable]),
      )),
      reason: knowledgeReadsAvailable
        ? null
        : local
          ? 'No executable selected Provider and Research Run service path is configured.'
          : unavailableReason(target, 'Knowledge read execution'),
    }),
    annotations: Object.freeze({
      available: annotationsAvailable,
      transport: annotationsAvailable ? 'same-origin' : false,
      capability: 'annotations.write',
      maxContentBytes: RUNTIME_ANNOTATION_CONTENT_MAX_BYTES,
      maxRequestBytes: RUNTIME_ANNOTATION_REQUEST_MAX_BYTES,
      reason: annotationsAvailable ? null : unavailableReason(target, 'annotation persistence'),
    }),
    actions: Object.freeze({
      available: actionsAvailable,
      transport: actionsAvailable ? 'same-origin' : false,
      maxInputBytes: MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
      maxOutputBytes: MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
      maxContextBytes: MAX_KNOWLEDGE_CONTEXT_BYTES,
      maxSessionHandoffBytes: MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
      capabilities: Object.freeze(Object.fromEntries(
        RUNTIME_ACTION_CAPABILITIES.map((capability) => [capability, actionsAvailable]),
      )),
      reason: actionsAvailable ? null : unavailableReason(target, 'Action service'),
    }),
  }
}

function sameOptionalService(actual, expected) {
  return Boolean(
    actual
    && actual.available === expected.available
    && actual.transport === expected.transport
    && ['maxContentBytes', 'maxRequestBytes', 'maxInputBytes', 'maxOutputBytes', 'maxContextBytes', 'maxSessionHandoffBytes']
      .every((field) => (
        expected[field] === undefined
        || actual[field] === expected[field]
      ))
    && actual.reason === expected.reason
    && (expected.capability === undefined || actual.capability === expected.capability)
    && (expected.capabilities === undefined
      || JSON.stringify(actual.capabilities) === JSON.stringify(expected.capabilities)),
  )
}

export function normalizeBuildMode(value) {
  return BUILD_MODE_VALUES.has(value) ? value : BUILD_MODES.PRODUCTION
}

export function normalizeRuntimeTarget(value) {
  return RUNTIME_TARGET_VALUES.has(value) ? value : RUNTIME_TARGETS.HOSTED_WEB
}

export function createRuntimeManifest({
  buildMode = BUILD_MODES.PRODUCTION,
  target = RUNTIME_TARGETS.HOSTED_WEB,
  version = '0.1.0',
  services = {},
} = {}) {
  const normalizedTarget = normalizeRuntimeTarget(target)
  const optionalServices = optionalRuntimeServices(normalizedTarget, services)
  return {
    schemaVersion: 1,
    buildMode: normalizeBuildMode(buildMode),
    target: normalizedTarget,
    appVersion: String(version || '0.1.0'),
    capabilities: Object.freeze({ ...CAPABILITY_PROFILES[normalizedTarget], ...optionalServices }),
  }
}

export function isRuntimeManifest(value) {
  if (!value || value.schemaVersion !== 1) return false
  if (!BUILD_MODE_VALUES.has(value.buildMode) || !RUNTIME_TARGET_VALUES.has(value.target)) return false
  const expected = CAPABILITY_PROFILES[value.target]
  const capabilities = value.capabilities
  return Boolean(
    capabilities
    && capabilities.localVault?.available === expected.localVault.available
    && capabilities.localVault?.preferred === expected.localVault.preferred
    && Array.isArray(capabilities.localVault?.adapters)
    && capabilities.localVault.adapters.length === expected.localVault.adapters.length
    && capabilities.localVault.adapters.every((adapter, index) => adapter === expected.localVault.adapters[index])
    && capabilities.credentials?.providerApiKeys === expected.credentials.providerApiKeys
    && capabilities.credentials?.subscriptionOAuth === expected.credentials.subscriptionOAuth
    && capabilities.chatgptSubscriptionOAuth === expected.chatgptSubscriptionOAuth
    && capabilities.providerTransport === expected.providerTransport
    && capabilities.researchRuns === expected.researchRuns
    && capabilities.researchExecution === expected.researchExecution
    && capabilities.mcp === expected.mcp
    && sameOptionalService(
      capabilities.knowledgeReads,
      optionalRuntimeServices(value.target, capabilities.knowledgeReads?.available === true
        ? {
            knowledgeReads: {
              provider: { selected: true, providerId: 'compatible', endpoint: 'https://runtime.invalid/v1', model: 'validated', credential: 'available' },
              researchRun: { executable: true, transport: 'research-run' },
            },
          }
        : {}).knowledgeReads,
    )
    && sameOptionalService(
      capabilities.annotations,
      optionalRuntimeServices(value.target, { annotations: capabilities.annotations?.available === true }).annotations,
    )
    && sameOptionalService(
      capabilities.actions,
      optionalRuntimeServices(value.target, { actions: capabilities.actions?.available === true }).actions,
    )
  )
}
