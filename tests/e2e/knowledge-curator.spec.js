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
        vaultName: 'saved-vault',
        notes: [{
          id: 'findings-note',
          name: 'findings.md',
          title: 'Findings',
          path: 'saved-vault/papers/findings.md',
          body: '# Findings\n\nSelected evidence is reproducible and supports the primary conclusion.\n\n## Methods\n\nThe assay was repeated in three cohorts.',
          frontmatter: { tags: ['evidence'] },
          wikilinks: [],
          wordCount: 18,
        }],
        source: 'manual',
        revision: 'vault-rev-e2e',
        savedAt: '2026-08-09T12:00:00.000Z',
      }, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  })
}

test('selects Markdown, approves an annotation, reopens it, and continues the same curator session in Research', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.route('**/api/runtime', async (route) => {
    const response = await route.fetch()
    const manifest = await response.json()
    manifest.capabilities.knowledgeActions = {
      availableCapabilities: ['annotations.write', 'knowledge.lint', 'actions.paperIngest', 'actions.xray', 'actions.codeAnalysis', 'actions.synthesis'],
    }
    await route.fulfill({ response, json: manifest })
  })

  await page.goto('/')
  await installVaultSnapshot(page)
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()

  const compactPanel = page.locator('.agent-conversation-panel.compact')
  await expect(compactPanel).toBeVisible()
  await expect(compactPanel.locator('.knowledge-context-chips').getByText('Current note', { exact: true })).toBeVisible()
  await expect(compactPanel).toHaveAttribute('data-agent-id', 'knowledge-curator')
  const sessionId = await compactPanel.getAttribute('data-session-id')
  expect(sessionId).toBeTruthy()
  await expect(compactPanel.getByRole('button', { name: /Lint/ })).toBeEnabled()
  await expect(compactPanel.getByRole('button', { name: /Lint/ })).toHaveAttribute('data-tool-id', 'knowledge.lint')
  await expect(compactPanel.getByRole('button', { name: /Paper ingest/ })).toBeEnabled()
  await expect(compactPanel.getByRole('button', { name: /Paper ingest/ })).toHaveAttribute('data-tool-id', 'knowledge.paper.ingest')
  await expect(compactPanel.getByRole('button', { name: /Static code analysis/ })).toBeEnabled()
  await expect(compactPanel.getByRole('button', { name: /Static code analysis/ })).toHaveAttribute('data-tool-id', 'knowledge.code.analyze')

  const passage = page.locator('.selectable-markdown-block').filter({ hasText: 'Selected evidence is reproducible' })
  await passage.click()
  await expect(page.getByRole('toolbar', { name: 'Selected text actions' })).toBeVisible()
  await expect(compactPanel.getByText('Selection')).toBeVisible()

  await page.getByRole('toolbar', { name: 'Selected text actions' }).getByRole('button', { name: 'Explain' }).click()
  await expect(compactPanel.getByText(/Explain completed as a read-only fixture/)).toBeVisible()
  await expect(compactPanel.getByText('Run complete')).toBeVisible()

  await page.getByRole('toolbar', { name: 'Selected text actions' }).getByRole('button', { name: 'Annotate' }).click()
  await expect(page.getByRole('complementary', { name: 'Annotations' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Anchor anchored' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('Flag this result for the discussion section.')
  await page.getByRole('button', { name: 'Save with approval' }).click()

  const approval = page.getByRole('dialog', { name: 'Approval required' })
  await expect(approval).toContainText('saved-vault / saved-vault/papers/findings.md')
  await expect(approval).toContainText(/annotation-findings-note-.*:save/)
  await approval.getByRole('button', { name: 'Approve once' }).click()
  await expect(compactPanel.getByText(/Annotate completed for saved-vault/)).toBeVisible()

  await page.getByRole('button', { name: 'Close annotation editor' }).click()
  const savedAnnotation = page.locator('.annotation-record').filter({ hasText: 'Flag this result for the discussion section.' })
  await expect(savedAnnotation).toBeVisible()
  await savedAnnotation.click()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveValue('Flag this result for the discussion section.')

  await compactPanel.getByRole('button', { name: /Continue in Research/ }).click()
  const fullPanel = page.locator('.agent-conversation-panel.full')
  await expect(fullPanel).toBeVisible()
  await expect(fullPanel).toHaveAttribute('data-session-id', sessionId)
  await expect(fullPanel.getByText(/Explain completed as a read-only fixture/)).toBeVisible()
  await expect(fullPanel.getByText(/Annotate completed for saved-vault/)).toBeVisible()
  await expect(fullPanel.getByText('Current note')).toBeVisible()
  await expect(fullPanel.getByText('Selection')).toBeVisible()


  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('shows a truthful empty curator boundary without fabricated note, selection, or run state', async ({ page }) => {
  await page.goto('/')
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()

  const panel = page.locator('.agent-conversation-panel.compact')
  await expect(panel.getByText('No current note or selection context.')).toBeVisible()
  await expect(panel.getByText('Connect a Vault and open a note before starting note-aware actions.')).toBeVisible()
  await expect(panel.locator('.knowledge-context-chips')).toHaveCount(0)
  await expect(page.getByRole('toolbar', { name: 'Selected text actions' })).toHaveCount(0)
  await expect(panel.getByText(/Run complete|Run failed|Run cancelled/)).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /Continue in Research/ })).toBeDisabled()
})
