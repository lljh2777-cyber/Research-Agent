import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRuntimeManifest, RUNTIME_TARGETS } from '../../shared/runtime-capabilities.mjs'
import {
  createDesktopRuntimeAdapter,
  createWebRuntimeAdapter,
  getRuntimeAdapter,
  resetRuntimeAdapterForTests,
} from '../../src/runtime/adapter.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

afterEach(() => {
  resetRuntimeAdapterForTests()
  vi.unstubAllGlobals()
})

describe('runtime adapters', () => {
  it('keeps Web API, Vault, and credentials behind one injected boundary', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify({
      vaultName: 'research-vault',
      revision: 'r1',
      files: [{ path: 'notes/cellchat.md', content: '# CellChat' }],
      url,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const windowRef = {
      sessionStorage: storage,
      setTimeout,
      clearTimeout,
      showDirectoryPicker: vi.fn(async () => ({ name: 'picked-vault' })),
    }
    const adapter = createWebRuntimeAdapter({ windowRef, fetchImpl, env: {} })

    adapter.credentials.write('provider-keys', '{"deepseek":"session-secret"}')
    expect(adapter.credentials.read('provider-keys')).toContain('session-secret')
    await expect(adapter.vault.selectDirectory()).resolves.toEqual({ handle: { name: 'picked-vault' } })

    const snapshot = await adapter.vault.loadLoopback({ revision: 'old' })
    expect(snapshot.notes[0]).toMatchObject({ title: 'CellChat', path: 'notes/cellchat.md' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4317/api/vault?since=old',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await adapter.researchRuns.create({ id: 'run-web' })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/research/runs',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ id: 'run-web' }) }),
    )
    await adapter.researchRuns.start('run-web', { kind: 'provider' })
    await adapter.researchRuns.submitToolResult('run-web', 'request-1', { content: '{}' })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/research/runs/run-web/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'provider' }) }),
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/research/runs/run-web/tool-results',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId: 'request-1', result: { content: '{}' } }) }),
    )
  })

  it('replaces only runtime operations when an Electron preload bridge exists', async () => {
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.DESKTOP })
    const calls = []
    const adapter = createDesktopRuntimeAdapter({
      windowRef: { setTimeout, clearTimeout },
      bridge: {
        runtime: { getManifest: async () => manifest },
        credentials: {
          hasProviderKey: async (providerId) => providerId === 'deepseek',
          setProviderKey: async (...args) => calls.push(['set', ...args]),
          deleteProviderKey: async (...args) => calls.push(['delete', ...args]),
        },
        vaults: {
          select: async () => ({ vaultId: 'vault-1', files: [{ path: 'paper.md', content: '# Paper' }] }),
          sync: async (vaultId, revision) => ({ vaultId, revision, unchanged: true }),
          onChanged: () => () => {},
        },
      },
    })

    await expect(adapter.runtime.getManifest()).resolves.toEqual(manifest)
    await expect(adapter.credentials.hasProviderKey('deepseek')).resolves.toBe(true)
    await adapter.credentials.setProviderKey('deepseek', 'secret', ['https://api.deepseek.com'])
    expect(calls).toEqual([['set', 'deepseek', 'secret', ['https://api.deepseek.com']]])
    await expect(adapter.vault.selectDesktop()).resolves.toMatchObject({
      vaultId: 'vault-1',
      notes: [{ title: 'Paper', path: 'paper.md' }],
    })
  })

  it('selects the adapter from the preload surface without exposing it to consumers', () => {
    vi.stubGlobal('window', { researchDesktop: { credentials: {
      hasProviderKey: vi.fn(), setProviderKey: vi.fn(), deleteProviderKey: vi.fn(),
    } } })

    const adapter = getRuntimeAdapter()
    expect(adapter.kind).toBe('desktop')
    expect(adapter.credentials.mode).toBe('os-keychain')
    expect('researchDesktop' in adapter).toBe(false)
  })
})
