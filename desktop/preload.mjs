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
})

contextBridge.exposeInMainWorld('researchDesktop', desktopApi)
