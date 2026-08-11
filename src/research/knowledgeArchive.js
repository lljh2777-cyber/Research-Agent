import {
  ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES,
  ANNOTATION_REVISION_MAX_BYTES,
  createArchiveCancellationError,
  normalizeAnnotationArchiveError,
  normalizeAnnotationArchiveTargets,
  normalizeSourceAnnotationReference,
} from '../annotations/annotation.js'
import {
  createKnowledgeActionInput,
  createKnowledgeActionOutput,
  KNOWLEDGE_ACTION_SCHEMA_VERSION,
  KNOWLEDGE_ACTION_STATUS,
  KNOWLEDGE_TOOL_EFFECT,
  KNOWLEDGE_TOOL_IDS,
} from './knowledgeAgent.js'
import { RESEARCH_RUN_EVENT } from './runProtocol.js'

export const KNOWLEDGE_ARCHIVE_RESULT_SCHEMA_VERSION = 1
export const KNOWLEDGE_ARCHIVE_RESULT_KIND = 'knowledge-archive-result'
export const KNOWLEDGE_ARCHIVE_TARGET_STATUS = Object.freeze({
  CREATED: 'created',
  UPDATED: 'updated',
  UNCHANGED: 'unchanged',
})

const TARGET_STATUSES = new Set(Object.values(KNOWLEDGE_ARCHIVE_TARGET_STATUS))
const TERMINAL_STATUSES = new Set([
  KNOWLEDGE_ACTION_STATUS.COMPLETED,
  KNOWLEDGE_ACTION_STATUS.FAILED,
  KNOWLEDGE_ACTION_STATUS.CANCELLED,
])

function cloneJson(value, label) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`${label} must be JSON serializable.`)
  }
  if (serialized === undefined) throw new Error(`${label} must be JSON serializable.`)
  return JSON.parse(serialized)
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length
}

function requiredString(value, label, maximumBytes) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  if (maximumBytes && utf8ByteLength(value) > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes.`)
  }
  return value
}

function requiredSummary(value, fallback) {
  const summary = String(value || fallback || '').trim()
  if (!summary) throw new Error('Knowledge archive result summary is required.')
  return Array.from(summary).slice(0, 2_000).join('')
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value || {}).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${keys.join(', ')}.`)
  }
}

export function createKnowledgeArchiveActionInput({
  requestId,
  runId,
  sessionId,
  context,
  scope,
  idempotencyKey,
  input,
} = {}) {
  const action = createKnowledgeActionInput(KNOWLEDGE_TOOL_IDS.SYNTHESIS, {
    requestId,
    runId,
    sessionId,
    context,
    scope,
    idempotencyKey,
    input,
  })
  requiredString(action.runId, 'Knowledge archive run ID', ANNOTATION_ARCHIVE_RUN_ID_MAX_BYTES)
  return action
}

export function consumeKnowledgeArchiveActionInput(value) {
  const action = cloneJson(value, 'Knowledge archive action input')
  if (action?.schemaVersion !== KNOWLEDGE_ACTION_SCHEMA_VERSION || action?.toolId !== KNOWLEDGE_TOOL_IDS.SYNTHESIS) {
    throw new Error('Unsupported Knowledge archive action input.')
  }
  return createKnowledgeArchiveActionInput(action)
}

