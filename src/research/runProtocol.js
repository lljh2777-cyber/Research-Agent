export const RESEARCH_RUN_SCHEMA_VERSION = 1

export const RESEARCH_RUN_STATUS = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting-approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

export const RESEARCH_RUN_EVENT = Object.freeze({
  RUN_STARTED: 'run.started',
  MODEL_STARTED: 'model.started',
  MODEL_TEXT_DELTA: 'model.text.delta',
  MODEL_REASONING_DELTA: 'model.reasoning.delta',
  PROVIDER_EVENT: 'provider.event',
  TOOL_ROUND_STARTED: 'tool.round.started',
  TOOL_EXECUTION_REQUESTED: 'tool.execution.requested',
  TOOL_EXECUTION_COMPLETED: 'tool.execution.completed',
  TOOL_ROUND_COMPLETED: 'tool.round.completed',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_CANCELLED: 'run.cancelled',
})

export const DEFAULT_RESEARCH_RUN_POLICY = Object.freeze({
  maxToolRounds: 6,
  maxToolCallsPerRound: 8,
  requireEvidence: false,
  stopOnInsufficientEvidence: false,
})

const TERMINAL_STATUSES = new Set([
  RESEARCH_RUN_STATUS.COMPLETED,
  RESEARCH_RUN_STATUS.FAILED,
  RESEARCH_RUN_STATUS.CANCELLED,
])

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

export function normalizeResearchRunPolicy(value = {}) {
  return {
    maxToolRounds: boundedInteger(value.maxToolRounds, DEFAULT_RESEARCH_RUN_POLICY.maxToolRounds, 1, 32),
    maxToolCallsPerRound: boundedInteger(value.maxToolCallsPerRound, DEFAULT_RESEARCH_RUN_POLICY.maxToolCallsPerRound, 1, 16),
    requireEvidence: Boolean(value.requireEvidence),
    stopOnInsufficientEvidence: Boolean(value.stopOnInsufficientEvidence),
  }
}

export function isTerminalResearchRunStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

export function createResearchRunRecord({
  id,
  sessionId = '',
  createdAt = new Date().toISOString(),
  model = null,
  policy,
  evidenceCount = 0,
  executionOwner = 'renderer',
} = {}) {
  const runId = String(id || '').trim()
  if (!runId) throw new Error('Research run requires an ID.')
  return {
    schemaVersion: RESEARCH_RUN_SCHEMA_VERSION,
    id: runId,
    sessionId: String(sessionId || ''),
    status: RESEARCH_RUN_STATUS.CREATED,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    iteration: 0,
    model: model ? structuredClone(model) : null,
    policy: normalizeResearchRunPolicy(policy),
    evidenceCount: Math.max(0, Number(evidenceCount) || 0),
    executionOwner: executionOwner === 'loopback' ? 'loopback' : 'renderer',
    error: null,
  }
}

export function eventStatus(type) {
  if (type === RESEARCH_RUN_EVENT.RUN_STARTED) return RESEARCH_RUN_STATUS.RUNNING
  if (type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED) return RESEARCH_RUN_STATUS.WAITING_APPROVAL
  if (type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED) return RESEARCH_RUN_STATUS.RUNNING
  if (type === RESEARCH_RUN_EVENT.RUN_COMPLETED) return RESEARCH_RUN_STATUS.COMPLETED
  if (type === RESEARCH_RUN_EVENT.RUN_FAILED) return RESEARCH_RUN_STATUS.FAILED
  if (type === RESEARCH_RUN_EVENT.RUN_CANCELLED) return RESEARCH_RUN_STATUS.CANCELLED
  return null
}

export function applyResearchRunEvent(run, event, { now = new Date().toISOString() } = {}) {
  if (!run || !event || (event.runId && event.runId !== run.id)) return run
  const status = eventStatus(event.type)
  const terminal = status && isTerminalResearchRunStatus(status)
  return {
    ...run,
    ...(status ? { status } : {}),
    updatedAt: now,
    completedAt: terminal ? now : run.completedAt,
    iteration: Math.max(run.iteration || 0, Number(event.iteration) || 0),
    error: event.type === RESEARCH_RUN_EVENT.RUN_FAILED
      ? event.error || { message: 'Research run failed.' }
      : run.error,
  }
}
