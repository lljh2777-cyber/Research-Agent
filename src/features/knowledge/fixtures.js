export const KNOWLEDGE_CONTEXT_CONTRACT = 'knowledge-context.v1'
export const KNOWLEDGE_AGENT_ID = 'knowledge-curator'
export const MAX_KNOWLEDGE_CONTEXT_BYTES = 65_536
export const MAX_KNOWLEDGE_ACTION_INPUT_BYTES = 131_072
export const MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES = 65_536

const TOOL_FIXTURES = [
  { id: 'query', title: 'Query', effect: 'read', riskClass: 'low', approvalPolicy: 'none', capability: 'knowledge.query' },
  { id: 'explain', title: 'Explain', effect: 'read', riskClass: 'low', approvalPolicy: 'none', capability: 'knowledge.explain' },
  { id: 'lint', title: 'Lint', effect: 'read', riskClass: 'low', approvalPolicy: 'none', capability: 'actions.lint' },
  { id: 'annotation', title: 'Annotate', effect: 'write', riskClass: 'medium', approvalPolicy: 'explicit', capability: 'annotations.write' },
  { id: 'paper-ingest', title: 'Paper ingest', effect: 'write', riskClass: 'medium', approvalPolicy: 'explicit', capability: 'actions.paper-ingest' },
  { id: 'xray', title: 'X-Ray', effect: 'write', riskClass: 'medium', approvalPolicy: 'explicit', capability: 'actions.xray' },
  { id: 'code-analysis', title: 'Static code analysis', effect: 'write', riskClass: 'medium', approvalPolicy: 'explicit', capability: 'actions.code-analysis' },
  { id: 'synthesis', title: 'Synthesis', effect: 'write', riskClass: 'medium', approvalPolicy: 'explicit', capability: 'actions.synthesis' },
]

export const KNOWLEDGE_TOOL_DESCRIPTOR_FIXTURES = Object.freeze(TOOL_FIXTURES.map((tool) => Object.freeze({
  ...tool,
  available: false,
  unavailableReason: 'Runtime capability has not been provided.',
})))

export const KNOWLEDGE_CURATOR_PRESET_FIXTURE = Object.freeze({
  id: KNOWLEDGE_AGENT_ID,
  version: 1,
  name: 'Knowledge Curator',
  shortName: 'Curator',
  description: 'Curate notes, annotations, and knowledge workflows with explicit context and approval.',
  contextContract: KNOWLEDGE_CONTEXT_CONTRACT,
  systemPrompt: 'Curate the supplied knowledge context. Keep reads non-mutating and require explicit scoped approval before every write.',
  model: Object.freeze({ mode: 'auto', providerId: null, modelId: 'smart-default', endpointType: null }),
  fallbackModels: Object.freeze([]),
  tools: Object.freeze({
    allowed: Object.freeze(TOOL_FIXTURES.map((tool) => tool.id)),
    defaults: Object.freeze(['query', 'explain']),
  }),
  knowledgeScopes: Object.freeze([]),
  permissions: Object.freeze({ readVault: true, writeVault: true, executeCode: false, networkAccess: 'ask' }),
  outputStyle: 'knowledge-curation',
  loopPolicy: Object.freeze({ maxToolRounds: 6, requireEvidence: false, stopOnInsufficientEvidence: false }),
})

export const KNOWLEDGE_CONTEXT_V1_FIXTURE = Object.freeze({
  schemaVersion: 1,
  surface: 'research',
  vault: Object.freeze({ id: 'vault-1', name: 'Lab Vault', revision: 'vault-rev-9' }),
  activeNote: Object.freeze({ id: 'note-1', path: 'papers/findings.md', title: 'Findings', revision: 'note-rev-4' }),
  selection: Object.freeze({
    noteId: 'note-1',
    anchor: Object.freeze({
      schemaVersion: 1,
      quote: Object.freeze({ exact: 'selected evidence', prefix: '# Findings\nThe ', suffix: ' is reproducible.\n' }),
      position: Object.freeze({ start: 15, end: 32 }),
      heading: Object.freeze({ text: 'Findings', level: 1, line: 1, relativeStartLine: 1, relativeEndLine: 1 }),
      line: Object.freeze({ start: 2, end: 2 }),
    }),
  }),
  attachments: Object.freeze([{ id: 'attachment-1', name: 'Dataset', kind: 'artifact', reference: 'artifact://dataset-7', mediaType: 'text/csv' }]),
  contextRevision: 'context-rev-3',
})

export const ANNOTATION_V1_FIXTURE = Object.freeze({
  schemaVersion: 1,
  id: 'annotation-1',
  source: Object.freeze({ vaultId: 'vault-1', noteId: 'note-1', path: 'papers/findings.md', revision: 'note-rev-4' }),
  anchor: KNOWLEDGE_CONTEXT_V1_FIXTURE.selection.anchor,
  sections: Object.freeze({ manual: 'Researcher-authored Markdown.', ai: 'AI-authored Markdown.' }),
  archived: false,
  timestamps: Object.freeze({ createdAt: '2026-08-09T12:00:00.000Z', updatedAt: '2026-08-09T12:05:00.000Z', archivedAt: null }),
  relocation: Object.freeze({ schemaVersion: 1, status: 'anchored', strategy: 'position', start: 15, end: 32, candidates: 1 }),
})

