import { runResearchAgent } from './agentEngine.js'
import { isTerminalResearchRunStatus, eventStatus, RESEARCH_RUN_EVENT } from './runProtocol.js'
import { getRuntimeAdapter } from '../runtime/adapter.js'

let researchRunExecutor = runResearchAgent
let researchRunTransportResolver = () => getRuntimeAdapter().researchRuns

const EVENT_BATCH_SIZE = 16
const EVENT_BATCH_DELAY_MS = 40

function abortError() {
  return Object.assign(new Error('Generation stopped.'), { name: 'AbortError' })
}

function parseEventBlock(block) {
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function toolFailure(call, error) {
  return {
    id: String(call?.id || ''),
    name: String(call?.name || 'unknown_tool'),
    content: JSON.stringify({ error: error?.message || 'Tool execution failed.' }),
    summary: error?.message || 'Tool execution failed.',
    isError: true,
  }
}

function isTerminalEvent(event) {
  const status = eventStatus(event?.type)
  return status ? isTerminalResearchRunStatus(status) : false
}

function createEventMirror(transport, runId, onEvent) {
  let eventCounter = 0
  let pending = []
  let timer = null
  let healthy = true
  let appendChain = Promise.resolve()

  const flush = () => {
    if (!healthy || !pending.length) return appendChain
    if (timer) clearTimeout(timer)
    timer = null
    const events = pending
    pending = []
    appendChain = appendChain
      .then(() => transport.append(runId, events))
      .catch(() => {
        healthy = false
        pending = []
      })
    return appendChain
  }

  const emit = (event) => {
    const callbackResult = onEvent?.(event)
    if (!healthy) return callbackResult
    pending.push({ ...event, runId, clientEventId: `${runId}:${++eventCounter}` })
    if (pending.length >= EVENT_BATCH_SIZE || isTerminalEvent(event)) {
      void flush()
    } else if (!timer) {
      timer = setTimeout(() => void flush(), EVENT_BATCH_DELAY_MS)
    }
    return callbackResult
  }

  return {
    emit,
    async close() {
      if (timer) clearTimeout(timer)
      timer = null
      await flush()
      await appendChain
    },
  }
}

async function executeLoopbackResearchRun(options, transport, { resume = false } = {}) {
  const runId = options.runId
  if (!resume) {
    await transport.create({
      id: runId,
      sessionId: options.sessionId,
      model: options.model,
      policy: options.policy,
      evidenceCount: options.evidenceCount,
      executionOwner: 'loopback',
    })
    await transport.start(runId, {
      ...options.execution,
      policy: options.policy,
      evidenceCount: options.evidenceCount,
    })
  }
  options.signal?.addEventListener('abort', () => void transport.cancel(runId).catch(() => {}), { once: true })

  let cursor = 0
  let terminalEvent = null
  const completedToolRequests = new Set()
  const inFlightToolRequests = new Map()

  const executeDelegatedTool = (event) => {
    if (completedToolRequests.has(event.requestId) || inFlightToolRequests.has(event.requestId)) return
    const task = Promise.resolve()
      .then(() => {
        if (typeof options.executeTool !== 'function') throw new Error('No browser tool executor is available for this run.')
        return options.executeTool(event.call, { iteration: event.iteration, signal: options.signal })
      })
      .catch((error) => toolFailure(event.call, error))
      .then((result) => transport.submitToolResult(runId, event.requestId, result))
      .finally(() => inFlightToolRequests.delete(event.requestId))
    inFlightToolRequests.set(event.requestId, task)
  }

  const dispatch = (envelope, { replayCompleted = completedToolRequests } = {}) => {
    if (!envelope?.event) return
    cursor = Math.max(cursor, Number(envelope.cursor) || 0)
    const event = envelope.event
    options.onEvent?.(event)
    if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED) replayCompleted.add(event.requestId)
    if (event.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_REQUESTED && !replayCompleted.has(event.requestId)) executeDelegatedTool(event)
    if (isTerminalEvent(event)) terminalEvent = event
  }

  const replay = await transport.events(runId, 0)
  for (const envelope of replay.events || []) {
    if (envelope.event?.type === RESEARCH_RUN_EVENT.TOOL_EXECUTION_COMPLETED) completedToolRequests.add(envelope.event.requestId)
  }
  for (const envelope of replay.events || []) dispatch(envelope)

  while (!terminalEvent) {
    if (options.signal?.aborted) {
      await transport.cancel(runId).catch(() => {})
      throw abortError()
    }
    const response = await transport.follow(runId, cursor, options.signal)
    if (!response.body) throw new Error('Research run stream returned an empty response.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!terminalEvent) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) dispatch(parseEventBlock(block))
      if (done) break
    }
    dispatch(parseEventBlock(buffer))
    if (!terminalEvent) {
      const nextReplay = await transport.events(runId, cursor)
      for (const envelope of nextReplay.events || []) dispatch(envelope)
    }
  }

  await Promise.allSettled(inFlightToolRequests.values())
  if (terminalEvent.type === RESEARCH_RUN_EVENT.RUN_CANCELLED) throw abortError()
  if (terminalEvent.type === RESEARCH_RUN_EVENT.RUN_FAILED) {
    const error = new Error(terminalEvent.error?.message || 'Research run failed.')
    error.name = terminalEvent.error?.name || 'ResearchRunError'
    error.code = terminalEvent.error?.code
    error.retryable = Boolean(terminalEvent.error?.retryable)
    throw error
  }
  return {
    result: terminalEvent.result,
    toolTrace: terminalEvent.toolTrace || [],
    iterations: terminalEvent.iteration || 1,
    policy: options.policy,
  }
}

