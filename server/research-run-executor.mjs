import { randomUUID } from 'node:crypto'

import { runResearchAgent } from '../src/research/agentEngine.js'
import { isTerminalResearchRunStatus, RESEARCH_RUN_EVENT, RESEARCH_RUN_STATUS } from '../src/research/runProtocol.js'
import { normalizeProviderError } from './provider-errors.mjs'
import { streamProviderChat } from './provider-runtime.mjs'

const MAX_ACTIVE_RUNS = 8
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_TOOL_RESULT_BYTES = 512 * 1024
const TOOL_RESULT_TIMEOUT_MS = 5 * 60 * 1000
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function abortError() {
  return Object.assign(new Error('Generation stopped.'), { name: 'AbortError' })
}

function cloneJson(value, { maxBytes = MAX_INPUT_BYTES, message = 'Research run request is too large.' } = {}) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw Object.assign(new Error('Research run payload must be JSON serializable.'), { statusCode: 400 })
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw Object.assign(new Error(message), { statusCode: 413 })
  return JSON.parse(serialized)
}

function validateProviderExecution(value) {
  if (!value || typeof value !== 'object' || value.kind !== 'provider') {
    throw Object.assign(new Error('Loopback execution requires a provider request.'), { statusCode: 400 })
  }
  if (!PROVIDER_ID_PATTERN.test(String(value.providerId || ''))) throw Object.assign(new Error('Invalid provider identifier.'), { statusCode: 400 })
  if (typeof value.endpoint !== 'string' || !value.endpoint.trim() || value.endpoint.length > 2_048) throw Object.assign(new Error('Invalid provider endpoint.'), { statusCode: 400 })
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256) throw Object.assign(new Error('Invalid provider model.'), { statusCode: 400 })
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100) throw Object.assign(new Error('A provider run requires 1 to 100 messages.'), { statusCode: 400 })
  if (!Array.isArray(value.tools) || value.tools.length > 64) throw Object.assign(new Error('A provider run accepts at most 64 tools.'), { statusCode: 400 })
  return cloneJson({
    kind: 'provider',
    providerId: value.providerId,
    endpoint: value.endpoint,
    endpointType: value.endpointType,
    apiKey: String(value.apiKey || ''),
    model: value.model,
    messages: value.messages,
    tools: value.tools,
    options: value.options || {},
    policy: value.policy || {},
    evidenceCount: value.evidenceCount || 0,
  })
}

function safeToolError(call, error) {
  return {
    id: String(call?.id || ''),
    name: String(call?.name || 'unknown_tool'),
    content: JSON.stringify({ error: error?.message || 'Tool execution failed.' }),
    summary: error?.message || 'Tool execution failed.',
    isError: true,
  }
}

export class ResearchRunExecutor {
  #manager
  #streamProvider
  #fetchImpl
  #active = new Map()

  constructor({ manager, streamProvider = streamProviderChat, fetchImpl = fetch } = {}) {
    if (!manager) throw new Error('Research Run executor requires a manager.')
    this.#manager = manager
    this.#streamProvider = streamProvider
    this.#fetchImpl = fetchImpl
  }

  get activeCount() {
    return this.#active.size
  }

