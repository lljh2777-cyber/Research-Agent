import { describe, expect, it } from 'vitest'

import {
  BUILD_MODES,
  createRuntimeManifest,
  isRuntimeManifest,
  RUNTIME_TARGETS,
} from '../../shared/runtime-capabilities.mjs'
import {
  createKnowledgeReadServiceEvidence,
  createLocalWebRuntimeManifest,
  createViteWebRuntimeManifest,
} from '../../server/runtime-api.mjs'

const EXECUTABLE_KNOWLEDGE_READS = {
  provider: {
    selected: true,
    providerId: 'compatible',
    endpoint: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    credential: 'not-required',
  },
  researchRun: { executable: true, transport: 'research-run' },
}

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
    expect(manifest.capabilities.researchRuns).toBe('loopback-event-buffer')
    expect(manifest.capabilities.researchExecution).toBe('loopback-provider')
    expect(manifest.capabilities.knowledgeReads).toEqual({
      available: false,
      transport: false,
      capabilities: {
        'knowledge.query': false,
        'knowledge.explain': false,
      },
      reason: expect.any(String),
    })
    expect(manifest.capabilities.mcp).toBe('loopback')
    expect(manifest.capabilities.annotations.available).toBe(false)
    expect(manifest.capabilities.actions.available).toBe(false)
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it('publishes Knowledge Reads only with explicit Provider and Research Run evidence', () => {
    const manifest = createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { knowledgeReads: EXECUTABLE_KNOWLEDGE_READS },
    })

    expect(manifest.capabilities.knowledgeReads).toEqual({
      available: true,
      transport: 'research-run',
      capabilities: {
        'knowledge.query': true,
        'knowledge.explain': true,
      },
      reason: null,
    })
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it.each([
    undefined,
    {},
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: undefined },
    { ...EXECUTABLE_KNOWLEDGE_READS, researchRun: undefined },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, selected: false } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, providerId: 'unknown-provider' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, endpoint: 'file:///vault/model' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, credential: 'unknown' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, providerId: 'openai', credential: 'not-required' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, researchRun: { executable: true, transport: 'research-run-v1' } },
  ])('fails malformed or incomplete Knowledge Read evidence closed', (knowledgeReads) => {
    const manifest = createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { knowledgeReads },
    })

    expect(manifest.capabilities.knowledgeReads).toMatchObject({
      available: false,
      transport: false,
      capabilities: {
        'knowledge.query': false,
        'knowledge.explain': false,
      },
      reason: expect.any(String),
    })
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it('publishes configured annotation and Action services only for full local Web', () => {
    const manifest = createRuntimeManifest({
      buildMode: BUILD_MODES.DEVELOPMENT,
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { annotations: true, actions: true },
    })

    expect(manifest.capabilities.annotations).toMatchObject({
      available: true,
      transport: 'same-origin',
      capability: 'annotations.write',
      maxContentBytes: 65_536,
      maxRequestBytes: 131_072,
      reason: null,
    })
    expect(manifest.capabilities.actions).toMatchObject({
      available: true,
      transport: 'same-origin',
      maxInputBytes: 131_072,
      maxOutputBytes: 65_536,
      maxContextBytes: 65_536,
      maxSessionHandoffBytes: 131_072,
      reason: null,
      capabilities: {
        'knowledge.lint': true,
        'actions.paperIngest': true,
        'actions.xray': true,
        'actions.codeAnalysis': true,
        'actions.synthesis': true,
      },
    })
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it('fails unknown targets closed as hosted Web', () => {
    const manifest = createRuntimeManifest({ target: 'unknown-target' })

    expect(manifest.target).toBe(RUNTIME_TARGETS.HOSTED_WEB)
    expect(manifest.capabilities.localVault.available).toBe(false)
    expect(manifest.capabilities.chatgptSubscriptionOAuth).toBe(false)
    expect(manifest.capabilities.mcp).toBe(false)
    expect(manifest.capabilities.researchRuns).toBe(false)
    expect(manifest.capabilities.researchExecution).toBe(false)
    expect(manifest.capabilities.knowledgeReads.available).toBe(false)
    expect(manifest.capabilities.annotations.available).toBe(false)
    expect(manifest.capabilities.actions.available).toBe(false)
  })

  it('describes the desktop security boundary independently from build mode', () => {
    const manifest = createRuntimeManifest({
      buildMode: BUILD_MODES.DEVELOPMENT,
      target: RUNTIME_TARGETS.DESKTOP,
    })

    expect(manifest.buildMode).toBe(BUILD_MODES.DEVELOPMENT)
    expect(manifest.capabilities.credentials.providerApiKeys).toBe('os-keychain')
    expect(manifest.capabilities.providerTransport).toBe('desktop-ipc')
    expect(manifest.capabilities.researchRuns).toBe('loopback-event-buffer')
    expect(manifest.capabilities.researchExecution).toBe('renderer-provider-ipc')
    expect(manifest.capabilities.localVault.adapters).toEqual(['desktop-ipc'])
    expect(manifest.capabilities.localVault.preferred).toBe('desktop-ipc')
    expect(manifest.capabilities.mcp).toBe('desktop-loopback')
    expect(manifest.capabilities.annotations.reason).toMatch(/not implemented/i)
    expect(manifest.capabilities.actions.reason).toMatch(/not implemented/i)
    expect(manifest.capabilities.knowledgeReads).toMatchObject({
      available: false,
      transport: false,
      capabilities: {
        'knowledge.query': false,
        'knowledge.explain': false,
      },
    })
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
    const manifest = createLocalWebRuntimeManifest({ nodeEnv: 'test', version: '1.2.3', vaultRoot: 'Z:/definitely-missing-runtime-vault' })

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      buildMode: BUILD_MODES.TEST,
      target: RUNTIME_TARGETS.LOCAL_WEB,
      appVersion: '1.2.3',
    })
    expect(manifest.capabilities.knowledgeReads.available).toBe(false)
  })

  it('composes a local manifest from explicit server-side execution evidence', () => {
    const manifest = createLocalWebRuntimeManifest({
      nodeEnv: 'test',
      services: {
        knowledgeReads: createKnowledgeReadServiceEvidence({
          providerId: 'compatible',
          endpoint: 'http://127.0.0.1:1234/v1',
          model: 'local-model',
          credential: 'not-required',
          researchRunExecutable: true,
        }),
      },
    })

    expect(manifest.capabilities.knowledgeReads).toEqual({
      available: true,
      transport: 'research-run',
      capabilities: {
        'knowledge.query': true,
        'knowledge.explain': true,
      },
      reason: null,
    })
  })

  it('fails Vite-only dev Web closed for unavailable loopback services', () => {
    const manifest = createViteWebRuntimeManifest({ nodeEnv: 'test', version: '1.2.3' })

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      buildMode: BUILD_MODES.TEST,
      target: RUNTIME_TARGETS.VITE_WEB,
      appVersion: '1.2.3',
      capabilities: {
        chatgptSubscriptionOAuth: false,
        credentials: { subscriptionOAuth: false },
        annotations: { available: false, transport: false },
        actions: { available: false, transport: false },
        knowledgeReads: {
          available: false,
          transport: false,
          capabilities: {
            'knowledge.query': false,
            'knowledge.explain': false,
          },
        },
        localVault: { adapters: ['browser-picker'] },
      },
    })
    expect(isRuntimeManifest(manifest)).toBe(true)
  })
})