export async function executeResearchRun(options) {
  const transport = researchRunTransportResolver?.()
  if (options?.execution?.kind === 'provider' && transport?.available && transport.start && transport.follow) {
    return executeLoopbackResearchRun(options, transport)
  }
  let mirror = null
  if (transport?.available && options?.runId) {
    try {
      await transport.create({
        id: options.runId,
        sessionId: options.sessionId,
        model: options.model,
        policy: options.policy,
        evidenceCount: options.evidenceCount,
        executionOwner: 'renderer',
      })
      mirror = createEventMirror(transport, options.runId, options.onEvent)
    } catch {
      mirror = null
    }
  }
  try {
    return await researchRunExecutor({ ...options, onEvent: mirror?.emit || options.onEvent })
  } finally {
    await mirror?.close()
  }
}

export function getResearchRun(runId) {
  const transport = researchRunTransportResolver?.()
  if (!transport?.available) throw new Error('Research run reattachment is unavailable in this runtime.')
  return transport.get(runId)
}

export function readResearchRunEvents(runId, after = 0) {
  const transport = researchRunTransportResolver?.()
  if (!transport?.available) throw new Error('Research run event history is unavailable in this runtime.')
  return transport.events(runId, after)
}

export async function reattachResearchRun(runId, after = 0) {
  const [snapshot, replay] = await Promise.all([
    getResearchRun(runId),
    readResearchRunEvents(runId, after),
  ])
  return {
    run: snapshot.run,
    events: replay.events,
    oldestCursor: replay.oldestCursor,
    lastCursor: replay.lastCursor,
    truncated: replay.truncated,
  }
}

export function cancelResearchRun(runId) {
  const transport = researchRunTransportResolver?.()
  if (!transport?.available) return Promise.resolve({ cancelled: false })
  return transport.cancel(runId)
}

export function resumeResearchRun(options) {
  const transport = researchRunTransportResolver?.()
  if (!transport?.available || !transport.follow) throw new Error('Research run reattachment is unavailable in this runtime.')
  return executeLoopbackResearchRun(options, transport, { resume: true })
}

export function setResearchRunExecutorForTests(executor) {
  researchRunExecutor = typeof executor === 'function' ? executor : runResearchAgent
}

export function setResearchRunTransportResolverForTests(resolver) {
  researchRunTransportResolver = typeof resolver === 'function'
    ? resolver
    : () => getRuntimeAdapter().researchRuns
}
