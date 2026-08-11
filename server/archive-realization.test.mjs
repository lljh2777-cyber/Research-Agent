import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { AnnotationStore, annotationStoreInternals } from './annotation-store.mjs'
import { ArchiveAuthenticityStore } from './archive-authenticity.mjs'
import { ArchiveRealizationService, archiveRealizationInternals } from './archive-realization.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bioresearch-archive-'))
  const authenticityStateRoot = await mkdtemp(join(tmpdir(), 'bioresearch-archive-auth-'))
  const sourcePath = 'wiki/annotations/source.MD'
  const sourceAbsolute = join(root, 'wiki', 'annotations', 'source.MD')
  const sourceContent = '# Reviewed Annotation\n\nOpaque Annotation v2 Markdown.\n'
  await mkdir(join(root, 'wiki', 'annotations'), { recursive: true })
  await mkdir(join(root, 'knowledge'), { recursive: true })
  await writeFile(sourceAbsolute, sourceContent, 'utf8')
  const sourceRevision = annotationStoreInternals.revisionFor(sourceContent)
  const envelope = {
    schemaVersion: 1,
    toolId: 'knowledge.synthesis.write',
    requestId: 'archive-request-1',
    runId: 'archive-run-1',
    sessionId: 'archive-session-1',
    context: { schemaVersion: 1 },
    scope: {
      vaultId: basename(root),
      target: { kind: 'folder', id: 'knowledge' },
      expectedRevision: 'root-revision-1',
    },
    idempotencyKey: 'archive-source-revision-1',
    input: {
      operation: 'archive-annotation',
      sourceAnnotation: { id: 'source', path: sourcePath, revision: sourceRevision },
      targets: ['knowledge/first.md', 'knowledge/second.md'],
    },
  }
  envelope.approval = {
    status: 'approved',
    scope: structuredClone(envelope.scope),
    sourceAnnotation: structuredClone(envelope.input.sourceAnnotation),
    targets: [...envelope.input.targets],
  }
  return { root, sourceAbsolute, envelope, authenticityStateRoot, authenticityKey: Buffer.alloc(32, 7) }
}

async function cleanup({ root, sourceAbsolute, authenticityStateRoot }) {
  const journalDirectory = join(root, ...archiveRealizationInternals.journalDirectory.split('/'))
  for (const name of await readdir(journalDirectory).catch(() => [])) await unlink(join(journalDirectory, name)).catch(() => {})
  for (const name of await readdir(join(root, 'knowledge')).catch(() => [])) {
    if (name.endsWith('.bioresearch.tmp')) await unlink(join(root, 'knowledge', name)).catch(() => {})
  }
  for (const path of [
    join(root, 'knowledge', 'first.md'),
    join(root, 'knowledge', 'second.md'),
    sourceAbsolute,
  ]) await unlink(path).catch(() => {})
  for (const path of [
    journalDirectory,
    join(root, '.bioresearch', 'runtime', 'archive-realizations'),
    join(root, '.bioresearch', 'runtime'),
    join(root, '.bioresearch'),
    join(root, 'wiki', 'annotations'),
    join(root, 'wiki'),
    join(root, 'knowledge'),
    root,
  ]) await rmdir(path).catch(() => {})
  const checkpointDirectory = join(authenticityStateRoot, 'archive-realizations', 'v1')
  for (const name of await readdir(checkpointDirectory).catch(() => [])) await unlink(join(checkpointDirectory, name)).catch(() => {})
  await rmdir(checkpointDirectory).catch(() => {})
  await rmdir(join(authenticityStateRoot, 'archive-realizations')).catch(() => {})
  await rmdir(authenticityStateRoot).catch(() => {})
}

function authenticity(value) {
  return {
    authenticityStateRoot: value.authenticityStateRoot,
    authenticityKey: value.authenticityKey,
  }
}

function authenticityStore(value) {
  return new ArchiveAuthenticityStore({
    root: value.root,
    stateRoot: value.authenticityStateRoot,
    key: value.authenticityKey,
  })
}

