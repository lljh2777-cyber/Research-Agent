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

describe('Runtime Knowledge Read execution contract', () => {
  it('publishes the exact authoritative local-web capability shape', () => {
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.LOCAL_WEB })

    expect(manifest.capabilities.knowledgeReads).toEqual({
      available: true,
      transport: 'research-run',
      capabilities: READ_CAPABILITIES,
      reason: null,
    })
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
    const local = createRuntimeManifest({ target: RUNTIME_TARGETS.LOCAL_WEB })
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
