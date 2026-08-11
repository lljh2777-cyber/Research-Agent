import { createHash } from 'node:crypto'

import {
  MAX_KNOWLEDGE_ACTION_INPUT_BYTES,
  MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES,
  MAX_KNOWLEDGE_CONTEXT_BYTES,
  RUNTIME_ACTION_DESCRIPTORS,
  RUNTIME_ACTION_SCHEMA_VERSION,
  runtimeActionDescriptor,
} from '../shared/runtime-action-contracts.mjs'
import {
  isTerminalResearchRunStatus,
  RESEARCH_RUN_EVENT,
} from '../src/research/runProtocol.js'
import {
  consumeKnowledgeArchiveResult,
  createKnowledgeArchiveResult,
} from '../src/research/knowledgeArchive.js'
import { ResearchRunManager } from './research-run-manager.mjs'

const IDEMPOTENCY_LIMIT = 1024
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])

function actionError(message, statusCode = 400, code = 'invalid_request') {
  return Object.assign(new Error(message), { statusCode, code })
}

function normalizedJson(value, label = 'Value') {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('undefined JSON')
    return serialized
  } catch {
    throw actionError(label + ' must be JSON serializable.')
  }
}

function byteLength(value, label) {
  return Buffer.byteLength(normalizedJson(value, label))
}

function requestDigest(value) {
  return createHash('sha256').update(normalizedJson(value, 'Action request')).digest('hex')
}

function validIdempotencyKey(value) {
  const key = String(value || '').trim()
  return key.length > 0 && key.length <= 256 && !key.includes(String.fromCharCode(0))
}


function validWriteScope(value) {
  const kinds = new Set(['vault', 'folder', 'note', 'selection', 'attachment'])
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && String(value.vaultId || '').trim()
    && value.target
    && kinds.has(value.target.kind)
    && String(value.target.id || '').trim()
  )
}
function isApproved(value) {
  return value?.status === 'approved' || value?.approved === true
}

function errorPayload(error, fallback = 'Action failed.') {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || fallback).slice(0, 4096),
    code: error?.code || 'action_failed',
    retryable: error?.name === 'AbortError',
  }
}

function requiredActionString(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > 256) throw actionError(label + ' is required.')
  return normalized
}

function normalizeActionOutput({ descriptor, requestId, runId, value }) {
  if (
    value?.schemaVersion === 1
    && value.toolId === descriptor.id
    && value.requestId === requestId
    && value.runId === runId
  ) return value
  return {
    schemaVersion: 1,
    toolId: descriptor.id,
    requestId,
    runId,
    status: 'completed',
    effect: descriptor.effect,
    summary: String(value?.summary || '').slice(0, 2000),
    data: value?.data ?? value ?? null,
    artifacts: Array.isArray(value?.artifacts) ? value.artifacts : [],
    error: null,
  }
}

function terminalEvent({ descriptor, runId, output }) {
  if (output.status === 'completed') {
    return { type: RESEARCH_RUN_EVENT.RUN_COMPLETED, runId, toolId: descriptor.id, output }
  }
  const cancelled = output.status === 'cancelled'
  return {
    type: cancelled ? RESEARCH_RUN_EVENT.RUN_CANCELLED : RESEARCH_RUN_EVENT.RUN_FAILED,
    runId,
    toolId: descriptor.id,
    error: {
      name: cancelled ? 'AbortError' : 'Error',
      message: output.error?.message || output.summary || (cancelled ? 'Action cancelled.' : 'Action failed.'),
      code: output.error?.code || (cancelled ? 'cancelled' : 'action_failed'),
      retryable: cancelled,
    },
    result: output,
  }
}

export class ActionService {
  #manager
  #runner
  #archiveRealizer
  #descriptors
  #runs = new Map()
  #idempotency = new Map()