function checkpointPathFor(value, key) {
  return join(value.authenticityStateRoot, 'archive-realizations', 'v1', `${key}.json`)
}

function journalPathFor(root, key) {
  return join(root, ...archiveRealizationInternals.journalDirectory.split('/'), `${key}.json`)
}

async function readJournal(root, key) {
  return JSON.parse(await readFile(journalPathFor(root, key), 'utf8'))
}

async function writeJournal(root, key, journal) {
  await writeFile(journalPathFor(root, key), `${JSON.stringify(journal)}\n`, 'utf8')
}

async function writeAuthenticatedState(value, key, record, store = authenticityStore(value)) {
  record.keyId = store.keyId
  record.mac = store.mac(record)
  await writeJournal(value.root, key, record)
  await store.persist(key, record)
}

function restoreRecoverablePlan(record, envelope, contents = ['# First\n', '# Second\n']) {
  const restored = structuredClone(record)
  restored.request = structuredClone(envelope)
  delete restored.request.approval
  restored.approval = structuredClone(envelope.approval)
  delete restored.binding
  restored.targets = restored.targets.map((target, index) => ({
    ...target,
    content: contents[index],
    intendedRevision: archiveRealizationInternals.revisionFor(contents[index]),
    intendedBytes: Buffer.byteLength(contents[index], 'utf8'),
  }))
  return restored
}

function planner(contents = ['# First\n', '# Second\n']) {
  return {
    calls: 0,
    async plan({ request, sourceRecord }) {
      this.calls += 1
      assert.match(sourceRecord.content, /Opaque Annotation v2/)
      return {
        targets: request.input.targets.map((path, index) => ({ path, content: contents[index] })),
      }
    },
  }
}

test('formal archive plans read-only and commits exact targets with durable ordered evidence', async () => {
  const value = await fixture()
  const first = join(value.root, 'knowledge', 'first.md')
  await writeFile(first, '# Previous\n', 'utf8')
  const plan = planner()
  const service = new ArchiveRealizationService({
    root: value.root,
    ...authenticity(value),
    annotationStore: new AnnotationStore({ root: value.root }),
    planner: plan,
  })
  try {
    const result = await service.run({ envelope: value.envelope })
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.deepEqual(result.data.sourceAnnotation, value.envelope.input.sourceAnnotation)
    assert.deepEqual(result.data.targets.map(({ path, status }) => [path, status]), [
      ['knowledge/first.md', 'updated'],
      ['knowledge/second.md', 'created'],
    ])
    assert.equal(await readFile(first, 'utf8'), '# First\n')
    assert.equal(await readFile(join(value.root, 'knowledge', 'second.md'), 'utf8'), '# Second\n')
    assert.equal(plan.calls, 1)

    const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: plan,
    })
    const replay = await restarted.run({ envelope: { ...value.envelope, runId: 'ignored-retry-run' } })
    assert.deepEqual(replay, result)
    assert.equal(plan.calls, 1)
  } finally {
    await cleanup(value)
  }
})

test('terminal journal and external checkpoint compact context, approval, source, and planned Markdown before replay', async () => {
  const value = await fixture()
  const sensitivePlan = ['# PRIVATE-PLAN-FIRST\n', '# PRIVATE-PLAN-SECOND\n']
  const service = new ArchiveRealizationService({
    root: value.root,
    ...authenticity(value),
    annotationStore: new AnnotationStore({ root: value.root }),
    planner: planner(sensitivePlan),
  })
  try {
    const result = await service.run({ envelope: value.envelope })
    const inspection = await service.inspect(value.envelope)
    const journalText = await readFile(journalPathFor(value.root, inspection.key), 'utf8')
    const checkpointText = await readFile(checkpointPathFor(value, inspection.key), 'utf8')
    for (const text of [journalText, checkpointText]) {
      const record = JSON.parse(text)
      assert.equal(record.state, 'completed')
      assert.equal(record.request, undefined)
      assert.equal(record.approval, undefined)
      assert.equal(record.binding.context, undefined)
      assert.equal(record.targets.every((target) => !Object.hasOwn(target, 'content')), true)
      assert.equal(record.targets.every((target) => Number.isSafeInteger(target.intendedBytes)), true)
      assert.doesNotMatch(text, /PRIVATE-PLAN|Opaque Annotation v2|sourceRecord|credential/i)
    }
    const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: { async plan() { throw new Error('Compact terminal replay must not re-plan.') } },
    })
    assert.deepEqual(await restarted.run({ envelope: value.envelope }), result)
  } finally {
    await cleanup(value)
  }
})

