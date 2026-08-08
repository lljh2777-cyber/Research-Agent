import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeManifest, RUNTIME_TARGETS } from '../../shared/runtime-capabilities.mjs'
import {
  failClosedRuntimeManifest,
  fetchRuntimeManifest,
  loadRuntimeManifest,
  resetRuntimeManifestForTests,
} from '../../src/runtime/client.js'
import { getAuthServiceBaseUrl, getVaultServiceBaseUrl } from '../../src/runtime/services.js'

afterEach(() => {
  resetRuntimeManifestForTests()
  vi.unstubAllGlobals()
})

describe('runtime discovery client', () => {
  it('accepts a valid trusted runtime response', async () => {
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.LOCAL_WEB })
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(fetchRuntimeManifest(fetchImpl)).resolves.toEqual(manifest)
    expect(fetchImpl).toHaveBeenCalledWith('/api/runtime', expect.objectContaining({ cache: 'no-store' }))
  })

  it('prefers the allowlisted desktop preload bridge over HTTP discovery', async () => {
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.DESKTOP })
    vi.stubGlobal('window', { researchDesktop: { runtime: { getManifest: vi.fn(async () => manifest) } } })
    const fetchImpl = vi.fn()

    await expect(fetchRuntimeManifest(fetchImpl)).resolves.toEqual(manifest)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('falls back to the restricted hosted profile when discovery fails', async () => {
    const manifest = await loadRuntimeManifest(async () => { throw new TypeError('offline') })

    expect(manifest).toEqual(failClosedRuntimeManifest())
    expect(manifest.capabilities.chatgptSubscriptionOAuth).toBe(false)
    expect(manifest.capabilities.localVault.available).toBe(false)
  })

  it('centralizes local service defaults and environment overrides', () => {
    expect(getAuthServiceBaseUrl({})).toBe('http://127.0.0.1:4318')
    expect(getVaultServiceBaseUrl({})).toBe('http://127.0.0.1:4317')
    expect(getAuthServiceBaseUrl({ VITE_AUTH_SERVER_URL: 'http://localhost:9000/' })).toBe('http://localhost:9000')
    expect(getVaultServiceBaseUrl({ VITE_VAULT_API_URL: 'http://localhost:9001/' })).toBe('http://localhost:9001')
  })
})
