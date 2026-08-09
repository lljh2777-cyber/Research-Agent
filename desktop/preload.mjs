import { contextBridge, ipcRenderer } from 'electron'

const desktopApi = Object.freeze({
  runtime: Object.freeze({
    getManifest: () => ipcRenderer.invoke('runtime:get-manifest'),
  }),
  credentials: Object.freeze({
    hasProviderKey: (providerId) => ipcRenderer.invoke('credentials:has-provider-key', providerId),
    setProviderKey: (providerId, value, allowedEndpoints) => ipcRenderer.invoke('credentials:set-provider-key', providerId, value, allowedEndpoints),
    deleteProviderKey: (providerId) => ipcRenderer.invoke('credentials:delete-provider-key', providerId),
  }),
  dataFiles: Object.freeze({
    saveBackup: (input) => ipcRenderer.invoke('data-files:save-backup', input),
    openBackup: () => ipcRenderer.invoke('data-files:open-backup'),
  }),
  providerRuns: Object.freeze({
    start: (input) => ipcRenderer.invoke('providers:start-run', input),
    cancel: (runId) => ipcRenderer.invoke('providers:cancel-run', runId),
    onEvent: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('Provider run listener must be a function.')
      const handler = (_event, payload) => listener(payload)
      ipcRenderer.on('providers:run-event', handler)
      return () => ipcRenderer.removeListener('providers:run-event', handler)
    },
  }),
  vaults: Object.freeze({
    select: () => ipcRenderer.invoke('vaults:select'),
    sync: (vaultId, revision) => ipcRenderer.invoke('vaults:sync', vaultId, revision),
    disconnect: (vaultId) => ipcRenderer.invoke('vaults:disconnect', vaultId),
    onChanged: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('Vault change listener must be a function.')
      const handler = (_event, payload) => listener(payload)
      ipcRenderer.on('vaults:changed', handler)
      return () => ipcRenderer.removeListener('vaults:changed', handler)
    },
  }),
})

contextBridge.exposeInMainWorld('researchDesktop', desktopApi)
