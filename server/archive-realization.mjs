import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import {
  RUNTIME_ARCHIVE_JOURNAL_SCHEMA_VERSION,
  RUNTIME_ARCHIVE_PLAN_MAX_BYTES,
  RUNTIME_ARCHIVE_TARGET_CONTENT_MAX_BYTES,
} from '../shared/runtime-action-contracts.mjs'
import {
  consumeKnowledgeArchiveActionInput,
  consumeKnowledgeArchiveResult,
  createKnowledgeArchiveResult,
} from '../src/research/knowledgeArchive.js'
import { ArchiveAuthenticityStore } from './archive-authenticity.mjs'

const RUNTIME_METADATA_DIRECTORY = '.bioresearch/runtime'
const JOURNAL_DIRECTORY = `${RUNTIME_METADATA_DIRECTORY}/archive-realizations/v1`
const JOURNAL_KIND = 'runtime-archive-realization'
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])
const REALIZATION_STATES = new Set(['accepted', 'planning', 'planned', 'committing', ...TERMINAL_STATES])
const COMMIT_STATUSES = new Set(['created', 'updated', 'unchanged'])

function archiveError(message, statusCode = 400, code = 'archive_failed', details = {}) {
  return Object.assign(new Error(message), { statusCode, code, ...details })
}

function abortError(message = 'Archive run was cancelled.') {
  return archiveError(message, 499, 'archive_cancelled', { name: 'AbortError' })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function serializedJson(value, label) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('undefined JSON')
    return serialized
  } catch {
    throw archiveError(`${label} must be JSON serializable.`)
  }
}

function byteLength(value, label) {
  return Buffer.byteLength(typeof value === 'string' ? value : serializedJson(value, label), 'utf8')
}

function digest(value) {
  return createHash('sha256').update(serializedJson(value, 'Archive request')).digest('hex')
}

function revisionFor(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw archiveError(`${label} must be an object.`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw archiveError(`${label} must contain exactly: ${keys.join(', ')}.`)
  }
}

function sameJson(left, right) {
  return serializedJson(left, 'Approval binding') === serializedJson(right, 'Approval binding')
}