test('formal archive rejects approval drift, stale source, scope escape, and target conflicts without overwrite', async () => {
  const value = await fixture()
  const target = join(value.root, 'knowledge', 'first.md')
  await writeFile(target, '# Snapshot\n', 'utf8')
  const conflictPlanner = {
    async plan({ request }) {
      await writeFile(target, '# Concurrent writer\n', 'utf8')
      return { targets: request.input.targets.map((path) => ({ path, content: `# Planned ${path}\n` })) }
    },
  }
  const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
    planner: conflictPlanner,
  })
  try {
    await assert.rejects(service.inspect({
      ...value.envelope,
      approval: { ...value.envelope.approval, targets: ['knowledge/other.md'] },
    }), (error) => error.code === 'approval_mismatch')
    await assert.rejects(service.inspect({
      ...value.envelope,
      scope: { ...value.envelope.scope, target: { kind: 'folder', id: 'other' } },
      approval: {
        ...value.envelope.approval,
        scope: { ...value.envelope.scope, target: { kind: 'folder', id: 'other' } },
      },
    }), (error) => error.code === 'scope_denied')

    const stale = structuredClone(value.envelope)
    stale.idempotencyKey = 'archive-source-stale-revision'
    stale.input.sourceAnnotation.revision = 'stale-revision'
    stale.approval.sourceAnnotation.revision = 'stale-revision'
    const staleResult = await service.run({ envelope: stale })
    assert.equal(staleResult.status, 'failed')
    assert.deepEqual(staleResult.data.targets, [])

    const conflict = await service.run({ envelope: value.envelope })
    assert.equal(conflict.status, 'failed')
    assert.deepEqual(conflict.data.targets, [])
    assert.match(conflict.error.message, /changed before commit/)
    assert.equal(await readFile(target, 'utf8'), '# Concurrent writer\n')
    assert.equal((await new AnnotationStore({ root: value.root }).read(value.envelope.input.sourceAnnotation.path)).revision,
      value.envelope.input.sourceAnnotation.revision)
  } finally {
    await cleanup(value)
  }
})

test('a mutation immediately before final rename is detected and never overwritten', async () => {
  const value = await fixture()
  const target = join(value.root, 'knowledge', 'first.md')
  await writeFile(target, '# Snapshot\n', 'utf8')
  let mutated = false
  const service = new ArchiveRealizationService({
    root: value.root,
    ...authenticity(value),
    annotationStore: new AnnotationStore({ root: value.root }),
    planner: planner(),
    hooks: {
      async beforeTargetRename({ path }) {
        if (!mutated && path === 'knowledge/first.md') {
          mutated = true
          await writeFile(target, '# Last-moment writer\n', 'utf8')
        }
      },
    },
  })
  try {
    const result = await service.run({ envelope: value.envelope })
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.data.targets, [])
    assert.match(result.error.message, /immediately before rename/)
    assert.equal(await readFile(target, 'utf8'), '# Last-moment writer\n')
  } finally {
    await cleanup(value)
  }
})

