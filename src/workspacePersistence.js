import { createConversationConfigSnapshot } from './agentPresets.js'
import { RESEARCH_RUN_STATUS, isTerminalResearchRunStatus } from './research/runProtocol.js'
import { MAX_WORKSPACE_TABS, WORKSPACE_TAB_KINDS } from './workspaceTabs.js'

const DB_NAME = 'bioresearch-os-workspace'
const DB_VERSION = 1
const STORE_NAME = 'snapshots'
const SNAPSHOT_KEY = 'current-workspace'
const FALLBACK_KEY = 'bioresearch-os:workspace:v1'
const SCHEMA_VERSION = 1
const MAX_MESSAGES_PER_SESSION = 200
const MAX_RUN_SNAPSHOTS = 50
const MAX_TEXT_LENGTH = 500_000
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024

function boundedString(value, limit = 160) {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function cloneBounded(value, maxBytes, fallback) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length > maxBytes) return fallback
    return JSON.parse(serialized)
  } catch {
    return fallback
  }
}

function normalizeTab(tab) {
  if (!tab || typeof tab.id !== 'string' || !WORKSPACE_TAB_KINDS[tab.kind]) return null
  const id = boundedString(tab.id, 128)
  if (!id) return null
  return {
    id,
    kind: tab.kind,
    title: boundedString(tab.title, 160) || WORKSPACE_TAB_KINDS[tab.kind].title,
    vaultName: boundedString(tab.vaultName, 160),
  }
}

function normalizeMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return null
  const id = boundedString(message.id, 128)
  if (!id) return null
  const normalized = {
    id,
    role: message.role,
    text: boundedString(message.text, MAX_TEXT_LENGTH),
  }
  const createdAt = boundedString(message.createdAt, 40)
  if (createdAt && Number.isFinite(Date.parse(createdAt))) normalized.createdAt = createdAt
  if (message.role === 'user') {
    normalized.evidenceContext = boundedString(message.evidenceContext, MAX_TEXT_LENGTH)
    return normalized
  }
  normalized.reasoning = boundedString(message.reasoning, MAX_TEXT_LENGTH)
  normalized.runId = boundedString(message.runId, 128)
  normalized.closing = boundedString(message.closing, 20_000)
  normalized.bullets = cloneBounded(message.bullets || [], 250_000, [])
  normalized.evidence = cloneBounded(message.evidence || [], 2_000_000, [])
  normalized.toolTrace = cloneBounded(message.toolTrace || [], 1_000_000, [])
  normalized.usage = cloneBounded(message.usage || null, 50_000, null)
  normalized.contextPlan = cloneBounded(message.contextPlan || null, 50_000, null)
  return normalized
}

function normalizeConfig(config) {
  const agentId = boundedString(config?.source?.agentId, 80) || 'biologist'
  const overrides = {}
  if (config && typeof config === 'object') {
    overrides.identity = cloneBounded(config.identity || {}, 20_000, {})
    overrides.systemPrompt = boundedString(config.systemPrompt, 100_000)
    if (config.model?.modelId) overrides.model = cloneBounded(config.model, 20_000, {})
    overrides.fallbackModels = cloneBounded(config.fallbackModels || [], 50_000, [])
    if (Array.isArray(config.enabledTools)) overrides.enabledTools = config.enabledTools.map((tool) => boundedString(tool, 100))
    overrides.knowledgeScopes = cloneBounded(config.knowledgeScopes || [], 100_000, [])
    overrides.permissions = cloneBounded(config.permissions || {}, 10_000, {})
    if (config.outputStyle) overrides.outputStyle = boundedString(config.outputStyle, 100)
    overrides.loopPolicy = cloneBounded(config.loopPolicy || {}, 10_000, {})
  }
  return createConversationConfigSnapshot({
    agentId,
    conversationOverrides: overrides,
  })
}

