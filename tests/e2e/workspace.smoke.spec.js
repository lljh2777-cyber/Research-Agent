import { expect, test } from '@playwright/test'

test('opens the local research workspace and launcher without runtime errors', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')

  await expect(page).toHaveTitle(/BioResearch OS/i)
  await expect(page.getByRole('heading', { name: 'Configure your research workspace' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /New research/i })).toBeVisible()

  await page.getByRole('button', { name: 'Open launcher' }).click()

  await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible()
  await expect(page.locator('.workspace-launcher-grid').getByRole('button', { name: /Knowledge graph/i })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('exposes a validated local Web runtime manifest', async ({ request }) => {
  const response = await request.get('/api/runtime')
  const manifest = await response.json()

  expect(response.ok()).toBe(true)
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    target: 'local-web',
    capabilities: {
      chatgptSubscriptionOAuth: true,
      providerTransport: 'loopback',
      mcp: 'loopback',
    },
  })
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
