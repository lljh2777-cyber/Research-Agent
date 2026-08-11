import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANNOTATION_ARCHIVE_ERROR_MESSAGE_MAX_BYTES,
  ANNOTATION_MARKDOWN_MAX_BYTES,
  ANNOTATION_PATCH_CONTENT_MAX_BYTES,
  ANNOTATION_PATCH_SCHEMA_VERSION,
  ANNOTATION_SECTION_MAX_BYTES,
  ANNOTATION_SCHEMA_VERSION,
  ANNOTATION_V2_SCHEMA_VERSION,
  RELOCATION_SCHEMA_VERSION,
  createArchiveCancellationError,
  createAnnotationPatchIntent,
  createTextAnchor,
  migrateAnnotationToV2,
  normalizeAnnotation,
  normalizeAnnotationArchiveTargets,
  normalizeArchiveAnnotationInput,
  normalizeSourceAnnotationReference,
  normalizeTextAnchor,
  parseAnnotationMarkdown,
  relocateTextAnchor,
  serializeAnnotationMarkdown,
  utf8ByteLength,
} from './annotation.js'

function annotationFixture() {
  const markdown = '# Findings\nA durable evidence statement.\n'
  const start = markdown.indexOf('durable evidence')
  const anchor = createTextAnchor(markdown, { start, end: start + 'durable evidence'.length })
  return {
    schemaVersion: ANNOTATION_SCHEMA_VERSION,
    id: 'annotation-1',
    source: {
      vaultId: 'vault-1',
      noteId: 'note-1',
      path: 'papers/findings.md',
      revision: 'rev-7',
    },
    anchor,
    sections: {
      manual: 'Reviewed by a researcher.\n\n- keep',
      ai: 'AI synthesis with [[Evidence]].',
    },
    archived: false,
    timestamps: {
      createdAt: '2026-08-09T12:00:00.000Z',
      updatedAt: '2026-08-09T12:05:00.000Z',
      archivedAt: null,
    },
    relocation: relocateTextAnchor(markdown, anchor),
  }
}

test('TextAnchor v1 captures quote, position, heading, and line fallback', () => {
  const markdown = '# Findings\nFirst line.\nSelected evidence spans here.\n'
  const start = markdown.indexOf('Selected evidence')
  const anchor = createTextAnchor(markdown, { start, end: start + 'Selected evidence'.length }, { contextCharacters: 8 })

  assert.deepEqual(anchor, {
    schemaVersion: 1,
    quote: {
      exact: 'Selected evidence',
      prefix: 't line.\n',
      suffix: ' spans h',
    },
    position: { start, end: start + 'Selected evidence'.length },
    heading: {
      text: 'Findings',
      level: 1,
      line: 1,
      relativeStartLine: 2,
      relativeEndLine: 2,
    },
    line: { start: 3, end: 3 },
  })
})

test('relocation uses quote context to choose deterministically among duplicates', () => {
  const original = '# One\nalpha target omega\n# Two\nbeta target gamma\n'
  const start = original.lastIndexOf('target')
  const anchor = createTextAnchor(original, { start, end: start + 6 }, { contextCharacters: 10 })
  const revised = 'Preface\n' + original

  assert.deepEqual(relocateTextAnchor(revised, anchor), {
    schemaVersion: RELOCATION_SCHEMA_VERSION,
    status: 'relocated',
    strategy: 'quote_context',
    start: revised.lastIndexOf('target'),
    end: revised.lastIndexOf('target') + 6,
    candidates: 2,
  })
})

test('relocation reports ambiguous ties rather than guessing', () => {
  const anchor = createTextAnchor('target', { start: 0, end: 6 }, { contextCharacters: 0 })
  const result = relocateTextAnchor('x target y target', anchor)

  assert.deepEqual(result, {
    schemaVersion: RELOCATION_SCHEMA_VERSION,
    status: 'ambiguous',
    strategy: 'none',
    start: null,
    end: null,
    candidates: 2,
  })
})

test('relocation returns stale heading/line fallback and missing when no fallback survives', () => {
  const original = '# Findings\nOriginal evidence sentence.\n'
  const start = original.indexOf('Original evidence')
  const anchor = createTextAnchor(original, { start, end: start + 'Original evidence'.length })
  const revised = '# Findings\nRewritten evidence sentence.\n'
  const stale = relocateTextAnchor(revised, anchor)

  assert.equal(stale.status, 'stale')
  assert.equal(stale.strategy, 'heading_line')
  assert.equal(revised.slice(stale.start, stale.end), 'Rewritten evidence sentence.')
  assert.deepEqual(relocateTextAnchor('', anchor), {
    schemaVersion: RELOCATION_SCHEMA_VERSION,
    status: 'missing',
    strategy: 'none',
    start: null,
    end: null,
    candidates: 0,
  })
})