function normalizeRunSnapshots(value) {
  return cloneBounded((Array.isArray(value) ? value : []).slice(-MAX_RUN_SNAPSHOTS), 2_000_000, [])
    .filter((run) => run && typeof run === 'object' && typeof run.id === 'string' && run.id)
    .map((run) => {
      if (!run.status) return { ...run, status: RESEARCH_RUN_STATUS.COMPLETED }
      if (isTerminalResearchRunStatus(run.status)) return run
      return {
        ...run,
        status: RESEARCH_RUN_STATUS.CANCELLED,
        completedAt: run.completedAt || run.updatedAt || run.createdAt || null,
        error: {
          code: 'run_interrupted',
          message: 'This run was interrupted before the workspace was restored.',
          retryable: true,
        },
      }
    })
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return null
  const messages = (Array.isArray(session.messages) ? session.messages : [])
    .slice(-MAX_MESSAGES_PER_SESSION)
    .map(normalizeMessage)
    .filter(Boolean)
  return {
    phase: session.phase === 'conversation' || messages.length ? 'conversation' : 'setup',
    conversationTitle: boundedString(session.conversationTitle, 160) || 'New research',
    input: boundedString(session.input, 100_000),
    messages,
    running: false,
    activeStage: messages.length ? 5 : 0,
    pendingQuestion: '',
    pendingRunId: '',
    runMode: 'mock',
    answerMode: messages.length ? 'restored' : 'idle',
    retrievalPacket: null,
    configSnapshot: normalizeConfig(session.configSnapshot),
    runSnapshots: normalizeRunSnapshots(session.runSnapshots),
  }
}

export function normalizeWorkspaceSnapshot(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION) return null
  const seen = new Set()
  const tabs = (Array.isArray(value.tabs) ? value.tabs : []).slice(0, MAX_WORKSPACE_TABS).flatMap((tab) => {
    const normalized = normalizeTab(tab)
    if (!normalized || seen.has(normalized.id)) return []
    seen.add(normalized.id)
    return [normalized]
  })
  const researchTabIds = new Set(tabs.filter((tab) => tab.kind === 'research').map((tab) => tab.id))
  const sessions = {}
  for (const [tabId, session] of Object.entries(value.sessions || {})) {
    if (!researchTabIds.has(tabId)) continue
    const normalized = normalizeSession(session)
    if (normalized) sessions[tabId] = normalized
  }
  for (const tabId of researchTabIds) {
    if (!sessions[tabId]) sessions[tabId] = normalizeSession({})
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: boundedString(value.savedAt, 40),
    tabs,
    activeTabId: tabs.some((tab) => tab.id === value.activeTabId) ? value.activeTabId : tabs[0]?.id || null,
    sessions,
  }
}

export function createWorkspaceSnapshot({ tabs, activeTabId, sessions }) {
  return normalizeWorkspaceSnapshot({
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    tabs,
    activeTabId,
    sessions,
  })
}

function openWorkspaceDb(indexedDb) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readFallback(storage) {
  try {
    return normalizeWorkspaceSnapshot(JSON.parse(storage?.getItem(FALLBACK_KEY) || 'null'))
  } catch {
    return null
  }
}

export async function loadWorkspaceSnapshot({ indexedDb = globalThis.window?.indexedDB, storage = globalThis.window?.localStorage } = {}) {
  if (!indexedDb) return readFallback(storage)
  try {
    const db = await openWorkspaceDb(indexedDb)
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(SNAPSHOT_KEY)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return normalizeWorkspaceSnapshot(value) || readFallback(storage)
  } catch {
    return readFallback(storage)
  }
}

export async function saveWorkspaceSnapshot(value, { indexedDb = globalThis.window?.indexedDB, storage = globalThis.window?.localStorage } = {}) {
  const snapshot = createWorkspaceSnapshot(value)
  if (!snapshot) return false
  const serialized = JSON.stringify(snapshot)
  if (serialized.length > MAX_SNAPSHOT_BYTES) return false
  if (indexedDb) {
    try {
      const db = await openWorkspaceDb(indexedDb)
      await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY)
        request.onsuccess = resolve
        request.onerror = () => reject(request.error)
      })
      db.close()
      try { storage?.removeItem(FALLBACK_KEY) } catch {}
      return true
    } catch {}
  }
  try {
    storage?.setItem(FALLBACK_KEY, serialized)
    return true
  } catch {
    return false
  }
}

export async function clearWorkspaceSnapshot({ indexedDb = globalThis.window?.indexedDB, storage = globalThis.window?.localStorage } = {}) {
  let cleared = true
  if (indexedDb) {
    try {
      const db = await openWorkspaceDb(indexedDb)
      await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(SNAPSHOT_KEY)
        request.onsuccess = resolve
        request.onerror = () => reject(request.error)
      })
      db.close()
    } catch {
      cleared = false
    }
  }
  try {
    storage?.removeItem(FALLBACK_KEY)
  } catch {
    cleared = false
  }
  return cleared
}

export const WORKSPACE_PERSISTENCE_LIMITS = Object.freeze({
  maxMessagesPerSession: MAX_MESSAGES_PER_SESSION,
  maxRunSnapshots: MAX_RUN_SNAPSHOTS,
  maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
})