  start(runId, rawInput) {
    const id = String(runId || '')
    const snapshot = this.#manager.get(id)
    if (isTerminalResearchRunStatus(snapshot.run.status)) return { started: false, terminal: true, runId: id }
    if (snapshot.run.executionOwner !== 'loopback') {
      throw Object.assign(new Error('This Research Run is not owned by the loopback executor.'), { statusCode: 409 })
    }
    if (snapshot.run.status !== RESEARCH_RUN_STATUS.CREATED || this.#active.has(id)) {
      return { started: false, runId: id, status: snapshot.run.status }
    }
    if (this.#active.size >= MAX_ACTIVE_RUNS) throw Object.assign(new Error('Too many Research Runs are active.'), { statusCode: 429 })
    const input = validateProviderExecution(rawInput)
    const active = {
      controller: new AbortController(),
      pendingTools: new Map(),
      resolvedTools: new Set(),
    }
    this.#active.set(id, active)
    queueMicrotask(() => void this.#execute(id, input, active))
    return { started: true, runId: id }
  }

  cancel(runId) {
    const active = this.#active.get(String(runId || ''))
    if (!active) return { cancelled: false }
    active.controller.abort()
    for (const pending of active.pendingTools.values()) {
      clearTimeout(pending.timer)
      pending.reject(abortError())
    }
    active.pendingTools.clear()
    return { cancelled: true }
  }

  submitToolResult(runId, requestId, rawResult) {
    const id = String(runId || '')
    const toolRequestId = String(requestId || '')
    const active = this.#active.get(id)
    if (!active) throw Object.assign(new Error('Research Run is no longer accepting tool results.'), { statusCode: 409 })
    if (active.resolvedTools.has(toolRequestId)) return { accepted: false, duplicate: true }
    const snapshot = this.#manager.get(id)
    if (isTerminalResearchRunStatus(snapshot.run.status) || snapshot.run.status !== RESEARCH_RUN_STATUS.WAITING_APPROVAL) {
      throw Object.assign(new Error('Research Run is no longer accepting tool results.'), { statusCode: 409 })
    }
    const pending = active.pendingTools.get(toolRequestId)
    if (!pending) throw Object.assign(new Error('Tool execution request was not found.'), { statusCode: 404 })
    const result = cloneJson(rawResult, { maxBytes: MAX_TOOL_RESULT_BYTES, message: 'Tool result is too large.' })
    active.pendingTools.delete(toolRequestId)
    active.resolvedTools.add(toolRequestId)
    clearTimeout(pending.timer)
    this.#manager.append(id, {
      type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED,
      runId: id,
      requestId: toolRequestId,
      toolCallId: pending.call.id,
      isError: Boolean(result?.isError),
    })
    pending.resolve(result)
    return { accepted: true, duplicate: false }
  }

  async #execute(runId, input, active) {
    const append = (event) => this.#manager.append(runId, { ...event, runId })
    const request = async (messages, runtimeContext) => {
      let completed = null
      for await (const event of this.#streamProvider({
        providerId: input.providerId,
        endpoint: input.endpoint,
        endpointType: input.endpointType,
        apiKey: input.apiKey,
        model: input.model,
        messages,
        tools: input.tools,
        options: input.options,
        signal: runtimeContext.signal,
      }, this.#fetchImpl)) {
        if (event.type === 'message.delta' && typeof event.delta === 'string') {
          append({ type: RESEARCH_RUN_EVENT.MODEL_TEXT_DELTA, iteration: runtimeContext.iteration, delta: event.delta })
        } else if (event.type === 'reasoning.delta' && typeof event.delta === 'string') {
          append({ type: RESEARCH_RUN_EVENT.MODEL_REASONING_DELTA, iteration: runtimeContext.iteration, delta: event.delta })
        } else if (event.type === 'run.completed') {
          completed = event
        } else if (event.type === 'run.cancelled') {
          throw abortError()
        } else if (event.type === 'run.failed') {
          const failure = new Error(event.error?.message || 'Provider stream failed.')
          failure.code = event.error?.code
          failure.retryable = Boolean(event.error?.retryable)
          throw failure
        } else {
          append({ type: RESEARCH_RUN_EVENT.PROVIDER_EVENT, iteration: runtimeContext.iteration, event: event.type, payload: event })
        }
      }
      if (!completed) throw new Error('Provider stream ended before completion.')
      return completed
    }
    const executeTool = (call, context) => new Promise((resolve, reject) => {
      if (active.controller.signal.aborted) return reject(abortError())
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        active.pendingTools.delete(requestId)
        reject(Object.assign(new Error('Browser tool execution timed out.'), { code: 'tool_timeout', retryable: true }))
      }, TOOL_RESULT_TIMEOUT_MS)
      active.pendingTools.set(requestId, { call, resolve, reject, timer })
      append({
        type: RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED,
        iteration: context.iteration,
        requestId,
        call,
      })
    })

    try {
      await runResearchAgent({
        runId,
        messages: input.messages,
        tools: input.tools,
        request,
        executeTool: input.tools.length ? executeTool : undefined,
        policy: input.policy,
        evidenceCount: input.evidenceCount,
        signal: active.controller.signal,
        onEvent: (event) => append(event),
      })
    } catch (error) {
      if (active.controller.signal.aborted || error?.name === 'AbortError') {
        try { this.#manager.cancel(runId) } catch { /* terminal already recorded */ }
      } else {
        const normalized = normalizeProviderError(error)
        try {
          append({ type: RESEARCH_RUN_EVENT.RUN_FAILED, error: normalized })
        } catch { /* the Agent Engine already recorded the failure */ }
      }
    } finally {
      for (const pending of active.pendingTools.values()) {
        clearTimeout(pending.timer)
        pending.reject(abortError())
      }
      active.pendingTools.clear()
      input.apiKey = ''
      this.#active.delete(runId)
    }
  }
}

export { safeToolError }
