import { expect, test } from '@playwright/test'
import { createRuntimeManifest } from '../../shared/runtime-capabilities.mjs'

const PROBE_TEXT = 'BioResearch OS embedding dimension probe.'
const PROVIDER_CONFIG_KEY = 'bioresearch-os:provider-configs:v1'
const MODEL_CONFIG_KEY = 'bioresearch-os:model-config'

async function installRetrievalFixture(page) {
  await page.route('**/api/runtime', (route) => route.fulfill({
    json: createRuntimeManifest({ buildMode: 'test', target: 'vite-web' }),
  }))
  await page.goto('/')
  await page.evaluate(async ({ providerConfigKey, modelConfigKey }) => {
    localStorage.setItem(providerConfigKey, JSON.stringify({
      siliconflow: {
        endpoint: 'https://api.siliconflow.cn/v1',
        enabled: false,
        models: [
          { id: 'BAAI/bge-m3', name: 'BGE M3', kind: 'embedding', capabilities: { embedding: true, embeddings: true } },
          { id: 'BAAI/bge-reranker-v2-m3', name: 'BGE Reranker', kind: 'rerank', capabilities: { rerank: true } },
        ],
        selectedModelIds: [],
        lastFetchedAt: '2026-08-12T00:00:00.000Z',
      },
    }))
    localStorage.setItem(modelConfigKey, JSON.stringify({
      embeddingModelId: 'siliconflow:BAAI/bge-m3',
      rerankModelId: 'none',
      remoteEmbeddingConsent: true,
      chunkSize: 900,
      chunkOverlap: 120,
      topK: 6,
      hybridSearch: true,
      citations: true,
    }))
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('bioresearch-os', 2)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('snapshots')) request.result.createObjectStore('snapshots')
        if (!request.result.objectStoreNames.contains('handles')) request.result.createObjectStore('handles')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise((resolve, reject) => {
      const request = db.transaction('snapshots', 'readwrite').objectStore('snapshots').put({
        schemaVersion: 1,
        vaultName: 'retrieval-vault',
        notes: [{
          id: 'dimension-note',
          name: 'dimension-note.md',
          title: 'Dimension probe fixture',
          path: 'retrieval-vault/dimension-note.md',
          body: '# Dimension probe fixture\n\nA bounded Vault chunk continues after dimension discovery.',
          frontmatter: {},
          wikilinks: [],
          wordCount: 10,
        }],
        source: 'manual',
        revision: 'retrieval-vault-revision-1',
        savedAt: '2026-08-12T00:00:00.000Z',
      }, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  }, { providerConfigKey: PROVIDER_CONFIG_KEY, modelConfigKey: MODEL_CONFIG_KEY })
  await page.reload()
  const vaultScope = page.getByRole('button', { name: /retrieval-vault.*cached Markdown note/i })
  await expect(vaultScope).toBeVisible()
  await vaultScope.click()
}

async function openProviderModel(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: /SiliconFlow/ }).click()
  const modelRow = page.locator('.provider-model-list > div').filter({ hasText: 'BAAI/bge-m3' })
  await expect(modelRow).toContainText('Use in Retrieval')
  await modelRow.getByRole('button', { name: 'Use in Retrieval' }).click()
  await expect(page.getByLabel('Embedding model')).toHaveValue('siliconflow:BAAI/bge-m3')
}

async function persistedEmbeddingModel(page) {
  return page.evaluate(({ providerConfigKey }) => {
    const config = JSON.parse(localStorage.getItem(providerConfigKey) || '{}')
    return config.siliconflow?.models?.find((model) => model.id === 'BAAI/bge-m3') || null
  }, { providerConfigKey: PROVIDER_CONFIG_KEY })
}

