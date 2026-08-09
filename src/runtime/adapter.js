import { getVaultServiceBaseUrl } from './services.js'
import { getVaultName, parseVaultDirectory, parseVaultFiles, parseVaultTextEntries } from '../vault.js'

function browserWindow() {
  return globalThis.window
}

function defaultFetch(...args) {
  return globalThis.fetch(...args)
}

function timeoutSignal(windowRef, timeout) {
  const controller = new AbortController()
  const timer = windowRef.setTimeout(() => controller.abort(), timeout)
  return { controller, timer }
}

function combineAbortSignals(signal, timeoutController) {
  if (!signal) return timeoutController.signal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutController.signal])
  if (signal.aborted) return signal
  signal.addEventListener('abort', () => timeoutController.abort(), { once: true })
  return timeoutController.signal
}

async function normalizeVaultSnapshot(payload) {
  if (!payload || payload.cancelled || payload.unchanged) return payload
  return { ...payload, notes: await parseVaultTextEntries(payload.files || []) }
}

export function createWebRuntimeAdapter({
  windowRef = browserWindow(),
  fetchImpl = defaultFetch,
  env = import.meta.env,
} = {}) {
  const api = Object.freeze({
    fetch: (input, init) => fetchImpl(input, init),
  })

  const credentials = Object.freeze({
    mode: 'session',
    read(storageKey, storage = windowRef?.sessionStorage) {
      return storage?.getItem(storageKey) || ''
    },
    write(storageKey, value, storage = windowRef?.sessionStorage) {
      storage?.setItem(storageKey, value)
    },
    hasProviderKey: async () => false,
    setProviderKey: async () => ({ ok: false }),
    deleteProviderKey: async () => ({ ok: false }),
  })

  const storage = Object.freeze({
    readLocal(storageKey, target = windowRef?.localStorage) {
      return target?.getItem(storageKey) || ''
    },
    writeLocal(storageKey, value, target = windowRef?.localStorage) {
      target?.setItem(storageKey, value)
    },
    removeLocal(storageKey, target = windowRef?.localStorage) {
      target?.removeItem(storageKey)
    },
  })

  const vault = Object.freeze({
    mode: 'web',
    hasDesktopBridge: false,
    canSelectDirectory: typeof windowRef?.showDirectoryPicker === 'function',
    async selectDirectory() {
      if (typeof windowRef?.showDirectoryPicker !== 'function') return { requiresFileInput: true }
      const handle = await windowRef.showDirectoryPicker({ mode: 'read' })
      return { handle }
    },
    async syncDirectory(handle, { requestPermission = false } = {}) {
      if (!handle) return { permission: 'missing', notes: [] }
      let permission = 'granted'
      if (handle.queryPermission) permission = await handle.queryPermission({ mode: 'read' })
      if (permission !== 'granted' && requestPermission && handle.requestPermission) {
        permission = await handle.requestPermission({ mode: 'read' })
      }
      if (permission !== 'granted') return { permission, notes: [], handle }
      const notes = await parseVaultDirectory(handle)
      return { permission, notes, handle, vaultName: handle.name || getVaultName(notes) }
    },
    async parseSelectedFiles(files) {
      const notes = await parseVaultFiles(files || [])
      return { notes, vaultName: getVaultName(notes) }
    },
    async loadLoopback({ revision = '', timeout = 2200, signal } = {}) {
      const baseUrl = getVaultServiceBaseUrl(env)
      const query = revision ? `?since=${encodeURIComponent(revision)}` : ''
      const { controller, timer } = timeoutSignal(windowRef, timeout)
      try {
        const response = await api.fetch(`${baseUrl}/api/vault${query}`, {
          headers: { Accept: 'application/json' },
          signal: combineAbortSignals(signal, controller),
        })
        if (!response.ok) throw new Error(`Local adapter returned ${response.status}`)
        return normalizeVaultSnapshot(await response.json())
      } finally {
        windowRef.clearTimeout(timer)
      }
    },
    async probeLoopback({ timeout = 700, signal } = {}) {
      const baseUrl = getVaultServiceBaseUrl(env)
      const { controller, timer } = timeoutSignal(windowRef, timeout)
      try {
        const response = await api.fetch(`${baseUrl}/api/health`, {
          headers: { Accept: 'application/json' },
          signal: combineAbortSignals(signal, controller),
        })
        if (!response.ok) throw new Error(`Local adapter returned ${response.status}`)
        return response.json()
      } finally {
        windowRef.clearTimeout(timer)
      }
    },
    selectDesktop: async () => { throw new Error('Desktop Vault access is unavailable.') },
    syncDesktop: async () => { throw new Error('Desktop Vault access is unavailable.') },
    onDesktopChanged: () => () => {},
  })

  const dataFiles = Object.freeze({
    native: false,
    async saveBackup({ fileName, content }) {
      const url = windowRef.URL.createObjectURL(new Blob([content], { type: 'application/json' }))
      const anchor = windowRef.document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.click()
      windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 0)
      return { cancelled: false, fileName, bytes: new TextEncoder().encode(content).length }
    },
    async openBackup() {
      throw new Error('Use the browser file picker to import a backup.')
    },
  })

  const providers = Object.freeze({
    discoverModels({ providerId, endpoint, apiKey, signal }) {
      return api.fetch('/api/providers/models', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, endpoint, apiKey }),
        signal,
      })
    },
    streamResponse({ providerId, endpoint, endpointType, apiKey, model, messages, options, signal }) {
      return api.fetch('/api/providers/responses/stream', {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId, endpoint, endpointType, apiKey, model, messages, options }),
        signal,
      })
    },
  })

  const mcp = Object.freeze({
    bootstrap({ signal } = {}) {
      return api.fetch('/api/mcp/bootstrap', {
        headers: { Accept: 'application/json' },
        signal,
      })
    },
    request({ path, body, runtimeToken, signal }) {
      return api.fetch(path, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-bioresearch-runtime-token': runtimeToken,
        },
        body: JSON.stringify(body),
        signal,
      })
    },
  })

  async function requestResearchRun(path, init = {}) {
    const response = await api.fetch(`/api/research/runs${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `Research run service failed (${response.status}).`)
    return payload
  }

  const researchRuns = Object.freeze({
    available: true,
    create: (input) => requestResearchRun('', { method: 'POST', body: JSON.stringify(input) }),
    get: (runId) => requestResearchRun(`/${encodeURIComponent(runId)}`),
    events: (runId, after = 0) => requestResearchRun(`/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}`),
    append: (runId, events) => requestResearchRun(`/${encodeURIComponent(runId)}/events`, {
      method: 'POST',
      body: JSON.stringify({ events }),
    }),
    start: (runId, execution) => requestResearchRun(`/${encodeURIComponent(runId)}/start`, {
      method: 'POST',
      body: JSON.stringify(execution),
    }),
    submitToolResult: (runId, requestId, result) => requestResearchRun(`/${encodeURIComponent(runId)}/tool-results`, {
      method: 'POST',
      body: JSON.stringify({ requestId, result }),
    }),
    async follow(runId, after = 0, signal) {
      const response = await api.fetch(`/api/research/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}&follow=1`, {
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        signal,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || `Research run stream failed (${response.status}).`)
      }
      return response
    },
    cancel: (runId) => requestResearchRun(`/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
  })

  return Object.freeze({
    kind: 'web',
    api,
    credentials,
    storage,
    vault,
    dataFiles,
    providers,
    mcp,
    researchRuns,
    providerRuns: Object.freeze({ available: false }),
    runtime: Object.freeze({
      async getManifest(fetchOverride = api.fetch) {
        const response = await fetchOverride('/api/runtime', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
        return response
      },
    }),
    browser: Object.freeze({
      openPopup: (...args) => windowRef?.open(...args),
      delay: (milliseconds) => new Promise((resolve) => windowRef.setTimeout(resolve, milliseconds)),
      setTimeout: (...args) => windowRef.setTimeout(...args),
      clearTimeout: (timer) => windowRef.clearTimeout(timer),
    }),
  })
}