test('cancellation quiesces after a committed target and restart replay preserves the truthful subset', async () => {
  const value = await fixture()
  const controller = new AbortController()
  const plan = planner()
  const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
    planner: plan,
  })
  try {
    const result = await service.run({
      envelope: value.envelope,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.type === 'archive.target.committed') controller.abort()
      },
    })
    assert.equal(result.status, 'cancelled')
    assert.deepEqual(result.data.targets.map(({ path }) => path), ['knowledge/first.md'])
    assert.equal(await readFile(join(value.root, 'knowledge', 'first.md'), 'utf8'), '# First\n')
    await assert.rejects(readFile(join(value.root, 'knowledge', 'second.md'), 'utf8'), (error) => error.code === 'ENOENT')
    assert.equal((await new AnnotationStore({ root: value.root }).read(value.envelope.input.sourceAnnotation.path)).revision,
      value.envelope.input.sourceAnnotation.revision)

    const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: plan,
    })
    const replay = await restarted.run({ envelope: value.envelope })
    assert.deepEqual(replay, result)
    assert.equal(plan.calls, 1)
  } finally {
    await cleanup(value)
  }
})

test('restart reconciles a committed target from intended revision and resumes an interrupted journal', async () => {
  const value = await fixture()
  const plan = planner()
  const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
    planner: plan,
  })
  try {
    const completed = await service.run({ envelope: value.envelope })
    const inspection = await service.inspect(value.envelope)
    const journal = restoreRecoverablePlan(await readJournal(value.root, inspection.key), value.envelope)
    journal.state = 'committing'
    journal.result = null
    journal.targets[0].committedStatus = null
    journal.targets[0].committedRevision = null
    journal.targets[1].committedStatus = null
    journal.targets[1].committedRevision = null
    await unlink(join(value.root, 'knowledge', 'second.md'))
    await writeAuthenticatedState(value, inspection.key, journal)

    const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: { async plan() { throw new Error('Recovery must not re-plan.') } },
    })
    const recovered = await restarted.run({ envelope: value.envelope })
    assert.equal(recovered.status, 'completed')
    assert.deepEqual(recovered.data.targets, completed.data.targets)
    assert.equal(await readFile(join(value.root, 'knowledge', 'second.md'), 'utf8'), '# Second\n')
  } finally {
    await cleanup(value)
  }
})

test('reserved Runtime metadata namespace and canonical approval binding fail closed', async () => {
  const value = await fixture()
  const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
    planner: planner(),
  })
  try {
    const reordered = structuredClone(value.envelope)
    reordered.approval = {
      targets: [...reordered.input.targets],
      sourceAnnotation: structuredClone(reordered.input.sourceAnnotation),
      scope: structuredClone(reordered.scope),
      status: 'approved',
    }
    await service.inspect(reordered)

    for (const target of ['.bioresearch/runtime/other.md', '.BIORESEARCH/RUNTIME/other.md']) {
      const blocked = structuredClone(value.envelope)
      blocked.idempotencyKey = `reserved-${target}`
      blocked.scope.target = { kind: 'note', id: target }
      blocked.input.targets = [target]
      blocked.approval = {
        status: 'approved',
        scope: structuredClone(blocked.scope),
        sourceAnnotation: structuredClone(blocked.input.sourceAnnotation),
        targets: [target],
      }
      await assert.rejects(service.inspect(blocked), (error) => error.code === 'scope_denied')
    }
  } finally {
    await cleanup(value)
  }
})

test('accepted source and planner failures are durable and restart replays without planning or writes', async () => {
  for (const scenario of ['source-stale', 'planner-failed']) {
    const value = await fixture()
    let planCalls = 0
    const failingPlanner = {
      async plan() {
        planCalls += 1
        throw new Error('Planner failed before producing a plan.')
      },
    }
    const envelope = structuredClone(value.envelope)
    envelope.idempotencyKey = `durable-${scenario}`
    if (scenario === 'source-stale') {
      envelope.input.sourceAnnotation.revision = 'stale-source-revision'
      envelope.approval.sourceAnnotation.revision = 'stale-source-revision'
    }
    const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: failingPlanner,
    })
    try {
      const result = await service.run({ envelope })
      assert.equal(result.status, 'failed')
      assert.deepEqual(result.data.targets, [])
      assert.equal(planCalls, scenario === 'source-stale' ? 0 : 1)

      const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
        planner: { async plan() { throw new Error('Durable terminal replay must not plan.') } },
      })
      assert.deepEqual(await restarted.run({ envelope }), result)
      await assert.rejects(readFile(join(value.root, 'knowledge', 'first.md'), 'utf8'), (error) => error.code === 'ENOENT')
      await assert.rejects(readFile(join(value.root, 'knowledge', 'second.md'), 'utf8'), (error) => error.code === 'ENOENT')
    } finally {
      await cleanup(value)
    }
  }
})