export function normalizeKnowledgeArchiveTargetEvidence(requestValue, value, {
  requireAll = false,
} = {}) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  const evidence = cloneJson(value ?? [], 'Knowledge archive target evidence')
  if (!Array.isArray(evidence)) throw new Error('Knowledge archive target evidence must be an array.')
  if (evidence.length > request.input.targets.length) {
    throw new Error('Knowledge archive target evidence exceeds the requested target count.')
  }

  const requestedIndex = new Map(request.input.targets.map((path, index) => [path, index]))
  const seen = new Set()
  let previousIndex = -1
  const normalized = evidence.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Knowledge archive target evidence[${index}] must be an object.`)
    }
    exactKeys(entry, ['path', 'status', 'revision'], `Knowledge archive target evidence[${index}]`)
    const path = normalizeAnnotationArchiveTargets([entry.path])[0]
    const targetIndex = requestedIndex.get(path)
    if (targetIndex === undefined) throw new Error(`Knowledge archive result contains an unrequested target: ${path}.`)
    if (seen.has(path)) throw new Error(`Knowledge archive result duplicates target evidence: ${path}.`)
    if (targetIndex <= previousIndex) throw new Error('Knowledge archive target evidence must preserve requested target order.')
    if (!TARGET_STATUSES.has(entry.status)) throw new Error(`Unsupported Knowledge archive target status: ${String(entry.status)}.`)
    const revision = entry.revision === null
      ? null
      : requiredString(entry.revision, `Knowledge archive target evidence[${index}].revision`, ANNOTATION_REVISION_MAX_BYTES)
    seen.add(path)
    previousIndex = targetIndex
    return { path, status: entry.status, revision }
  })

  if (requireAll && (
    normalized.length !== request.input.targets.length
    || normalized.some((entry, index) => entry.path !== request.input.targets[index])
  )) {
    throw new Error('A completed Knowledge archive result requires terminal-success evidence for every requested target.')
  }
  return normalized
}

function normalizeTerminalError(status, value, summary) {
  if (status === KNOWLEDGE_ACTION_STATUS.COMPLETED) {
    if (value !== null && value !== undefined) throw new Error('Completed Knowledge archive results cannot contain an error.')
    return null
  }
  const supplied = value && typeof value === 'object' ? value : {}
  if (status === KNOWLEDGE_ACTION_STATUS.CANCELLED) {
    if (supplied.code && supplied.code !== 'archive_cancelled') {
      throw new Error('Cancelled Knowledge archive results require archive_cancelled.')
    }
    return createArchiveCancellationError(supplied.message || summary || undefined)
  }
  if (supplied.code && supplied.code !== 'archive_failed') {
    throw new Error('Failed Knowledge archive results require archive_failed.')
  }
  return normalizeAnnotationArchiveError({
    code: 'archive_failed',
    message: supplied.message || summary || 'Knowledge archive run failed.',
  })
}

function createResultData(request, targets) {
  return {
    schemaVersion: KNOWLEDGE_ARCHIVE_RESULT_SCHEMA_VERSION,
    kind: KNOWLEDGE_ARCHIVE_RESULT_KIND,
    sourceAnnotation: normalizeSourceAnnotationReference(request.input.sourceAnnotation),
    targets,
  }
}

export function createKnowledgeArchiveResult(requestValue, {
  status = KNOWLEDGE_ACTION_STATUS.COMPLETED,
  summary,
  targets = [],
  error = null,
} = {}) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Unsupported Knowledge archive terminal status: ${String(status)}.`)
  const normalizedTargets = normalizeKnowledgeArchiveTargetEvidence(request, targets, {
    requireAll: status === KNOWLEDGE_ACTION_STATUS.COMPLETED,
  })
  const normalizedSummary = requiredSummary(summary, status === KNOWLEDGE_ACTION_STATUS.COMPLETED
    ? 'Knowledge archive completed.'
    : status === KNOWLEDGE_ACTION_STATUS.CANCELLED
      ? 'Knowledge archive cancelled.'
      : 'Knowledge archive failed.')
  const normalizedError = normalizeTerminalError(status, error, normalizedSummary)
  return createKnowledgeActionOutput(KNOWLEDGE_TOOL_IDS.SYNTHESIS, {
    requestId: request.requestId,
    runId: request.runId,
    status,
    effect: KNOWLEDGE_TOOL_EFFECT.WRITE,
    summary: normalizedSummary,
    data: createResultData(request, normalizedTargets),
    artifacts: [],
    error: normalizedError,
  })
}

