import { expect, test } from '@playwright/test'
import { createRuntimeManifest } from '../../shared/runtime-capabilities.mjs'
import { parseAnnotationMarkdown } from '../../src/annotations/annotation.js'
import { createKnowledgeArchiveResult } from '../../src/research/knowledgeArchive.js'

const KNOWLEDGE_READ_SERVICE = {
  provider: {
    selected: true,
    providerId: 'compatible',
    endpoint: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    credential: 'not-required',
  },
  researchRun: { executable: true, transport: 'research-run' },
}

const ARCHIVE_ACTION_SERVICE = {
  executable: true,
  capabilities: {},
  archive: {
    executable: true,
    transport: 'research-run',
    journal: 'atomic-json-v1',
    crashRecovery: true,
    authenticity: 'hmac-sha256-v1',
    planner: { sandbox: 'read-only', output: 'strict-json' },
  },
}

const AI_EXPLANATION = '该段证据说明所选结果在重复实验中保持一致。'

async function installKnowledgeReadTransport(page, { text = AI_EXPLANATION, status = 'completed' } = {}) {
  const calls = { creates: [], starts: [] }
  await page.route('**/api/research/runs**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/api/research/runs')) {
      const body = request.postDataJSON()
      calls.creates.push(body)
      return route.fulfill({ status: 201, json: { created: true, run: { id: body.id, sessionId: body.sessionId, status: 'created' } } })
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/start')) {
      const body = request.postDataJSON()
      calls.starts.push(body)
      return route.fulfill({ status: 202, json: { started: true } })
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/events')) {
      const start = calls.starts.at(-1)
      const read = start?.knowledgeRead
      if (status !== 'completed') {
        const eventType = status === 'cancelled' ? 'run.cancelled' : 'run.failed'
        return route.fulfill({ json: { events: [{ cursor: 1, event: { type: eventType, runId: read?.runId, error: { name: status === 'cancelled' ? 'AbortError' : 'KnowledgeReadError', message: status === 'cancelled' ? 'Stopped.' : 'Provider failed.' } } }] } })
      }
      const result = {
        schemaVersion: 1,
        toolId: read?.toolId,
        requestId: read?.requestId,
        runId: read?.runId,
        status: 'completed',
        effect: 'read',
        summary: '所选证据解释已完成。',
        data: {
          schemaVersion: 1,
          kind: 'knowledge-read-result',
          agentId: 'knowledge-curator',
          sessionId: read?.sessionId,
          runId: read?.runId,
          text,
        },
        artifacts: [],
        error: null,
      }
      return route.fulfill({ json: { events: [{ cursor: 1, event: { type: 'run.completed', runId: read?.runId, result } }] } })
    }
    return route.fulfill({ status: 405, json: { error: 'Unexpected Research Run request.' } })
  })
  return calls
}

