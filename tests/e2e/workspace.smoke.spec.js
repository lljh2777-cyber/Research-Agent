import { expect, test } from '@playwright/test'

test('opens the local research workspace and launcher without runtime errors', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && /^http:\/\/127\.0\.0\.1:431[78]\//.test(message.location().url)) consoleErrors.push(message.text())
  })

  await page.goto('/')

  await expect(page).toHaveTitle(/BioResearch OS/i)
  await expect(page.getByRole('heading', { name: 'Configure your research workspace' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /New research/i })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect Obsidian vault' })).toContainText('Connect a Vault')
  await expect(page.getByRole('button', { name: 'Connect Obsidian vault' })).toContainText('Choose a local Obsidian folder')
  await expect(page.getByText('Tumor Niche Workspace')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open launcher' }).click()

  await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible()
  await expect(page.locator('.workspace-launcher-grid').getByRole('button', { name: /Knowledge graph/i })).toBeVisible()
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('exposes a fail-closed Vite-only runtime manifest', async ({ request }) => {
  const response = await request.get('/api/runtime')
  const manifest = await response.json()

  expect(response.ok()).toBe(true)
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    target: 'vite-web',
    capabilities: {
      chatgptSubscriptionOAuth: false,
      localVault: { adapters: ['browser-picker'] },
      providerTransport: 'loopback',
      mcp: 'loopback',
    },
  })
})

test('does not present an unversioned legacy Vault snapshot as a current connection', async ({ page }) => {
  await page.goto('/')
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
        vaultName: 'legacy-knowledge-base',
        notes: [{ id: 'legacy-note', title: 'Legacy', path: 'legacy.md', body: '# Legacy' }],
        source: 'manual',
      }, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  })

  await page.reload()

  const vaultButton = page.getByRole('button', { name: 'Connect Obsidian vault' })
  await expect(vaultButton).toContainText('Connect a Vault')
  await expect(vaultButton).not.toContainText('legacy-knowledge-base')
})

test('labels a valid restored Vault snapshot as cached until it is reconnected', async ({ page }) => {
  await page.goto('/')
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
        vaultName: 'saved-vault',
        notes: [{ id: 'saved-note', title: 'Saved', path: 'saved.md', body: '# Saved' }],
        source: 'manual',
        revision: '',
        savedAt: '2026-08-09T00:00:00.000Z',
      }, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  })

  await page.reload()

  const vaultButton = page.getByRole('button', { name: 'Reconnect saved-vault Vault' })
  await expect(vaultButton).toContainText('saved-vault')
  await expect(vaultButton).toContainText('1 cached Markdown note · reconnect to refresh')
  await expect(page.getByRole('button', { name: /saved-vault.*cached Markdown note/i })).toBeVisible()
})

test('restores workspace tabs and conversation configuration after reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open launcher' }).click()
  await page.locator('.workspace-launcher-grid').getByRole('button', { name: /Research Start an independent conversation/i }).click()
  await page.getByRole('textbox', { name: 'Agent name' }).fill('Persistent Biologist')
  const tabCount = await page.getByRole('tab').count()

  await page.waitForTimeout(450)
  await page.reload()

  await expect(page.getByRole('textbox', { name: 'Agent name' })).toHaveValue('Persistent Biologist')
  await expect(page.getByRole('tab')).toHaveCount(tabCount)
})

test('records a terminal Research Run for the offline evidence-only path', async ({ page }) => {
  await page.route('http://127.0.0.1:4318/**', (route) => route.abort())
  await page.goto('/')
  await page.getByRole('button', { name: 'Start conversation' }).click()
  await page.getByRole('textbox', { name: 'Ask a follow-up about your research...' }).fill('What evidence is available?')
  await page.getByRole('button', { name: 'Send question' }).click()

  await expect(page.getByText(/No relevant Markdown evidence matched this question/i)).toBeVisible({ timeout: 7_000 })
  await expect(page.locator('.message-time')).toContainText('0 sources')
  await expect(page.locator('.message-time')).not.toContainText('10:24 AM')
  await page.waitForTimeout(400)
  const latestRun = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('bioresearch-os-workspace', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const workspace = await new Promise((resolve, reject) => {
      const request = db.transaction('snapshots', 'readonly').objectStore('snapshots').get('current-workspace')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    const session = workspace.sessions[workspace.activeTabId]
    return session.runSnapshots.at(-1)
  })

  expect(latestRun).toMatchObject({ schemaVersion: 1, status: 'completed', iteration: 1, evidenceCount: 0 })
})

test('exports, clears, and restores portable local data', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: '数据管理', exact: true }).click()

  await expect(page.getByRole('heading', { name: '数据管理' })).toBeVisible()
  const conversationSummary = page.locator('.data-summary-strip > div').filter({ hasText: 'Conversations' })
  await expect(conversationSummary.locator('strong')).toHaveText('1')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup', exact: true }).click()
  const download = await downloadPromise
  const backupPath = await download.path()
  expect(backupPath).toBeTruthy()
  await expect(page.locator('.data-action-feedback')).toContainText('Downloaded')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Clear history', exact: true }).click()
  await expect(conversationSummary.locator('strong')).toHaveText('0')
  await expect(page.locator('.data-action-feedback')).toContainText(/cleared/i)

  await page.getByLabel('Select BioResearch OS backup').setInputFiles(backupPath)
  await expect(conversationSummary.locator('strong')).toHaveText('1')
  await expect(page.locator('.data-action-feedback')).toContainText(/restored/i)
})

test('routes backup files through the desktop preload bridge when available', async ({ page }) => {
  await page.addInitScript(() => {
    let backupContent = ''
    window.researchDesktop = {
      dataFiles: {
        saveBackup: async ({ content }) => {
          backupContent = content
          return { cancelled: false, fileName: 'native-backup.json', bytes: new TextEncoder().encode(content).length }
        },
        openBackup: async () => ({ cancelled: false, fileName: 'native-backup.json', content: backupContent }),
      },
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: '数据管理', exact: true }).click()

  const conversationSummary = page.locator('.data-summary-strip > div').filter({ hasText: 'Conversations' })
  await page.getByRole('button', { name: 'Export backup', exact: true }).click()
  await expect(page.locator('.data-action-feedback')).toContainText('Saved native-backup.json')
  await expect(page.getByLabel('Select BioResearch OS backup')).toHaveCount(0)

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Clear history', exact: true }).click()
  await expect(conversationSummary.locator('strong')).toHaveText('0')
  await page.getByRole('button', { name: 'Import backup', exact: true }).click()
  await expect(conversationSummary.locator('strong')).toHaveText('1')
  await expect(page.locator('.data-action-feedback')).toContainText('Restored 1 conversation')
})