function safeRelativePath(value, label) {
  const path = String(value || '')
  if (!path || path.includes('\\') || path.includes(String.fromCharCode(0)) || isAbsolute(path)) {
    throw archiveError(`${label} must be a safe relative forward-slash path.`, 403, 'scope_denied')
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw archiveError(`${label} must be a safe relative forward-slash path.`, 403, 'scope_denied')
  }
  const comparablePath = path.toLowerCase()
  if (comparablePath === RUNTIME_METADATA_DIRECTORY || comparablePath.startsWith(`${RUNTIME_METADATA_DIRECTORY}/`)) {
    throw archiveError('Archive targets cannot use the reserved Runtime realization metadata path.', 403, 'scope_denied')
  }
  return path
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function approvalBinding(envelope, request) {
  const approval = envelope.approval
  exactKeys(approval, ['status', 'scope', 'sourceAnnotation', 'targets'], 'Archive approval')
  if (approval.status !== 'approved') throw archiveError('Formal archive requires explicit approval.', 403, 'approval_required')
  let proof
  try {
    proof = consumeKnowledgeArchiveActionInput({
      ...request,
      scope: approval.scope,
      input: {
        operation: request.input.operation,
        sourceAnnotation: approval.sourceAnnotation,
        targets: approval.targets,
      },
    })
  } catch (error) {
    throw archiveError(`Archive approval is invalid: ${error.message}`, 409, 'approval_mismatch')
  }
  const canonicalRequest = {
    scope: request.scope,
    sourceAnnotation: request.input.sourceAnnotation,
    targets: request.input.targets,
  }
  const canonicalProof = {
    scope: proof.scope,
    sourceAnnotation: proof.input.sourceAnnotation,
    targets: proof.input.targets,
  }
  if (!sameJson(canonicalProof, canonicalRequest)) {
    throw archiveError('Archive approval does not match the exact scope, source Annotation, and targets.', 409, 'approval_mismatch')
  }
  const binding = {
    status: 'approved',
    ...canonicalRequest,
  }
  return { binding, digest: digest(binding) }
}

function scopeAllowsTargets(scope, targets) {
  if (scope.target.kind === 'vault') return true
  const scopePath = safeRelativePath(scope.target.id, 'Archive authorization root')
  if (scope.target.kind === 'folder') {
    const prefix = scopePath.endsWith('/') ? scopePath : `${scopePath}/`
    return targets.every((path) => path.startsWith(prefix))
  }
  if (scope.target.kind === 'note') return targets.length === 1 && targets[0] === scopePath
  return false
}

function normalizedRequestDigest(request) {
  return digest({
    toolId: request.toolId,
    input: request.input,
    context: request.context,
    scope: request.scope,
  })
}

function terminalBinding(request) {
  return {
    schemaVersion: request.schemaVersion,
    toolId: request.toolId,
    requestId: request.requestId,
    runId: request.runId,
    sessionId: request.sessionId,
    scope: structuredClone(request.scope),
    idempotencyKey: request.idempotencyKey,
    input: structuredClone(request.input),
  }
}

function requestFromTerminalBinding(binding) {
  exactKeys(binding, [
    'schemaVersion', 'toolId', 'requestId', 'runId', 'sessionId', 'scope', 'idempotencyKey', 'input',
  ], 'Archive realization terminal binding')
  return consumeKnowledgeArchiveActionInput({
    ...binding,
    context: { schemaVersion: 1 },
  })
}

function journalKey(request) {
  return createHash('sha256')
    .update(`${request.scope.vaultId}\0${request.toolId}\0${request.idempotencyKey}`)
    .digest('hex')
}

function terminalEventFor(result) {
  if (result.status === 'completed') return { type: 'run.completed', output: result }
  if (result.status === 'cancelled') return { type: 'run.cancelled', result }
  return { type: 'run.failed', result }
}

function safeFailure(error) {
  return {
    code: 'archive_failed',
    message: String(error?.message || 'Knowledge archive run failed.').slice(0, 1024),
  }
}

function planTargets(request, plan) {
  exactKeys(plan, ['targets'], 'Archive realization plan')
  if (byteLength(plan, 'Archive realization plan') > RUNTIME_ARCHIVE_PLAN_MAX_BYTES) {
    throw archiveError('Archive realization plan exceeds the 4,194,304-byte limit.', 413, 'limit_exceeded')
  }
  if (!Array.isArray(plan.targets) || plan.targets.length !== request.input.targets.length) {
    throw archiveError('Archive realization plan must cover every requested target exactly once.')
  }
  return plan.targets.map((entry, index) => {
    exactKeys(entry, ['path', 'content'], `Archive realization target[${index}]`)
    const path = request.input.targets[index]
    if (entry.path !== path) throw archiveError('Archive realization plan must preserve exact requested target order.')
    if (typeof entry.content !== 'string' || !entry.content) {
      throw archiveError(`Archive realization target ${path} requires non-empty Markdown content.`)
    }
    if (byteLength(entry.content, 'Archive target content') > RUNTIME_ARCHIVE_TARGET_CONTENT_MAX_BYTES) {
      throw archiveError('Archive target content exceeds the 1,048,576-byte limit.', 413, 'limit_exceeded')
    }
    return { path, content: entry.content, intendedRevision: revisionFor(entry.content) }
  })
}

function validateJournalRecord(value, key, authenticity) {
  const terminal = TERMINAL_STATES.has(value?.state)
  exactKeys(value, terminal ? [
    'schemaVersion', 'kind', 'key', 'keyId', 'generation', 'previousMac', 'mac', 'requestDigest', 'approvalDigest', 'binding',
    'state', 'targets', 'result', 'createdAt', 'updatedAt',
  ] : [
    'schemaVersion', 'kind', 'key', 'keyId', 'generation', 'previousMac', 'mac', 'requestDigest', 'approvalDigest', 'request', 'approval',
    'state', 'targets', 'result', 'createdAt', 'updatedAt',
  ], 'Archive realization journal')
  if (value.schemaVersion !== RUNTIME_ARCHIVE_JOURNAL_SCHEMA_VERSION
    || value.kind !== JOURNAL_KIND
    || value.key !== key
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0) {
    throw archiveError('Archive realization journal is incompatible or corrupt.', 500, 'journal_corrupt')
  }
  if (value.keyId !== authenticity.keyId
    || (value.previousMac !== null && (typeof value.previousMac !== 'string' || value.previousMac.length !== 64))
    || typeof value.mac !== 'string'
    || value.mac.length !== 64
    || !authenticity.verify(value)) {
    throw archiveError('Archive realization journal authenticity validation failed.', 500, 'journal_corrupt')
  }
  const request = terminal
    ? requestFromTerminalBinding(value.binding)
    : consumeKnowledgeArchiveActionInput(value.request)
  const expectedKey = journalKey(request)
  const approval = terminal ? null : approvalBinding({ approval: value.approval }, request)
  if (expectedKey !== key
    || (!terminal && value.requestDigest !== normalizedRequestDigest(request))
    || (!terminal && value.approvalDigest !== approval.digest)
    || typeof value.requestDigest !== 'string'
    || value.requestDigest.length !== 64
    || typeof value.approvalDigest !== 'string'
    || value.approvalDigest.length !== 64) {
    throw archiveError('Archive realization journal digest validation failed.', 500, 'journal_corrupt')
  }
  if (!REALIZATION_STATES.has(value.state)) throw archiveError('Archive realization journal state is invalid.', 500, 'journal_corrupt')
  if (!Array.isArray(value.targets) || value.targets.length !== request.input.targets.length) {
    throw archiveError('Archive realization journal target inventory is invalid.', 500, 'journal_corrupt')
  }
  const unplanned = value.targets.every((target) => target.content === null && target.intendedRevision === null && target.intendedBytes === null)
  const compact = terminal && value.targets.every((target) => target.content === undefined)
  const compactPlanned = compact && value.targets.every((target) => typeof target.intendedRevision === 'string'
    && Number.isSafeInteger(target.intendedBytes)
    && target.intendedBytes > 0)
  const compactUnplanned = compact && value.targets.every((target) => target.intendedRevision === null
    && target.intendedBytes === null)
  if (compact && !compactPlanned && !compactUnplanned) {
    throw archiveError('Archive realization compact target inventory is partial.', 500, 'journal_corrupt')
  }
  if (!unplanned && !compact && value.targets.some((target) => target.content === null || target.intendedRevision === null || target.intendedBytes === null)) {
    throw archiveError('Archive realization journal has a partial plan.', 500, 'journal_corrupt')
  }
  if (['accepted', 'planning'].includes(value.state) && !unplanned) {
    throw archiveError('Pre-plan archive realization journal cannot carry a plan.', 500, 'journal_corrupt')
  }
  if (['planned', 'committing', 'completed'].includes(value.state) && unplanned) {
    throw archiveError('Archive realization journal is missing its durable plan.', 500, 'journal_corrupt')
  }
  const normalizedPlan = unplanned || compact ? null : planTargets(request, {
    targets: value.targets.map(({ path, content }) => ({ path, content })),
  })
  let sawUncommitted = false
  let committedCount = 0
  value.targets.forEach((target, index) => {
    exactKeys(target, compact ? [
      'path', 'intendedRevision', 'intendedBytes', 'snapshotRevision', 'snapshotExisted',
      'committedStatus', 'committedRevision',
    ] : [
      'path', 'content', 'intendedRevision', 'intendedBytes', 'snapshotRevision', 'snapshotExisted',
      'committedStatus', 'committedRevision',
    ], `Archive realization journal target[${index}]`)
    if (!unplanned && !compact && (target.intendedRevision !== normalizedPlan[index].intendedRevision
      || target.intendedBytes !== Buffer.byteLength(target.content, 'utf8'))) {
      throw archiveError('Archive realization journal intended revision is invalid.', 500, 'journal_corrupt')
    }
    if (compactPlanned && (!/^[a-f0-9]{32}$/.test(target.intendedRevision)
      || target.intendedBytes > RUNTIME_ARCHIVE_TARGET_CONTENT_MAX_BYTES)) {
      throw archiveError('Archive realization compact target evidence is invalid.', 500, 'journal_corrupt')
    }
    if (unplanned || compactUnplanned) {
      if (target.path !== request.input.targets[index]
        || target.snapshotExisted !== null
        || target.snapshotRevision !== null
        || target.committedStatus !== null
        || target.committedRevision !== null) {
        throw archiveError('Archive realization journal accepted target is invalid.', 500, 'journal_corrupt')
      }
      return
    }
    if (typeof target.snapshotExisted !== 'boolean'
      || (target.snapshotRevision !== null && typeof target.snapshotRevision !== 'string')
      || target.snapshotExisted !== (target.snapshotRevision !== null)) {
      throw archiveError('Archive realization journal snapshot is invalid.', 500, 'journal_corrupt')
    }
    if (target.committedStatus === null) {
      if (target.committedRevision !== null) throw archiveError('Archive realization journal commit evidence is invalid.', 500, 'journal_corrupt')
      sawUncommitted = true
    } else if (!COMMIT_STATUSES.has(target.committedStatus)
      || typeof target.committedRevision !== 'string'
      || target.committedRevision !== target.intendedRevision) {
      throw archiveError('Archive realization journal commit evidence is invalid.', 500, 'journal_corrupt')
    } else {
      if (sawUncommitted) throw archiveError('Archive realization journal commit evidence must be an ordered prefix.', 500, 'journal_corrupt')
      committedCount += 1
    }
  })
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw archiveError('Archive realization journal timestamps are invalid.', 500, 'journal_corrupt')
  }
  if (['accepted', 'planning'].includes(value.state) && (!unplanned || committedCount !== 0 || value.result !== null)) {
    throw archiveError('Accepted/planning archive journal state is impossible.', 500, 'journal_corrupt')
  }
  if (value.state === 'planned' && (unplanned || committedCount !== 0 || value.result !== null)) {
    throw archiveError('Planned archive journal state cannot contain committed evidence or a terminal result.', 500, 'journal_corrupt')
  }
  if (value.state === 'committing' && (unplanned || value.result !== null)) {
    throw archiveError('Committing archive journal state requires a plan and no terminal result.', 500, 'journal_corrupt')
  }
  let result = null
  if (terminal) {
    result = consumeKnowledgeArchiveResult(request, value.result)
    if (result.status !== value.state) throw archiveError('Archive realization journal terminal status is invalid.', 500, 'journal_corrupt')
    const evidence = value.targets.flatMap((target) => target.committedStatus ? [{
      path: target.path,
      status: target.committedStatus,
      revision: target.committedRevision,
    }] : [])
    if (!sameJson(result.data.targets, evidence)) {
      throw archiveError('Archive realization journal terminal evidence is invalid.', 500, 'journal_corrupt')
    }
    if (value.state === 'completed' && committedCount !== value.targets.length) {
      throw archiveError('Completed archive journal requires evidence for every target.', 500, 'journal_corrupt')
    }
  } else if (value.result !== null) {
    throw archiveError('Non-terminal archive realization journal cannot carry a result.', 500, 'journal_corrupt')
  }
  const normalized = {
    ...value,
    ...(terminal ? { binding: terminalBinding(request) } : { request, approval: approval.binding }),
    targets: value.targets.map((target) => ({ ...target })),
    result,
  }
  return normalized
}