test('journal request, source, targets, approval, digests, plan, evidence, and terminal result tampering fail closed', async () => {
  const value = await fixture()
  const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
    planner: planner(),
  })
  try {
    await service.run({ envelope: value.envelope })
    const inspection = await service.inspect(value.envelope)
    const original = await readJournal(value.root, inspection.key)
    const mutations = [
      ['request source', (record) => { record.binding.input.sourceAnnotation.path = 'wiki/annotations/other.md' }],
      ['request targets', (record) => { record.binding.input.targets.reverse() }],
      ['authorization root', (record) => { record.binding.scope.target.id = 'other' }],
      ['request digest', (record) => { record.requestDigest = '0'.repeat(64) }],
      ['approval digest', (record) => { record.approvalDigest = '1'.repeat(64) }],
      ['snapshot', (record) => { record.targets[0].snapshotExisted = !record.targets[0].snapshotExisted }],
      ['intended revision and public byte metadata', (record) => {
        record.targets[0].intendedBytes += 1
        record.targets[0].intendedRevision = archiveRealizationInternals.revisionFor('# Fabricated\n')
        record.targets[0].committedRevision = record.targets[0].intendedRevision
        record.result.data.targets[0].revision = record.targets[0].intendedRevision
      }],
      ['intended revision', (record) => { record.targets[0].intendedRevision = 'fabricated-revision' }],
      ['commit evidence', (record) => { record.targets[0].committedStatus = 'unchanged' }],
      ['terminal result', (record) => { record.result.data.targets = [] }],
    ]
    for (const [label, mutate] of mutations) {
      const changed = structuredClone(original)
      mutate(changed)
      await writeJournal(value.root, inspection.key, changed)
      assert.throws(() => new ArchiveRealizationService({
        root: value.root,
        ...authenticity(value),
        annotationStore: new AnnotationStore({ root: value.root }),
        planner: { async plan() { throw new Error('Corrupt journal must not plan.') } },
      }), undefined, label)
    }

    const rawIntegrityTamper = structuredClone(original)
    rawIntegrityTamper.result.summary = 'Fabricated replay result.'
    await writeJournal(value.root, inspection.key, rawIntegrityTamper)
    await assert.rejects(service.inspect(value.envelope), (error) => error.code === 'journal_corrupt')

    await writeJournal(value.root, inspection.key, original)
    await unlink(journalPathFor(value.root, inspection.key))
    await service.inspect(value.envelope)
    assert.deepEqual(await readJournal(value.root, inspection.key), original)

    const checkpointPath = checkpointPathFor(value, inspection.key)
    const originalCheckpoint = await readFile(checkpointPath, 'utf8')
    await unlink(checkpointPath)
    await assert.rejects(service.inspect(value.envelope), (error) => error.code === 'journal_corrupt')
    await writeFile(checkpointPath, originalCheckpoint, 'utf8')

    assert.throws(() => new ArchiveRealizationService({
      root: value.root,
      authenticityStateRoot: value.authenticityStateRoot,
      authenticityKey: Buffer.alloc(32, 9),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: planner(),
    }), /does not match the Runtime-private key/)
    assert.throws(() => new ArchiveRealizationService({
      root: value.root,
      authenticityStateRoot: value.authenticityStateRoot,
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: planner(),
    }), /authenticity key is missing/)

    const corruptCheckpoint = JSON.parse(originalCheckpoint)
    corruptCheckpoint.result.summary = 'Checkpoint tamper with unchanged MAC.'
    await writeFile(checkpointPath, `${JSON.stringify(corruptCheckpoint)}\n`, 'utf8')
    await assert.rejects(service.inspect(value.envelope), (error) => error.code === 'journal_corrupt')
  } finally {
    await cleanup(value)
  }
})

