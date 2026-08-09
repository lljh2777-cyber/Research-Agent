import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ANNOTATION_PATCH_SCHEMA_VERSION,
  ANNOTATION_SCHEMA_VERSION,
  RELOCATION_SCHEMA_VERSION,
  createAnnotationPatchIntent,
  createTextAnchor,
  normalizeAnnotation,
  normalizeTextAnchor,
  parseAnnotationMarkdown,
  relocateTextAnchor,
  serializeAnnotationMarkdown,
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
