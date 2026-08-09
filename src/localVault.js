import { getRuntimeAdapter } from './runtime/adapter.js'

export async function probeLocalVaultAdapter() {
  return getRuntimeAdapter().vault.probeLoopback({ timeout: 700 })
}

export async function loadLocalVault({ revision = '', timeout = 2200 } = {}) {
  return getRuntimeAdapter().vault.loadLoopback({ revision, timeout })
}
