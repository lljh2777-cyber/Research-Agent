import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { createRuntimeManifest, RUNTIME_TARGETS } from '../shared/runtime-capabilities.mjs'
import { createKnowledgeArchiveResult } from '../src/research/knowledgeArchive.js'
import { createActionApiMiddleware } from './action-api.mjs'
import { ActionService } from './action-service.mjs'
import { ArchiveRealizationService } from './archive-realization.mjs'

function archiveEnvelope(runId, idempotencyKey = runId) {
  const request = {
    schemaVersion: 1,
    toolId: 'knowledge.synthesis.write',
    requestId: `request-${runId}`,
    runId,
    sessionId: 'archive-session',
    context: { schemaVersion: 1 },
    scope: {
      vaultId: 'vault-http',
      target: { kind: 'folder', id: 'knowledge' },
      expectedRevision: 'root-revision',
    },
    idempotencyKey,
    input: {
      operation: 'archive-annotation',
      sourceAnnotation: {
        id: 'annotation-1',
        path: 'wiki/annotations/annotation-1.md',
        revision: 'annotation-revision-1',
      },
      targets: ['knowledge/archive.md'],
    },
  }
  request.approval = {
    status: 'approved',
    scope: structuredClone(request.scope),
    sourceAnnotation: structuredClone(request.input.sourceAnnotation),
    targets: [...request.input.targets],
  }
  return request
}

function resultFor(request, status) {
  return createKnowledgeArchiveResult(request, {
    status,
    summary: `Archive ${status}.`,
    targets: status === 'completed' ? [{
      path: request.input.targets[0],
      status: 'created',
      revision: 'target-revision-1',
    }] : [],
    ...(status === 'failed' ? { error: { code: 'archive_failed', message: 'Archive failed.' } } : {}),
    ...(status === 'cancelled' ? { error: { code: 'archive_cancelled', message: 'Archive run was cancelled.' } } : {}),
  })
}

