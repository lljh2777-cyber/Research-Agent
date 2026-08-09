import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { getKnowledgeAgentRunPresentation } from '../../src/features/knowledge/AgentConversationPanel.jsx'
import {
  ANNOTATION_V1_FIXTURE,
  assertKnowledgeEnvelopeFixture,
  createAnnotationFixture,
  createKnowledgeAgentSessionFixture,
  createKnowledgeContextFixture,
  createKnowledgeToolFixtures,
  KNOWLEDGE_AGENT_ID,
  KNOWLEDGE_CONTEXT_V1_FIXTURE,
  KNOWLEDGE_TOOL_DESCRIPTOR_FIXTURES,
  knowledgeEnvelopeSize,
  MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
} from '../../src/features/knowledge/fixtures.js'

describe('Knowledge Agent v1 consumer contract', () => {
  it('copies the authoritative KB Annotation v1 and Knowledge Context v1 groups', () => {
    expect(Object.keys(KNOWLEDGE_CONTEXT_V1_FIXTURE)).toEqual(['schemaVersion', 'surface', 'vault', 'activeNote', 'selection', 'attachments', 'contextRevision'])
    expect(Object.keys(KNOWLEDGE_CONTEXT_V1_FIXTURE.selection.anchor)).toEqual(['schemaVersion', 'quote', 'position', 'heading', 'line'])
    expect(Object.keys(ANNOTATION_V1_FIXTURE)).toEqual(['schemaVersion', 'id', 'source', 'anchor', 'sections', 'archived', 'timestamps', 'relocation'])
    expect(Object.keys(ANNOTATION_V1_FIXTURE.source)).toEqual(['vaultId', 'noteId', 'path', 'revision'])
    expect(Object.keys(ANNOTATION_V1_FIXTURE.relocation)).toEqual(['schemaVersion', 'status', 'strategy', 'start', 'end', 'candidates'])
  })

  it('keeps first-run activeNote and selection nullable without inventing Vault state', () => {
    expect(createKnowledgeContextFixture()).toBeNull()
    const context = createKnowledgeContextFixture({ vaultId: 'vault-1', vaultName: 'Lab Vault', contextRevision: 'empty-1' })
    expect(context).toMatchObject({ activeNote: null, selection: null, attachments: [] })
  })

  it('freezes exactly eight descriptors and per-call explicit approval for writes', () => {
    expect(KNOWLEDGE_TOOL_DESCRIPTOR_FIXTURES.map(({ id }) => id)).toEqual(['query', 'explain', 'lint', 'annotation', 'paper-ingest', 'xray', 'code-analysis', 'synthesis'])
    expect(KNOWLEDGE_TOOL_DESCRIPTOR_FIXTURES.filter(({ effect }) => effect === 'read').map(({ id, approvalPolicy }) => [id, approvalPolicy])).toEqual([['query', 'none'], ['explain', 'none'], ['lint', 'none']])
    expect(KNOWLEDGE_TOOL_DESCRIPTOR_FIXTURES.filter(({ effect }) => effect === 'write').every(({ approvalPolicy }) => approvalPolicy === 'explicit')).toBe(true)
  })

  it('derives availability without probing and exposes unavailable reasons', () => {
    const descriptors = createKnowledgeToolFixtures({ context: KNOWLEDGE_CONTEXT_V1_FIXTURE, availableCapabilities: ['annotations.write'] })
    expect(descriptors.find(({ id }) => id === 'annotation')).toMatchObject({ available: true, approvalPolicy: 'explicit' })
    expect(descriptors.find(({ id }) => id === 'synthesis')).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/Runtime capability/) })
  })

  it('uses distinct Context, Action input/handoff, and Action output byte ceilings', () => {
    expect(MAX_KNOWLEDGE_CONTEXT_BYTES).toBe(65_536)
    expect(MAX_KNOWLEDGE_ACTION_INPUT_BYTES).toBe(131_072)
    expect(MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES).toBe(65_536)

    const context = createKnowledgeContextFixture({ vaultId: 'v', vaultName: 'V', contextRevision: '' })
    context.contextRevision = 'x'.repeat(MAX_KNOWLEDGE_CONTEXT_BYTES - knowledgeEnvelopeSize(context))
    expect(knowledgeEnvelopeSize(context)).toBe(MAX_KNOWLEDGE_CONTEXT_BYTES)
    expect(assertKnowledgeEnvelopeFixture(context)).toBe(context)
    context.contextRevision += 'x'
    expect(() => assertKnowledgeEnvelopeFixture(context)).toThrow(/65536/)

    const actionInput = { agentId: KNOWLEDGE_AGENT_ID, sessionId: 's', runId: 'r', cursor: 0, context: null, input: '' }
    actionInput.input = 'x'.repeat(MAX_KNOWLEDGE_ACTION_INPUT_BYTES - knowledgeEnvelopeSize(actionInput))
    expect(knowledgeEnvelopeSize(actionInput)).toBe(MAX_KNOWLEDGE_ACTION_INPUT_BYTES)
    expect(assertKnowledgeEnvelopeFixture(actionInput, MAX_KNOWLEDGE_ACTION_INPUT_BYTES)).toBe(actionInput)
    expect(() => assertKnowledgeEnvelopeFixture(actionInput, MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES)).toThrow(/65536/)
  })

  it('preserves one agent/session/run/cursor and the opaque Context object for handoff', () => {
    const context = structuredClone(KNOWLEDGE_CONTEXT_V1_FIXTURE)
    context.ownerExtension = { opaque: true }
    const session = createKnowledgeAgentSessionFixture({ sessionId: 'session-7', runId: 'run-3', cursor: 9, context })
    expect(session).toMatchObject({ agentId: KNOWLEDGE_AGENT_ID, sessionId: 'session-7', runId: 'run-3', cursor: 9 })
    expect(session.context).toBe(context)
    expect(session.context.ownerExtension).toEqual({ opaque: true })
  })

  it('uses Research Run v1 terminal labels without presenting failed or cancelled as success', () => {
    expect(getKnowledgeAgentRunPresentation('completed')).toMatchObject({ label: 'Run complete', tone: 'completed' })
    expect(getKnowledgeAgentRunPresentation('failed')).toMatchObject({ label: 'Run failed', tone: 'failed' })
    expect(getKnowledgeAgentRunPresentation('cancelled')).toMatchObject({ label: 'Run cancelled', tone: 'cancelled' })
    expect(getKnowledgeAgentRunPresentation('waiting-approval')).toMatchObject({ label: 'Waiting for approval', tone: 'approval' })
    expect(getKnowledgeAgentRunPresentation('failed').tone).not.toBe('completed')
    expect(getKnowledgeAgentRunPresentation('cancelled').tone).not.toBe('completed')
    expect(getKnowledgeAgentRunPresentation('unknown')).toBeNull()
  })

  it('retains exact annotation anchor groups and stable relocation details', () => {
    const annotation = createAnnotationFixture({ id: 'annotation-stable', context: KNOWLEDGE_CONTEXT_V1_FIXTURE, manual: 'Manual', ai: 'AI', createdAt: '2026-08-09T12:00:00.000Z', updatedAt: '2026-08-09T12:05:00.000Z' })
    expect(annotation.anchor).toBe(KNOWLEDGE_CONTEXT_V1_FIXTURE.selection.anchor)
    expect(annotation.sections).toEqual({ manual: 'Manual', ai: 'AI' })
    expect(annotation.relocation).toEqual({ schemaVersion: 1, status: 'anchored', strategy: 'position', start: 15, end: 32, candidates: 1 })
  })

  it('keeps the new React components free of transport and persistence APIs', async () => {
    const sources = await Promise.all([
      readFile(new URL('../../src/features/knowledge/AgentConversationPanel.jsx', import.meta.url), 'utf8'),
      readFile(new URL('../../src/features/knowledge/KnowledgeRoundTwo.jsx', import.meta.url), 'utf8'),
    ])
    for (const source of sources) expect(source).not.toMatch(/\bfetch\s*\(|FileSystem|showDirectoryPicker|\bprocess\.|electron|obsidian/i)
  })
})
