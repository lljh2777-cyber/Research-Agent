import assert from 'node:assert/strict'
import test from 'node:test'

import {
  KNOWLEDGE_CONTEXT_MAX_BYTES,
  KNOWLEDGE_CONTEXT_SCHEMA_VERSION,
  createActiveNoteReference,
  createKnowledgeContext,
  createSelectionReference,
  knowledgeContextByteLength,
} from './context.js'

const activeNote = {
  id: 'note-1',
  path: 'papers/findings.md',
  title: 'Findings',
  revision: 'note-rev-4',
}

function contextFixture() {
  const markdown = '# Findings\nThe selected evidence is reproducible.\n'
  const start = markdown.indexOf('selected evidence')
  return createKnowledgeContext({
    surface: 'research',
    vault: { id: 'vault-1', name: 'Lab Vault', revision: 'vault-rev-9' },
    activeNote,
    selection: createSelectionReference(markdown, activeNote, {
      start,
      end: start + 'selected evidence'.length,
    }),
    attachments: [{
      id: 'attachment-1',
      name: 'Dataset',
      kind: 'artifact',
      reference: 'artifact://dataset-7',
      mediaType: 'text/csv',
    }],
    contextRevision: 'context-rev-3',
  })
}

test('Knowledge Context v1 freezes the surface-neutral envelope', () => {
  const context = contextFixture()

  assert.deepEqual(Object.keys(context), [
    'schemaVersion',
    'surface',
    'vault',
    'activeNote',
    'selection',
    'attachments',
    'contextRevision',
  ])
  assert.equal(context.schemaVersion, KNOWLEDGE_CONTEXT_SCHEMA_VERSION)
  assert.deepEqual(context.vault, { id: 'vault-1', name: 'Lab Vault', revision: 'vault-rev-9' })
  assert.deepEqual(context.activeNote, activeNote)
  assert.equal(context.selection.noteId, activeNote.id)
  assert.equal(context.selection.anchor.quote.exact, 'selected evidence')
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context)
})

test('active-note and selection builders do not fabricate first-run state', () => {
  assert.equal(createActiveNoteReference(null), null)
  assert.throws(
    () => createSelectionReference('text', null, { start: 0, end: 4 }),
    /active note is required/,
  )

  const context = createKnowledgeContext({
    surface: 'knowledge_sidebar',
    vault: { id: 'vault-1', name: 'Empty Vault', revision: '' },
    activeNote: null,
    selection: null,
    attachments: [],
    contextRevision: 'context-empty-1',
  })
  assert.equal(context.activeNote, null)
  assert.equal(context.selection, null)
})

test('selection identity must match the active note', () => {
  const context = contextFixture()
  assert.throws(() => createKnowledgeContext({
    ...context,
    selection: { ...context.selection, noteId: 'other-note' },
  }), /must match activeNote.id/)
  assert.throws(() => createKnowledgeContext({
    ...context,
    activeNote: null,
  }), /requires activeNote/)
})

test('attachment kinds are explicit and runtime references remain opaque strings', () => {
  const context = contextFixture()
  assert.equal(context.attachments[0].reference, 'artifact://dataset-7')
  assert.throws(() => createKnowledgeContext({
    ...context,
    attachments: [{ ...context.attachments[0], kind: 'browser_file' }],
  }), /Unsupported knowledge context attachment kind/)
})

test('Knowledge Context v1 enforces the Core 64 KiB UTF-8 envelope', () => {
  const context = contextFixture()
  assert.ok(knowledgeContextByteLength(context) < KNOWLEDGE_CONTEXT_MAX_BYTES)
  assert.equal(knowledgeContextByteLength({ x: '😀' }), 12)

  assert.throws(() => createKnowledgeContext({
    ...context,
    attachments: [{
      ...context.attachments[0],
      reference: 'a'.repeat(KNOWLEDGE_CONTEXT_MAX_BYTES),
    }],
  }), /exceeds the 65536-byte Core envelope/)
})
