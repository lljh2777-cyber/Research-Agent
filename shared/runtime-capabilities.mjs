export const BUILD_MODES = Object.freeze({
  DEVELOPMENT: 'development',
  TEST: 'test',
  PRODUCTION: 'production',
})

export const RUNTIME_TARGETS = Object.freeze({
  LOCAL_WEB: 'local-web',
  DESKTOP: 'desktop',
  HOSTED_WEB: 'hosted-web',
})

const BUILD_MODE_VALUES = new Set(Object.values(BUILD_MODES))
const RUNTIME_TARGET_VALUES = new Set(Object.values(RUNTIME_TARGETS))

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
    mcp: 'loopback',
  }),
  [RUNTIME_TARGETS.DESKTOP]: Object.freeze({
    localVault: Object.freeze({
      available: true,
      adapters: Object.freeze(['desktop-fs']),
      preferred: 'desktop-fs',
    }),
    credentials: Object.freeze({
      providerApiKeys: 'os-keychain',
      subscriptionOAuth: 'os-keychain',
    }),
    chatgptSubscriptionOAuth: true,
    providerTransport: 'desktop-ipc',
    mcp: 'desktop',
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
    mcp: false,
  }),
})

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
} = {}) {
  const normalizedTarget = normalizeRuntimeTarget(target)
  return {
    schemaVersion: 1,
    buildMode: normalizeBuildMode(buildMode),
    target: normalizedTarget,
    appVersion: String(version || '0.1.0'),
    capabilities: CAPABILITY_PROFILES[normalizedTarget],
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
    && capabilities.credentials?.providerApiKeys === expected.credentials.providerApiKeys
    && capabilities.credentials?.subscriptionOAuth === expected.credentials.subscriptionOAuth
    && capabilities.chatgptSubscriptionOAuth === expected.chatgptSubscriptionOAuth
    && capabilities.providerTransport === expected.providerTransport
    && capabilities.mcp === expected.mcp
  )
}