export function createDesktopRuntimeAdapter({
  bridge,
  windowRef = browserWindow(),
  fetchImpl = defaultFetch,
  env = import.meta.env,
} = {}) {
  const web = createWebRuntimeAdapter({ windowRef, fetchImpl, env })
  const credentialBridge = bridge?.credentials
  const vaultBridge = bridge?.vaults
  const dataFilesBridge = bridge?.dataFiles
  const providerRunsBridge = bridge?.providerRuns

  return Object.freeze({
    ...web,
    kind: 'desktop',
    runtime: Object.freeze({
      async getManifest(fetchOverride = web.api.fetch) {
        if (bridge?.runtime?.getManifest) return bridge.runtime.getManifest()
        return web.runtime.getManifest(fetchOverride)
      },
    }),
    credentials: credentialBridge ? Object.freeze({
      mode: 'os-keychain',
      hasProviderKey: (providerId) => credentialBridge.hasProviderKey(providerId),
      setProviderKey: (providerId, value, allowedEndpoints) => credentialBridge.setProviderKey(providerId, value, allowedEndpoints),
      deleteProviderKey: (providerId) => credentialBridge.deleteProviderKey(providerId),
    }) : web.credentials,
    vault: Object.freeze({
      ...web.vault,
      mode: vaultBridge ? 'desktop' : web.vault.mode,
      hasDesktopBridge: Boolean(vaultBridge?.select && vaultBridge?.sync),
      selectDesktop: async () => {
        if (!vaultBridge?.select) throw new Error('Desktop Vault access is unavailable.')
        return normalizeVaultSnapshot(await vaultBridge.select())
      },
      syncDesktop: async ({ vaultId, revision = '' }) => {
        if (!vaultBridge?.sync) throw new Error('Desktop Vault access is unavailable.')
        return normalizeVaultSnapshot(await vaultBridge.sync(vaultId, revision))
      },
      onDesktopChanged: (listener) => vaultBridge?.onChanged?.(listener) || (() => {}),
    }),
    dataFiles: dataFilesBridge ? Object.freeze({
      native: Boolean(dataFilesBridge.saveBackup && dataFilesBridge.openBackup),
      saveBackup: (input) => dataFilesBridge.saveBackup(input),
      openBackup: () => dataFilesBridge.openBackup(),
    }) : web.dataFiles,
    providerRuns: providerRunsBridge ? Object.freeze({
      available: Boolean(providerRunsBridge.start && providerRunsBridge.cancel && providerRunsBridge.onEvent),
      start: (input) => providerRunsBridge.start(input),
      cancel: (runId) => providerRunsBridge.cancel(runId),
      onEvent: (listener) => providerRunsBridge.onEvent(listener),
    }) : web.providerRuns,
  })
}

let cachedBridge
let cachedAdapter

export function getRuntimeAdapter() {
  const bridge = browserWindow()?.researchDesktop || null
  if (!cachedAdapter || bridge !== cachedBridge) {
    cachedBridge = bridge
    cachedAdapter = bridge
      ? createDesktopRuntimeAdapter({ bridge })
      : createWebRuntimeAdapter()
  }
  return cachedAdapter
}

export function resetRuntimeAdapterForTests() {
  cachedBridge = undefined
  cachedAdapter = undefined
}
