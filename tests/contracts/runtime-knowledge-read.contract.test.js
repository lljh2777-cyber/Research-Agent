import { describe, expect, it } from 'vitest'

import {
  createRuntimeManifest,
  isRuntimeManifest,
  RUNTIME_TARGETS,
} from '../../shared/runtime-capabilities.mjs'

const READ_CAPABILITIES = {
  'knowledge.query': true,
  'knowledge.explain': true,
}

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

describe('Runtime Knowledge Read execution contract', () => {
  it('fails nominal local-web closed without executable service evidence', () => {
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.LOCAL_WEB })

    expect(manifest.capabilities.knowledgeReads).toEqual({
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

  it('publishes the exact authoritative shape with explicit executable evidence', () => {
    const manifest = createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { knowledgeReads: EXECUTABLE_KNOWLEDGE_READS },
    })

    expect(manifest.capabilities.knowledgeReads).toEqual({
      available: true,
      transport: 'research-run',
      capabilities: READ_CAPABILITIES,
      reason: null,
    })
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it.each([
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: undefined },
    { ...EXECUTABLE_KNOWLEDGE_READS, researchRun: undefined },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, selected: false } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, providerId: '../provider' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, providerId: 'unknown-provider' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, model: '' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, endpoint: 'file:///model' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, credential: false } },
    { ...EXECUTABLE_KNOWLEDGE_READS, provider: { ...EXECUTABLE_KNOWLEDGE_READS.provider, providerId: 'openai', credential: 'not-required' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, researchRun: { executable: false, transport: 'research-run' } },
    { ...EXECUTABLE_KNOWLEDGE_READS, researchRun: { executable: true, transport: 'research-run-v1' } },
  ])('fails incomplete or malformed service evidence closed', (knowledgeReads) => {
    const manifest = createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { knowledgeReads },
    })

    expect(manifest.capabilities.knowledgeReads.available).toBe(false)
    expect(manifest.capabilities.knowledgeReads.transport).toBe(false)
    expect(manifest.capabilities.knowledgeReads.reason).toEqual(expect.any(String))
    expect(isRuntimeManifest(manifest)).toBe(true)
  })

  it.each([
    RUNTIME_TARGETS.VITE_WEB,
    RUNTIME_TARGETS.DESKTOP,
    RUNTIME_TARGETS.HOSTED_WEB,
  ])('fails %s closed without a Knowledge Read probe', (target) => {
    const manifest = createRuntimeManifest({ target })

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

  it('rejects preliminary, synthetic, missing, and malformed capability shapes', () => {
    const local = createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { knowledgeReads: EXECUTABLE_KNOWLEDGE_READS },
    })
    const vite = createRuntimeManifest({ target: RUNTIME_TARGETS.VITE_WEB })
    const variants = [
      { manifest: local, knowledgeReads: { ...local.capabilities.knowledgeReads, transport: 'research-run-v1' } },
      { manifest: vite, knowledgeReads: { ...vite.capabilities.knowledgeReads, available: true, transport: 'research-run', capabilities: READ_CAPABILITIES, reason: null } },
      { manifest: local, knowledgeReads: undefined },
      { manifest: local, knowledgeReads: { ...local.capabilities.knowledgeReads, capabilities: { ...READ_CAPABILITIES, 'knowledge.write': true } } },
    ]

    for (const { manifest, knowledgeReads } of variants) {
      expect(isRuntimeManifest({
        ...manifest,
        capabilities: { ...manifest.capabilities, knowledgeReads },
      })).toBe(false)
    }
  })
})