  constructor({
    manager = new ResearchRunManager(),
    runner,
    archiveRealizer = null,
    descriptors = RUNTIME_ACTION_DESCRIPTORS,
  } = {}) {
    if (!runner?.run) throw new Error('ActionService requires a runner.')
    this.#manager = manager
    this.#runner = runner
    this.#archiveRealizer = archiveRealizer
    this.#descriptors = Object.freeze([...descriptors])
  }

  list() {
    return {
      ok: true,
      schemaVersion: RUNTIME_ACTION_SCHEMA_VERSION,
      actions: this.#descriptors,
    }
  }

  capabilityEvidence() {
    const archive = this.#archiveRealizer?.capabilityEvidence?.() || null
    const archiveExecutable = Boolean(
      archive?.executable === true
      && archive.transport === 'research-run'
      && archive.journal === 'atomic-json-v1'
      && archive.crashRecovery === true
      && archive.authenticity === 'hmac-sha256-v1'
      && archive.planner?.sandbox === 'read-only'
      && archive.planner?.output === 'strict-json'
    )
    return {
      executable: true,
      transport: 'same-origin',
      archive: archiveExecutable ? archive : null,
      capabilities: Object.fromEntries(this.#descriptors.map((descriptor) => [
        descriptor.capability,
        descriptor.id === 'knowledge.synthesis.write' ? archiveExecutable : true,
      ])),
    }
  }

  async start(envelope = {}) {
    if (byteLength(envelope, 'Action input') > MAX_KNOWLEDGE_ACTION_INPUT_BYTES) {
      throw actionError('Action input exceeds the 131,072-byte limit.', 413, 'limit_exceeded')
    }
    if (envelope.schemaVersion !== RUNTIME_ACTION_SCHEMA_VERSION) {
      throw actionError('Knowledge Action input requires schemaVersion 1.')
    }
    const descriptor = runtimeActionDescriptor(envelope.toolId)
    if (!descriptor || !this.#descriptors.some((entry) => entry.id === descriptor.id)) {
      throw actionError('Unknown Runtime Action.', 404, 'not_found')
    }
    const formalArchive = descriptor.id === 'knowledge.synthesis.write'
    if (formalArchive && !this.#archiveRealizer) {
      throw actionError('Formal archive realization is unavailable.', 503, 'runtime_unavailable')
    }
    const inspection = formalArchive
      ? await (this.#archiveRealizer.accept?.(envelope) || this.#archiveRealizer.inspect(envelope))
      : null
    const effectiveEnvelope = inspection?.existing?.request
      ? { ...inspection.existing.request, approval: inspection.existing.approval }
      : envelope
    const requestId = requiredActionString(effectiveEnvelope.requestId, 'Knowledge Action requestId')
    const runId = requiredActionString(effectiveEnvelope.runId, 'Knowledge Action runId')
    const sessionId = requiredActionString(effectiveEnvelope.sessionId, 'Knowledge Action sessionId')
    if (!effectiveEnvelope.input || typeof effectiveEnvelope.input !== 'object' || Array.isArray(effectiveEnvelope.input)) {
      throw actionError('Knowledge Action input.input must be an object.')
    }
    if (!effectiveEnvelope.context || typeof effectiveEnvelope.context !== 'object' || Array.isArray(effectiveEnvelope.context)) {
      throw actionError('KnowledgeContextV1 must be an opaque object.')
    }
    if (effectiveEnvelope.context.schemaVersion !== 1) {
      throw actionError('KnowledgeContextV1 requires schemaVersion 1.')
    }
    if (byteLength(effectiveEnvelope.context, 'KnowledgeContextV1') > MAX_KNOWLEDGE_CONTEXT_BYTES) {
      throw actionError('KnowledgeContextV1 exceeds the 65,536-byte limit.', 413, 'limit_exceeded')
    }
    if (descriptor.approvalPolicy === 'explicit' && !isApproved(effectiveEnvelope.approval)) {
      throw actionError('This Runtime Action requires explicit approval.', 403, 'approval_required')
    }
    if (descriptor.requiresScope && !validWriteScope(effectiveEnvelope.scope)) {
      throw actionError('This Runtime Action requires an explicit scope.', 403, 'scope_required')
    }
    if (descriptor.requiresIdempotencyKey && !validIdempotencyKey(effectiveEnvelope.idempotencyKey)) {
      throw actionError('This Runtime Action requires a valid idempotencyKey.')
    }

    const idempotencyKey = descriptor.requiresIdempotencyKey
      ? descriptor.id + ':' + String(effectiveEnvelope.idempotencyKey).trim()
      : null
    const digest = requestDigest({
      toolId: descriptor.id,
      input: effectiveEnvelope.input || {},
      context: effectiveEnvelope.context || null,
      scope: effectiveEnvelope.scope || null,
    })
    if (inspection?.existing && TERMINAL_STATES.has(inspection.existing.state)) {
      const created = this.#manager.create({ id: runId, sessionId, executionOwner: 'local-action' })
      if (created.created) {
        this.#manager.append(runId, {
          type: RESEARCH_RUN_EVENT.RUN_STARTED, runId, toolId: descriptor.id, requestId, sessionId,
        })
        this.#manager.append(runId, terminalEvent({ descriptor, runId, output: inspection.existing.result }))
      }
      this.#runs.set(runId, { toolId: descriptor.id, requestId, sessionId, controller: new AbortController(), execution: Promise.resolve() })
      return {
        started: false,
        replayed: true,
        toolId: descriptor.id,
        terminalEvent: this.#terminalEvent(runId),
        ...this.#manager.get(runId),
      }
    }
    if (idempotencyKey) {
      const existing = this.#idempotency.get(idempotencyKey)
      if (existing) {
        if (existing.digest !== digest) {
          throw actionError('idempotencyKey was already used for a different Action request.', 409, 'idempotency_conflict')
        }
        return {
          started: false,
          replayed: true,
          toolId: descriptor.id,
          terminalEvent: this.#terminalEvent(existing.runId),
          ...this.#manager.get(existing.runId),
        }
      }
    }

    const created = this.#manager.create({
      id: runId,
      sessionId,
      executionOwner: 'local-action',
    })
    if (!created.created) throw actionError('Action run ID already exists.', 409, 'run_conflict')
    const controller = new AbortController()
    this.#runs.set(runId, { toolId: descriptor.id, requestId, sessionId, controller })
    if (idempotencyKey) this.#remember(idempotencyKey, { digest, runId })
    this.#manager.append(runId, {
      type: RESEARCH_RUN_EVENT.RUN_STARTED,
      runId,
      toolId: descriptor.id,
      requestId,
      sessionId,
    })
    const execution = this.#execute(runId, descriptor, effectiveEnvelope, controller, inspection)
    this.#runs.get(runId).execution = execution
    void execution
    return { started: true, replayed: false, toolId: descriptor.id, ...this.#manager.get(runId) }
  }

  shutdown() {
    for (const [runId] of this.#runs) {
      const snapshot = this.#manager.get(runId)
      if (!isTerminalResearchRunStatus(snapshot.run.status)) this.#runs.get(runId)?.controller.abort()
    }
  }

  get(runId) {
    const metadata = this.#runs.get(runId)
    return { toolId: metadata?.toolId || null, ...this.#manager.get(runId) }
  }

  eventsAfter(runId, after = 0) {
    const metadata = this.#runs.get(runId)
    return { toolId: metadata?.toolId || null, ...this.#manager.eventsAfter(runId, after) }
  }

  subscribe(runId, listener) {
    return this.#manager.subscribe(runId, listener)
  }

  async cancel(runId) {
    const metadata = this.#runs.get(runId)
    const snapshot = this.#manager.get(runId)
    if (isTerminalResearchRunStatus(snapshot.run.status)) {
      return { cancelled: false, toolId: metadata?.toolId || null, ...snapshot }
    }
    metadata?.controller.abort()
    await metadata?.execution
    const terminal = this.#manager.get(runId)
    if (!isTerminalResearchRunStatus(terminal.run.status)) {
      return { toolId: metadata?.toolId || null, ...this.#manager.cancel(runId, {
        name: 'AbortError', message: 'Action cancelled.', code: 'cancelled', retryable: true,
      }) }
    }
    return { cancelled: terminal.run.status === 'cancelled', toolId: metadata?.toolId || null, ...terminal }
  }

  async #execute(runId, descriptor, envelope, controller, inspection) {
    try {
      const runnerInput = {
        descriptor,
        input: envelope.input || {},
        context: envelope.context || null,
        scope: envelope.scope || null,
        signal: controller.signal,
        onProgress: (progress) => this.#progress(runId, descriptor.id, progress),
      }
      const runnerOutput = descriptor.id === 'knowledge.synthesis.write'
        ? await this.#archiveRealizer.run({ envelope, signal: controller.signal, onProgress: runnerInput.onProgress, inspection })
        : await this.#runner.run(runnerInput)
      const output = descriptor.id === 'knowledge.synthesis.write'
        ? consumeKnowledgeArchiveResult(envelope, runnerOutput)
        : normalizeActionOutput({ descriptor, requestId: envelope.requestId, runId, value: runnerOutput })
      if (byteLength(output, 'Action output') > MAX_KNOWLEDGE_ACTION_OUTPUT_BYTES) {
        throw actionError('Action output exceeds the 65,536-byte limit.', 413, 'limit_exceeded')
      }
      this.#appendIfActive(runId, terminalEvent({ descriptor, runId, output }))
    } catch (error) {
      if (descriptor.id === 'knowledge.synthesis.write') {
        const status = error?.name === 'AbortError' || controller.signal.aborted ? 'cancelled' : 'failed'
        const output = createKnowledgeArchiveResult(envelope, {
          status,
          summary: error?.message,
          targets: [],
          error: {
            code: status === 'cancelled' ? 'archive_cancelled' : 'archive_failed',
            message: error?.message || (status === 'cancelled' ? 'Archive run was cancelled.' : 'Knowledge archive failed.'),
          },
        })
        this.#appendIfActive(runId, terminalEvent({ descriptor, runId, output }))
        return
      }
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        this.#appendIfActive(runId, {
          type: RESEARCH_RUN_EVENT.RUN_CANCELLED,
          runId,
          toolId: descriptor.id,
          error: errorPayload(error, 'Action cancelled.'),
        })
      } else {
        this.#appendIfActive(runId, {
          type: RESEARCH_RUN_EVENT.RUN_FAILED,
          runId,
          toolId: descriptor.id,
          error: errorPayload(error),
        })
      }
    }
  }

  #progress(runId, toolId, progress) {
    this.#appendIfActive(runId, {
      type: RESEARCH_RUN_EVENT.PROVIDER_EVENT,
      runId,
      toolId,
      providerEvent: { type: 'action.progress', data: progress || {} },
    })
  }

  #appendIfActive(runId, event) {
    const snapshot = this.#manager.get(runId)
    if (isTerminalResearchRunStatus(snapshot.run.status)) return false
    return this.#manager.append(runId, event).accepted === 1
  }


  #terminalEvent(runId) {
    const snapshot = this.#manager.get(runId)
    if (!isTerminalResearchRunStatus(snapshot.run.status)) return null
    const replay = this.#manager.eventsAfter(runId, Math.max(0, snapshot.lastCursor - 1))
    return replay.events.at(-1)?.event || null
  }
  #remember(key, value) {
    this.#idempotency.set(key, value)
    if (this.#idempotency.size > IDEMPOTENCY_LIMIT) this.#idempotency.delete(this.#idempotency.keys().next().value)
  }
}
