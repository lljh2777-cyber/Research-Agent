import {
  ANNOTATION_ARCHIVE_MAX_TARGETS,
  ANNOTATION_ARCHIVE_TARGET_MAX_BYTES,
  ANNOTATION_ID_MAX_BYTES,
  ANNOTATION_RECORD_PATH_MAX_LENGTH,
  ANNOTATION_REVISION_MAX_BYTES,
  normalizeArchiveAnnotationInput,
} from '../annotations/annotation.js'

export const KNOWLEDGE_AGENT_SCHEMA_VERSION = 1
export const KNOWLEDGE_ACTION_SCHEMA_VERSION = 1
export const KNOWLEDGE_SESSION_HANDOFF_SCHEMA_VERSION = 1
export const KNOWLEDGE_AGENT_ID = 'knowledge-curator'

export const KNOWLEDGE_SURFACE = Object.freeze({
  RESEARCH: 'research',
  SIDEBAR: 'knowledge-sidebar',
})

export const KNOWLEDGE_TOOL_EFFECT = Object.freeze({ READ: 'read', WRITE: 'write' })
export const KNOWLEDGE_TOOL_RISK = Object.freeze({ READ: 'read', WRITE: 'write' })
export const KNOWLEDGE_TOOL_APPROVAL = Object.freeze({ NONE: 'none', EXPLICIT: 'explicit' })
export const KNOWLEDGE_ACTION_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const KNOWLEDGE_TOOL_IDS = Object.freeze({
  QUERY: 'knowledge.query',
  EXPLAIN: 'knowledge.explain',
  LINT: 'knowledge.lint',
  ANNOTATION: 'knowledge.annotation.write',
  PAPER_INGEST: 'knowledge.paper.ingest',
  XRAY: 'knowledge.xray',
  CODE_ANALYSIS: 'knowledge.code.analyze',
  SYNTHESIS: 'knowledge.synthesis.write',
})

export const MAX_KNOWLEDGE_CONTEXT_BYTES = 64 * 1024
export const MAX_KNOWLEDGE_ACTION_INPUT_BYTES = 128 * 1024
export const MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES = 64 * 1024

const SURFACES = new Set(Object.values(KNOWLEDGE_SURFACE))
const ACTION_STATUSES = new Set(Object.values(KNOWLEDGE_ACTION_STATUS))
const TARGET_KINDS = new Set(['vault', 'folder', 'note', 'selection', 'attachment'])