async function installArchiveTransport(page, { status = 'completed' } = {}) {
  const calls = { starts: [], cancels: [] }
  await page.route('**/api/runtime/actions**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/api/runtime/actions')) {
      calls.starts.push(request.postDataJSON())
      return route.fulfill({ status: 202, json: { started: true, replayed: false } })
    }
    if (request.method() === 'DELETE') {
      calls.cancels.push(url.pathname.split('/').at(-1))
      return route.fulfill({ json: { ok: true, cancelled: true } })
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/events')) {
      const { approval, ...action } = calls.starts.at(-1)
      const terminalStatus = status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed'
      const targets = terminalStatus === 'completed'
        ? action.input.targets.map((path, index) => ({ path, status: index ? 'updated' : 'created', revision: `target-revision-${index + 1}` }))
        : action.input.targets.slice(0, 1).map((path) => ({ path, status: 'created', revision: 'partial-target-revision-1' }))
      const output = createKnowledgeArchiveResult(action, {
        status: terminalStatus,
        summary: terminalStatus === 'completed' ? 'Formal archive completed.' : terminalStatus === 'cancelled' ? 'Formal archive cancelled.' : 'Formal archive failed.',
        targets,
        error: terminalStatus === 'completed' ? null : { code: terminalStatus === 'cancelled' ? 'archive_cancelled' : 'archive_failed', message: terminalStatus === 'cancelled' ? 'Archive run was cancelled.' : 'Planner failed after one committed target.' },
      })
      const type = terminalStatus === 'completed' ? 'run.completed' : terminalStatus === 'cancelled' ? 'run.cancelled' : 'run.failed'
      const event = { type, runId: action.runId, ...(terminalStatus === 'completed' ? { output } : { result: output }) }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ cursor: 2, event })}\n\n` })
    }
    return route.fulfill({ status: 405, json: { error: 'Unexpected Action request.' } })
  })
  return calls
}

async function installVaultSnapshot(page) {
  await page.evaluate(async () => {
    localStorage.setItem('bioresearch-os:model-config', JSON.stringify({ chatModelId: 'api:compatible:test-model' }))
    localStorage.setItem('bioresearch-os:provider-configs:v1', JSON.stringify({
      compatible: {
        endpoint: 'http://127.0.0.1:1234/v1',
        enabled: true,
        models: [{ id: 'test-model', name: 'Test model', kind: 'chat', capabilities: { chat: true } }],
        selectedModelIds: ['test-model'],
        lastFetchedAt: '2026-08-11T00:00:00.000Z',
      },
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

test('captures a real Explain result, approves the same file-backed annotation, reloads it, and continues the curator session', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })

  await page.route('**/api/runtime', async (route) => {
    const manifest = createRuntimeManifest({
      buildMode: 'test',
      target: 'local-web',
      services: { annotations: true, actions: true, knowledgeReads: KNOWLEDGE_READ_SERVICE },
    })
    await route.fulfill({ json: manifest })
  })
  const persisted = new Map()
  const annotationCalls = { list: 0, read: 0, writes: [] }
  const knowledgeReadCalls = await installKnowledgeReadTransport(page)
  await page.route('**/api/runtime/annotations*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.searchParams.has('path')) {
      annotationCalls.read += 1
      const path = url.searchParams.get('path')
      const entry = persisted.get(path)
      return route.fulfill({ status: entry ? 200 : 404, json: entry ? { ok: true, schemaVersion: 1, path, ...entry } : { ok: false, code: 'not_found', error: 'Missing annotation.' } })
    }
    if (request.method() === 'GET') {
      annotationCalls.list += 1
      return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [...persisted.entries()].map(([path, entry]) => ({ path, revision: entry.revision, bytes: entry.content.length })) } })
    }
    const body = request.postDataJSON()
    annotationCalls.writes.push(body)
    const revision = `annotation-rev-${annotationCalls.writes.length}`
    persisted.set(body.intent.target.path, { content: body.intent.content, revision })
    return route.fulfill({ json: { ok: true, schemaVersion: 1, annotationId: body.intent.annotationId, path: body.intent.target.path, revision, replayed: false } })
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

  const explainItem = chooser.getByRole('menuitem', { name: 'AI 解释' })
  await expect(explainItem).toBeEnabled()
  await explainItem.click()
  await expect(page.getByRole('complementary', { name: 'Annotations' })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Anchor anchored' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'AI contribution' })).toHaveValue(AI_EXPLANATION)
  await expect(page.getByRole('status').filter({ hasText: 'AI explanation ready for review' })).toBeVisible()
  expect(annotationCalls.writes).toHaveLength(0)
  expect(knowledgeReadCalls.creates).toHaveLength(1)
  expect(knowledgeReadCalls.starts).toHaveLength(1)
  const readCreate = knowledgeReadCalls.creates[0]
  const readStart = knowledgeReadCalls.starts[0]
  expect(readCreate).toMatchObject({ id: expect.any(String), sessionId, executionOwner: 'loopback' })
  expect(readStart).toMatchObject({ kind: 'provider', providerId: 'compatible', model: 'test-model', tools: [] })
  expect(readStart.knowledgeRead).toMatchObject({
    schemaVersion: 1,
    kind: 'knowledge-read-run',
    agentId: 'knowledge-curator',
    toolId: 'knowledge.explain',
    requestId: expect.any(String),
    sessionId,
    runId: readCreate.id,
    context: { selection: { anchor: { quote: { exact: 'Selected evidence is reproducible' } } } },
  })
  expect(readStart.knowledgeRead.requestId).not.toBe(readStart.knowledgeRead.runId)
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('讨论部分需要人工核验。')
  await page.getByRole('button', { name: 'Save with approval' }).click()

  const approval = page.getByRole('dialog', { name: 'Approval required' })
  await expect(approval).toContainText('saved-vault / wiki/annotations/')
  await expect(approval).toContainText(/annotation\.write\.body\.[a-f0-9]{64}/)
  await approval.getByRole('button', { name: 'Approve once' }).click()
  await expect(compactPanel.getByText(/Save completed for saved-vault/)).toBeVisible()
  expect(annotationCalls.writes).toHaveLength(1)
  const write = annotationCalls.writes[0]
  expect(write.approval).toEqual({ status: 'approved' })
  expect(write.intent).toMatchObject({ schemaVersion: 1, kind: 'annotation.upsert', contentType: 'text/markdown', target: { vaultId: 'saved-vault', expectedRevision: null } })
  expect(write.intent.target.path).toMatch(/^wiki\/annotations\/annotation-findings-note-/)
  const savedRecord = parseAnnotationMarkdown(write.intent.content)
  expect(savedRecord.schemaVersion).toBe(2)
  expect(savedRecord.anchor.quote.exact).toBe('Selected evidence is reproducible')
  expect(savedRecord.sections).toEqual({ manual: '讨论部分需要人工核验。', ai: AI_EXPLANATION })
  expect(savedRecord.aiProvenance).toMatchObject({ providerId: 'compatible', modelId: 'test-model', generatedAt: expect.any(String) })
  expect(savedRecord.archive).toEqual({ state: 'none', targets: [], runId: null, error: null })
  await expect(page.getByRole('button', { name: /Open annotation for Selected evidence is reproducible/ }).first()).toBeVisible()

  const closeWorkbench = page.getByRole('button', { name: 'Close annotations' })
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
  await expect(page.getByRole('button', { name: 'Close annotations' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveCount(0)
  const savedAnnotation = page.locator('.annotation-record').filter({ hasText: '讨论部分需要人工核验。' })
  await expect(savedAnnotation).toBeVisible()
  await savedAnnotation.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.annotation-rendered')).toContainText('讨论部分需要人工核验。')
  await page.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveValue('讨论部分需要人工核验。')
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('讨论部分已完成人工核验。')
  await page.getByRole('button', { name: 'Save with approval' }).click()
  await page.getByRole('dialog', { name: 'Approval required' }).getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(() => annotationCalls.writes.length).toBe(2)
  expect(annotationCalls.writes[1].intent.target.expectedRevision).toBe('annotation-rev-1')
  expect(parseAnnotationMarkdown(annotationCalls.writes[1].intent.content).sections).toEqual({ manual: '讨论部分已完成人工核验。', ai: AI_EXPLANATION })
  await page.getByRole('button', { name: 'Close annotations' }).click()

  await compactPanel.getByRole('button', { name: /Continue in Research/ }).click()
  const fullPanel = page.locator('.agent-conversation-panel.full')
  await expect(fullPanel).toBeVisible()
  await expect(fullPanel).toHaveAttribute('data-session-id', sessionId)
  await expect(fullPanel.getByText(/Save completed for saved-vault/)).toHaveCount(2)
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
  await expect(page.locator('.annotation-rendered')).toContainText(AI_EXPLANATION)
  expect(annotationCalls.list).toBeGreaterThan(1)
  expect(annotationCalls.read).toBeGreaterThan(0)


  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

test('runs a separately approved formal archive with exact source identity, targets, terminal evidence, and reload', async ({ page }) => {
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.route('**/api/runtime', (route) => route.fulfill({
    json: createRuntimeManifest({
      buildMode: 'test',
      target: 'local-web',
      services: { annotations: true, actions: ARCHIVE_ACTION_SERVICE, knowledgeReads: KNOWLEDGE_READ_SERVICE },
    }),
  }))
  const persisted = new Map()
  const writes = []
  const readPaths = []
  let runtimePath = null
  await page.route('**/api/runtime/annotations*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.searchParams.has('path')) {
      const path = url.searchParams.get('path')
      readPaths.push(path)
      const entry = persisted.get(path)
      return route.fulfill({ status: entry ? 200 : 404, json: entry ? { ok: true, schemaVersion: 1, path, ...entry } : { ok: false, error: 'Missing annotation.' } })
    }
    if (request.method() === 'GET') {
      return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [...persisted.entries()].map(([path, entry]) => ({ path, revision: entry.revision })) } })
    }
    const body = request.postDataJSON()
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(body.idempotencyKey)) {
      return route.fulfill({ json: { ok: false, schemaVersion: 1, error: 'Annotation writes require a valid idempotencyKey.' } })
    }
    writes.push(body)
    const revision = `annotation-revision-${writes.length}`
    runtimePath ||= body.intent.target.path.replace(/\.md$/i, '.MD')
    persisted.set(runtimePath, { content: body.intent.content, revision })
    return route.fulfill({ json: { ok: true, schemaVersion: 1, annotationId: body.intent.annotationId, path: runtimePath, revision, replayed: false } })
  })
  await installKnowledgeReadTransport(page)
  const archiveCalls = await installArchiveTransport(page)

  await page.goto('/')
  await installVaultSnapshot(page)
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
  const noteBody = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
  const start = noteBody.indexOf('Selected evidence')
  await selectMarkdownRange(page, start, start + 'Selected evidence is reproducible'.length)
  await page.getByRole('menuitem', { name: 'AI 解释' }).click()
  await expect(page.getByRole('textbox', { name: 'AI contribution' })).toHaveValue(AI_EXPLANATION)
  await page.getByRole('button', { name: 'Save with approval' }).click()
  await page.getByRole('dialog', { name: 'Approval required' }).getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(() => writes.length).toBe(1)

  await page.getByRole('textbox', { name: 'Formal archive targets (one Vault .md path per line)' }).fill('synthesis/findings.md\nsynthesis/methods.md')
  await page.getByRole('button', { name: 'Archive knowledge with approval' }).click()
  const approval = page.getByRole('dialog', { name: 'Approval required' })
  await expect(approval).toContainText('Persist pending archive lifecycle')
  await expect(approval).toContainText('wiki/annotations/annotation-findings-note-')
  await approval.getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(() => writes.length).toBe(2)
  const pendingRecord = parseAnnotationMarkdown(writes[1].intent.content)
  expect(pendingRecord.archive).toMatchObject({ state: 'pending', targets: ['synthesis/findings.md', 'synthesis/methods.md'], runId: expect.any(String) })
  expect(writes[1].intent.target.expectedRevision).toBe('annotation-revision-1')
  expect(writes[1].intent.target.path).toBe(runtimePath)

  await expect(approval).toContainText('saved-vault (Vault root)')
  await expect(approval).toContainText('saved-vault · vault:saved-vault')
  await expect(approval).toContainText('annotation-revision-2')
  await expect(approval).toContainText('synthesis/findings.md')
  await expect(approval).toContainText('synthesis/methods.md')
  await approval.getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(() => archiveCalls.starts.length).toBe(1)
  await expect(approval).toContainText('Persist completed archive lifecycle')
  expect(writes).toHaveLength(2)
  await approval.getByRole('button', { name: 'Approve once' }).click()
  await expect.poll(() => writes.length).toBe(3)
  await expect.poll(() => readPaths.length).toBe(3)
  expect(writes.map((entry) => entry.approval)).toEqual([{ status: 'approved' }, { status: 'approved' }, { status: 'approved' }])
  expect(new Set(writes.map((entry) => entry.idempotencyKey)).size).toBe(3)
  writes.forEach((entry) => expect(entry.idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,160}$/))
  expect(readPaths).toEqual([runtimePath, runtimePath, runtimePath])
  expect(runtimePath).toMatch(/\.MD$/)

  const action = archiveCalls.starts[0]
  expect(action.input).toEqual({
    operation: 'archive-annotation',
    sourceAnnotation: { id: expect.any(String), path: runtimePath, revision: 'annotation-revision-2' },
    targets: ['synthesis/findings.md', 'synthesis/methods.md'],
  })
  expect(action.approval).toEqual({ status: 'approved', scope: action.scope, sourceAnnotation: action.input.sourceAnnotation, targets: action.input.targets })
  expect(writes.map((entry) => entry.idempotencyKey)).not.toContain(action.idempotencyKey)
  expect(writes[2].intent.target.expectedRevision).toBe('annotation-revision-2')
  const terminalRecord = parseAnnotationMarkdown(writes[2].intent.content)
  expect(terminalRecord.archive).toMatchObject({ state: 'completed', targets: action.input.targets, runId: action.runId, error: null })
  expect(terminalRecord.archived).toBe(true)
  await expect(page.getByRole('region', { name: 'Formal archive status' })).toContainText('completed')
  await expect(page.getByRole('region', { name: 'Formal archive status' })).toContainText('created')
  await expect(page.getByRole('region', { name: 'Formal archive status' })).toContainText('updated')

  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
  await page.getByRole('button', { name: 'Show annotations workbench (1)' }).click()
  const record = page.locator('.annotation-record').filter({ hasText: 'Archived' })
  await expect(record).toBeVisible()
  await record.click()
  await expect(page.getByRole('region', { name: 'Formal archive status' })).toContainText('completed')
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})

for (const archiveStatus of ['failed', 'cancelled']) {
  test(`keeps a ${archiveStatus} formal archive visible with truthful partial evidence`, async ({ page }) => {
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.route('**/api/runtime', (route) => route.fulfill({
      json: createRuntimeManifest({ buildMode: 'test', target: 'local-web', services: { annotations: true, actions: ARCHIVE_ACTION_SERVICE } }),
    }))
    const persisted = new Map()
    const writes = []
    await page.route('**/api/runtime/annotations*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.searchParams.has('path')) {
        const path = url.searchParams.get('path')
        const entry = persisted.get(path)
        return route.fulfill({ status: entry ? 200 : 404, json: entry ? { ok: true, schemaVersion: 1, path, ...entry } : { ok: false, error: 'Missing annotation.' } })
      }
      if (request.method() === 'GET') return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [...persisted.entries()].map(([path, entry]) => ({ path, revision: entry.revision })) } })
      const body = request.postDataJSON()
      writes.push(body)
      const revision = `annotation-revision-${writes.length}`
      persisted.set(body.intent.target.path, { content: body.intent.content, revision })
      return route.fulfill({ json: { ok: true, schemaVersion: 1, annotationId: body.intent.annotationId, path: body.intent.target.path, revision } })
    })
    await installArchiveTransport(page, { status: archiveStatus })
    await page.goto('/')
    await installVaultSnapshot(page)
    await page.reload()
    await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
    const markdown = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
    const start = markdown.indexOf('Selected evidence')
    await selectMarkdownRange(page, start, start + 'Selected evidence'.length)
    await page.getByRole('menuitem', { name: '手工批注' }).click()
    await page.getByRole('textbox', { name: 'Your annotation' }).fill('Saved before archive.')
    await page.getByRole('button', { name: 'Save with approval' }).click()
    await page.getByRole('dialog', { name: 'Approval required' }).getByRole('button', { name: 'Approve once' }).click()
    await expect.poll(() => writes.length).toBe(1)
    await page.getByRole('textbox', { name: 'Formal archive targets (one Vault .md path per line)' }).fill('synthesis/first.md\nsynthesis/second.md')
    await page.getByRole('button', { name: 'Archive knowledge with approval' }).click()
    const approval = page.getByRole('dialog', { name: 'Approval required' })
    await expect(approval).toContainText('Persist pending archive lifecycle')
    await approval.getByRole('button', { name: 'Approve once' }).click()
    await expect.poll(() => writes.length).toBe(2)
    expect(parseAnnotationMarkdown(writes[1].intent.content).archive.state).toBe('pending')
    await expect(approval).toContainText('saved-vault (Vault root)')
    await approval.getByRole('button', { name: 'Approve once' }).click()
    await expect(approval).toContainText(`Persist ${archiveStatus} archive lifecycle`)
    await approval.getByRole('button', { name: 'Approve once' }).click()
    await expect.poll(() => writes.length).toBe(3)
    const terminal = parseAnnotationMarkdown(writes[2].intent.content)
    expect(terminal.archive).toMatchObject({
      state: 'failed',
      targets: ['synthesis/first.md', 'synthesis/second.md'],
      runId: expect.any(String),
      error: { code: archiveStatus === 'cancelled' ? 'archive_cancelled' : 'archive_failed' },
    })
    expect(terminal.archived).toBe(false)
    const status = page.getByRole('region', { name: 'Formal archive status' })
    await expect(status).toContainText('failed')
    await expect(status).toContainText('synthesis/first.md')
    await expect(status).toContainText('created')
    await expect(status).not.toContainText('completed')
    await expect(page.getByRole('button', { name: /Open annotation for Selected evidence/ }).first()).toBeVisible()
    await page.reload()
    await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
    await page.getByRole('button', { name: 'Show annotations workbench (1)' }).click()
    await page.locator('.annotation-record').filter({ hasText: 'Archive failed' }).click()
    await expect(page.getByRole('region', { name: 'Formal archive status' })).toContainText('failed')
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
}

for (const persistenceCase of ['pending-declined', 'pending-conflict', 'tuple-mismatch', 'terminal-declined', 'terminal-conflict']) {
  test(`fails closed for ${persistenceCase} without reusing archive approval`, async ({ page }) => {
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.route('**/api/runtime', (route) => route.fulfill({
      json: createRuntimeManifest({ buildMode: 'test', target: 'local-web', services: { annotations: true, actions: ARCHIVE_ACTION_SERVICE } }),
    }))
    const persisted = new Map()
    const writes = []
    let writeAttempts = 0
    await page.route('**/api/runtime/annotations*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() === 'GET' && url.searchParams.has('path')) {
        const path = url.searchParams.get('path')
        if (persistenceCase === 'tuple-mismatch' && writeAttempts === 2) {
          return route.fulfill({ json: { ok: false, schemaVersion: 1, code: 'not_found', error: 'Exact Runtime path mismatch.' } })
        }
        const entry = persisted.get(path)
        return route.fulfill({ json: entry ? { ok: true, schemaVersion: 1, path, ...entry } : { ok: false, schemaVersion: 1, error: 'Missing annotation.' } })
      }
      if (request.method() === 'GET') {
        return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [...persisted.entries()].map(([path, entry]) => ({ path, revision: entry.revision })) } })
      }
      writeAttempts += 1
      const body = request.postDataJSON()
      if ((persistenceCase === 'pending-conflict' && writeAttempts === 2) || (persistenceCase === 'terminal-conflict' && writeAttempts === 3)) {
        return route.fulfill({ json: { ok: false, schemaVersion: 1, code: 'revision_conflict', error: 'Annotation revision conflict.' } })
      }
      const revision = `annotation-revision-${writeAttempts}`
      writes.push(body)
      persisted.set(body.intent.target.path, { content: body.intent.content, revision })
      const path = persistenceCase === 'tuple-mismatch' && writeAttempts === 2 ? `${body.intent.target.path}.mismatch` : body.intent.target.path
      return route.fulfill({ json: { ok: true, schemaVersion: 1, annotationId: body.intent.annotationId, path, revision } })
    })
    const archiveCalls = await installArchiveTransport(page)
    await page.goto('/')
    await installVaultSnapshot(page)
    await page.reload()
    await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
    const markdown = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
    const start = markdown.indexOf('Selected evidence')
    await selectMarkdownRange(page, start, start + 'Selected evidence'.length)
    await page.getByRole('menuitem', { name: '手工批注' }).click()
    await page.getByRole('textbox', { name: 'Your annotation' }).fill('Body remains saved.')
    await page.getByRole('button', { name: 'Save with approval' }).click()
    const approval = page.getByRole('dialog', { name: 'Approval required' })
    await approval.getByRole('button', { name: 'Approve once' }).click()
    await expect.poll(() => writes.length).toBe(1)
    await page.getByRole('textbox', { name: 'Formal archive targets (one Vault .md path per line)' }).fill('synthesis/guard.md')
    await page.getByRole('button', { name: 'Archive knowledge with approval' }).click()
    await expect(approval).toContainText('Persist pending archive lifecycle')

    if (persistenceCase === 'pending-declined') {
      await approval.getByRole('button', { name: 'Cancel' }).click()
      await expect(page.getByRole('alert').filter({ hasText: 'No Action started' })).toBeVisible()
      expect(archiveCalls.starts).toHaveLength(0)
      expect(writes).toHaveLength(1)
    } else {
      await approval.getByRole('button', { name: 'Approve once' }).click()
      if (['pending-conflict', 'tuple-mismatch'].includes(persistenceCase)) {
        await expect(page.getByRole('alert').filter({ hasText: /revision conflict|path mismatch/ })).toBeVisible()
        expect(archiveCalls.starts).toHaveLength(0)
        expect(writes).toHaveLength(persistenceCase === 'tuple-mismatch' ? 2 : 1)
      } else {
        await expect(approval).toContainText('saved-vault (Vault root)')
        await approval.getByRole('button', { name: 'Approve once' }).click()
        await expect.poll(() => archiveCalls.starts.length).toBe(1)
        await expect(approval).toContainText('Persist completed archive lifecycle')
        if (persistenceCase === 'terminal-declined') {
          await approval.getByRole('button', { name: 'Cancel' }).click()
          await expect(page.getByRole('status').filter({ hasText: 'write was declined' })).toBeVisible()
        } else {
          await approval.getByRole('button', { name: 'Approve once' }).click()
          await expect(page.getByRole('status').filter({ hasText: 'write failed' })).toBeVisible()
        }
        await expect(page.locator('.annotation-rendered')).toContainText('Body remains saved.')
        expect(parseAnnotationMarkdown([...persisted.values()][0].content).archive.state).toBe('pending')
        await page.reload()
        await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
        await page.getByRole('button', { name: 'Show annotations workbench (1)' }).click()
        await expect(page.locator('.annotation-record').filter({ hasText: 'Archive pending' })).toBeVisible()
      }
    }
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
}

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

for (const terminalStatus of ['failed', 'cancelled']) {
  test(`keeps a ${terminalStatus} Explain terminal out of sections.ai and annotation writes`, async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.route('**/api/runtime', (route) => route.fulfill({
      json: createRuntimeManifest({
        buildMode: 'test',
        target: 'local-web',
        services: { annotations: true, knowledgeReads: KNOWLEDGE_READ_SERVICE },
      }),
    }))
    let writeCount = 0
    await page.route('**/api/runtime/annotations*', (route) => {
      if (route.request().method() === 'PUT') writeCount += 1
      return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [] } })
    })
    await installKnowledgeReadTransport(page, { status: terminalStatus })

    await page.goto('/')
    await installVaultSnapshot(page)
    await page.reload()
    await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
    const markdown = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
    const start = markdown.indexOf('Selected evidence')
    await selectMarkdownRange(page, start, start + 'Selected evidence is reproducible'.length)
    await page.getByRole('menuitem', { name: 'AI 解释' }).click()

    await expect(page.getByRole('alert').filter({ hasText: terminalStatus === 'cancelled' ? 'cancelled' : 'failed' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'AI contribution' })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Save with approval' })).toBeDisabled()
    expect(writeCount).toBe(0)
    expect(pageErrors).toEqual([])
  })
}

test('cancels an in-flight AI explanation and excludes its late completed text', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/api/runtime', (route) => route.fulfill({
    json: createRuntimeManifest({ buildMode: 'test', target: 'local-web', services: { annotations: true, knowledgeReads: KNOWLEDGE_READ_SERVICE } }),
  }))
  let writeCount = 0
  let cancelledRun = null
  let readRequest = null
  await page.route('**/api/runtime/annotations*', (route) => {
    if (route.request().method() === 'PUT') writeCount += 1
    return route.fulfill({ json: { ok: true, schemaVersion: 1, vaultId: 'saved-vault', annotations: [] } })
  })
  await page.route('**/api/research/runs**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'POST' && url.pathname.endsWith('/api/research/runs')) return route.fulfill({ status: 201, json: { created: true } })
    if (request.method() === 'POST' && url.pathname.endsWith('/start')) {
      readRequest = request.postDataJSON().knowledgeRead
      return route.fulfill({ status: 202, json: { started: true } })
    }
    if (request.method() === 'DELETE') {
      cancelledRun = decodeURIComponent(url.pathname.split('/').at(-1))
      return route.fulfill({ json: { cancelled: true } })
    }
    if (request.method() === 'GET' && url.searchParams.get('follow') !== '1') return route.fulfill({ json: { events: [] } })
    if (request.method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const result = {
        schemaVersion: 1,
        toolId: readRequest.toolId,
        requestId: readRequest.requestId,
        runId: readRequest.runId,
        status: 'completed',
        effect: 'read',
        summary: 'Late result.',
        data: { schemaVersion: 1, kind: 'knowledge-read-result', agentId: 'knowledge-curator', sessionId: readRequest.sessionId, runId: readRequest.runId, text: 'This late text must never enter sections.ai.' },
        artifacts: [],
        error: null,
      }
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ cursor: 1, event: { type: 'run.completed', runId: readRequest.runId, result } })}\n\n` })
    }
    return route.fulfill({ status: 405, json: { error: 'Unexpected request.' } })
  })

  await page.goto('/')
  await installVaultSnapshot(page)
  await page.reload()
  await page.locator('.main-nav').getByRole('button', { name: 'Knowledge Graph' }).click()
  const markdown = '# Findings\n\nSelected evidence is reproducible with [[findings#Methods|inline evidence]] and\ncontinues across a second rendered line.\n\n## Methods\n\nThe assay was repeated in three cohorts.\n\n```js\nconst protectedValue = true\n```'
  const start = markdown.indexOf('Selected evidence')
  await selectMarkdownRange(page, start, start + 'Selected evidence'.length)
  await page.getByRole('menuitem', { name: 'AI 解释' }).click()
  await expect(page.getByRole('button', { name: 'Cancel AI' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel AI' }).click()
  await expect(page.getByRole('alert')).toContainText('cancelled')
  await page.waitForTimeout(450)
  await expect(page.getByRole('textbox', { name: 'AI contribution' })).toHaveValue('')
  expect(cancelledRun).toBe(readRequest.runId)
  expect(writeCount).toBe(0)
  expect(pageErrors).toEqual([])
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
    await page.getByRole('button', { name: 'Close annotations' }).click()
  }

  const wordStart = markdown.indexOf('evidence')
  await inspectSelection(wordStart, wordStart + 'evidence'.length, 'evidence', { mouse: false })
  const phraseStart = markdown.indexOf('Selected evidence')
  const phraseEnd = phraseStart + 'Selected evidence is reproducible'.length
  await selectMarkdownRange(page, phraseStart, phraseEnd)
  await expect(chooser.getByRole('menuitem', { name: 'AI 解释' })).toBeDisabled()
  await chooser.getByRole('menuitem', { name: '手工批注' }).click()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toBeFocused()
  await expect(page.locator('.annotation-source blockquote')).toHaveText('Selected evidence is reproducible')
  await page.getByRole('button', { name: 'Close annotations' }).click()
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

  await page.getByRole('button', { name: 'Back' }).click()
  await expect(chooser).toBeVisible()
  await chooser.getByRole('menuitem', { name: '手工批注' }).click()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Your annotation' }).fill('guarded draft')
  await page.keyboard.press('Escape')
  const closeGuard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })
  await expect(closeGuard).toBeVisible()
  await closeGuard.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.getByRole('textbox', { name: 'Your annotation' })).toHaveValue('guarded draft')
  await page.locator('.workspace-breadcrumb').click()
  await expect(closeGuard).toBeVisible()
  await closeGuard.getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('complementary', { name: 'Annotations' })).toHaveCount(0)

  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
})
