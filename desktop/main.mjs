import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'

import { startAuthServer } from '../server/auth-server.mjs'
import { BUILD_MODES, createRuntimeManifest, RUNTIME_TARGETS } from '../shared/runtime-capabilities.mjs'
import { createDesktopAppServer } from './app-server.mjs'
import { EncryptedCredentialStore } from './credential-store.mjs'
import { ProviderRunManager } from './provider-run-manager.mjs'
import { DesktopVaultManager } from './vault-manager.mjs'

const desktopDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(desktopDir, '..')
const preloadPath = join(desktopDir, 'preload.mjs')
const devUrl = process.env.BIORESEARCH_DESKTOP_DEV_URL || ''
const allowedExternalHosts = new Set([
  'aistudio.google.com',
  'auth.openai.com',
  'bailian.console.aliyun.com',
  'chatgpt.com',
  'console.anthropic.com',
  'openrouter.ai',
  'platform.deepseek.com',
  'platform.openai.com',
])

let mainWindow
let appServer
let ownedAuthServer
let desktopOrigin = ''
let credentialStore
let providerRunManager
let vaultManager

function isTrustedLoopbackUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  } catch {
    return false
  }
}

function hasSameOrigin(value, trustedOrigin) {
  try {
    return new URL(value).origin === new URL(trustedOrigin).origin
  } catch {
    return false
  }
}

if (devUrl && !isTrustedLoopbackUrl(devUrl)) {
  throw new Error('BIORESEARCH_DESKTOP_DEV_URL must use HTTP on 127.0.0.1 or localhost.')
}

async function ensureAuthServer() {
  try {
    const response = await fetch('http://127.0.0.1:4318/api/health', { signal: AbortSignal.timeout(700) })
    if (response.ok) return
  } catch {}
  ownedAuthServer = startAuthServer()
}

function trustedIpcSender(event) {
  const sourceUrl = event.senderFrame?.url || ''
  if (desktopOrigin && hasSameOrigin(sourceUrl, desktopOrigin)) return true
  return Boolean(devUrl && hasSameOrigin(sourceUrl, devUrl))
}

function requireTrustedSender(event) {
  if (!trustedIpcSender(event)) throw new Error('Untrusted desktop IPC sender.')
}

function registerIpc(runtimeManifest) {
  ipcMain.handle('runtime:get-manifest', (event) => {
    requireTrustedSender(event)
    return runtimeManifest
  })
  ipcMain.handle('credentials:has-provider-key', async (event, providerId) => {
    requireTrustedSender(event)
    return credentialStore.has(providerId)
  })
  ipcMain.handle('credentials:set-provider-key', async (event, providerId, value, allowedEndpoints) => {
    requireTrustedSender(event)
    if (typeof value !== 'string' || value.length > 16_384) throw new Error('Invalid provider credential.')
    await credentialStore.set(providerId, value, allowedEndpoints)
    return { ok: true }
  })
  ipcMain.handle('credentials:delete-provider-key', async (event, providerId) => {
    requireTrustedSender(event)
    await credentialStore.delete(providerId)
    return { ok: true }
  })
  ipcMain.handle('providers:start-run', (event, input) => {
    requireTrustedSender(event)
    const ownerId = event.sender.id
    return providerRunManager.start(ownerId, input, (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('providers:run-event', payload)
    })
  })
  ipcMain.handle('providers:cancel-run', (event, runId) => {
    requireTrustedSender(event)
    return providerRunManager.cancel(event.sender.id, runId)
  })
  ipcMain.handle('vaults:select', async (event) => {
    requireTrustedSender(event)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Select an Obsidian Vault',
      properties: ['openDirectory'],
    }
    const selection = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (selection.canceled || selection.filePaths.length !== 1) return { cancelled: true }
    const ownerId = event.sender.id
    return vaultManager.connect(ownerId, selection.filePaths[0], (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('vaults:changed', payload)
    })
  })
  ipcMain.handle('vaults:sync', (event, vaultId, revision) => {
    requireTrustedSender(event)
    return vaultManager.sync(event.sender.id, vaultId, revision)
  })
  ipcMain.handle('vaults:disconnect', (event, vaultId) => {
    requireTrustedSender(event)
    return vaultManager.disconnect(event.sender.id, vaultId)
  })
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#07101f',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      if (target.protocol === 'https:' && allowedExternalHosts.has(target.hostname)) void shell.openExternal(url)
    } catch {}
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const trusted = desktopOrigin ? hasSameOrigin(url, desktopOrigin) : devUrl && hasSameOrigin(url, devUrl)
    if (!trusted) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  const ownerId = mainWindow.webContents.id
  mainWindow.webContents.once('destroyed', () => {
    providerRunManager?.cancelOwner(ownerId)
    vaultManager?.cancelOwner(ownerId)
  })
  await mainWindow.loadURL(devUrl || desktopOrigin)
}

async function shutdown() {
  ipcMain.removeHandler('runtime:get-manifest')
  ipcMain.removeHandler('credentials:has-provider-key')
  ipcMain.removeHandler('credentials:set-provider-key')
  ipcMain.removeHandler('credentials:delete-provider-key')
  ipcMain.removeHandler('providers:start-run')
  ipcMain.removeHandler('providers:cancel-run')
  ipcMain.removeHandler('vaults:select')
  ipcMain.removeHandler('vaults:sync')
  ipcMain.removeHandler('vaults:disconnect')
  vaultManager?.close()
  await appServer?.close().catch(() => {})
  if (ownedAuthServer?.listening) await new Promise((resolveClose) => ownedAuthServer.close(resolveClose))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const runtimeManifest = createRuntimeManifest({
      buildMode: app.isPackaged ? BUILD_MODES.PRODUCTION : BUILD_MODES.DEVELOPMENT,
      target: RUNTIME_TARGETS.DESKTOP,
      version: app.getVersion(),
    })
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-backed credential encryption is unavailable.')
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('A secure Linux secret store is required for provider credentials.')
    }
    credentialStore = new EncryptedCredentialStore({
      filePath: join(app.getPath('userData'), 'provider-credentials.json'),
      encrypt: async (value) => safeStorage.encryptString(value).toString('base64'),
      decrypt: async (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    })
    providerRunManager = new ProviderRunManager({
      credentialResolver: (providerId, endpoint) => credentialStore.get(providerId, endpoint),
    })
    vaultManager = new DesktopVaultManager()
    if (!devUrl) {
      appServer = createDesktopAppServer({
        rootDir: join(projectRoot, 'dist'),
        runtimeManifest,
        credentialResolver: (providerId, endpoint) => credentialStore.get(providerId, endpoint),
      })
      desktopOrigin = await appServer.listen()
    }
    registerIpc(runtimeManifest)
    await ensureAuthServer()
    await createMainWindow()
  }).catch((error) => {
    console.error(`[desktop] startup failed: ${error.message}`)
    app.quit()
  })

  app.on('window-all-closed', () => {
    shutdown().finally(() => app.quit())
  })
}