export function consumeKnowledgeArchiveExecutionResult(requestValue, value = {}) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  const result = cloneJson(value, 'Knowledge archive execution result')
  if (['schemaVersion', 'toolId', 'requestId', 'runId'].some((key) => result?.[key] !== undefined)) {
    return consumeKnowledgeArchiveResult(request, result)
  }
  if (result?.effect !== undefined && result.effect !== KNOWLEDGE_TOOL_EFFECT.WRITE) {
    throw new Error('Knowledge archive execution result cannot change its write effect identity.')
  }
  if (result?.artifacts !== undefined && (!Array.isArray(result.artifacts) || result.artifacts.length)) {
    throw new Error('Knowledge archive execution result artifacts must be empty.')
  }
  const data = result?.data && typeof result.data === 'object' ? result.data : {}
  if (['schemaVersion', 'kind', 'sourceAnnotation'].some((key) => data[key] !== undefined)) {
    exactKeys(data, ['schemaVersion', 'kind', 'sourceAnnotation', 'targets'], 'Knowledge archive execution result data')
    if (data.schemaVersion !== KNOWLEDGE_ARCHIVE_RESULT_SCHEMA_VERSION) {
      throw new Error('Knowledge archive execution result has an incompatible data schema version.')
    }
  }
  if (data.kind !== undefined && data.kind !== KNOWLEDGE_ARCHIVE_RESULT_KIND) {
    throw new Error('Knowledge archive execution result has an incompatible data subtype.')
  }
  if (data.sourceAnnotation !== undefined) {
    exactKeys(data.sourceAnnotation, ['id', 'path', 'revision'], 'Knowledge archive execution source Annotation')
    const sourceAnnotation = normalizeSourceAnnotationReference(data.sourceAnnotation)
    if (
      sourceAnnotation.id !== request.input.sourceAnnotation.id
      || sourceAnnotation.path !== request.input.sourceAnnotation.path
      || sourceAnnotation.revision !== request.input.sourceAnnotation.revision
    ) throw new Error('Knowledge archive execution source Annotation does not match its request.')
  }
  return createKnowledgeArchiveResult(request, {
    status: result?.status,
    summary: result?.summary,
    targets: data.targets ?? result?.targets ?? [],
    error: result?.error,
  })
}

export function consumeKnowledgeArchiveResult(requestValue, value) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  const result = cloneJson(value, 'Knowledge archive result')
  exactKeys(result, [
    'schemaVersion', 'toolId', 'requestId', 'runId', 'status', 'effect', 'summary', 'data', 'artifacts', 'error',
  ], 'Knowledge archive result')
  if (result.schemaVersion !== KNOWLEDGE_ACTION_SCHEMA_VERSION || result.toolId !== KNOWLEDGE_TOOL_IDS.SYNTHESIS) {
    throw new Error('Unsupported Knowledge archive result schema or tool identity.')
  }
  if (result.requestId !== request.requestId || result.runId !== request.runId) {
    throw new Error('Knowledge archive result identity does not match its request.')
  }
  if (result.effect !== KNOWLEDGE_TOOL_EFFECT.WRITE) throw new Error('Knowledge archive result must retain write effect identity.')
  if (!Array.isArray(result.artifacts) || result.artifacts.length) {
    throw new Error('Knowledge archive result artifacts must be empty; target evidence belongs in data.targets.')
  }
  if (result.error !== null) exactKeys(result.error, ['code', 'message'], 'Knowledge archive result error')
  const data = result.data
  exactKeys(data, ['schemaVersion', 'kind', 'sourceAnnotation', 'targets'], 'Knowledge archive result data')
  if (data.schemaVersion !== KNOWLEDGE_ARCHIVE_RESULT_SCHEMA_VERSION || data.kind !== KNOWLEDGE_ARCHIVE_RESULT_KIND) {
    throw new Error('Unsupported Knowledge archive result data subtype.')
  }
  exactKeys(data.sourceAnnotation, ['id', 'path', 'revision'], 'Knowledge archive result source Annotation')
  const sourceAnnotation = normalizeSourceAnnotationReference(data.sourceAnnotation)
  if (
    sourceAnnotation.id !== request.input.sourceAnnotation.id
    || sourceAnnotation.path !== request.input.sourceAnnotation.path
    || sourceAnnotation.revision !== request.input.sourceAnnotation.revision
  ) throw new Error('Knowledge archive result source Annotation identity does not match its request.')
  return createKnowledgeArchiveResult(request, {
    status: result.status,
    summary: result.summary,
    targets: data.targets,
    error: result.error,
  })
}

