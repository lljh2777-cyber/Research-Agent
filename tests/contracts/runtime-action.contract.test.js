import { describe, expect, it } from 'vitest'

import {
  isAnnotationPatchIntent,
  MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
  RUNTIME_ACTION_DESCRIPTORS,
  RUNTIME_ACTION_SCHEMA_VERSION,
  RUNTIME_ANNOTATION_CONTENT_MAX_BYTES,
  RUNTIME_ANNOTATION_REQUEST_MAX_BYTES,
} from '../../shared/runtime-action-contracts.mjs'
import { getKnowledgeActionToolDescriptor } from '../../src/research/knowledgeAgent.js'

const REQUIRED_DESCRIPTOR_FIELDS = [
  'schemaVersion',
  'id',
  'name',
  'title',
  'description',
  'effect',
  'riskClass',
  'approvalPolicy',
  'capability',
  'inputSchema',
  'outputSchema',
  'requiresScope',
  'requiresIdempotencyKey',
]

describe('Runtime Action/Annotation v1 contract', () => {
  it('exposes exact Core-owned descriptor fields and superseding byte bounds', () => {
    expect(RUNTIME_ACTION_SCHEMA_VERSION).toBe(1)
    expect(MAX_KNOWLEDGE_CONTEXT_BYTES).toBe(65_536)
    expect(MAX_KNOWLEDGE_ACTION_INPUT_BYTES).toBe(131_072)
    expect(MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES).toBe(65_536)
    expect(RUNTIME_ANNOTATION_CONTENT_MAX_BYTES).toBe(65_536)
    expect(RUNTIME_ANNOTATION_REQUEST_MAX_BYTES).toBe(131_072)
    expect(RUNTIME_ACTION_DESCRIPTORS.map((entry) => entry.id)).toEqual([
      'knowledge.lint',
      'knowledge.paper.ingest',
      'knowledge.xray',
      'knowledge.code.analyze',
      'knowledge.synthesis.write',
    ])
    for (const descriptor of RUNTIME_ACTION_DESCRIPTORS) {
      expect(Object.keys(descriptor)).toEqual(REQUIRED_DESCRIPTOR_FIELDS)
      expect(descriptor.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      expect(descriptor.outputSchema).toMatchObject({
        type: 'object',
        required: ['schemaVersion', 'toolId', 'requestId', 'runId', 'status', 'effect', 'summary', 'artifacts', 'error'],
        additionalProperties: false,
      })
    }
    expect(RUNTIME_ACTION_DESCRIPTORS.map(({ id, capability }) => [id, capability])).toEqual([
      ['knowledge.lint', 'knowledge.lint'],
      ['knowledge.paper.ingest', 'actions.paperIngest'],
      ['knowledge.xray', 'actions.xray'],
      ['knowledge.code.analyze', 'actions.codeAnalysis'],
      ['knowledge.synthesis.write', 'actions.synthesis'],
    ])
    expect(RUNTIME_ACTION_DESCRIPTORS.map(({ id, name, title, description }) => ({ id, name, title, description }))).toEqual([
      { id: 'knowledge.lint', name: 'knowledge_lint', title: 'Lint knowledge', description: 'Inspect knowledge quality and return findings. This tool never repairs or writes.' },
      { id: 'knowledge.paper.ingest', name: 'knowledge_paper_ingest', title: 'Ingest paper', description: 'Run an approved paper-ingest action and return references to resulting artifacts.' },
      { id: 'knowledge.xray', name: 'knowledge_xray', title: 'X-Ray source', description: 'Run an approved X-Ray workflow and persist only explicitly scoped artifacts.' },
      { id: 'knowledge.code.analyze', name: 'knowledge_code_analysis', title: 'Analyze code', description: 'Run approved static code analysis and persist only explicitly scoped artifacts.' },
      { id: 'knowledge.synthesis.write', name: 'knowledge_synthesis_write', title: 'Write synthesis', description: 'Create an approved synthesis artifact inside an explicit target scope.' },
    ])
    expect(Object.keys(RUNTIME_ACTION_DESCRIPTORS[0].inputSchema.properties.input.properties)).toEqual(['rules'])
    expect(RUNTIME_ACTION_DESCRIPTORS.at(-1)).toEqual(getKnowledgeActionToolDescriptor('knowledge.synthesis.write'))
    expect(Object.keys(RUNTIME_ACTION_DESCRIPTORS.at(-1).inputSchema.properties.input.properties)).toEqual([
      'operation', 'sourceAnnotation', 'targets',
    ])
    expect(RUNTIME_ACTION_DESCRIPTORS.slice(1).map((entry) => entry.inputSchema.required)).toEqual([
      ['input', 'scope', 'idempotencyKey'],
      ['input', 'scope', 'idempotencyKey'],
      ['input', 'scope', 'idempotencyKey'],
      ['input', 'scope', 'idempotencyKey'],
    ])
  })

  it('preserves Core approval and idempotency semantics for write Actions', () => {
    const [lint, ...writes] = RUNTIME_ACTION_DESCRIPTORS
    expect(lint).toMatchObject({
      effect: 'read',
      riskClass: 'read',
      approvalPolicy: 'none',
      requiresScope: false,
      requiresIdempotencyKey: false,
    })
    for (const descriptor of writes) {
      expect(descriptor).toMatchObject({
        effect: 'write',
        riskClass: 'write',
        approvalPolicy: 'explicit',
        requiresScope: true,
        requiresIdempotencyKey: true,
      })
    }

  })
  it('accepts only the KB-owned Annotation Patch Intent v1 transport shape without rewriting content', () => {
    const content = [
      '# Annotation v1',
      'opaque source, TextAnchor, manual/AI, archive, and relocation envelope',
    ].join('\n')
    const intent = {
      kind: 'annotation.upsert',
      annotationId: 'annotation-1',
      target: {
        vaultId: 'vault-1',
        path: 'wiki/annotations/annotation-1.md',
        expectedRevision: 'revision-1',
      },
      contentType: 'text/markdown',
      content,
    }

    expect(isAnnotationPatchIntent(intent)).toBe(true)
    expect(intent.content).toBe(content)
    expect(isAnnotationPatchIntent({ ...intent, kind: 'annotation.patch' })).toBe(false)
    expect(isAnnotationPatchIntent({ ...intent, contentType: 'application/json' })).toBe(false)
    expect(isAnnotationPatchIntent({
      ...intent,
      target: { ...intent.target, expectedRevision: undefined },
    })).toBe(false)
  })
})
