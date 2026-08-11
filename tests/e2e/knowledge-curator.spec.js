import { expect, test } from '@playwright/test'
import { createRuntimeManifest } from '../../shared/runtime-capabilities.mjs'
import { parseAnnotationMarkdown } from '../../src/annotations/annotation.js'

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
          body: '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```',
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

async function selectMarkdownRange(page, start, end, { mouse = true } = {}) {
  await page.evaluate(({ start, end, mouse }) => {
    const mapped = [...document.querySelectorAll('.document-markdown [data-source-start][data-source-end]')]
    const point = (offset, edge) => {
      const element = mapped.find((candidate) => {
        const sourceStart = Number(candidate.dataset.sourceStart)
        const sourceEnd = Number(candidate.dataset.sourceEnd)
        return edge === 'start' ? offset >= sourceStart && offset < sourceEnd : offset > sourceStart && offset <= sourceEnd
      })
      if (!element) throw new Error(`No source-mapped node for ${edge} ${offset}`)
      const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)
      return { node: textNode, offset: offset - Number(element.dataset.sourceStart) }
    }
    const first = point(start, 'start')
    const last = point(end, 'end')
    const range = document.createRange()
    range.setStart(first.node, first.offset)
    range.setEnd(last.node, last.offset)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    if (mouse) document.querySelector('.knowledge-document').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  }, { start, end, mouse })
}

