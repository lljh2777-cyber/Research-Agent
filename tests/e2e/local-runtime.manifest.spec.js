import { expect, test } from '@playwright/test'

async function installVaultSnapshot(page) {
  await page.evaluate(async () => {
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
        vaultName: 'runtime-manifest-vault',
        notes: [{
          id: 'runtime-note',
          name: 'README.md',
          title: 'Runtime manifest note',
          path: 'runtime-manifest-vault/README.md',
          body: '# Runtime manifest note\n\nCanonical capability consumer coverage.',
          frontmatter: {},
          wikilinks: [],
          wordCount: 7,
        }],
        source: 'manual',
        revision: 'runtime-manifest-rev',
        savedAt: '2026-08-10T04:00:00.000Z',
      }, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  })
}

test('configured full local Runtime advertises owned loopback and optional services', async ({ request }) => {
  const response = await request.get('/api/runtime')
  const manifest = await response.json()

  expect(response.ok()).toBe(true)
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    target: 'local-web',
    capabilities: {
      chatgptSubscriptionOAuth: true,
      credentials: { subscriptionOAuth: 'os-keychain' },
      localVault: { adapters: ['browser-picker', 'loopback-adapter'] },
      providerTransport: 'loopback',
      mcp: 'loopback',
      researchRuns: 'loopback-event-buffer',
      researchExecution: 'loopback-provider',
      annotations: {
        available: true,
        transport: 'same-origin',
        maxContentBytes: 65_536,
        maxRequestBytes: 131_072,
      },
      actions: {
        available: true,
        transport: 'same-origin',
        maxInputBytes: 131_072,
        maxOutputBytes: 65_536,
        maxContextBytes: 65_536,
        maxSessionHandoffBytes: 131_072,
      },
    },
  })

  const actions = await request.get('/api/runtime/actions')
  expect(actions.ok()).toBe(true)
  expect((await actions.json()).actions).toHaveLength(5)

  const annotations = await request.get('/api/runtime/annotations')
  expect(annotations.ok()).toBe(true)
  expect((await annotations.json()).annotations).toEqual([])
})

test('Knowledge Curator consumes the unmodified local Runtime actions and annotations manifest', async ({ page, request }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  const response = await request.get('/api/runtime')
  const manifest = await response.json()
  await page.goto('/')
  await installVaultSnapshot(page)
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()

  const panel = page.locator('.agent-conversation-panel.compact')
  const expected = [
    ['Lint', 'knowledge.lint'],
    ['Paper ingest', 'actions.paperIngest'],
    ['X-Ray', 'actions.xray'],
    ['Static code analysis', 'actions.codeAnalysis'],
    ['Synthesis', 'actions.synthesis'],
  ]
  for (const [title, capability] of expected) {
    const action = panel.getByRole('button', { name: new RegExp(title) })
    if (manifest.capabilities.actions?.available === true && manifest.capabilities.actions.capabilities?.[capability] === true) {
      await expect(action).toBeEnabled()
    } else {
      await expect(action).toBeDisabled()
    }
  }

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
