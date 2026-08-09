import { randomUUID } from 'node:crypto'

import {
  applyResearchRunEvent,
  canApplyResearchRunEvent,
  createResearchRunRecord,
  isTerminalResearchRunStatus,
  RESEARCH_RUN_EVENT,
  validateResearchRunEvent,
} from '../src/research/runProtocol.js'
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function requireRunId(value) {
  const runId = String(value || '').trim()
  if (!RUN_ID_PATTERN.test(runId)) throw Object.assign(new Error('Invalid research run identifier.'), { statusCode: 400 })
  return runId
}

function normalizeEvent(runId, value, maxEventBytes) {
  const validationError = validateResearchRunEvent(value)
  if (validationError) throw Object.assign(new Error(validationError), { statusCode: 400 })
  if (value.runId && value.runId !== runId) {
    throw Object.assign(new Error('Research run event ID does not match the route.'), { statusCode: 409 })
  }
  const event = jsonClone({ ...value, runId })
  if (byteLength(event) > maxEventBytes) {
    throw Object.assign(new Error('Research run event is too large.'), { statusCode: 413 })
  }
  return event
}

export class ResearchRunManager {
  #runs = new Map()
  #listeners = new Map()
  #now
  #createId
  #maxRuns
  #maxEventsPerRun
  #maxBufferedBytes
  #maxEventBytes
  #terminalTtlMs
  #activeTtlMs

  constructor({
    now = () => new Date(),
    createId = randomUUID,
    maxRuns = 64,
    maxEventsPerRun = 512,
    maxBufferedBytes = 1024 * 1024,
    maxEventBytes = 128 * 1024,
    terminalTtlMs = 30 * 60 * 1000,
    activeTtlMs = 10 * 60 * 1000,
  } = {}) {
    this.#now = now
    this.#createId = createId
    this.#maxRuns = maxRuns
    this.#maxEventsPerRun = maxEventsPerRun
    this.#maxBufferedBytes = maxBufferedBytes
    this.#maxEventBytes = maxEventBytes
    this.#terminalTtlMs = terminalTtlMs
    this.#activeTtlMs = activeTtlMs
  }

  get size() {
    this.#prune()
    return this.#runs.size
  }