function validTransition(previous, next) {
  if (!previous) return next.state === 'accepted' && next.generation === 0 && next.previousMac === null
  if (next.generation !== previous.generation + 1 || next.previousMac !== previous.mac) return false
  if (TERMINAL_STATES.has(previous.state)) return false
  return {
    accepted: new Set(['planning', 'failed', 'cancelled']),
    planning: new Set(['planned', 'failed', 'cancelled']),
    planned: new Set(['committing', 'failed', 'cancelled']),
    committing: new Set(['committing', 'completed', 'failed', 'cancelled']),
  }[previous.state]?.has(next.state) === true
}

export class ArchiveRealizationService {
  #rootPromise
  #annotationStore
  #planner
  #authenticity
  #hooks
  #now
  #locks = new Map()

  constructor({ root, annotationStore, planner, authenticityStore, authenticityStateRoot, authenticityKey, hooks = {}, now = () => new Date().toISOString() } = {}) {
    if (!root) throw new Error('ArchiveRealizationService requires a Vault root.')
    if (!annotationStore?.read) throw new Error('ArchiveRealizationService requires AnnotationStore read access.')
    if (!planner?.plan) throw new Error('ArchiveRealizationService requires a read-only archive planner.')
    this.#rootPromise = realpath(resolve(root))
    this.#annotationStore = annotationStore
    this.#planner = planner
    this.#authenticity = authenticityStore || new ArchiveAuthenticityStore({
      root,
      stateRoot: authenticityStateRoot,
      key: authenticityKey,
    })
    this.#authenticity.audit?.(root, validateJournalRecord)
    this.#hooks = hooks
    this.#now = now
  }

  capabilityEvidence() {
    const planner = this.#planner.capabilityEvidence?.()
    return {
      executable: planner?.executable === true && planner.sandbox === 'read-only' && planner.output === 'strict-json',
      transport: 'research-run',
      journal: 'atomic-json-v1',
      journalPath: JOURNAL_DIRECTORY,
      crashRecovery: true,
      authenticity: 'hmac-sha256-v1',
      planner,
    }
  }

  async inspect(envelope) {
    const request = consumeKnowledgeArchiveActionInput(envelope)
    const root = await this.#rootPromise
    if (request.scope.vaultId !== basename(root)) {
      throw archiveError('Archive scope Vault does not match the configured Vault.', 403, 'scope_denied')
    }
    if (!scopeAllowsTargets(request.scope, request.input.targets)) {
      throw archiveError('Archive targets exceed the approved authorization root.', 403, 'scope_denied')
    }
    const approval = approvalBinding(envelope, request)
    for (const target of request.input.targets) safeRelativePath(target, 'Archive target')
    const key = journalKey(request)
    const requestDigest = normalizedRequestDigest(request)
    const existing = await this.#load(root, key)
    if (existing && (existing.requestDigest !== requestDigest || existing.approvalDigest !== approval.digest)) {
      throw archiveError('Archive idempotencyKey was already used for a different scoped request.', 409, 'idempotency_conflict')
    }
    if (existing) await this.#validateActualEvidence(root, existing)
    return {
      root,
      key,
      request,
      approval: approval.binding,
      approvalDigest: approval.digest,
      requestDigest,
      existing,
    }
  }

  async accept(envelope) {
    const prepared = await this.inspect(envelope)
    const previous = this.#locks.get(prepared.key) || Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      let record = await this.#load(prepared.root, prepared.key)
      if (record && (record.requestDigest !== prepared.requestDigest
        || record.approvalDigest !== prepared.approvalDigest)) {
        throw archiveError('Archive idempotencyKey was already used for a different scoped request.', 409, 'idempotency_conflict')
      }
      if (!record) {
        record = this.#acceptedRecord(prepared)
        await this.#persist(prepared.root, prepared.key, record)
      }
      await this.#validateActualEvidence(prepared.root, record)
      return record
    })
    this.#locks.set(prepared.key, task)
    try {
      return { ...prepared, existing: await task }
    } finally {
      if (this.#locks.get(prepared.key) === task) this.#locks.delete(prepared.key)
    }
  }

  async run({ envelope, signal, onProgress = () => {}, inspection } = {}) {
    const prepared = inspection || await this.inspect(envelope)
    const previous = this.#locks.get(prepared.key) || Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.#runLocked(prepared, signal, onProgress))
    this.#locks.set(prepared.key, task)
    try {
      return await task
    } finally {
      if (this.#locks.get(prepared.key) === task) this.#locks.delete(prepared.key)
    }
  }

  async #runLocked(prepared, signal, onProgress) {
    let record = await this.#load(prepared.root, prepared.key)
    if (record && (record.requestDigest !== prepared.requestDigest
      || record.approvalDigest !== prepared.approvalDigest)) {
      throw archiveError('Archive idempotencyKey was already used for a different scoped request.', 409, 'idempotency_conflict')
    }
    if (record && TERMINAL_STATES.has(record.state)) return record.result

    const request = record?.request || prepared.request
    if (!record) {
      record = this.#acceptedRecord(prepared)
      await this.#persist(prepared.root, prepared.key, record)
    }
    try {
      throwIfAborted(signal)
      if (record.state === 'accepted') {
        record.state = 'planning'
        record.updatedAt = this.#now()
        await this.#persist(prepared.root, prepared.key, record)
      }
      await this.#assertNoSymlinks(prepared.root, request.input.sourceAnnotation.path)
      const source = await this.#annotationStore.read(request.input.sourceAnnotation.path)
      if (source.path !== request.input.sourceAnnotation.path || source.revision !== request.input.sourceAnnotation.revision) {
        throw archiveError('Source Annotation revision conflict.', 409, 'revision_conflict', {
          currentRevision: source.revision,
        })
      }

      if (record.state === 'planning') {
        const snapshots = []
        for (const path of request.input.targets) snapshots.push(await this.#readTarget(prepared.root, path))
        const plan = await this.#planner.plan({
          request,
          sourceRecord: source,
          signal,
          onProgress,
        })
        const intended = planTargets(request, plan)
        record.state = 'planned'
        record.targets = intended.map((target, index) => ({
          ...target,
          intendedBytes: Buffer.byteLength(target.content, 'utf8'),
          snapshotRevision: snapshots[index].revision,
          snapshotExisted: snapshots[index].exists,
          committedStatus: null,
          committedRevision: null,
        }))
        record.updatedAt = this.#now()
        await this.#persist(prepared.root, prepared.key, record)
      }

      record.state = 'committing'
      record.updatedAt = this.#now()
      await this.#persist(prepared.root, prepared.key, record)
      for (const target of record.targets) {
        if (target.committedStatus) continue
        throwIfAborted(signal)
        const current = await this.#readTarget(prepared.root, target.path)
        if (current.revision === target.intendedRevision) {
          target.committedStatus = target.snapshotRevision === target.intendedRevision ? 'unchanged' : target.snapshotExisted ? 'updated' : 'created'
          target.committedRevision = current.revision
        } else {
          if (current.revision !== target.snapshotRevision) {
            throw archiveError(`Archive target changed before commit: ${target.path}.`, 409, 'revision_conflict', {
              target: target.path,
              currentRevision: current.revision,
            })
          }
          await this.#commitTarget(prepared.root, target)
          target.committedStatus = target.snapshotExisted ? 'updated' : 'created'
          target.committedRevision = target.intendedRevision
        }
        record.updatedAt = this.#now()
        await this.#persist(prepared.root, prepared.key, record)
        onProgress({ type: 'archive.target.committed', path: target.path, status: target.committedStatus })
      }

      throwIfAborted(signal)

      const result = createKnowledgeArchiveResult(request, {
        status: 'completed',
        summary: 'Knowledge archive completed.',
        targets: this.#evidence(record),
      })
      record.state = 'completed'
      record.result = result
      record.updatedAt = this.#now()
      this.#compactTerminal(record, request)
      await this.#persist(prepared.root, prepared.key, record)
      return result
    } catch (error) {
      const cancelled = error?.name === 'AbortError' || signal?.aborted
      const result = createKnowledgeArchiveResult(request, {
        status: cancelled ? 'cancelled' : 'failed',
        summary: cancelled ? 'Knowledge archive cancelled.' : String(error?.message || 'Knowledge archive failed.'),
        targets: record ? this.#evidence(record) : [],
        error: cancelled
          ? { code: 'archive_cancelled', message: 'Archive run was cancelled.' }
          : safeFailure(error),
      })
      if (record) {
        record.state = cancelled ? 'cancelled' : 'failed'
        record.result = result
        record.updatedAt = this.#now()
        this.#compactTerminal(record, request)
        await this.#persist(prepared.root, prepared.key, record)
      }
      return result
    }
  }

  #evidence(record) {
    return record.targets.flatMap((target) => target.committedStatus ? [{
      path: target.path,
      status: target.committedStatus,
      revision: target.committedRevision,
    }] : [])
  }

  #compactTerminal(record, request) {
    record.binding = terminalBinding(request)
    delete record.request
    delete record.approval
    record.targets = record.targets.map((target) => {
      const { content: _content, ...compact } = target
      return compact
    })
  }

  #acceptedRecord(prepared) {
    const request = prepared.request
    return {
      schemaVersion: RUNTIME_ARCHIVE_JOURNAL_SCHEMA_VERSION,
      kind: JOURNAL_KIND,
      key: prepared.key,
      keyId: this.#authenticity.keyId,
      generation: 0,
      previousMac: null,
      mac: '',
      requestDigest: prepared.requestDigest,
      approvalDigest: prepared.approvalDigest,
      request,
      approval: prepared.approval,
      state: 'accepted',
      targets: request.input.targets.map((path) => ({
        path,
        content: null,
        intendedRevision: null,
        intendedBytes: null,
        snapshotRevision: null,
        snapshotExisted: null,
        committedStatus: null,
        committedRevision: null,
      })),
      result: null,
      createdAt: this.#now(),
      updatedAt: this.#now(),
    }
  }

  async #readTarget(root, pathValue) {
    const path = safeRelativePath(pathValue, 'Archive target')
    await this.#assertNoSymlinks(root, path)
    const absolute = resolve(root, ...path.split('/'))
    if (!inside(root, absolute)) throw archiveError('Archive target escapes the Vault root.', 403, 'scope_denied')
    try {
      const details = await lstat(absolute)
      if (details.isSymbolicLink() || !details.isFile()) {
        throw archiveError(`Archive target is not a regular file: ${path}.`, 403, 'scope_denied')
      }
      const content = await readFile(absolute, 'utf8')
      return { path, absolute, exists: true, content, revision: revisionFor(content) }
    } catch (error) {
      if (error?.code === 'ENOENT') return { path, absolute, exists: false, content: null, revision: null }
      throw error
    }
  }

  async #commitTarget(root, target) {
    const absolute = resolve(root, ...target.path.split('/'))
    const parentPath = dirname(absolute)
    await this.#assertNoSymlinks(root, dirname(target.path))
    await mkdir(parentPath, { recursive: true })
    await this.#assertNoSymlinks(root, dirname(target.path))
    const parent = await realpath(parentPath)
    if (!inside(root, parent)) throw archiveError('Archive target parent escapes the Vault root.', 403, 'scope_denied')
    const before = await this.#readTarget(root, target.path)
    if (before.revision !== target.snapshotRevision) {
      throw archiveError(`Archive target changed during commit: ${target.path}.`, 409, 'revision_conflict')
    }
    const temporary = resolve(parent, `.${basename(target.path)}.${target.intendedRevision}.bioresearch.tmp`)
    let handle
    try {
      try {
        const staging = await lstat(temporary)
        if (staging.isSymbolicLink() || !staging.isFile()) {
          throw archiveError('Archive staging path is not a regular file.', 403, 'scope_denied')
        }
        const stagedContent = await readFile(temporary, 'utf8')
        if (revisionFor(stagedContent) !== target.intendedRevision || stagedContent !== target.content) {
          throw archiveError('Archive staging content does not match the durable plan.', 500, 'journal_corrupt')
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(target.content, 'utf8')
        await handle.sync()
        await handle.close()
        handle = null
      }
      const finalCheck = await this.#readTarget(root, target.path)
      if (finalCheck.revision !== target.snapshotRevision) {
        throw archiveError(`Archive target changed during commit: ${target.path}.`, 409, 'revision_conflict')
      }
      await this.#hooks.beforeTargetRename?.({ path: target.path })
      const renameCheck = await this.#readTarget(root, target.path)
      if (renameCheck.revision !== target.snapshotRevision) {
        throw archiveError(`Archive target changed immediately before rename: ${target.path}.`, 409, 'revision_conflict')
      }
      await rename(temporary, absolute)
    } catch (error) {
      await handle?.close().catch(() => {})
      throw error
    }
  }

  async #load(root, key) {
    await this.#assertNoSymlinks(root, JOURNAL_DIRECTORY)
    const path = resolve(root, ...JOURNAL_DIRECTORY.split('/'), `${key}.json`)
    let journalText = null
    try {
      await this.#assertNoSymlinks(root, `${JOURNAL_DIRECTORY}/${key}.json`)
      journalText = await readFile(path, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') return null
        throw error
      })
      const checkpointValue = await this.#authenticity.load(key)
      const journal = journalText === null ? null : validateJournalRecord(JSON.parse(journalText), key, this.#authenticity)
      const checkpoint = checkpointValue === null ? null : validateJournalRecord(checkpointValue, key, this.#authenticity)
      if (!journal && !checkpoint) return null
      if (!journal) {
        await this.#writeJournal(root, key, checkpoint)
        return checkpoint
      }
      if (!checkpoint) {
        if (journal.generation !== 0 || journal.state !== 'accepted') {
          throw archiveError('Trusted archive checkpoint is missing for an active realization.', 500, 'journal_corrupt')
        }
        await this.#authenticity.persist(key, journal)
        return journal
      }
      if (journal.generation === checkpoint.generation) {
        if (journal.mac !== checkpoint.mac) throw archiveError('Archive journal and trusted checkpoint disagree.', 500, 'journal_corrupt')
        return journal
      }
      if (journal.generation === checkpoint.generation + 1
        && journal.previousMac === checkpoint.mac
        && validTransition(checkpoint, journal)) {
        await this.#authenticity.persist(key, journal)
        return journal
      }
      throw archiveError('Archive realization rollback or generation drift detected.', 500, 'journal_corrupt')
    } catch (error) {
      if (error instanceof SyntaxError) throw archiveError('Archive realization journal is invalid JSON.', 500, 'journal_corrupt')
      throw error
    }
  }

  async #persist(root, key, record) {
    const previous = await this.#authenticity.load(key)
    const trusted = previous === null ? null : validateJournalRecord(previous, key, this.#authenticity)
    if (trusted) {
      record.generation = trusted.generation + 1
      record.previousMac = trusted.mac
    }
    record.keyId = this.#authenticity.keyId
    record.mac = this.#authenticity.mac(record)
    if (!validTransition(trusted, record)) {
      throw archiveError('Archive realization state transition is invalid.', 500, 'journal_corrupt')
    }
    const normalized = validateJournalRecord(structuredClone(record), key, this.#authenticity)
    await this.#writeJournal(root, key, normalized)
    await this.#authenticity.persist(key, normalized)
  }

  async #writeJournal(root, key, normalized) {
    const directory = resolve(root, ...JOURNAL_DIRECTORY.split('/'))
    await this.#assertNoSymlinks(root, JOURNAL_DIRECTORY)
    await mkdir(directory, { recursive: true })
    await this.#assertNoSymlinks(root, JOURNAL_DIRECTORY)
    const resolvedDirectory = await realpath(directory)
    if (!inside(root, resolvedDirectory)) throw archiveError('Archive journal directory escapes the Vault root.', 403, 'scope_denied')
    const path = resolve(directory, `${key}.json`)
    const temporary = resolve(directory, `.${key}.${randomUUID()}.tmp`)
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(`${serializedJson(normalized, 'Archive realization journal')}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temporary, path)
      let directoryHandle
      try {
        directoryHandle = await open(directory, 'r')
        await directoryHandle.sync()
        await directoryHandle.close()
        directoryHandle = null
      } catch {
        // Directory fsync is best-effort on platforms that do not expose it.
      } finally {
        await directoryHandle?.close().catch(() => {})
      }
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  async #validateActualEvidence(root, record) {
    const evidence = []
    for (const target of record.targets) {
      if (!target.committedStatus) continue
      const actual = await this.#readTarget(root, target.path)
      if (actual.revision !== target.intendedRevision) {
        throw archiveError(`Committed archive target no longer matches durable evidence: ${target.path}.`, 409, 'revision_conflict')
      }
      const expectedStatus = target.snapshotRevision === target.intendedRevision
        ? 'unchanged'
        : target.snapshotExisted ? 'updated' : 'created'
      if (target.committedStatus !== expectedStatus || target.committedRevision !== actual.revision) {
        throw archiveError('Archive realization journal committed evidence is inconsistent.', 500, 'journal_corrupt')
      }
      evidence.push({ path: target.path, status: target.committedStatus, revision: actual.revision })
    }
    if (record.result !== null && !sameJson(record.result.data.targets, evidence)) {
      throw archiveError('Archive realization journal terminal evidence is inconsistent.', 500, 'journal_corrupt')
    }
  }

  async #assertNoSymlinks(root, relativePath) {
    const parts = String(relativePath || '').split('/').filter(Boolean)
    let current = root
    for (const part of parts) {
      current = resolve(current, part)
      if (!inside(root, current)) throw archiveError('Runtime path escapes the Vault root.', 403, 'scope_denied')
      try {
        const details = await lstat(current)
        if (details.isSymbolicLink()) throw archiveError('Runtime paths cannot traverse symbolic links or reparse points.', 403, 'scope_denied')
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
    }
  }
}

export const archiveRealizationInternals = Object.freeze({
  journalDirectory: JOURNAL_DIRECTORY,
  runtimeMetadataDirectory: RUNTIME_METADATA_DIRECTORY,
  journalKind: JOURNAL_KIND,
  normalizedRequestDigest,
  journalKey,
  revisionFor,
  terminalEventFor,
})
