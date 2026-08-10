import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'browser-vault')
const markdownVault = path.join(fixtureRoot, 'runtime-vault')
const emptyVault = path.join(fixtureRoot, 'empty-vault')

test('browser directory fallback preserves selection state and reports every outcome', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.addInitScript(() => { delete window.showDirectoryPicker })
  await page.goto('/')
  const picker = page.getByLabel('Select Obsidian Vault folder')
  await picker.setInputFiles(markdownVault)

  const connectedVault = page.getByRole('button', { name: 'Open runtime-vault Vault connection' })
  await expect(connectedVault).toContainText('runtime-vault')
  await expect(connectedVault).toContainText('1 Markdown note')
  await page.getByRole('button', { name: 'Knowledge Graph' }).click()
  await expect(page.getByRole('tab', { name: /Browser Vault Fixture/ })).toBeVisible()

  await picker.setInputFiles(emptyVault)
  await expect(page.getByRole('status')).toContainText('No Markdown files were found. The current Vault was kept.')
  await expect(connectedVault).toContainText('1 Markdown note')

  await page.evaluate(() => {
    window.__originalVaultFileText = File.prototype.text
    File.prototype.text = () => Promise.reject(new Error('synthetic parser rejection'))
  })
  await picker.setInputFiles(markdownVault)
  await expect(page.getByRole('alert')).toContainText('The folder could not be read. The current Vault was kept.')
  await expect(connectedVault).toContainText('runtime-vault')

  await page.evaluate(() => {
    File.prototype.text = window.__originalVaultFileText
    delete window.__originalVaultFileText
  })
  await picker.evaluate((input) => {
    input.__nativeClick = input.click
    input.click = () => {}
  })
  await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click()
  await picker.setInputFiles(markdownVault)
  await expect(page.getByRole('status')).toContainText('Connected runtime-vault with 1 Markdown note.')

  await connectedVault.click()
  const unavailableAlert = page.getByRole('alert')
  await expect(unavailableAlert).toContainText('The browser did not deliver the selected folder. The current Vault was kept.', { timeout: 8_000 })
  await expect(connectedVault).toContainText('runtime-vault')

  await picker.setInputFiles(emptyVault)
  await expect(unavailableAlert).toContainText('The browser did not deliver the selected folder. The current Vault was kept.')
  await expect(connectedVault).toContainText('1 Markdown note')

  await unavailableAlert.getByRole('button', { name: 'Retry' }).click()
  await picker.setInputFiles(markdownVault)
  await expect(page.getByRole('status')).toContainText('Connected runtime-vault with 1 Markdown note.')

  await picker.evaluate((input) => { input.click = () => {} })
  await connectedVault.click()
  await picker.dispatchEvent('cancel')
  await expect(page.getByRole('status')).toContainText('Folder selection cancelled. The current Vault was kept.')
  await expect(connectedVault).toContainText('runtime-vault')

  await picker.evaluate((input) => {
    input.click = input.__nativeClick
    delete input.__nativeClick
  })

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
