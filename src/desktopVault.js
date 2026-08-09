import { getRuntimeAdapter } from './runtime/adapter.js'

export function hasDesktopVaultBridge() {
  return getRuntimeAdapter().vault.hasDesktopBridge
}

export async function selectDesktopVault() {
  return getRuntimeAdapter().vault.selectDesktop()
}

export async function syncDesktopVault({ vaultId, revision = '' }) {
  return getRuntimeAdapter().vault.syncDesktop({ vaultId, revision })
}

export function onDesktopVaultChanged(listener) {
  return getRuntimeAdapter().vault.onDesktopChanged(listener)
}
