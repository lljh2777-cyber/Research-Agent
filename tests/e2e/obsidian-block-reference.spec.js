import { expect, test } from '@playwright/test'

import { createRuntimeManifest } from '../../shared/runtime-capabilities.mjs'
import { installChatgptAuthStatusRoute } from './helpers/auth-status.js'

async function installObsidianVaultSnapshot(page) {
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
        vaultName: 'obsidian-fixture',
        notes: [
          {
            id: 'wiki/sources/paper.md',
            name: 'paper.md',
            title: 'Source paper',
            path: 'wiki/sources/paper.md',
            body: '# Source paper\n\nThe method uses [[wiki/annotations/paper#^ann-2384afaf23|Delaunay subgraph]].\n\n[[wiki/annotations/paper#^missing|Missing block]] remains unavailable.\n\n[[wiki/annotations/duplicate#^duplicate|Duplicate block]] remains unavailable.\n\n[[wiki/annotations/paper#Explanation|Heading link]] remains supported.',
            frontmatter: {},
            wikilinks: [],
            wordCount: 16,
          },
          {
            id: 'wiki/annotations/paper.md',
            name: 'paper.md',
            title: 'Paper annotations',
            path: 'wiki/annotations/paper.md',
            body: '# Paper annotations\n\n## Explanation\n\nPersisted Obsidian annotation text.\n\n^ann-2384afaf23',
            frontmatter: { tags: ['annotation'] },
            wikilinks: [],
            wordCount: 7,
          },
          {
            id: 'wiki/annotations/duplicate.md',
            name: 'duplicate.md',
            title: 'Duplicate annotations',
            path: 'wiki/annotations/duplicate.md',
            body: '# Duplicate annotations\n\nFirst.\n\n^duplicate\n\nSecond.\n\n^duplicate',
            frontmatter: { tags: ['annotation'] },
            wikilinks: [],
            wordCount: 5,
          },
        ],
        source: 'manual',
        revision: 'obsidian-block-ref-revision',
        savedAt: '2026-08-12T00:00:00.000Z',
      }, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  })
}

test.beforeEach(async ({ page }) => {
  await installChatgptAuthStatusRoute(page)
  await page.route('**/api/runtime', (route) => route.fulfill({
    json: createRuntimeManifest({ buildMode: 'test', target: 'local-web' }),
  }))
})

test('opens persisted Obsidian annotation block references by mouse and keyboard', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  const httpErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`) })

  await page.goto('/')
  await installObsidianVaultSnapshot(page)
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()

  const blockLink = page.getByRole('button', { name: 'Delaunay subgraph', exact: true })
  await expect(blockLink).toBeEnabled()
  await expect(blockLink).not.toHaveClass(/missing/)
  await blockLink.click()
  await expect(page.getByRole('heading', { name: 'Paper annotations', level: 1 })).toBeVisible()
  await expect(page.locator('#block-reference-ann-2384afaf23')).toHaveCount(1)

  await page.getByRole('button', { name: 'Source paper Markdown', exact: true }).click()
  await blockLink.focus()
  await blockLink.press('Enter')
  await expect(page.getByRole('heading', { name: 'Paper annotations', level: 1 })).toBeVisible()

  await page.getByRole('button', { name: 'Source paper Markdown', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Missing block', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Duplicate block', exact: true })).toBeDisabled()
  await expect(page.locator('#block-reference-duplicate')).toHaveCount(0)
  const headingLink = page.getByRole('button', { name: 'Heading link', exact: true })
  await expect(headingLink).toBeEnabled()
  await headingLink.click()
  await expect(page.getByRole('heading', { name: 'Explanation', level: 3 })).toBeVisible()

  expect(pageErrors).toEqual([])
  expect({ consoleErrors, httpErrors }).toEqual({ consoleErrors: [], httpErrors: [] })
})