async function httpFixture(run) {
  const archiveRealizer = {
    inspect: async (envelope) => ({ request: envelope, existing: null }),
    run,
    capabilityEvidence: () => ({
      executable: true,
      transport: 'research-run',
      journal: 'atomic-json-v1',
      crashRecovery: true,
      authenticity: 'hmac-sha256-v1',
      planner: { executable: true, sandbox: 'read-only', output: 'strict-json' },
    }),
  }
  const service = new ActionService({
    runner: { async run() { throw new Error('Generic runner must not handle formal archive.') } },
    archiveRealizer,
  })
  const middleware = createActionApiMiddleware({ service })
  const server = createServer((request, response) => {
    void middleware(request, response, () => {
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    service,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function startAndReplay(baseUrl, request) {
  const started = await fetch(`${baseUrl}/api/runtime/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(started.status, 202)
  const startPayload = await started.json()
  assert.equal(startPayload.started, true)
  const replay = await fetch(`${baseUrl}/api/runtime/actions/${request.runId}/events?after=0`)
  assert.equal(replay.status, 200)
  const text = await replay.text()
  const events = [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]).event)
  return events
}

test('real HTTP/SSE archive transport preserves completed, failed, and cancelled terminal fields and replay', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const runtime = await httpFixture(async ({ envelope }) => resultFor(envelope, status))
    const request = archiveEnvelope(`archive-http-${status}`)
    try {
      const events = await startAndReplay(runtime.baseUrl, request)
      assert.equal(events[0].type, 'run.started')
      const terminal = events.at(-1)
      assert.equal(terminal.type, `run.${status}`)
      if (status === 'completed') {
        assert.equal(terminal.output.status, status)
        assert.equal(terminal.result, undefined)
      } else {
        assert.equal(terminal.result.status, status)
        assert.equal(terminal.output, undefined)
      }

      const cursorReplay = await fetch(`${runtime.baseUrl}/api/runtime/actions/${request.runId}/events?after=1`)
      const replayText = await cursorReplay.text()
      assert.match(replayText, new RegExp(`event: run\\.${status}`))
    } finally {
      await runtime.close()
    }
  }
})

test('HTTP cancellation waits for archive quiescence and emits one cancelled result', async () => {
  let quiesced = false
  const runtime = await httpFixture(({ envelope, signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      setImmediate(() => {
        quiesced = true
        resolve(resultFor(envelope, 'cancelled'))
      })
    }, { once: true })
  }))
  const request = archiveEnvelope('archive-http-cancel-quiescence')
  try {
    const started = await fetch(`${runtime.baseUrl}/api/runtime/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(started.status, 202)
    const cancelled = await fetch(`${runtime.baseUrl}/api/runtime/actions/${request.runId}`, { method: 'DELETE' })
    const payload = await cancelled.json()
    assert.equal(quiesced, true)
    assert.equal(payload.run.status, 'cancelled')
    const events = runtime.service.eventsAfter(request.runId, 0).events.map((entry) => entry.event)
    assert.equal(events.filter((event) => event.type === 'run.cancelled').length, 1)
    assert.equal(events.at(-1).result.status, 'cancelled')
  } finally {
    await runtime.close()
  }
})

test('malformed and oversized archive outputs fail before a completed terminal can append', async () => {
  const invalidOutputs = [
    () => ({ status: 'completed', data: { targets: [] } }),
    (envelope) => ({ ...resultFor(envelope, 'completed'), artifacts: ['x'.repeat(65_536)] }),
  ]
  for (const [index, output] of invalidOutputs.entries()) {
    const runtime = await httpFixture(async ({ envelope }) => output(envelope))
    const request = archiveEnvelope(`archive-http-invalid-${index}`)
    try {
      const events = await startAndReplay(runtime.baseUrl, request)
      assert.equal(events.at(-1).type, 'run.failed')
      assert.equal(events.some((event) => event.type === 'run.completed'), false)
      assert.equal(events.at(-1).result.status, 'failed')
    } finally {
      await runtime.close()
    }
  }
})

test('a replaced valid-length authenticity key disables only synthesis before local manifest publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bioresearch-action-cap-vault-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'bioresearch-action-cap-state-'))
  const journalDirectory = join(root, '.bioresearch', 'runtime', 'archive-realizations', 'v1')
  const checkpointDirectory = join(stateRoot, 'archive-realizations', 'v1')
  const keyPath = join(stateRoot, 'keys', 'archive-realization-hmac-v1.key')
  try {
    const envelope = archiveEnvelope('archive-capability-audit')
    envelope.scope.vaultId = basename(root)
    envelope.approval.scope = structuredClone(envelope.scope)
    const initial = new ArchiveRealizationService({
      root,
      authenticityStateRoot: stateRoot,
      annotationStore: { async read() { throw new Error('Acceptance must not read the source.') } },
      planner: {
        async plan() { throw new Error('Acceptance must not plan.') },
        capabilityEvidence: () => ({ executable: true, sandbox: 'read-only', output: 'strict-json' }),
      },
    })
    await initial.accept(envelope)
    const healthyMiddleware = createActionApiMiddleware({
      root,
      authenticityStateRoot: stateRoot,
      archivePlanner: {
        async plan() { throw new Error('Startup capability audit must not invoke the planner.') },
        capabilityEvidence: () => ({ executable: true, sandbox: 'read-only', output: 'strict-json' }),
      },
    })
    assert.equal(healthyMiddleware.service.capabilityEvidence().capabilities['actions.synthesis'], true)
    await writeFile(keyPath, Buffer.alloc(32, 9))

    const middleware = createActionApiMiddleware({
      root,
      authenticityStateRoot: stateRoot,
      archivePlanner: {
        async plan() { throw new Error('Startup capability audit must not invoke the planner.') },
        capabilityEvidence: () => ({ executable: true, sandbox: 'read-only', output: 'strict-json' }),
      },
    })
    const evidence = middleware.service.capabilityEvidence()
    const manifest = createRuntimeManifest({ target: RUNTIME_TARGETS.LOCAL_WEB, services: { actions: evidence } })
    assert.equal(manifest.capabilities.actions.capabilities['actions.synthesis'], false)
    assert.equal(manifest.capabilities.actions.capabilities['actions.paperIngest'], true)
    assert.equal(manifest.capabilities.actions.capabilities['actions.xray'], true)
    assert.equal(manifest.capabilities.actions.capabilities['actions.codeAnalysis'], true)
    assert.equal(await readFile(keyPath).then((value) => value.equals(Buffer.alloc(32, 9))), true)
  } finally {
    for (const directory of [journalDirectory, checkpointDirectory]) {
      for (const name of await readdir(directory).catch(() => [])) await unlink(join(directory, name)).catch(() => {})
    }
    await unlink(keyPath).catch(() => {})
    for (const directory of [
      journalDirectory,
      join(root, '.bioresearch', 'runtime', 'archive-realizations'),
      join(root, '.bioresearch', 'runtime'),
      join(root, '.bioresearch'),
      checkpointDirectory,
      join(stateRoot, 'archive-realizations'),
      join(stateRoot, 'keys'),
      root,
      stateRoot,
    ]) await rmdir(directory).catch(() => {})
  }
})
