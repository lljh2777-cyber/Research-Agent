import { describe, expect, it } from 'vitest'

import {
  BUILD_MODES,
  createRuntimeManifest,
  isRuntimeManifest,
  RUNTIME_TARGETS,
} from '../../shared/runtime-capabilities.mjs'
import { createLocalWebRuntimeManifest } from '../../server/runtime-api.mjs'

describe('runtime capability matrix', () => {
  it('keeps local Web behavior local-first', () => {
    const manifest = createRuntimeManifest({
      buildMode: BUILD_MODES.DEVELOPMENT,
      target: RUNTIME_TARGETS.LOCAL_WEB,
    })

    expect(manifest.capabilities.localVault.adapters).toEqual(['browser-picker', 'loopback-adapter'])
    expect(manifest.capabilities.credentials.providerApiKeys).toBe('session')
    expect(manifest.capabilities.credentials.subscriptionOAuth).toBe('os-keychain')
    expect(manifest.capabilities.chatgptSubscriptionOAuth).toBe(true)
    expect(manifest.capabilities.providerTransport).toBe('loopback')
    expect(manifest.capabilities.mcp).toBe('loopback')
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it('fails unknown targets closed as hosted Web', () => {
    const manifest = createRuntimeManifest({ target: 'unknown-target' })

    expect(manifest.target).toBe(RUNTIME_TARGETS.HOSTED_WEB)
    expect(manifest.capabilities.localVault.available).toBe(false)
    expect(manifest.capabilities.chatgptSubscriptionOAuth).toBe(false)
    expect(manifest.capabilities.mcp).toBe(false)
  })

  it('describes the desktop security boundary independently from build mode', () => {
    const manifest = createRuntimeManifest({
      buildMode: BUILD_MODES.DEVELOPMENT,
      target: RUNTIME_TARGETS.DESKTOP,
    })

    expect(manifest.buildMode).toBe(BUILD_MODES.DEVELOPMENT)
    expect(manifest.capabilities.credentials.providerApiKeys).toBe('os-keychain')
    expect(manifest.capabilities.providerTransport).toBe('desktop-ipc')
    expect(manifest.capabilities.localVault.preferred).toBe('browser-picker')
    expect(manifest.capabilities.mcp).toBe('desktop-loopback')
  })

  it('rejects a manifest with injected local adapters', () => {
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.DESKTOP })
    const tampered = {
      ...manifest,
      capabilities: {
        ...manifest.capabilities,
        localVault: { ...manifest.capabilities.localVault, adapters: [...manifest.capabilities.localVault.adapters, 'untrusted-adapter'] },
      },
    }

    expect(isRuntimeManifest(tampered)).toBe(false)
  })

  it('creates the current Vite runtime as local Web', () => {
    const manifest = createLocalWebRuntimeManifest({ nodeEnv: 'test', version: '1.2.3' })

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      buildMode: BUILD_MODES.TEST,
      target: RUNTIME_TARGETS.LOCAL_WEB,
      appVersion: '1.2.3',
    })
  })
})