function compactNoteReference(note) {
  if (!note) return null
  return {
    id: String(note.id || note.noteId || ''),
    path: String(note.path || ''),
    title: String(note.title || note.name || 'Untitled note'),
    revision: String(note.revision || ''),
  }
}

export function createTextAnchorFixture({ markdown = '', exact = '', start, end, heading = null, lineStart = 1, lineEnd = lineStart } = {}) {
  const source = String(markdown)
  const quote = String(exact)
  const resolvedStart = Number.isInteger(start) ? start : source.indexOf(quote)
  const safeStart = Math.max(0, resolvedStart)
  const resolvedEnd = Number.isInteger(end) ? end : safeStart + quote.length
  const headingLine = heading?.line || Math.max(1, lineStart - (heading?.relativeStartLine || 0))
  return {
    schemaVersion: 1,
    quote: {
      exact: quote,
      prefix: source.slice(Math.max(0, safeStart - 64), safeStart),
      suffix: source.slice(resolvedEnd, Math.min(source.length, resolvedEnd + 64)),
    },
    position: { start: safeStart, end: resolvedEnd },
    heading: heading?.text ? {
      text: String(heading.text),
      level: Number(heading.level) || 1,
      line: headingLine,
      relativeStartLine: lineStart - headingLine,
      relativeEndLine: lineEnd - headingLine,
    } : null,
    line: { start: lineStart, end: lineEnd },
  }
}

export function createKnowledgeContextFixture({
  surface = 'knowledge-sidebar',
  vaultId = '',
  vaultName = '',
  vaultRevision = '',
  activeNote = null,
  selection = null,
  attachments = [],
  contextRevision = 'context-rev-0',
} = {}) {
  if (!vaultId) return null
  const note = compactNoteReference(activeNote)
  return {
    schemaVersion: 1,
    surface: String(surface),
    vault: { id: String(vaultId), name: String(vaultName || vaultId), revision: String(vaultRevision) },
    activeNote: note,
    selection: note && selection?.anchor ? { noteId: note.id, anchor: selection.anchor } : null,
    attachments: attachments.map((attachment) => ({
      id: String(attachment.id || ''),
      name: String(attachment.name || ''),
      kind: String(attachment.kind || 'artifact'),
      reference: String(attachment.reference || ''),
      mediaType: attachment.mediaType == null ? null : String(attachment.mediaType),
    })),
    contextRevision: String(contextRevision),
  }
}

export function createKnowledgeAgentSessionFixture({
  sessionId = 'knowledge-curator-session',
  runId = null,
  cursor = 0,
  context = null,
  messages = [],
  runStatus = 'created',
} = {}) {
  return {
    schemaVersion: 1,
    agentId: KNOWLEDGE_AGENT_ID,
    sessionId: String(sessionId),
    runId: runId ? String(runId) : null,
    cursor: Math.max(0, Number(cursor) || 0),
    context,
    messages: messages.map((message) => ({ ...message })),
    runStatus,
  }
}

function missingContextReason(tool, context) {
  if (!context?.vault) return 'Connect a Vault to use this action.'
  if (['explain', 'annotation'].includes(tool.id) && !context.selection) return 'Select text in the current note first.'
  if (!context.activeNote && tool.id !== 'paper-ingest') return 'Open a current note to use this action.'
  return ''
}

export function createKnowledgeToolFixtures({ context, availableCapabilities = [] } = {}) {
  const available = new Set(availableCapabilities)
  return TOOL_FIXTURES.map((tool) => {
    const contextReason = missingContextReason(tool, context)
    const capabilityAvailable = ['query', 'explain'].includes(tool.id) || available.has(tool.capability)
    return {
      ...tool,
      available: !contextReason && capabilityAvailable,
      unavailableReason: contextReason || (capabilityAvailable ? '' : 'Unavailable in the current Runtime capability profile.'),
    }
  })
}

export function createAnnotationFixture({ id, context, manual = '', ai = '', archived = false, createdAt, updatedAt, archivedAt = null, relocation } = {}) {
  if (!context?.selection?.anchor || !context?.activeNote || !context?.vault) throw new TypeError('Annotation v1 requires a Vault note selection context.')
  const timestamp = updatedAt || createdAt || new Date().toISOString()
  const anchor = context.selection.anchor
  return {
    schemaVersion: 1,
    id: String(id),
    source: {
      vaultId: context.vault.id,
      noteId: context.activeNote.id,
      path: context.activeNote.path,
      revision: context.activeNote.revision,
    },
    anchor,
    sections: { manual: String(manual), ai: String(ai) },
    archived: Boolean(archived),
    timestamps: { createdAt: createdAt || timestamp, updatedAt: timestamp, archivedAt: archived ? (archivedAt || timestamp) : null },
    relocation: relocation || { schemaVersion: 1, status: 'anchored', strategy: 'position', start: anchor.position.start, end: anchor.position.end, candidates: 1 },
  }
}

export function knowledgeEnvelopeSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export function assertKnowledgeEnvelopeFixture(value, maxBytes = MAX_KNOWLEDGE_CONTEXT_BYTES) {
  const bytes = knowledgeEnvelopeSize(value)
  if (bytes > maxBytes) throw new Error(`Knowledge Agent fixture exceeds ${maxBytes} bytes.`)
  return value
}

export function knowledgeCuratorPresetList(presets = []) {
  return presets.some((preset) => preset.id === KNOWLEDGE_AGENT_ID) ? presets : [...presets, KNOWLEDGE_CURATOR_PRESET_FIXTURE]
}
