export const RUNTIME_ACTION_SCHEMA_VERSION = 1
export const MAX_KNOWLEDGE_CONTEXT_BYTES = 65_536
export const MAX_KNOWLEDGE_ACTION_INPUT_BYTES = 131_072
export const MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES = 65_536
export const RUNTIME_ANNOTATION_CONTENT_MAX_BYTES = 65_536
export const RUNTIME_ANNOTATION_REQUEST_MAX_BYTES = 131_072
export const RUNTIME_ARCHIVE_JOURNAL_SCHEMA_VERSION = 1
export const RUNTIME_ARCHIVE_PLAN_MAX_BYTES = 4 * 1024 * 1024
export const RUNTIME_ARCHIVE_TARGET_CONTENT_MAX_BYTES = 1024 * 1024
export const ANNOTATION_PATCH_KIND = 'annotation.upsert'
export const ANNOTATION_CONTENT_TYPE = 'text/markdown'

export const RUNTIME_ACTION_CAPABILITIES = Object.freeze([
  'knowledge.lint',
  'actions.paperIngest',
  'actions.xray',
  'actions.codeAnalysis',
  'actions.synthesis',
])

const TARGET_KINDS = ['vault', 'folder', 'note', 'selection', 'attachment']
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    schemaVersion: { const: 1 },
    toolId: { type: 'string' },
    requestId: { type: 'string' },
    runId: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
    effect: { type: 'string', enum: ['read', 'write'] },
    summary: { type: 'string' },
    data: {},
    artifacts: { type: 'array', items: { type: 'object' } },
    error: { type: ['object', 'null'] },
  },
  required: ['schemaVersion', 'toolId', 'requestId', 'runId', 'status', 'effect', 'summary', 'artifacts', 'error'],
  additionalProperties: false,
})

function actionInputSchema({ write = false, inputProperties = {}, inputRequired = [] } = {}) {
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
  return Object.freeze({ type: 'object', properties, required, additionalProperties: false })
}

function descriptor({
  id,
  name,
  title,
  description,
  effect,
  riskClass,
  approvalPolicy,
  capability,
  requiresScope,
  inputSchema,
  requiresIdempotencyKey,
}) {
  return Object.freeze({
    schemaVersion: RUNTIME_ACTION_SCHEMA_VERSION,
    id,
    name,
    title,
    description,
    effect,
    riskClass,
    approvalPolicy,
    capability,
    inputSchema,
    outputSchema: OUTPUT_SCHEMA,
    requiresScope,
    requiresIdempotencyKey,
  })
}

export const RUNTIME_ACTION_DESCRIPTORS = Object.freeze([
  descriptor({
    id: 'knowledge.lint',
    name: 'knowledge_lint',
    title: 'Lint knowledge',
    description: 'Inspect knowledge quality and return findings. This tool never repairs or writes.',
    effect: 'read',
    riskClass: 'read',
    approvalPolicy: 'none',
    capability: 'knowledge.lint',
    inputSchema: actionInputSchema({
      inputProperties: { rules: { type: 'array', items: { type: 'string', maxLength: 128 }, maxItems: 64 } },
    }),
    requiresScope: false,
    requiresIdempotencyKey: false,
  }),
  descriptor({
    id: 'knowledge.paper.ingest',
    name: 'knowledge_paper_ingest',
    title: 'Ingest paper',
    description: 'Run an approved paper-ingest action and return references to resulting artifacts.',
    effect: 'write',
    riskClass: 'write',
    approvalPolicy: 'explicit',
    capability: 'actions.paperIngest',
    inputSchema: actionInputSchema({
      write: true,
      inputProperties: { attachmentId: { type: 'string', minLength: 1, maxLength: 256 } },
      inputRequired: ['attachmentId'],
    }),
    requiresScope: true,
    requiresIdempotencyKey: true,
  }),
  descriptor({
    id: 'knowledge.xray',
    name: 'knowledge_xray',
    title: 'X-Ray source',
    description: 'Run an approved X-Ray workflow and persist only explicitly scoped artifacts.',
    effect: 'write',
    riskClass: 'write',
    approvalPolicy: 'explicit',
    capability: 'actions.xray',
    inputSchema: actionInputSchema({
      write: true,
      inputProperties: { sourceRef: { type: 'string', minLength: 1, maxLength: 1024 } },
      inputRequired: ['sourceRef'],
    }),
    requiresScope: true,
    requiresIdempotencyKey: true,
  }),
  descriptor({
    id: 'knowledge.code.analyze',
    name: 'knowledge_code_analysis',
    title: 'Analyze code',
    description: 'Run approved static code analysis and persist only explicitly scoped artifacts.',
    effect: 'write',
    riskClass: 'write',
    approvalPolicy: 'explicit',
    capability: 'actions.codeAnalysis',
    inputSchema: actionInputSchema({
      write: true,
      inputProperties: { sourceRef: { type: 'string', minLength: 1, maxLength: 1024 } },
      inputRequired: ['sourceRef'],
    }),
    requiresScope: true,
    requiresIdempotencyKey: true,
  }),
  descriptor({
    id: 'knowledge.synthesis.write',
    name: 'knowledge_synthesis_write',
    title: 'Write synthesis',
    description: 'Create an approved synthesis artifact inside an explicit target scope.',
    effect: 'write',
    riskClass: 'write',
    approvalPolicy: 'explicit',
    capability: 'actions.synthesis',
    inputSchema: actionInputSchema({
      write: true,
      inputProperties: {
        operation: { const: 'archive-annotation' },
        sourceAnnotation: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 256 },
            path: { type: 'string', minLength: 1, maxLength: 512 },
            revision: { type: 'string', minLength: 1, maxLength: 256 },
          },
          required: ['id', 'path', 'revision'],
          additionalProperties: false,
        },
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      },
      inputRequired: ['operation', 'sourceAnnotation', 'targets'],
    }),
    requiresScope: true,
    requiresIdempotencyKey: true,
  }),
])

export function runtimeActionDescriptor(toolId) {
  return RUNTIME_ACTION_DESCRIPTORS.find((entry) => entry.id === toolId) || null
}

export function isAnnotationPatchIntent(value) {
  return Boolean(
    value
    && value.kind === ANNOTATION_PATCH_KIND
    && typeof value.annotationId === 'string'
    && value.annotationId.length > 0
    && value.target
    && typeof value.target.vaultId === 'string'
    && value.target.vaultId.length > 0
    && typeof value.target.path === 'string'
    && Object.prototype.hasOwnProperty.call(value.target, 'expectedRevision')
    && (value.target.expectedRevision === null || typeof value.target.expectedRevision === 'string')
    && value.contentType === ANNOTATION_CONTENT_TYPE
    && typeof value.content === 'string'
    && value.content.length > 0
  )
}
