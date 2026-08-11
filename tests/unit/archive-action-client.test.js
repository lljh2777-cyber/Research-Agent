import { describe, expect, it, vi } from 'vitest'
import { createKnowledgeArchiveActionInput, createKnowledgeArchiveResult } from '../../src/research/knowledgeArchive.js'
import { executeKnowledgeArchiveAction } from '../../src/features/knowledge/archiveActionClient.js'

function request() {
  return createKnowledgeArchiveActionInput({
    requestId: 'archive-request-1',
    runId: 'archive-run-1',
    sessionId: 'knowledge-session-1',
    context: { schemaVersion: 1 },
    scope: { vaultId: 'vault-1', target: { kind: 'vault', id: 'vault-1' }, expectedRevision: null },
    idempotencyKey: 'archive-key-1',
    input: {
      operation: 'archive-annotation',
      sourceAnnotation: { id: 'annotation-1', path: 'wiki/annotations/Annotation-1.MD', revision: 'annotation-revision-1' },
      targets: ['synthesis/summary.md'],
    },
  })
}

describe('executeKnowledgeArchiveAction', () => {
  it('uses the Adapter and Core terminal guard for completed evidence', async () => {
    const action = request()
    const output = createKnowledgeArchiveResult(action, {
      status: 'completed',
      targets: [{ path: 'synthesis/summary.md', status: 'created', revision: 'target-revision-1' }],
    })
    const stream = `data: ${JSON.stringify({ cursor: 2, event: { type: 'run.completed', runId: action.runId, output } })}\n\n`
    const actionRuntime = {
      available: true,
      start: vi.fn().mockResolvedValue({ started: true }),
      follow: vi.fn().mockResolvedValue({ ok: true, response: new Response(stream) }),
      cancel: vi.fn(),
    }
    const result = await executeKnowledgeArchiveAction({
      actionRuntime,
      request: action,
      approval: { status: 'approved', scope: action.scope, sourceAnnotation: action.input.sourceAnnotation, targets: action.input.targets },
    })
    expect(result).toEqual(output)
    expect(actionRuntime.start).toHaveBeenCalledWith(expect.objectContaining({
      ...action,
      approval: { status: 'approved', scope: action.scope, sourceAnnotation: action.input.sourceAnnotation, targets: action.input.targets },
    }))
  })

  it('cancels through the Adapter and excludes a late terminal after abort', async () => {
    const action = request()
    const controller = new AbortController()
    const actionRuntime = {
      available: true,
      start: vi.fn().mockResolvedValue({ started: true }),
      follow: vi.fn().mockImplementation(async () => {
        controller.abort()
        return { ok: true, response: new Response('') }
      }),
      cancel: vi.fn().mockResolvedValue({ ok: true }),
    }
    await expect(executeKnowledgeArchiveAction({
      actionRuntime,
      request: action,
      approval: { status: 'approved', scope: action.scope, sourceAnnotation: action.input.sourceAnnotation, targets: action.input.targets },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(actionRuntime.cancel).toHaveBeenCalledWith(action.runId)
  })
})
