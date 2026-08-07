import { parseVaultTextEntries } from './vault.js'

const DEFAULT_ADAPTER_URL = 'http://127.0.0.1:4317'

function adapterUrl() {
  return (import.meta.env.VITE_VAULT_API_URL || DEFAULT_ADAPTER_URL).replace(/\/$/, '')
}

async function requestAdapter(path, timeout = 900) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`${adapterUrl()}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Local adapter returned ${response.status}`)
    return response.json()
  } finally {
    window.clearTimeout(timer)
  }
}

export async function probeLocalVaultAdapter() {
  return requestAdapter('/api/health', 700)
}

export async function loadLocalVault({ revision = '', timeout = 2200 } = {}) {
  const query = revision ? `?since=${encodeURIComponent(revision)}` : ''
  const payload = await requestAdapter(`/api/vault${query}`, timeout)
  if (payload.unchanged) return payload
  const notes = await parseVaultTextEntries(payload.files || [])
  return { ...payload, notes }
}
