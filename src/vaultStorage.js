import { extractWikilinks } from './vault.js'

const DB_NAME = 'bioresearch-os'
const STORE_NAME = 'snapshots'
const HANDLE_STORE_NAME = 'handles'
const SNAPSHOT_KEY = 'current-vault'
const HANDLE_KEY = 'current-vault'
const FALLBACK_KEY = 'bioresearch-os:vault-snapshot'
export const VAULT_SNAPSHOT_SCHEMA_VERSION = 1
const SNAPSHOT_SOURCES = new Set(['browser-handle', 'desktop-ipc', 'local-adapter', 'manual'])

function normalizeStoredNote(value, index) {
  if (!value || typeof value !== 'object') return null
  const path = typeof value.path === 'string' ? value.path.trim().replace(/\\/g, '/').slice(0, 1_024) : ''
  if (!path || !/\.md$/i.test(path)) return null
  const body = typeof value.body === 'string' ? value.body : ''
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : path.split('/').pop() || path
  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title.trim()
    : name.replace(/\.md$/i, '') || `Note ${index + 1}`
  const frontmatter = value.frontmatter && typeof value.frontmatter === 'object' && !Array.isArray(value.frontmatter)
    ? value.frontmatter
    : {}
  const wikilinks = Array.isArray(value.wikilinks)
    ? [...new Set(value.wikilinks.filter((target) => typeof target === 'string' && target.trim()).map((target) => target.trim()))]
    : extractWikilinks(body)
  return {
    schemaVersion: 1,
    id: typeof value.id === 'string' && value.id ? value.id : path,
    path,
    name,
    title,
    body,
    frontmatter,
    wikilinks,
    wordCount: Number.isFinite(value.wordCount) && value.wordCount >= 0
      ? value.wordCount
      : (body.trim() ? body.trim().split(/\s+/).length : 0),
    type: typeof value.type === 'string' && value.type.trim() ? value.type.trim() : 'note',
  }
}

export function normalizeVaultSnapshot(value) {
  if (!value || value.schemaVersion !== VAULT_SNAPSHOT_SCHEMA_VERSION || !Array.isArray(value.notes)) return null
  const vaultName = typeof value.vaultName === 'string' ? value.vaultName.trim().slice(0, 240) : ''
  if (!vaultName) return null
  const notes = value.notes.map(normalizeStoredNote).filter(Boolean)
  return {
    schemaVersion: VAULT_SNAPSHOT_SCHEMA_VERSION,
    vaultName,
    notes,
    source: SNAPSHOT_SOURCES.has(value.source) ? value.source : 'manual',
    revision: typeof value.revision === 'string' ? value.revision.slice(0, 512) : '',
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : '',
  }
}

function openVaultDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) db.createObjectStore(HANDLE_STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function fallbackRead() {
  try {
    const value = window.localStorage.getItem(FALLBACK_KEY)
    return value ? normalizeVaultSnapshot(JSON.parse(value)) : null
  } catch {
    return null
  }
}

export async function loadVaultSnapshot() {
  if (!('indexedDB' in window)) return fallbackRead()
  try {
    const db = await openVaultDb()
    const snapshot = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(SNAPSHOT_KEY)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return normalizeVaultSnapshot(snapshot)
  } catch {
    return fallbackRead()
  }
}

export async function saveVaultSnapshot(snapshot) {
  const payload = normalizeVaultSnapshot({
    ...snapshot,
    schemaVersion: VAULT_SNAPSHOT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
  })
  if (!payload) return
  if (!('indexedDB' in window)) {
    try { window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(payload)) } catch { /* storage is optional */ }
    return
  }
  try {
    const db = await openVaultDb()
    await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(payload, SNAPSHOT_KEY)
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  } catch {
    try { window.localStorage.setItem(FALLBACK_KEY, JSON.stringify(payload)) } catch { /* storage is optional */ }
  }
}

export async function loadVaultHandle() {
  if (!('indexedDB' in window)) return null
  try {
    const db = await openVaultDb()
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction(HANDLE_STORE_NAME, 'readonly').objectStore(HANDLE_STORE_NAME).get(HANDLE_KEY)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return handle
  } catch {
    return null
  }
}

export async function saveVaultHandle(handle) {
  if (!('indexedDB' in window) || !handle) return
  try {
    const db = await openVaultDb()
    await new Promise((resolve, reject) => {
      const request = db.transaction(HANDLE_STORE_NAME, 'readwrite').objectStore(HANDLE_STORE_NAME).put(handle, HANDLE_KEY)
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  } catch {
    // FileSystemDirectoryHandle cannot be serialized into localStorage.
  }
}