test('selects Markdown, approves an annotation, reopens it, and continues the same curator session in Research', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.route('**/api/runtime', async (route) => {
    const manifest = createRuntimeManifest({
      buildMode: 'test',
      target: 'local-web',
      services: { annotations: true, actions: true },
    })
    await route.fulfill({ json: manifest })
  })
  const persisted = new Map()
  const annotationCalls = { list: 0, read: 0, writes: [] }
  await page.route('**/api/runtime/annotations*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.searchParams.has('path')) {
      annotationCalls.read += 1
      const entry = persisted.get(url.searchParams.get('path'))
      return route.fulfill({ status: entry ? 200 : 404, json: entry ? { ok: true, schemaVersion: 1, ...entry } : { ok: false, code: 'not_found', error: 'Missing annotation.' } })
    }
    if (request.method() === 'GET') {
      annotationCalls.list += 1
      return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [...persisted.entries()].map(([path, entry]) => ({ path, revision: entry.revision, bytes: entry.content.length })) } })
    }
    const body = request.postDataJSON()
    annotationCalls.writes.push(body)
    const revision = `annotation-rev-${annotationCalls.writes.length}`
    persisted.set(body.intent.target.path, { content: body.intent.content, revision })
    return route.fulfill({ json: { ok: true, schemaVersion: 1, revision, replayed: false } })
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

  const noteBody = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
  const selectedStart = noteBody.indexOf('Selected evidence')
  const selectedEnd = selectedStart + 'Selected evidence is reproducible'.length
  await selectMarkdownRange(page, selectedStart, selectedEnd)
  const chooser = page.getByRole('menu', { name: '选中文本操作' })
  await expect(chooser).toBeVisible()
  await expect(chooser.getByRole('menuitem')).toHaveText(['手工批注', 'AI 解释'])
  await expect(compactPanel.getByText('Selection')).toBeVisible()

  await chooser.getByRole('menuitem', { name: '手工批注' }).click()
  await expect(page.getByRole('complementary', { name: 'Annotations' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Anchor anchored' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('讨论部分需要人工核验。')
  await page.getByRole('textbox', { name: 'AI contribution' }).fill('AI 解释：该证据支持主要结论。')
  await page.getByRole('button', { name: 'Save with approval' }).click()

  const approval = page.getByRole('dialog', { name: 'Approval required' })
  await expect(approval).toContainText('saved-vault / wiki/annotations/')
  await expect(approval).toContainText(/annotation-findings-note-.*:save/)
  await approval.getByRole('button', { name: 'Approve once' }).click()
  await expect(compactPanel.getByText(/Annotate completed for saved-vault/)).toBeVisible()
  expect(annotationCalls.writes).toHaveLength(1)
  const write = annotationCalls.writes[0]
  expect(write.approval).toEqual({ status: 'approved' })
  expect(write.intent).toMatchObject({ schemaVersion: 1, kind: 'annotation.upsert', contentType: 'text/markdown', target: { vaultId: 'saved-vault', expectedRevision: null } })
  expect(write.intent.target.path).toMatch(/^wiki\/annotations\/annotation-findings-note-/)
  const savedRecord = parseAnnotationMarkdown(write.intent.content)
  expect(savedRecord.anchor.quote.exact).toBe('Selected evidence is reproducible')
  expect(savedRecord.sections).toEqual({ manual: '讨论部分需要人工核验。', ai: 'AI 解释：该证据支持主要结论。' })
  await expect(page.getByRole('button', { name: /Open annotation for Selected evidence is reproducible/ }).first()).toBeVisible()

  const closeWorkbench = page.getByRole('button', { name: 'Close annotations workbench' })
  await closeWorkbench.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: 'Annotations' })).toHaveCount(0)
  await expect(page.locator('.knowledge-workspace')).not.toHaveClass(/annotation-open/)

  const showWorkbench = page.getByRole('button', { name: 'Show annotations workbench (1)' })
  await expect(showWorkbench).toBeVisible()
  await showWorkbench.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('complementary', { name: 'Annotations' })).toBeVisible()
  await expect(page.locator('.knowledge-workspace')).toHaveClass(/annotation-open/)
  await expect(page.getByRole('button', { name: 'Close annotations workbench' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveCount(0)
  const savedAnnotation = page.locator('.annotation-record').filter({ hasText: '讨论部分需要人工核验。' })
  await expect(savedAnnotation).toBeVisible()
  await savedAnnotation.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveValue('讨论部分需要人工核验。')
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('讨论部分已完成人工核验。')
  await page.getByRole('button', { name: 'Save with approval' }).click()
  await page.getByRole('dialog', { name: 'Approval required' }).getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(() => annotationCalls.writes.length).toBe(2)
  expect(annotationCalls.writes[1].intent.target.expectedRevision).toBe('annotation-rev-1')
  expect(parseAnnotationMarkdown(annotationCalls.writes[1].intent.content).sections).toEqual({ manual: '讨论部分已完成人工核验。', ai: 'AI 解释：该证据支持主要结论。' })
  await page.getByRole('button', { name: 'Close annotations workbench' }).click()

  await compactPanel.getByRole('button', { name: /Continue in Research/ }).click()
  const fullPanel = page.locator('.agent-conversation-panel.full')
  await expect(fullPanel).toBeVisible()
  await expect(fullPanel).toHaveAttribute('data-session-id', sessionId)
  await expect(fullPanel.getByText(/Annotate completed for saved-vault/)).toHaveCount(2)
  await expect(fullPanel.getByText('Current note')).toBeVisible()
  await expect(fullPanel.getByText('Selection')).toBeVisible()

  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('bioresearch-os', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const snapshot = await new Promise((resolve, reject) => {
      const request = db.transaction('snapshots').objectStore('snapshots').get('current-vault')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    snapshot.notes[0].body = `Minor editorial preface.\n${snapshot.notes[0].body}`
    await new Promise((resolve, reject) => {
      const request = db.transaction('snapshots', 'readwrite').objectStore('snapshots').put(snapshot, 'current-vault')
      request.onsuccess = resolve
      request.onerror = () => reject(request.error)
    })
    db.close()
  })
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
  const relocatedHighlight = page.getByRole('button', { name: /Open annotation for Selected evidence is reproducible/ }).first()
  await expect(relocatedHighlight).toBeVisible()
  await relocatedHighlight.click()
  await expect(page.getByRole('status').filter({ hasText: 'Anchor relocated' })).toBeVisible()
  expect(annotationCalls.list).toBeGreaterThan(1)
  expect(annotationCalls.read).toBeGreaterThan(0)


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

test('maps word, phrase, paragraph, inline-node, and multi-line selections and keeps Shift+S safe', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.route('**/api/runtime', (route) => route.fulfill({ json: createRuntimeManifest({ buildMode: 'test', target: 'local-web', services: { annotations: true, actions: true } }) }))
  let writeCount = 0
  await page.route('**/api/runtime/annotations*', (route) => {
    if (route.request().method() === 'PUT') writeCount += 1
    return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [] } })
  })
  await page.goto('/')
  await installVaultSnapshot(page)
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()

  const markdown = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
  const chooser = page.getByRole('menu', { name: '选中文本操作' })
  const inspectSelection = async (start, end, expected, options) => {
    await selectMarkdownRange(page, start, end, options)
    if (options?.mouse === false) await page.keyboard.press('Shift+S')
    await expect(chooser).toBeVisible()
    await chooser.getByRole('menuitem', { name: '手工批注' }).click()
    await expect(page.locator('.annotation-source blockquote')).toHaveText(expected)
    await page.getByRole('button', { name: 'Close annotations workbench' }).click()
  }

  const wordStart = markdown.indexOf('evidence')
  await inspectSelection(wordStart, wordStart + 'evidence'.length, 'evidence', { mouse: false })
  const phraseStart = markdown.indexOf('Selected evidence')
  const phraseEnd = phraseStart + 'Selected evidence is reproducible'.length
  await selectMarkdownRange(page, phraseStart, phraseEnd)
  await chooser.getByRole('menuitem', { name: 'AI 解释' }).click()
  await expect(page.getByRole('textbox', { name: 'AI contribution' })).toBeFocused()
  await expect(page.locator('.annotation-source blockquote')).toHaveText('Selected evidence is reproducible')
  await page.getByRole('button', { name: 'Close annotations workbench' }).click()
  const inlineStart = markdown.indexOf('with')
  const inlineEnd = markdown.indexOf('inline evidence') + 'inline evidence'.length
  await inspectSelection(inlineStart, inlineEnd, markdown.slice(inlineStart, inlineEnd))
  const multiEnd = markdown.indexOf('rendered line') + 'rendered line'.length
  await inspectSelection(inlineStart, multiEnd, markdown.slice(inlineStart, multiEnd))
  const paragraphStart = markdown.indexOf('Selected evidence')
  const paragraphEnd = markdown.indexOf('\n\n## Methods')
  await inspectSelection(paragraphStart, paragraphEnd, markdown.slice(paragraphStart, paragraphEnd))

  await selectMarkdownRange(page, wordStart, wordStart + 'evidence'.length)
  await expect(chooser).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(chooser).toHaveCount(0)
  await selectMarkdownRange(page, wordStart, wordStart + 'evidence'.length)
  await expect(chooser).toBeVisible()
  await page.locator('.workspace-breadcrumb').click()
  await expect(chooser).toHaveCount(0)

  await selectMarkdownRange(page, wordStart, wordStart + 'evidence'.length, { mouse: false })
  await page.locator('.knowledge-agent-composer textarea').dispatchEvent('keydown', { key: 's', shiftKey: true, bubbles: true })
  await expect(chooser).toHaveCount(0)

  await page.evaluate(() => {
    const code = document.querySelector('.document-markdown code')
    if (!code?.firstChild) return
    const range = document.createRange()
    range.selectNodeContents(code.firstChild)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('Shift+S')
  await expect(chooser).toHaveCount(0)

  await selectMarkdownRange(page, wordStart, wordStart + 'evidence'.length)
  await chooser.getByRole('menuitem', { name: '手工批注' }).click()
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('cancelled draft')
  await page.getByRole('button', { name: 'Save with approval' }).click()
  await page.getByRole('dialog', { name: 'Approval required' }).getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.agent-conversation-panel.compact').getByText(/was cancelled/)).toBeVisible()
  expect(writeCount).toBe(0)

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