test('routes a BGE retrieval model and continues the same Build after a dimension probe', async ({ page }) => {
  const calls = []
  await page.route('**/api/providers/embeddings', async (route) => {
    const body = route.request().postDataJSON()
    calls.push(body)
    expect(body.apiKey).toBe('')
    if (body.input === PROBE_TEXT) {
      expect(body).not.toHaveProperty('dimensions')
      expect(body).not.toHaveProperty('inputs')
      return route.fulfill({ json: {
        ok: true,
        providerId: 'siliconflow',
        modelId: 'BAAI/bge-m3',
        dimensions: 3,
        embeddings: [{ index: 0, vector: [0.1, -0.2, 0.3] }],
        provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' },
      } })
    }
    expect(body.dimensions).toBe(3)
    expect(Array.isArray(body.inputs)).toBe(true)
    return route.fulfill({ json: {
      ok: true,
      providerId: 'siliconflow',
      modelId: 'BAAI/bge-m3',
      dimensions: 3,
      embeddings: body.inputs.map((_input, index) => ({ index, vector: [0.1, 0.2, 0.3] })),
      provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' },
    } })
  })

  await installRetrievalFixture(page)
  await openProviderModel(page)
  const build = page.getByRole('button', { name: 'Build index' })
  await expect(build).toBeEnabled()
  await build.click()
  await expect.poll(() => calls.length).toBeGreaterThanOrEqual(1)
  const state = page.locator('.retrieval-index-lifecycle .settings-section-heading > span')
  await expect.poll(async () => state.textContent()).not.toBe('building')
  const persisted = await persistedEmbeddingModel(page)
  expect({ state: await state.textContent(), callCount: calls.length, dimensions: persisted.dimensions }).toEqual({ state: 'ready', callCount: 2, dimensions: 3 })
  expect(calls[0]).toMatchObject({ providerId: 'siliconflow', model: 'BAAI/bge-m3', input: PROBE_TEXT })
  expect(calls[1]).toMatchObject({ providerId: 'siliconflow', model: 'BAAI/bge-m3', dimensions: 3 })
  expect(JSON.stringify(persisted)).not.toContain(PROBE_TEXT)
  expect(JSON.stringify(persisted)).not.toContain('apiKey')
  expect(JSON.stringify(persisted)).not.toContain('vector')
})

test('cancels an in-flight dimension probe and ignores its late valid result', async ({ page }) => {
  let releaseProbe
  let signalProbe
  const probeSeen = new Promise((resolve) => { signalProbe = resolve })
  const probeRelease = new Promise((resolve) => { releaseProbe = resolve })
  const calls = []
  await page.route('**/api/providers/embeddings', async (route) => {
    calls.push(route.request().postDataJSON())
    signalProbe()
    await probeRelease
    await route.fulfill({ json: {
      ok: true,
      providerId: 'siliconflow',
      modelId: 'BAAI/bge-m3',
      dimensions: 3,
      embeddings: [{ index: 0, vector: [0.1, 0.2, 0.3] }],
      provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' },
    } }).catch(() => {})
  })

  await installRetrievalFixture(page)
  await openProviderModel(page)
  await page.getByRole('button', { name: 'Build index' }).click()
  await probeSeen
  await expect(page.getByRole('button', { name: 'Cancel build' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel build' }).click()
  releaseProbe()
  await expect(page.locator('.retrieval-index-lifecycle .settings-section-heading > span')).toHaveText('cancelled')
  await page.waitForTimeout(150)
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toHaveProperty('dimensions')
  expect((await persistedEmbeddingModel(page)).dimensions).toBeUndefined()
})

test('fails closed on a typed dimension-probe error without persisting metadata or starting a build', async ({ page }) => {
  const calls = []
  await page.route('**/api/providers/embeddings', async (route) => {
    calls.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: false, code: 'authentication_failed', error: 'RAW_PROVIDER_SECRET_MUST_NOT_RENDER' } })
  })

  await installRetrievalFixture(page)
  await openProviderModel(page)
  await page.getByRole('button', { name: 'Build index' }).click()
  await expect(page.locator('.retrieval-index-lifecycle .settings-section-heading > span')).toHaveText('failed')
  await expect(page.locator('.retrieval-index-lifecycle')).toContainText('Embedding provider authentication failed.')
  await expect(page.getByText('RAW_PROVIDER_SECRET_MUST_NOT_RENDER')).toHaveCount(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toHaveProperty('dimensions')
  const persisted = await persistedEmbeddingModel(page)
  expect(persisted.dimensions).toBeUndefined()
  expect(JSON.stringify(persisted)).not.toContain('RAW_PROVIDER_SECRET_MUST_NOT_RENDER')
})