test('HMAC checkpoint detects rollback and rejects every impossible journal state', async () => {
  const value = await fixture()
  const service = new ArchiveRealizationService({
    root: value.root,
    ...authenticity(value),
    annotationStore: new AnnotationStore({ root: value.root }),
    planner: planner(),
  })
  try {
    await service.accept(value.envelope)
    const inspection = await service.inspect(value.envelope)
    const accepted = await readJournal(value.root, inspection.key)
    await service.run({ envelope: value.envelope })
    const completed = await readJournal(value.root, inspection.key)

    await writeJournal(value.root, inspection.key, accepted)
    await assert.rejects(service.inspect(value.envelope), (error) => error.code === 'journal_corrupt')
    await writeJournal(value.root, inspection.key, completed)

    const impossible = [
      ['accepted with plan', (record) => {
        record.state = 'accepted'; record.result = null
        for (const target of record.targets) { target.committedStatus = null; target.committedRevision = null }
      }],
      ['planning with plan', (record) => {
        record.state = 'planning'; record.result = null
        for (const target of record.targets) { target.committedStatus = null; target.committedRevision = null }
      }],
      ['planned with evidence', (record) => { record.state = 'planned'; record.result = null }],
      ['committing with terminal', (record) => { record.state = 'committing' }],
      ['terminal status mismatch', (record) => { record.state = 'failed' }],
      ['non-prefix evidence', (record) => {
        record.state = 'committing'; record.result = null
        record.targets[0].committedStatus = null
        record.targets[0].committedRevision = null
      }],
    ]
    const signingStore = authenticityStore(value)
    for (const [label, mutate] of impossible) {
      const record = restoreRecoverablePlan(completed, value.envelope)
      mutate(record)
      await writeAuthenticatedState(value, inspection.key, record, signingStore)
      await assert.rejects(service.inspect(value.envelope), undefined, label)
    }
  } finally {
    await cleanup(value)
  }
})

test('accepted initialization recovers either durable-copy crash boundary and concurrent starters bind one request', async () => {
  const value = await fixture()
  let plannerCalls = 0
  const service = new ArchiveRealizationService({
    root: value.root,
    ...authenticity(value),
    annotationStore: new AnnotationStore({ root: value.root }),
    planner: { async plan() { plannerCalls += 1; throw new Error('accept() must not start planning.') } },
  })
  try {
    const [first, second] = await Promise.all([
      service.accept(value.envelope),
      service.accept(structuredClone(value.envelope)),
    ])
    assert.equal(first.existing.mac, second.existing.mac)
    assert.equal(first.existing.state, 'accepted')
    assert.equal(plannerCalls, 0)
    const key = first.key

    await unlink(checkpointPathFor(value, key))
    const afterJournalOnly = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: planner(),
    })
    assert.equal((await afterJournalOnly.accept(value.envelope)).existing.state, 'accepted')

    await unlink(journalPathFor(value.root, key))
    const journalDirectory = join(value.root, ...archiveRealizationInternals.journalDirectory.split('/'))
    await writeFile(join(journalDirectory, `.${key}.before-rename.tmp`), 'orphan', 'utf8')
    const afterCheckpointOnly = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: planner(),
    })
    assert.equal((await afterCheckpointOnly.accept(value.envelope)).existing.state, 'accepted')

    const different = structuredClone(value.envelope)
    different.input.targets = ['knowledge/different.md']
    different.approval.targets = ['knowledge/different.md']
    await assert.rejects(afterCheckpointOnly.accept(different), (error) => error.code === 'idempotency_conflict')
    assert.equal(plannerCalls, 0)
  } finally {
    await cleanup(value)
  }
})

