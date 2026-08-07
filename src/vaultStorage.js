const DB_NAME = 'bioresearch-os'
const STORE_NAME = 'snapshots'
const HANDLE_STORE_NAME = 'handles'
const SNAPSHOT_KEY = 'current-vault'
const HANDLE_KEY = 'current-vault'
const FALLBACK_KEY = 'bioresearch-os:vault-snapshot'

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
    return value ? JSON.parse(value) : null
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
    return snapshot
  } catch {
    return fallbackRead()
  }
}

export async function saveVaultSnapshot(snapshot) {
  const payload = { ...snapshot, savedAt: new Date().toISOString() }
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
