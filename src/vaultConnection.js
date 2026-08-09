export const VAULT_CONNECTION_STATUS = Object.freeze({
  DISCONNECTED: 'disconnected',
  CACHED: 'cached',
  CONNECTED: 'connected',
  SYNCING: 'syncing',
})

export function describeVaultConnection({ vaultName = '', noteCount = 0, syncState = 'idle' } = {}) {
  const normalizedName = typeof vaultName === 'string' ? vaultName.trim() : ''
  const normalizedCount = Math.max(0, Number(noteCount) || 0)
  if (!normalizedName) {
    return {
      status: VAULT_CONNECTION_STATUS.DISCONNECTED,
      title: 'Connect a Vault',
      detail: 'Choose a local Obsidian folder',
      actionLabel: 'Connect Obsidian vault',
      syncLabel: '',
    }
  }

  if (syncState === 'needs-permission') {
    return {
      status: VAULT_CONNECTION_STATUS.CACHED,
      title: normalizedName,
      detail: `${normalizedCount} cached Markdown note${normalizedCount === 1 ? '' : 's'} · reconnect to refresh`,
      actionLabel: `Reconnect ${normalizedName} Vault`,
      syncLabel: 'Reconnect vault',
    }
  }

  const syncing = syncState === 'syncing'
  return {
    status: syncing ? VAULT_CONNECTION_STATUS.SYNCING : VAULT_CONNECTION_STATUS.CONNECTED,
    title: normalizedName,
    detail: `${normalizedCount} Markdown note${normalizedCount === 1 ? '' : 's'}`,
    actionLabel: `Open ${normalizedName} Vault connection`,
    syncLabel: syncing ? 'Syncing vault' : 'Sync vault',
  }
}