test('the entire generated plan is validated before the first write and invalid plans replay durably', async () => {
  const cases = [
    ['extra plan key', { targets: [], extra: true }],
    ['missing target', { targets: [{ path: 'knowledge/first.md', content: '# First\n' }] }],
    ['duplicate target', { targets: [
      { path: 'knowledge/first.md', content: '# First\n' },
      { path: 'knowledge/first.md', content: '# Duplicate\n' },
    ] }],
    ['wrong target order', { targets: [
      { path: 'knowledge/second.md', content: '# Second\n' },
      { path: 'knowledge/first.md', content: '# First\n' },
    ] }],
    ['non-string content', { targets: [
      { path: 'knowledge/first.md', content: 42 },
      { path: 'knowledge/second.md', content: '# Second\n' },
    ] }],
    ['extra target key', { targets: [
      { path: 'knowledge/first.md', content: '# First\n', revision: 'caller-controlled' },
      { path: 'knowledge/second.md', content: '# Second\n' },
    ] }],
    ['per-target limit', { targets: [
      { path: 'knowledge/first.md', content: 'x'.repeat(1_048_577) },
      { path: 'knowledge/second.md', content: '# Second\n' },
    ] }],
    ['total plan limit', { targets: [
      { path: 'knowledge/first.md', content: 'x'.repeat(1_048_576) },
      { path: 'knowledge/second.md', content: 'y'.repeat(3_145_729) },
    ] }],
  ]
  for (const [label, invalidPlan] of cases) {
    const value = await fixture()
    let calls = 0
    const envelope = structuredClone(value.envelope)
    envelope.idempotencyKey = `invalid-plan-${label}`
    const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: { async plan() { calls += 1; return invalidPlan } },
    })
    try {
      const result = await service.run({ envelope })
      assert.equal(result.status, 'failed', label)
      assert.deepEqual(result.data.targets, [], label)
      assert.equal(calls, 1, label)
      await assert.rejects(readFile(join(value.root, 'knowledge', 'first.md'), 'utf8'), (error) => error.code === 'ENOENT')
      await assert.rejects(readFile(join(value.root, 'knowledge', 'second.md'), 'utf8'), (error) => error.code === 'ENOENT')

      const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
        planner: { async plan() { throw new Error('Invalid terminal plan must replay without planning.') } },
      })
      assert.deepEqual(await restarted.run({ envelope }), result, label)
    } finally {
      await cleanup(value)
    }
  }
})

test('source, target parent, and Runtime journal symlinks fail closed before archive writes', async (t) => {
  const probeRoot = await mkdtemp(join(tmpdir(), 'bioresearch-symlink-probe-'))
  const probeTarget = await mkdtemp(join(tmpdir(), 'bioresearch-symlink-target-'))
  const probeLink = join(probeRoot, 'link')
  try {
    await symlink(probeTarget, probeLink, 'junction')
  } catch (error) {
    await rmdir(probeRoot).catch(() => {})
    await rmdir(probeTarget).catch(() => {})
    if (error?.code === 'EPERM') return t.skip('Creating symlinks requires an unavailable Windows privilege.')
    throw error
  }
  await unlink(probeLink)
  await rmdir(probeRoot)
  await rmdir(probeTarget)

  for (const scenario of ['source', 'target-parent', 'journal']) {
    const value = await fixture()
    const outside = await mkdtemp(join(tmpdir(), `bioresearch-${scenario}-outside-`))
    const envelope = structuredClone(value.envelope)
      envelope.idempotencyKey = `symlink-${scenario}`
    try {
      if (scenario === 'source') {
        await unlink(value.sourceAbsolute)
        await rmdir(join(value.root, 'wiki', 'annotations'))
        const externalSource = join(outside, 'source.MD')
        await writeFile(externalSource, '# External source\n', 'utf8')
        await symlink(outside, join(value.root, 'wiki', 'annotations'), 'junction')
      } else if (scenario === 'target-parent') {
        await rmdir(join(value.root, 'knowledge'))
        await symlink(outside, join(value.root, 'knowledge'), 'junction')
      } else {
        await mkdir(join(value.root, '.bioresearch'))
        await symlink(outside, join(value.root, '.bioresearch', 'runtime'), 'junction')
      }
      const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
        planner: planner(),
      })
      if (scenario === 'journal') {
        await assert.rejects(service.inspect(envelope), (error) => error.code === 'scope_denied')
      } else {
        const result = await service.run({ envelope })
        assert.equal(result.status, 'failed')
        assert.deepEqual(result.data.targets, [])
      }
      await assert.rejects(readFile(join(outside, 'first.md'), 'utf8'), (error) => error.code === 'ENOENT')
    } finally {
      await unlink(join(value.root, '.bioresearch', 'runtime')).catch(() => {})
      await unlink(join(value.root, 'knowledge')).catch(() => {})
      await unlink(join(value.root, 'wiki', 'annotations')).catch(() => {})
      for (const name of await readdir(outside).catch(() => [])) await unlink(join(outside, name)).catch(() => {})
      await rmdir(outside).catch(() => {})
      await cleanup(value)
    }
  }
})

