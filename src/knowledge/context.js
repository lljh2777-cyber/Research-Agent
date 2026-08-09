import { createTextAnchor, normalizeTextAnchor } from '../annotations/annotation.js'

export const KNOWLEDGE_CONTEXT_SCHEMA_VERSION = 1
export const KNOWLEDGE_CONTEXT_MAX_BYTES = 64 * 1024

const ATTACHMENT_KINDS = new Set(['vault_note', 'artifact', 'file', 'url'])

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object.')
  return value
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new TypeError(label + ' must be a non-empty string.')
  return value
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null
  return requireString(value, label)
}

function utf8ByteLength(value) {
  let bytes = 0
  for (const character of value) {
    const point = character.codePointAt(0)
    if (point <= 0x7f) bytes += 1
    else if (point <= 0x7ff) bytes += 2
    else if (point <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

function normalizeVault(value) {
  const vault = requireRecord(value, 'knowledge context.vault')
  return {
    id: requireString(vault.id, 'knowledge context.vault.id'),
    name: requireString(vault.name, 'knowledge context.vault.name'),
    revision: requireString(vault.revision, 'knowledge context.vault.revision', { allowEmpty: true }),
  }
}

export function createActiveNoteReference(value) {
  if (value === null || value === undefined) return null
  const note = requireRecord(value, 'active note')
  return {
    id: requireString(note.id, 'active note.id'),
    path: requireString(note.path, 'active note.path'),
    title: requireString(note.title, 'active note.title'),
    revision: requireString(note.revision, 'active note.revision', { allowEmpty: true }),
  }
}

function normalizeSelection(value) {
  if (value === null || value === undefined) return null
  const selection = requireRecord(value, 'knowledge context.selection')
  return {
    noteId: requireString(selection.noteId, 'knowledge context.selection.noteId'),
    anchor: normalizeTextAnchor(selection.anchor),
  }
}

export function createSelectionReference(markdown, activeNote, selection, options = {}) {
  const note = createActiveNoteReference(activeNote)
  if (!note) throw new TypeError('An active note is required to build a selection reference.')
  return {
    noteId: note.id,
    anchor: createTextAnchor(markdown, selection, options),
  }
}

function normalizeAttachment(value, index) {
  const attachment = requireRecord(value, 'knowledge context.attachments[' + index + ']')
  const kind = requireString(attachment.kind, 'knowledge context.attachments[' + index + '].kind')
  if (!ATTACHMENT_KINDS.has(kind)) throw new TypeError('Unsupported knowledge context attachment kind: ' + kind + '.')
  return {
    id: requireString(attachment.id, 'knowledge context.attachments[' + index + '].id'),
    name: requireString(attachment.name, 'knowledge context.attachments[' + index + '].name'),
    kind,
    reference: requireString(attachment.reference, 'knowledge context.attachments[' + index + '].reference'),
    mediaType: optionalString(attachment.mediaType, 'knowledge context.attachments[' + index + '].mediaType'),
  }
}

export function knowledgeContextByteLength(value) {
  return utf8ByteLength(JSON.stringify(value))
}

export function normalizeKnowledgeContext(value) {
  const context = requireRecord(value, 'knowledge context')
  if (context.schemaVersion !== KNOWLEDGE_CONTEXT_SCHEMA_VERSION) throw new TypeError('Unsupported knowledge context schemaVersion.')
  const activeNote = createActiveNoteReference(context.activeNote)
  const selection = normalizeSelection(context.selection)
  if (selection && !activeNote) throw new TypeError('knowledge context.selection requires activeNote.')
  if (selection && selection.noteId !== activeNote.id) throw new TypeError('knowledge context.selection.noteId must match activeNote.id.')
  if (!Array.isArray(context.attachments)) throw new TypeError('knowledge context.attachments must be an array.')
  const normalized = {
    schemaVersion: KNOWLEDGE_CONTEXT_SCHEMA_VERSION,
    surface: requireString(context.surface, 'knowledge context.surface'),
    vault: normalizeVault(context.vault),
    activeNote,
    selection,
    attachments: context.attachments.map(normalizeAttachment),
    contextRevision: requireString(context.contextRevision, 'knowledge context.contextRevision'),
  }
  const bytes = knowledgeContextByteLength(normalized)
  if (bytes > KNOWLEDGE_CONTEXT_MAX_BYTES) {
    throw new RangeError('Knowledge Context v1 exceeds the 65536-byte Core envelope: ' + bytes + ' bytes.')
  }
  return normalized
}

export function createKnowledgeContext(value) {
  return normalizeKnowledgeContext({
    schemaVersion: KNOWLEDGE_CONTEXT_SCHEMA_VERSION,
    ...requireRecord(value, 'knowledge context input'),
  })
}
