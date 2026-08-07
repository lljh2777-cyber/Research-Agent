const DB_NAME = 'bioresearch-os'
const STORE_NAME = 'snapshots'
const SNAPSHOT_KEY = 'current-vault'
const FALLBACK_KEY = 'bioresearch-os:vault-snapshot'

function openVaultDb() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
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
