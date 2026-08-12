import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

import { createRuntimeManifest, RUNTIME_TARGETS } from '../../shared/runtime-capabilities.mjs'
import {
  createAnnotationPatchIntent,
  normalizeAnnotation,
} from '../../src/annotations/annotation.js'
import {
  createDesktopRuntimeAdapter,
  createWebRuntimeAdapter,
  getRuntimeAdapter,
  resetRuntimeAdapterForTests,
  runtimeAdapterInternals,
} from '../../src/runtime/adapter.js'
import { ANNOTATION_WRITE_STAGES, createAnnotationWriteIdempotencyKey } from '../../src/features/knowledge/annotationWriteClient.js'

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
      localStorage: storage,
      setTimeout,
      clearTimeout,
      showDirectoryPicker: vi.fn(async () => ({ name: 'picked-vault' })),
    }
    const adapter = createWebRuntimeAdapter({ windowRef, fetchImpl, env: {} })

    adapter.credentials.write('provider-keys', '{"deepseek":"session-secret"}')
    expect(adapter.credentials.read('provider-keys')).toContain('session-secret')
    adapter.storage.writeLocal('provider-config', '{"deepseek":true}')
    expect(adapter.storage.readLocal('provider-config')).toContain('deepseek')
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

  it('exposes stable Provider and MCP Web transports and composes Vault cancellation', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const adapter = createWebRuntimeAdapter({
      fetchImpl,
      env: {},
      windowRef: { setTimeout, clearTimeout },
    })
    const controller = new AbortController()

    await adapter.providers.discoverModels({
      providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'session-key', signal: controller.signal,
    })
    await adapter.providers.discoverModels({
      providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'session-key', signal: controller.signal,
    })
    await adapter.providers.streamResponse({
      providerId: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', messages: [], options: {}, signal: controller.signal,
    })
    await adapter.mcp.bootstrap({ signal: controller.signal })
    await adapter.mcp.request({ path: '/api/mcp/sessions/connect', body: { server: { id: 'bio' } }, runtimeToken: 'runtime-token', signal: controller.signal })
    await adapter.vault.probeLoopback({ signal: controller.signal })

    const modelCall = fetchImpl.mock.calls.find(([url]) => url === '/api/providers/models')
    expect(JSON.parse(modelCall[1].body)).toMatchObject({ providerId: 'deepseek', apiKey: 'session-key' })
    expect(modelCall[1].signal).toBe(controller.signal)
    const siliconFlowModelCall = fetchImpl.mock.calls.find(([url, options]) => url === '/api/providers/models' && JSON.parse(options.body).providerId === 'siliconflow')
    expect(JSON.parse(siliconFlowModelCall[1].body)).toMatchObject({ providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'session-key' })
    expect(siliconFlowModelCall[1].signal).toBe(controller.signal)
    const streamCall = fetchImpl.mock.calls.find(([url]) => url === '/api/providers/responses/stream')
    expect(streamCall[1].headers.Accept).toBe('text/event-stream')
    const mcpCall = fetchImpl.mock.calls.find(([url]) => url === '/api/mcp/sessions/connect')
    expect(mcpCall[1].headers['x-bioresearch-runtime-token']).toBe('runtime-token')
    const vaultCall = fetchImpl.mock.calls.find(([url]) => url === 'http://127.0.0.1:4317/api/health')
    expect(vaultCall[1].signal).toBeInstanceOf(AbortSignal)
    controller.abort()
    expect(vaultCall[1].signal.aborted).toBe(true)
  })

  it('exposes bounded embedding and rerank operations through the same abortable Provider boundary', async () => {
    const fetchImpl = vi.fn(async (url) => new Response(
      url === '/api/providers/embeddings'
        ? JSON.stringify({ ok: true, providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dimensions: 2, embeddings: [{ index: 0, vector: [0.1, 0.2] }], provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' } })
        : JSON.stringify({ ok: true, providerId: 'siliconflow', modelId: 'BAAI/bge-reranker-v2-m3', scores: [{ chunkId: 'chunk-1', score: 0.8 }], provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-reranker-v2-m3' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const adapter = createWebRuntimeAdapter({ fetchImpl, env: {}, windowRef: { setTimeout, clearTimeout } })
    const controller = new AbortController()

    await expect(adapter.providers.embed({
      providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'session-key', model: 'BAAI/bge-m3', input: 'text', signal: controller.signal,
    })).resolves.toMatchObject({ dimensions: 2, provenance: { providerId: 'siliconflow' } })
    await expect(adapter.providers.rerank({
      providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'session-key', model: 'BAAI/bge-reranker-v2-m3', query: 'q', candidates: [{ chunkId: 'chunk-1', excerpt: 'text' }], signal: controller.signal,
    })).resolves.toMatchObject({ scores: [{ chunkId: 'chunk-1', score: 0.8 }] })

    const embeddingCall = fetchImpl.mock.calls.find(([url]) => url === '/api/providers/embeddings')
    const rerankCall = fetchImpl.mock.calls.find(([url]) => url === '/api/providers/rerank')
    expect(embeddingCall[1].signal).toBe(controller.signal)
    expect(rerankCall[1].signal).toBe(controller.signal)
    expect(JSON.parse(embeddingCall[1].body)).toMatchObject({ providerId: 'siliconflow', apiKey: 'session-key', model: 'BAAI/bge-m3', input: 'text' })
    expect(JSON.parse(rerankCall[1].body)).toMatchObject({ providerId: 'siliconflow', apiKey: 'session-key', model: 'BAAI/bge-reranker-v2-m3', query: 'q' })
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

  it('fails optional surfaces closed, then uses same-origin AbortSignal-aware transports after manifest discovery', async () => {
    const fetchImpl = vi.fn(async (url) => new Response(
      url.includes('/events?') ? '' : JSON.stringify({ ok: true }),
      { status: 200, headers: { 'Content-Type': url.includes('/events?') ? 'text/event-stream' : 'application/json' } },
    ))
    const adapter = createWebRuntimeAdapter({
      fetchImpl,
      env: {},
      windowRef: { setTimeout, clearTimeout },
    })

    await expect(adapter.annotations.list()).resolves.toMatchObject({
      ok: false,
      unavailable: true,
      surface: 'annotations',
    })
    await expect(adapter.actions.list()).resolves.toMatchObject({
      ok: false,
      unavailable: true,
      surface: 'actions',
    })
    expect(fetchImpl).not.toHaveBeenCalled()

    adapter.runtime.setManifest(createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { annotations: true, actions: true },
    }))
    const controller = new AbortController()
    const intent = {
      kind: 'annotation.upsert',
      annotationId: 'annotation-1',
      target: {
        vaultId: 'vault-1',
        path: 'wiki/annotations/annotation-1.md',
        expectedRevision: null,
      },
      contentType: 'text/markdown',
      content: '# Annotation v1',
    }
    await adapter.annotations.read({ path: intent.target.path, signal: controller.signal })
    await adapter.annotations.write({
      intent,
      idempotencyKey: 'annotation-write-1',
      approval: { status: 'approved' },
      signal: controller.signal,
    })
    await adapter.actions.list({ signal: controller.signal })
    await adapter.actions.start({
      schemaVersion: 1,
      toolId: 'knowledge.lint',
      requestId: 'call-1',
      runId: 'run-1',
      sessionId: 'session-1',
      context: { schemaVersion: 1 },
      scope: null,
      idempotencyKey: null,
      input: { rules: [] },
      signal: controller.signal,
    })
    const followed = await adapter.actions.follow('run-1', { after: 2, signal: controller.signal })
    await adapter.actions.cancel('run-1', { signal: controller.signal })

    expect(followed).toMatchObject({ ok: true, response: expect.any(Response) })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/runtime/annotations?path=wiki%2Fannotations%2Fannotation-1.md',
      expect.objectContaining({ signal: controller.signal }),
    )
    const annotationWrite = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(annotationWrite[1].body)).toEqual({
      intent,
      idempotencyKey: 'annotation-write-1',
      approval: { status: 'approved' },
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/runtime/actions/run-1/events?after=2',
      expect.objectContaining({ signal: controller.signal }),
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/runtime/actions/run-1',
      expect.objectContaining({ method: 'DELETE', signal: controller.signal }),
    )
  })

  it('preflights the exact serialized Annotation request bytes and rejects the KB escaping adversary before fetch', async () => {
    const fixture = async (name) => JSON.parse(await readFile(new URL(`../../docs/contracts/${name}`, import.meta.url), 'utf8'))
    const recipe = await fixture('annotation-write-boundary-v1.fixture.json')
    const source = normalizeAnnotation(await fixture(recipe.baseAnnotationFixture))
    const adversarial = normalizeAnnotation({
      ...source,
      sections: {
        ...source.sections,
        manual: recipe.runtimeEnvelopeAdversary.manualCharacter.repeat(recipe.runtimeEnvelopeAdversary.repeat),
      },
    })
    const intent = createAnnotationPatchIntent(adversarial, {
      path: 'wiki/annotations/adversarial.md',
      expectedRevision: null,
    })
    const request = { intent, idempotencyKey: 'fixture-key', approval: { status: 'approved' } }
    expect(new TextEncoder().encode(intent.content).length).toBeLessThanOrEqual(65_536)
    expect(runtimeAdapterInternals.serializeAnnotationRequest(request)).toEqual({
      ok: false,
      code: 'limit_exceeded',
      error: 'Annotation request exceeds the 131,072-byte limit.',
    })

    const fetchImpl = vi.fn()
    const adapter = createWebRuntimeAdapter({
      fetchImpl,
      env: {},
      windowRef: { setTimeout, clearTimeout },
    })
    adapter.runtime.setManifest(createRuntimeManifest({
      target: RUNTIME_TARGETS.LOCAL_WEB,
      services: { annotations: true },
    }))
    await expect(adapter.annotations.write(request)).resolves.toMatchObject({
      ok: false,
      code: 'limit_exceeded',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('carries stable valid and stage-distinct Annotation write keys through the real Adapter envelope', async () => {
    const baseIntent = {
      schemaVersion: 1,
      kind: 'annotation.upsert',
      annotationId: 'annotation-1',
      target: { vaultId: 'vault-1', path: 'wiki/annotations/annotation-1.md', expectedRevision: null },
      contentType: 'text/markdown',
      content: '# Saved body\n',
    }
    const intents = [
      baseIntent,
      { ...baseIntent, target: { ...baseIntent.target, expectedRevision: 'revision-1' }, content: '# Archive pending\n' },
      { ...baseIntent, target: { ...baseIntent.target, expectedRevision: 'revision-2' }, content: '# Archive completed\n' },
    ]
    const stages = [
      ANNOTATION_WRITE_STAGES.BODY,
      ANNOTATION_WRITE_STAGES.ARCHIVE_PENDING,
      ANNOTATION_WRITE_STAGES.ARCHIVE_COMPLETED,
    ]
    const keys = await Promise.all(intents.map((intent, index) => createAnnotationWriteIdempotencyKey(intent, stages[index])))
    await expect(createAnnotationWriteIdempotencyKey(intents[1], stages[1])).resolves.toBe(keys[1])
    expect(new Set(keys).size).toBe(3)
    keys.forEach((key) => expect(key).toMatch(/^[A-Za-z0-9._:-]{8,160}$/))

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const adapter = createWebRuntimeAdapter({ fetchImpl, env: {}, windowRef: { setTimeout, clearTimeout } })
    adapter.runtime.setManifest(createRuntimeManifest({ target: RUNTIME_TARGETS.LOCAL_WEB, services: { annotations: true } }))
    for (let index = 0; index < intents.length; index += 1) {
      await adapter.annotations.write({ intent: intents[index], idempotencyKey: keys[index], approval: { status: 'approved' } })
    }
    const envelopes = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body))
    expect(envelopes.map(({ idempotencyKey }) => idempotencyKey)).toEqual(keys)
    expect(envelopes.every(({ approval }) => approval.status === 'approved')).toBe(true)
  })
})
