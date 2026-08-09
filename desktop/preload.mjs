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
})

contextBridge.exposeInMainWorld('researchDesktop', desktopApi)