function cloneJson(value, label = 'Knowledge Agent value') {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`${label} must be JSON serializable.`)
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable.`)
  return JSON.parse(serialized)
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

function boundedEnvelope(value, maximum, label) {
  if (byteLength(value) > maximum) throw new Error(`${label} exceeds the ${maximum}-byte limit.`)
  return value
}

function requiredString(value, label, maximum = 256) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${label} is required.`)
  if (normalized.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`)
  return normalized
}

function nullableString(value, label, maximum = 256) {
  if (value === undefined || value === null || value === '') return null
  return requiredString(value, label, maximum)
}

function validateSchema(value, schema, path = 'Knowledge action arguments') {
  if (!schema) return
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}.`)
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path} has an unsupported value.`)
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const matchesType = (type) => {
    if (type === 'null') return value === null
    if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    if (type === 'array') return Array.isArray(value)
    if (type === 'integer') return Number.isInteger(value)
    return typeof value === type
  }
  if (types.length && !types.some(matchesType)) {
    throw new Error(`${path} has an invalid type.`)
  }
  if (value === null || value === undefined) return

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${path} is too short.`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`${path} is too long.`)
    }
  }
  if (Number.isInteger(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new Error(`${path} is below the minimum.`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new Error(`${path} exceeds the maximum.`)
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} contains too few items.`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new Error(`${path} contains too many items.`)
    }
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!(required in value)) throw new Error(`${path}.${required} is required.`)
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}))
      for (const key of Object.keys(value)) {
        if (!known.has(key)) throw new Error(`${path}.${key} is not allowed.`)
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) validateSchema(value[key], childSchema, `${path}.${key}`)
    }
  }
}

function freezeDescriptor(value) {
  return Object.freeze({
    ...value,
    inputSchema: Object.freeze(value.inputSchema),
    outputSchema: Object.freeze(value.outputSchema),
  })
}

function inputSchema({ write = false, inputProperties = {}, inputRequired = [] } = {}) {
  const properties = {
    input: {
      type: 'object',
      properties: inputProperties,
      required: inputRequired,
      additionalProperties: false,
    },
  }
  const required = []
  if (write) {
    properties.scope = {
      type: 'object',
      properties: {
        vaultId: { type: 'string', minLength: 1, maxLength: 256 },
        target: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: [...TARGET_KINDS] },
            id: { type: 'string', minLength: 1, maxLength: 1024 },
          },
          required: ['kind', 'id'],
          additionalProperties: false,
        },
        expectedRevision: { type: ['string', 'null'], maxLength: 256 },
      },
      required: ['vaultId', 'target'],
      additionalProperties: false,
    }
    properties.idempotencyKey = { type: 'string', minLength: 1, maxLength: 256 }
    required.push('scope', 'idempotencyKey')
  }
  if (inputRequired.length) required.unshift('input')
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { const: KNOWLEDGE_ACTION_SCHEMA_VERSION },
    toolId: { type: 'string' },
    requestId: { type: 'string' },
    runId: { type: 'string' },
    status: { type: 'string', enum: Object.values(KNOWLEDGE_ACTION_STATUS) },
    effect: { type: 'string', enum: Object.values(KNOWLEDGE_TOOL_EFFECT) },
    summary: { type: 'string' },
    data: {},
    artifacts: { type: 'array', items: { type: 'object' } },
    error: { type: ['object', 'null'] },
  },
  required: ['schemaVersion', 'toolId', 'requestId', 'runId', 'status', 'effect', 'summary', 'artifacts', 'error'],
  additionalProperties: false,
}

const READ_POLICY = Object.freeze({
  effect: KNOWLEDGE_TOOL_EFFECT.READ,
  riskClass: KNOWLEDGE_TOOL_RISK.READ,
  approvalPolicy: KNOWLEDGE_TOOL_APPROVAL.NONE,
  requiresScope: false,
  requiresIdempotencyKey: false,
})

const WRITE_POLICY = Object.freeze({
  effect: KNOWLEDGE_TOOL_EFFECT.WRITE,
  riskClass: KNOWLEDGE_TOOL_RISK.WRITE,
  approvalPolicy: KNOWLEDGE_TOOL_APPROVAL.EXPLICIT,
  requiresScope: true,
  requiresIdempotencyKey: true,
})

export const KNOWLEDGE_ACTION_TOOL_DESCRIPTORS = Object.freeze([
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.QUERY,
    name: 'knowledge_query',
    title: 'Query knowledge',
    description: 'Query connected Vault knowledge without changing it.',
    capability: 'knowledge.query',
    ...READ_POLICY,
    inputSchema: inputSchema({
      inputProperties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000 },
        topK: { type: 'integer', minimum: 1, maximum: 50 },
      },
      inputRequired: ['query'],
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.EXPLAIN,
    name: 'knowledge_explain',
    title: 'Explain selection',
    description: 'Explain the active note or selection as untrusted evidence without changing it.',
    capability: 'knowledge.explain',
    ...READ_POLICY,
    inputSchema: inputSchema({
      inputProperties: { question: { type: 'string', maxLength: 2_000 } },
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.LINT,
    name: 'knowledge_lint',
    title: 'Lint knowledge',
    description: 'Inspect knowledge quality and return findings. This tool never repairs or writes.',
    capability: 'knowledge.lint',
    ...READ_POLICY,
    inputSchema: inputSchema({
      inputProperties: { rules: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 64 } },
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.ANNOTATION,
    name: 'knowledge_annotation_write',
    title: 'Save annotation',
    description: 'Create, update, archive, or restore an Annotation v1 object within an explicitly approved target scope.',
    capability: 'annotations.write',
    ...WRITE_POLICY,
    inputSchema: inputSchema({
      write: true,
      inputProperties: {
        operation: { type: 'string', enum: ['create', 'update', 'archive', 'restore'] },
        annotation: { type: 'object' },
      },
      inputRequired: ['operation', 'annotation'],
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.PAPER_INGEST,
    name: 'knowledge_paper_ingest',
    title: 'Ingest paper',
    description: 'Run an approved paper-ingest action and return references to resulting artifacts.',
    capability: 'actions.paperIngest',
    ...WRITE_POLICY,
    inputSchema: inputSchema({
      write: true,
      inputProperties: { attachmentId: { type: 'string', minLength: 1, maxLength: 256 } },
      inputRequired: ['attachmentId'],
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.XRAY,
    name: 'knowledge_xray',
    title: 'X-Ray source',
    description: 'Run an approved X-Ray workflow and persist only explicitly scoped artifacts.',
    capability: 'actions.xray',
    ...WRITE_POLICY,
    inputSchema: inputSchema({
      write: true,
      inputProperties: { sourceRef: { type: 'string', minLength: 1, maxLength: 1024 } },
      inputRequired: ['sourceRef'],
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.CODE_ANALYSIS,
    name: 'knowledge_code_analysis',
    title: 'Analyze code',
    description: 'Run approved static code analysis and persist only explicitly scoped artifacts.',
    capability: 'actions.codeAnalysis',
    ...WRITE_POLICY,
    inputSchema: inputSchema({
      write: true,
      inputProperties: { sourceRef: { type: 'string', minLength: 1, maxLength: 1024 } },
      inputRequired: ['sourceRef'],
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
  freezeDescriptor({
    schemaVersion: KNOWLEDGE_AGENT_SCHEMA_VERSION,
    id: KNOWLEDGE_TOOL_IDS.SYNTHESIS,
    name: 'knowledge_synthesis_write',
    title: 'Write synthesis',
    description: 'Create an approved synthesis artifact inside an explicit target scope.',
    capability: 'actions.synthesis',
    ...WRITE_POLICY,
    inputSchema: inputSchema({
      write: true,
      inputProperties: {
        operation: { const: 'archive-annotation' },
        sourceAnnotation: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: ANNOTATION_ID_MAX_BYTES },
            path: { type: 'string', minLength: 1, maxLength: ANNOTATION_RECORD_PATH_MAX_LENGTH },
            revision: { type: 'string', minLength: 1, maxLength: ANNOTATION_REVISION_MAX_BYTES },
          },
          required: ['id', 'path', 'revision'],
          additionalProperties: false,
        },
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: ANNOTATION_ARCHIVE_MAX_TARGETS,
          items: { type: 'string', minLength: 1, maxLength: ANNOTATION_ARCHIVE_TARGET_MAX_BYTES },
        },
      },
      inputRequired: ['operation', 'sourceAnnotation', 'targets'],
    }),
    outputSchema: OUTPUT_SCHEMA,
  }),
])

const DESCRIPTORS = new Map(KNOWLEDGE_ACTION_TOOL_DESCRIPTORS.flatMap((descriptor) => [
  [descriptor.id, descriptor],
  [descriptor.name, descriptor],
]))

export function getKnowledgeActionToolDescriptor(idOrName) {
  return DESCRIPTORS.get(String(idOrName || '')) || null
}

export function consumeKnowledgeContextV1(value) {
  const context = cloneJson(value, 'Knowledge Context v1')
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('Knowledge Context v1 must be an object.')
  if (context.schemaVersion !== 1) throw new Error('Unsupported Knowledge Context schema version.')
  return boundedEnvelope(context, MAX_KNOWLEDGE_CONTEXT_BYTES, 'Knowledge Context v1')
}

export function normalizeKnowledgeActionScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Knowledge write action requires an explicit scope.')
  const target = value.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('Knowledge write scope requires a target.')
  const kind = requiredString(target.kind, 'Knowledge write scope target kind', 32)
  if (!TARGET_KINDS.has(kind)) throw new Error(`Unsupported Knowledge write target kind: ${kind}.`)
  return {
    vaultId: requiredString(value.vaultId, 'Knowledge write scope Vault ID'),
    target: {
      kind,
      id: requiredString(target.id, 'Knowledge write scope target ID', 1_024),
    },
    expectedRevision: nullableString(value.expectedRevision, 'Knowledge write scope expected revision'),
  }
}

export function createKnowledgeActionInput(descriptorId, {
  requestId,
  runId,
  sessionId,
  context,
  scope,
  idempotencyKey,
  input = {},
} = {}) {
  const descriptor = getKnowledgeActionToolDescriptor(descriptorId)
  if (!descriptor) throw new Error(`Unknown Knowledge Action Tool: ${String(descriptorId || 'missing')}.`)
  const normalizedScope = descriptor.requiresScope ? normalizeKnowledgeActionScope(scope) : null
  const normalizedIdempotencyKey = descriptor.requiresIdempotencyKey
    ? requiredString(idempotencyKey, 'Knowledge action idempotency key')
    : null
  const clonedInput = cloneJson(input, 'Knowledge action input')
  validateSchema(clonedInput, descriptor.inputSchema.properties.input, 'Knowledge action arguments.input')
  const normalizedInput = descriptor.id === KNOWLEDGE_TOOL_IDS.SYNTHESIS
    ? normalizeArchiveAnnotationInput(clonedInput)
    : clonedInput
  validateSchema({
    input: normalizedInput,
    ...(descriptor.requiresScope
      ? { scope: normalizedScope, idempotencyKey: normalizedIdempotencyKey }
      : {}),
  }, descriptor.inputSchema)
  const envelope = {
    schemaVersion: KNOWLEDGE_ACTION_SCHEMA_VERSION,
    toolId: descriptor.id,
    requestId: requiredString(requestId, 'Knowledge action request ID'),
    runId: requiredString(runId, 'Knowledge action run ID'),
    sessionId: requiredString(sessionId, 'Knowledge action session ID'),
    context: consumeKnowledgeContextV1(context),
    scope: normalizedScope,
    idempotencyKey: normalizedIdempotencyKey,
    input: normalizedInput,
  }
  if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)) {
    throw new Error('Knowledge action input must be an object.')
  }
  return boundedEnvelope(envelope, MAX_KNOWLEDGE_ACTION_INPUT_BYTES, 'Knowledge action input')
}

export function parseKnowledgeActionCall(descriptorId, call, metadata = {}) {
  let payload
  try {
    payload = JSON.parse(call?.arguments || '{}')
  } catch {
    throw new Error('Knowledge action arguments must be valid JSON.')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Knowledge action arguments must be an object.')
  return createKnowledgeActionInput(descriptorId, {
    ...metadata,
    requestId: call?.id,
    scope: payload.scope,
    idempotencyKey: payload.idempotencyKey,
    input: payload.input || {},
  })
}

export function createKnowledgeActionOutput(descriptorId, {
  requestId,
  runId,
  status = KNOWLEDGE_ACTION_STATUS.COMPLETED,
  summary = '',
  data = null,
  artifacts = [],
  error = null,
  effect,
} = {}) {
  const descriptor = getKnowledgeActionToolDescriptor(descriptorId)
  if (!descriptor) throw new Error(`Unknown Knowledge Action Tool: ${String(descriptorId || 'missing')}.`)
  if (!ACTION_STATUSES.has(status)) throw new Error(`Unsupported Knowledge action status: ${String(status)}.`)
  if (effect && effect !== descriptor.effect) throw new Error(`Knowledge tool ${descriptor.id} cannot emit a ${effect} effect.`)
  const normalizedArtifacts = cloneJson(artifacts, 'Knowledge action artifacts')
  if (!Array.isArray(normalizedArtifacts)) throw new Error('Knowledge action artifacts must be an array.')
  if (descriptor.effect === KNOWLEDGE_TOOL_EFFECT.READ && normalizedArtifacts.length) {
    throw new Error(`Read-only Knowledge tool ${descriptor.id} cannot emit write artifacts.`)
  }
  const envelope = {
    schemaVersion: KNOWLEDGE_ACTION_SCHEMA_VERSION,
    toolId: descriptor.id,
    requestId: requiredString(requestId, 'Knowledge action request ID'),
    runId: requiredString(runId, 'Knowledge action run ID'),
    status,
    effect: descriptor.effect,
    summary: String(summary || '').slice(0, 2_000),
    data: cloneJson(data, 'Knowledge action output data'),
    artifacts: normalizedArtifacts,
    error: error === null ? null : cloneJson(error, 'Knowledge action error'),
  }
  validateSchema(envelope, descriptor.outputSchema, 'Knowledge action output')
  return boundedEnvelope(envelope, MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES, 'Knowledge action output')
}

export function createKnowledgeSessionHandoff({
  sessionId,
  runId = null,
  cursor = 0,
  context,
  sourceSurface,
  createdAt = new Date().toISOString(),
} = {}) {
  const surface = requiredString(sourceSurface, 'Knowledge handoff source surface', 64)
  if (!SURFACES.has(surface)) throw new Error(`Unsupported Knowledge Agent surface: ${surface}.`)
  const normalizedCursor = Number(cursor)
  if (!Number.isInteger(normalizedCursor) || normalizedCursor < 0) throw new Error('Knowledge handoff cursor must be a non-negative integer.')
  return boundedEnvelope({
    schemaVersion: KNOWLEDGE_SESSION_HANDOFF_SCHEMA_VERSION,
    kind: 'knowledge-agent-session-handoff',
    agentId: KNOWLEDGE_AGENT_ID,
    sessionId: requiredString(sessionId, 'Knowledge handoff session ID'),
    runId: nullableString(runId, 'Knowledge handoff run ID'),
    cursor: normalizedCursor,
    context: consumeKnowledgeContextV1(context),
    sourceSurface: surface,
    createdAt: requiredString(createdAt, 'Knowledge handoff creation time', 64),
  }, MAX_KNOWLEDGE_ACTION_INPUT_BYTES, 'Knowledge session handoff')
}

export function consumeKnowledgeSessionHandoff(value, { surface } = {}) {
  const handoff = cloneJson(value, 'Knowledge session handoff')
  if (handoff?.schemaVersion !== KNOWLEDGE_SESSION_HANDOFF_SCHEMA_VERSION || handoff?.kind !== 'knowledge-agent-session-handoff') {
    throw new Error('Unsupported Knowledge session handoff.')
  }
  if (handoff.agentId !== KNOWLEDGE_AGENT_ID) throw new Error('Knowledge session handoff has an incompatible Agent identity.')
  const targetSurface = requiredString(surface, 'Knowledge handoff target surface', 64)
  if (!SURFACES.has(targetSurface)) throw new Error(`Unsupported Knowledge Agent surface: ${targetSurface}.`)
  const sourceSurface = requiredString(handoff.sourceSurface, 'Knowledge handoff source surface', 64)
  if (!SURFACES.has(sourceSurface)) throw new Error(`Unsupported Knowledge Agent surface: ${sourceSurface}.`)
  const cursor = Number(handoff.cursor)
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('Knowledge handoff cursor must be a non-negative integer.')
  return {
    agentId: KNOWLEDGE_AGENT_ID,
    sessionId: requiredString(handoff.sessionId, 'Knowledge handoff session ID'),
    runId: nullableString(handoff.runId, 'Knowledge handoff run ID'),
    cursor,
    context: consumeKnowledgeContextV1(handoff.context),
    surface: targetSurface,
  }
}
