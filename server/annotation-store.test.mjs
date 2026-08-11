import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { RUNTIME_ANNOTATION_CONTENT_MAX_BYTES } from '../shared/runtime-action-contracts.mjs'
import { normalizeAnnotation, serializeAnnotationMarkdown } from '../src/annotations/annotation.js'
import { AnnotationStore } from './annotation-store.mjs'

test('AnnotationStore writes atomically with approval, scope, revision, and idempotency checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bioresearch-annotations-'))
  const annotationsDirectory = join(root, 'wiki', 'annotations')
  const target = join(annotationsDirectory, 'annotation-1.md')
  await mkdir(join(root, 'wiki'))
  const vaultId = basename(root)
  const store = new AnnotationStore({ root })
  const path = 'wiki/annotations/annotation-1.md'
  const createInput = {
    intent: {
      kind: 'annotation.upsert',
      annotationId: 'annotation-1',
      target: { vaultId, path, expectedRevision: null },
      contentType: 'text/markdown',
      content: '# Annotation v1\nopaque-full-kb-envelope\n',
    },
    idempotencyKey: 'annotation-create-1',
    approval: { status: 'approved' },
  }

  try {
    const created = await store.write(createInput)
    assert.equal(created.ok, true)
    assert.equal(created.replayed, false)
    assert.equal(created.bytes, Buffer.byteLength(createInput.intent.content))

    const replayed = await store.write(createInput)
    assert.equal(replayed.replayed, true)
    assert.equal(replayed.revision, created.revision)

    const listed = await store.list()
    assert.equal(listed.vaultId, vaultId)
    assert.deepEqual(listed.annotations, [{
      path: 'wiki/annotations/annotation-1.md',
      revision: created.revision,
      bytes: Buffer.byteLength(createInput.intent.content),
    }])

    const loaded = await store.read(createInput.intent.target.path)
    assert.equal(loaded.content, createInput.intent.content)
    assert.equal(loaded.revision, created.revision)

    await assert.rejects(
      store.write({ ...createInput, intent: { ...createInput.intent, content: '# Different\n' } }),
      (error) => error.code === 'idempotency_conflict' && error.statusCode === 409,
    )
    await assert.rejects(
      store.write({ ...createInput, idempotencyKey: 'annotation-stale-1', intent: { ...createInput.intent, content: '# Updated\n' } }),
      (error) => error.code === 'revision_conflict' && error.currentRevision === created.revision,
    )
    await assert.rejects(
      store.write({
        ...createInput,
        idempotencyKey: 'annotation-scope-1',
        intent: { ...createInput.intent, target: { ...createInput.intent.target, vaultId: 'different-vault', expectedRevision: created.revision } },
      }),
      (error) => error.code === 'scope_denied',
    )
    await assert.rejects(
      store.write({
        ...createInput,
        idempotencyKey: 'annotation-large-1',
        intent: { ...createInput.intent, content: 'x'.repeat(RUNTIME_ANNOTATION_CONTENT_MAX_BYTES + 1) },
      }),
      (error) => error.code === 'limit_exceeded' && error.statusCode === 413,
    )

    const updated = await store.write({
      ...createInput,
      intent: { ...createInput.intent, content: '# Updated\n', target: { ...createInput.intent.target, expectedRevision: created.revision } },
      idempotencyKey: 'annotation-update-1',
    })
    assert.notEqual(updated.revision, created.revision)
    assert.equal((await store.read(createInput.intent.target.path)).content, '# Updated\n')
  } finally {
    await unlink(target).catch(() => {})
    await rmdir(annotationsDirectory).catch(() => {})
    await rmdir(join(root, 'wiki')).catch(() => {})
    await rmdir(root).catch(() => {})
  }
})

test('AnnotationStore preserves enriched Annotation v2 Markdown opaquely with case-preserved path and exact revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bioresearch-annotations-v2-'))
  const annotationsDirectory = join(root, 'wiki', 'annotations')
  const path = 'wiki/annotations/enriched.MD'
  const target = join(annotationsDirectory, 'enriched.MD')
  await mkdir(join(root, 'wiki'))
  const fixture = normalizeAnnotation(JSON.parse(await readFile(
    new URL('../docs/contracts/annotation-v2.fixture.json', import.meta.url),
    'utf8',
  )))
  const content = serializeAnnotationMarkdown(fixture)
  const store = new AnnotationStore({ root })
  try {
    const written = await store.write({
      intent: {
        schemaVersion: 1,
        kind: 'annotation.upsert',
        annotationId: fixture.id,
        target: { vaultId: basename(root), path, expectedRevision: null },
        contentType: 'text/markdown',
        content,
      },
      idempotencyKey: 'annotation-v2-opaque-1',
      approval: { status: 'approved' },
    })
    const loaded = await store.read(path)
    assert.equal(loaded.path, path)
    assert.equal(loaded.content, content)
    assert.equal(loaded.revision, written.revision)
    assert.equal(Buffer.byteLength(loaded.content), Buffer.byteLength(content))
    assert.deepEqual((await store.list()).annotations, [{
      path,
      revision: written.revision,
      bytes: Buffer.byteLength(content),
    }])
  } finally {
    await unlink(target).catch(() => {})
    await rmdir(annotationsDirectory).catch(() => {})
    await rmdir(join(root, 'wiki')).catch(() => {})
    await rmdir(root).catch(() => {})
  }
})