test('restart recovers a fsynced deterministic staging file without replanning or overwriting', async () => {
  const value = await fixture()
  const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
    planner: planner(),
  })
  try {
    await service.run({ envelope: value.envelope })
    const inspection = await service.inspect(value.envelope)
    const journal = restoreRecoverablePlan(await readJournal(value.root, inspection.key), value.envelope)
    journal.state = 'committing'
    journal.result = null
    for (const target of journal.targets) {
      target.committedStatus = null
      target.committedRevision = null
      await unlink(join(value.root, ...target.path.split('/')))
    }
    const staged = join(
      value.root,
      'knowledge',
      `.first.md.${journal.targets[0].intendedRevision}.bioresearch.tmp`,
    )
    await writeFile(staged, journal.targets[0].content, 'utf8')
    await writeAuthenticatedState(value, inspection.key, journal)

    const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: { async plan() { throw new Error('Staging recovery must not re-plan.') } },
    })
    const result = await restarted.run({ envelope: value.envelope })
    assert.equal(result.status, 'completed')
    assert.equal(await readFile(join(value.root, 'knowledge', 'first.md'), 'utf8'), '# First\n')
    assert.equal(await readFile(join(value.root, 'knowledge', 'second.md'), 'utf8'), '# Second\n')
    await assert.rejects(readFile(staged, 'utf8'), (error) => error.code === 'ENOENT')
  } finally {
    await cleanup(value)
  }
})

test('cancellation during planning and after the final rename is durable, quiescent, and truthful', async () => {
  for (const point of ['planning', 'after-final-rename']) {
    const value = await fixture()
    const controller = new AbortController()
    let plannerCalls = 0
    const archivePlanner = point === 'planning' ? {
      plan({ signal }) {
        plannerCalls += 1
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })
          setImmediate(() => controller.abort())
        })
      },
    } : planner()
    const service = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
      planner: archivePlanner,
    })
    try {
      const result = await service.run({
        envelope: value.envelope,
        signal: controller.signal,
        onProgress(progress) {
          if (point === 'after-final-rename'
            && progress.type === 'archive.target.committed'
            && progress.path === value.envelope.input.targets.at(-1)) controller.abort()
        },
      })
      assert.equal(result.status, 'cancelled')
      assert.deepEqual(result.data.targets.map(({ path }) => path),
        point === 'planning' ? [] : value.envelope.input.targets)

      const restarted = new ArchiveRealizationService({
      root: value.root,
      ...authenticity(value),
      annotationStore: new AnnotationStore({ root: value.root }),
        planner: { async plan() { throw new Error('Cancelled realization must replay without planning.') } },
      })
      assert.deepEqual(await restarted.run({ envelope: value.envelope }), result)
      if (point === 'planning') assert.equal(plannerCalls, 1)
    } finally {
      await cleanup(value)
    }
  }
})