  create(input = {}) {
    this.#prune()
    const id = requireRunId(input.id || this.#createId())
    const existing = this.#runs.get(id)
    if (existing) return { created: false, ...this.#snapshot(existing) }
    this.#makeRoom()
    const createdAt = this.#timestamp()
    const run = createResearchRunRecord({
      id,
      sessionId: input.sessionId,
      createdAt,
      model: input.model,
      policy: input.policy,
      evidenceCount: input.evidenceCount,
      executionOwner: input.executionOwner,
    })
    const entry = {
      run,
      events: [],
      eventIds: new Set(),
      pendingToolRequests: new Map(),
      nextCursor: 1,
      bufferedBytes: 0,
      terminalAt: null,
      lastActivityAt: Date.parse(createdAt),
    }
    this.#runs.set(id, entry)
    return { created: true, ...this.#snapshot(entry) }
  }

  get(runId) {
    this.#prune()
    const entry = this.#require(runId)
    return this.#snapshot(entry)
  }

  append(runId, values) {
    this.#prune()
    const id = requireRunId(runId)
    const entry = this.#require(id)
    const input = Array.isArray(values) ? values : [values]
    if (!input.length) return { accepted: 0, ...this.#snapshot(entry) }
    let accepted = 0
    for (const raw of input) {
      const clientEventId = String(raw?.clientEventId || '').trim()
      if (clientEventId && entry.eventIds.has(clientEventId)) continue
      if (isTerminalResearchRunStatus(entry.run.status)) continue
      const event = normalizeEvent(id, raw, this.#maxEventBytes)
      if (!canApplyResearchRunEvent(entry.run, event)) {
        throw Object.assign(new Error(`Research run event ${event.type} is invalid while status is ${entry.run.status}.`), { statusCode: 409 })
      }
      const requestId = String(event.requestId || '').trim()
      if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED && entry.pendingToolRequests.has(requestId)) {
        throw Object.assign(new Error('Tool execution requestId has already been recorded.'), { statusCode: 409 })
      }
      if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED && !entry.pendingToolRequests.has(requestId)) {
        throw Object.assign(new Error('Tool execution request was not found or is already completed.'), { statusCode: 409 })
      }
      const cursor = entry.nextCursor++
      const envelope = {
        cursor,
        recordedAt: this.#timestamp(),
        event,
      }
      const bytes = byteLength(envelope)
      entry.events.push({ ...envelope, bytes })
      entry.bufferedBytes += bytes
      if (clientEventId) entry.eventIds.add(clientEventId)
      if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED) entry.pendingToolRequests.set(requestId, event.call)
      if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED) entry.pendingToolRequests.delete(requestId)
      entry.run = applyResearchRunEvent(entry.run, event, {
        now: envelope.recordedAt,
        pendingToolRequests: entry.pendingToolRequests.size,
      })
      entry.lastActivityAt = Date.parse(envelope.recordedAt)
      if (isTerminalResearchRunStatus(entry.run.status)) {
        entry.terminalAt = Date.parse(envelope.recordedAt)
        entry.pendingToolRequests.clear()
      }
      this.#trim(entry)
      accepted += 1
      this.#notify(id, envelope)
    }
    return { accepted, ...this.#snapshot(entry) }
  }

  cancel(runId, error = { name: 'AbortError', message: 'Generation stopped.', code: 'cancelled', retryable: true }) {
    const id = requireRunId(runId)
    const entry = this.#require(id)
    if (isTerminalResearchRunStatus(entry.run.status)) return { cancelled: false, ...this.#snapshot(entry) }
    const result = this.append(id, { type: RESEARCH_RUN_EVENT.RUN_CANCELLED, runId: id, error })
    return { cancelled: result.accepted === 1, ...result }
  }

  eventsAfter(runId, after = 0) {
    this.#prune()
    const entry = this.#require(runId)
    const cursor = Math.max(0, Number(after) || 0)
    const oldestCursor = entry.events[0]?.cursor ?? entry.nextCursor
    return {
      run: jsonClone(entry.run),
      events: entry.events.filter((item) => item.cursor > cursor).map(({ bytes: _bytes, ...item }) => jsonClone(item)),
      after: cursor,
      oldestCursor,
      lastCursor: entry.nextCursor - 1,
      truncated: cursor < oldestCursor - 1,
    }
  }

  subscribe(runId, listener) {
    const id = requireRunId(runId)
    this.#require(id)
    if (typeof listener !== 'function') throw new Error('Research run subscription requires a listener.')
    const listeners = this.#listeners.get(id) || new Set()
    listeners.add(listener)
    this.#listeners.set(id, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#listeners.delete(id)
    }
  }

  #snapshot(entry) {
    return {
      run: jsonClone(entry.run),
      oldestCursor: entry.events[0]?.cursor ?? entry.nextCursor,
      lastCursor: entry.nextCursor - 1,
    }
  }

  #require(runId) {
    const id = requireRunId(runId)
    const entry = this.#runs.get(id)
    if (!entry) throw Object.assign(new Error('Research run was not found.'), { statusCode: 404 })
    return entry
  }

  #timestamp() {
    const value = this.#now()
    return (value instanceof Date ? value : new Date(value)).toISOString()
  }

  #notify(runId, envelope) {
    for (const listener of this.#listeners.get(runId) || []) listener(jsonClone(envelope))
  }

  #trim(entry) {
    while (entry.events.length > this.#maxEventsPerRun || entry.bufferedBytes > this.#maxBufferedBytes) {
      const removed = entry.events.shift()
      entry.bufferedBytes -= removed?.bytes || 0
    }
  }

  #makeRoom() {
    if (this.#runs.size < this.#maxRuns) return
    const terminal = [...this.#runs.entries()].find(([, entry]) => isTerminalResearchRunStatus(entry.run.status))
    if (terminal) {
      this.#runs.delete(terminal[0])
      this.#listeners.delete(terminal[0])
      return
    }
    throw Object.assign(new Error('Too many research runs are active.'), { statusCode: 429 })
  }

  #prune() {
    const value = this.#now()
    const now = (value instanceof Date ? value : new Date(value)).getTime()
    const terminalCutoff = now - this.#terminalTtlMs
    const activeCutoff = now - this.#activeTtlMs
    for (const [runId, entry] of this.#runs) {
      const expired = entry.terminalAt === null
        ? entry.lastActivityAt <= activeCutoff
        : entry.terminalAt <= terminalCutoff
      if (!expired) continue
      this.#runs.delete(runId)
      this.#listeners.delete(runId)
    }
  }
}