export function isCompletedKnowledgeArchiveResult(requestValue, value) {
  try {
    return consumeKnowledgeArchiveResult(requestValue, value).status === KNOWLEDGE_ACTION_STATUS.COMPLETED
  } catch {
    return false
  }
}

export function requireCompletedKnowledgeArchiveResult(requestValue, value) {
  const result = consumeKnowledgeArchiveResult(requestValue, value)
  if (result.status !== KNOWLEDGE_ACTION_STATUS.COMPLETED) {
    throw new Error('A completed Knowledge archive result is required.')
  }
  return result
}

export function createKnowledgeArchivePendingState(requestValue) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  return {
    state: 'pending',
    targets: [...request.input.targets],
    runId: request.runId,
    error: null,
  }
}

export function knowledgeArchiveResultToAnnotationArchive(requestValue, value) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  const result = consumeKnowledgeArchiveResult(request, value)
  if (result.status === KNOWLEDGE_ACTION_STATUS.COMPLETED) {
    return {
      state: 'completed',
      targets: [...request.input.targets],
      runId: request.runId,
      error: null,
    }
  }
  return {
    state: 'failed',
    targets: [...request.input.targets],
    runId: request.runId,
    error: result.status === KNOWLEDGE_ACTION_STATUS.CANCELLED
      ? createArchiveCancellationError(result.error?.message)
      : normalizeAnnotationArchiveError(result.error),
  }
}

export function consumeKnowledgeArchiveTerminalEvent(requestValue, eventValue) {
  const request = consumeKnowledgeArchiveActionInput(requestValue)
  const event = eventValue?.event || eventValue
  if (event?.runId && event.runId !== request.runId) {
    throw new Error('Knowledge archive terminal event has a mismatched run ID.')
  }
  if (event?.type === RESEARCH_RUN_EVENT.RUN_COMPLETED) {
    try {
      const result = consumeKnowledgeArchiveResult(request, event.output)
      if (result.status !== KNOWLEDGE_ACTION_STATUS.COMPLETED) {
        throw new Error('Knowledge archive completed terminal requires a completed Action output.')
      }
      return result
    } catch (error) {
      return createKnowledgeArchiveResult(request, {
        status: KNOWLEDGE_ACTION_STATUS.FAILED,
        summary: error.message,
        targets: [],
        error: { code: 'archive_failed', message: error.message },
      })
    }
  }
  if (event?.type === RESEARCH_RUN_EVENT.RUN_FAILED || event?.type === RESEARCH_RUN_EVENT.RUN_CANCELLED) {
    const status = event.type === RESEARCH_RUN_EVENT.RUN_CANCELLED
      ? KNOWLEDGE_ACTION_STATUS.CANCELLED
      : KNOWLEDGE_ACTION_STATUS.FAILED
    if (event.result?.schemaVersion === KNOWLEDGE_ACTION_SCHEMA_VERSION) {
      const result = consumeKnowledgeArchiveResult(request, event.result)
      if (result.status !== status) throw new Error('Knowledge archive terminal event status does not match its result.')
      return result
    }
    const partial = event.result?.data?.targets ?? event.result?.targets ?? []
    return createKnowledgeArchiveResult(request, {
      status,
      summary: event.error?.message,
      targets: partial,
      error: {
        code: status === KNOWLEDGE_ACTION_STATUS.CANCELLED ? 'archive_cancelled' : 'archive_failed',
        message: event.error?.message || (status === KNOWLEDGE_ACTION_STATUS.CANCELLED
          ? 'Archive run was cancelled.'
          : 'Knowledge archive run failed.'),
      },
    })
  }
  return null
}

export function consumeKnowledgeArchiveReplay(requestValue, envelopes = []) {
  if (!Array.isArray(envelopes)) throw new Error('Knowledge archive replay must be an array.')
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const output = consumeKnowledgeArchiveTerminalEvent(requestValue, envelopes[index])
    if (output) {
      const cursor = Number(envelopes[index]?.cursor)
      return {
        cursor: Number.isInteger(cursor) && cursor >= 0 ? cursor : 0,
        output,
      }
    }
  }
  return null
}