test('anchors reject protected Markdown and relocation never targets it', () => {
  const samples = [
    ['---\nsecret: value\n---\nBody\n', 'value'],
    ['# Note\n~~~js\nconst secret = true\n~~~\n', 'secret'],
    ['# Note\n```js\n```not-a-close\nconst secret = true\n```\n', 'secret'],
    ['# Note\nUse `secret` here.\n', 'secret'],
    ['# Note\n<!-- secret -->\n', 'secret'],
  ]
  for (const [markdown, quote] of samples) {
    const start = markdown.indexOf(quote)
    assert.throws(() => createTextAnchor(markdown, { start, end: start + quote.length }), /protected Markdown/)
  }

  const anchor = createTextAnchor('target', { start: 0, end: 6 }, { contextCharacters: 0 })
  const revised = '---\nkey: target\n---\nBody target\n'
  const result = relocateTextAnchor(revised, anchor)
  assert.equal(result.status, 'relocated')
  assert.equal(result.candidates, 1)
  assert.equal(result.start, revised.lastIndexOf('target'))
})

test('Annotation v1 Markdown round-trips manual and AI sections', () => {
  const annotation = annotationFixture()
  const markdown = serializeAnnotationMarkdown(annotation)

  assert.match(markdown, /^---\nannotation_schema: 1\n/)
  assert.match(markdown, /## Manual\n<!-- annotation:manual:start -->/)
  assert.match(markdown, /## AI\n<!-- annotation:ai:start -->/)
  assert.deepEqual(parseAnnotationMarkdown(markdown.replaceAll('\n', '\r\n')), annotation)
})

test('Annotation v1 archive invariants are explicit', () => {
  const annotation = annotationFixture()
  annotation.archived = true
  assert.throws(() => normalizeAnnotation(annotation), /archivedAt/)
  annotation.timestamps.archivedAt = '2026-08-09T12:06:00.000Z'
  assert.equal(normalizeAnnotation(annotation).archived, true)

  annotation.timestamps.updatedAt = '2026-08-09T11:59:00.000Z'
  assert.throws(() => normalizeAnnotation(annotation), /updatedAt must not precede/)
})

test('Annotation v1 migrates explicitly to v2 without fabricated provenance or archive identity', () => {
  const active = migrateAnnotationToV2(annotationFixture())
  assert.equal(active.schemaVersion, ANNOTATION_V2_SCHEMA_VERSION)
  assert.equal(active.aiProvenance, null)
  assert.deepEqual(active.archive, { state: 'none', targets: [], runId: null, error: null })
  assert.equal(active.archived, false)

  const legacy = annotationFixture()
  legacy.archived = true
  legacy.timestamps.archivedAt = '2026-08-09T12:06:00.000Z'
  const archived = migrateAnnotationToV2(legacy)
  assert.deepEqual(archived.archive, { state: 'completed', targets: [], runId: null, error: null })
  assert.equal(archived.archived, true)
  assert.equal(archived.aiProvenance, null)
})

test('Annotation v2 projects archived only for completed archive state', () => {
  const base = migrateAnnotationToV2(annotationFixture())
  const pending = normalizeAnnotation({
    ...base,
    archived: true,
    archive: { state: 'pending', targets: ['knowledge/findings.md'], runId: 'run-1', error: null },
  })
  assert.equal(pending.archived, false)
  assert.equal(pending.timestamps.archivedAt, null)

  const failed = normalizeAnnotation({
    ...pending,
    archive: {
      state: 'failed',
      targets: pending.archive.targets,
      runId: pending.archive.runId,
      error: createArchiveCancellationError(),
    },
  })
  assert.equal(failed.archived, false)
  assert.deepEqual(failed.archive.error, {
    code: 'archive_cancelled',
    message: 'Archive run was cancelled.',
  })

  const completedAt = '2026-08-09T12:07:00.000Z'
  const completed = normalizeAnnotation({
    ...pending,
    archive: { ...pending.archive, state: 'completed' },
    timestamps: { ...pending.timestamps, updatedAt: completedAt, archivedAt: completedAt },
  })
  assert.equal(completed.archived, true)
})

test('Annotation v2 migration and archive lifecycle preserve Web anchoring and relocation semantics', () => {
  const original = '# Findings\nA durable evidence statement.\n'
  const revised = '# Findings\nA newly durable evidence statement.\n'
  const migrated = migrateAnnotationToV2(annotationFixture())
  const before = relocateTextAnchor(revised, migrated.anchor)
  const pending = normalizeAnnotation({
    ...migrated,
    archive: { state: 'pending', targets: ['knowledge/findings.md'], runId: 'run-1', error: null },
  })

  assert.deepEqual(pending.source, migrated.source)
  assert.deepEqual(pending.anchor, migrated.anchor)
  assert.deepEqual(pending.sections, migrated.sections)
  assert.deepEqual(relocateTextAnchor(revised, pending.anchor), before)
  assert.equal(original.slice(migrated.anchor.position.start, migrated.anchor.position.end), migrated.anchor.quote.exact)
})

test('Annotation v2 freezes opaque source revision and normalized archive target semantics', () => {
  assert.deepEqual(normalizeSourceAnnotationReference({ id: 'annotation-1', revision: 'annotation-rev-7' }), {
    id: 'annotation-1',
    revision: 'annotation-rev-7',
  })
  assert.deepEqual(normalizeAnnotationArchiveTargets(['knowledge/findings.md', '知识/证据.md']), [
    'knowledge/findings.md',
    '知识/证据.md',
  ])
  assert.throws(() => normalizeAnnotationArchiveTargets(['../escape.md']), /normalized relative Vault path/)
  assert.throws(() => normalizeAnnotationArchiveTargets(['knowledge\\escape.md']), /forward slashes/)
  assert.throws(() => normalizeAnnotationArchiveTargets(['knowledge/bad\npath.md']), /control characters/)
  assert.throws(() => normalizeAnnotationArchiveTargets(['knowledge/findings.md', 'knowledge/findings.md']), /duplicate/)
  assert.throws(() => normalizeAnnotationArchiveTargets(['knowledge/findings.txt']), /Markdown file/)
  assert.deepEqual(normalizeArchiveAnnotationInput({
    operation: 'archive-annotation',
    sourceAnnotation: { id: 'annotation-1', revision: 'annotation-rev-7' },
    targets: ['knowledge/findings.md'],
  }), {
    operation: 'archive-annotation',
    sourceAnnotation: { id: 'annotation-1', revision: 'annotation-rev-7' },
    targets: ['knowledge/findings.md'],
  })
  assert.throws(() => normalizeArchiveAnnotationInput({
    operation: 'archive-annotation',
    sourceAnnotation: { id: 'annotation-1', revision: 'annotation-rev-7' },
    targets: [],
  }), /must not be empty/)
})

test('Annotation v2 enforces safe provenance and UTF-8 section bounds', () => {
  const base = migrateAnnotationToV2(annotationFixture())
  const withProvenance = normalizeAnnotation({
    ...base,
    aiProvenance: {
      providerId: 'provider-id',
      modelId: 'model-id',
      generatedAt: base.timestamps.updatedAt,
      apiKey: 'must-be-dropped',
    },
  })
  assert.deepEqual(Object.keys(withProvenance.aiProvenance), ['providerId', 'modelId', 'generatedAt'])
  assert.equal('apiKey' in withProvenance.aiProvenance, false)
  assert.throws(() => normalizeAnnotation({
    ...base,
    sections: { ...base.sections, manual: '界'.repeat(Math.floor(ANNOTATION_SECTION_MAX_BYTES / 3) + 1) },
  }), /65536 UTF-8 bytes/)
  assert.throws(
    () => createArchiveCancellationError('x'.repeat(ANNOTATION_ARCHIVE_ERROR_MESSAGE_MAX_BYTES + 1)),
    /1024 UTF-8 bytes/,
  )
  assert.throws(() => parseAnnotationMarkdown('x'.repeat(ANNOTATION_MARKDOWN_MAX_BYTES + 1)), /262144 UTF-8 bytes/)
})

test('annotation writes are represented only as a versioned patch intent', () => {
  const annotation = annotationFixture()
  const patchIntent = createAnnotationPatchIntent(annotation, {
    path: '.annotations/annotation-1.md',
    expectedRevision: 'annotation-rev-2',
  })

  assert.deepEqual(Object.keys(patchIntent), [
    'schemaVersion',
    'kind',
    'annotationId',
    'target',
    'contentType',
    'content',
  ])
  assert.equal(patchIntent.schemaVersion, ANNOTATION_PATCH_SCHEMA_VERSION)
  assert.equal(patchIntent.kind, 'annotation.upsert')
  assert.deepEqual(patchIntent.target, {
    vaultId: 'vault-1',
    path: '.annotations/annotation-1.md',
    expectedRevision: 'annotation-rev-2',
  })
  assert.deepEqual(parseAnnotationMarkdown(patchIntent.content), annotation)
})

test('AnnotationPatchIntentV1 remains unchanged for Annotation v2 payloads', () => {
  const annotation = migrateAnnotationToV2(annotationFixture())
  const intent = createAnnotationPatchIntent(annotation, {
    path: '.annotations/annotation-1.md',
    expectedRevision: null,
  })
  assert.deepEqual(Object.keys(intent), ['schemaVersion', 'kind', 'annotationId', 'target', 'contentType', 'content'])
  assert.equal(intent.schemaVersion, 1)
  assert.equal(parseAnnotationMarkdown(intent.content).schemaVersion, 2)
})

test('persistable v2 counts complete Markdown and accepts exactly 65536 UTF-8 bytes', () => {
  const annotation = migrateAnnotationToV2(annotationFixture())
  const withCjkPrefix = normalizeAnnotation({
    ...annotation,
    sections: { ...annotation.sections, manual: '界' },
  })
  const prefixBytes = utf8ByteLength(serializeAnnotationMarkdown(withCjkPrefix))
  const exact = normalizeAnnotation({
    ...annotation,
    sections: {
      ...annotation.sections,
      manual: '界' + 'x'.repeat(ANNOTATION_PATCH_CONTENT_MAX_BYTES - prefixBytes),
    },
  })
  const intent = createAnnotationPatchIntent(exact, {
    path: '.annotations/annotation-exact.md',
    expectedRevision: null,
  })
  assert.equal(utf8ByteLength(intent.content), ANNOTATION_PATCH_CONTENT_MAX_BYTES)
  assert.equal(parseAnnotationMarkdown(intent.content).sections.manual.startsWith('界'), true)

  const oneByteOver = normalizeAnnotation({
    ...exact,
    sections: { ...exact.sections, manual: exact.sections.manual + 'x' },
  })
  const oversized = serializeAnnotationMarkdown(oneByteOver)
  assert.equal(utf8ByteLength(oversized), ANNOTATION_PATCH_CONTENT_MAX_BYTES + 1)
  assert.deepEqual(parseAnnotationMarkdown(oversized), oneByteOver)
  assert.throws(() => createAnnotationPatchIntent(oneByteOver, {
    path: '.annotations/annotation-over.md',
    expectedRevision: null,
  }), /65536-byte Runtime write ceiling/)
})

test('oversized external v2 remains readable but cannot produce AnnotationPatchIntentV1', () => {
  const annotation = migrateAnnotationToV2(annotationFixture())
  const large = normalizeAnnotation({
    ...annotation,
    sections: { ...annotation.sections, manual: '界'.repeat(21_700) },
  })
  const serialized = serializeAnnotationMarkdown(large)
  const contentBytes = utf8ByteLength(serialized)

  assert.ok(contentBytes > ANNOTATION_PATCH_CONTENT_MAX_BYTES)
  assert.ok(contentBytes <= ANNOTATION_MARKDOWN_MAX_BYTES)
  assert.deepEqual(parseAnnotationMarkdown(serialized), large)
  assert.throws(() => createAnnotationPatchIntent(large, {
    path: '.annotations/annotation-large.md',
    expectedRevision: null,
  }), /65536-byte Runtime write ceiling/)
})

test('TextAnchor normalization rejects unknown schema versions', () => {
  assert.throws(() => normalizeTextAnchor({ schemaVersion: 2 }), /Unsupported text anchor/)

  const annotation = annotationFixture()
  assert.throws(() => normalizeTextAnchor({
    ...annotation.anchor,
    position: { ...annotation.anchor.position, end: annotation.anchor.position.end + 1 },
  }), /span must match quote/)

  assert.throws(() => normalizeAnnotation({
    ...annotation,
    relocation: { ...annotation.relocation, status: 'missing' },
  }), /must not select a range/)
})
