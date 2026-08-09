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
