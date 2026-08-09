import { parseVaultTextEntries } from './vault.js'

function bridge() {
  return globalThis.window?.researchDesktop?.vaults || null
}
async function normalizeSnapshot(payload) {
  if (!payload || payload.cancelled) return payload
  if (payload.unchanged) return payload
  return { ...payload, notes: await parseVaultTextEntries(payload.files || []) }
}

export function hasDesktopVaultBridge() {
  const api = bridge()
  return Boolean(api?.select && api?.sync)
}

export async function selectDesktopVault() {
  const api = bridge()
  if (!api?.select) throw new Error('Desktop Vault access is unavailable.')
  return normalizeSnapshot(await api.select())
}

export async function syncDesktopVault({ vaultId, revision = '' }) {
  const api = bridge()
  if (!api?.sync) throw new Error('Desktop Vault access is unavailable.')
  return normalizeSnapshot(await api.sync(vaultId, revision))
}

export function onDesktopVaultChanged(listener) {
  const api = bridge()
  if (!api?.onChanged) return () => {}
  return api.onChanged(listener)
}
