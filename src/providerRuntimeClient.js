import { getRuntimeAdapter } from './runtime/adapter.js'

function parseEventBlock(block) {
  const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
  const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  if (!data) return null
  try {
    return { event, payload: JSON.parse(data) }
  } catch {
    return null
  }
}

export class ProviderRuntimeError extends Error {
  constructor(error = {}) {
    super(typeof error === 'string' ? error : error.message || 'Provider stream failed.')
    this.name = 'ProviderRuntimeError'
    this.code = typeof error === 'object' ? error.code : 'provider_error'
    this.retryable = typeof error === 'object' ? Boolean(error.retryable) : false
    this.statusCode = typeof error === 'object' ? error.statusCode ?? null : null
  }
}

function abortError() {
  return Object.assign(new Error('Generation stopped.'), { name: 'AbortError' })
}

function dispatchEvent(parsed, handlers, state) {
  if (!parsed) return
  handlers.onEvent?.(parsed.event, parsed.payload)
  if (parsed.event === 'message.delta' && typeof parsed.payload.delta === 'string') handlers.onDelta?.(parsed.payload.delta)
  if (parsed.event === 'reasoning.delta' && typeof parsed.payload.delta === 'string') handlers.onReasoningDelta?.(parsed.payload.delta)
  if (parsed.event === 'tool_call.delta') handlers.onToolCallDelta?.(parsed.payload)
  if (parsed.event === 'run.completed') state.completed = parsed.payload
  if (parsed.event === 'run.cancelled') throw abortError()
  if (parsed.event === 'run.failed') throw new ProviderRuntimeError(parsed.payload.error)
}

async function streamDesktopProviderResponse(input, handlers) {
  const bridge = getRuntimeAdapter().providerRuns
  let transportRunId = ''
  let settled = false
  const pendingPayloads = []
  let resolveRun
  let rejectRun
  const completion = new Promise((resolve, reject) => {
    resolveRun = resolve
    rejectRun = reject
  })
  const cleanupEvent = bridge.onEvent((payload) => {
    if (!payload || settled) return
    if (!transportRunId) {
      if (pendingPayloads.length < 32) pendingPayloads.push(payload)
      return
    }
    if (payload.runId !== transportRunId) return
    try {
      const state = {}
      dispatchEvent({ event: payload.event?.type, payload: payload.event }, handlers, state)
      if (state.completed) {
        settled = true
        resolveRun(state.completed)
      }
    } catch (error) {
      settled = true
      rejectRun(error)
    }
  })
  const handleAbort = () => {
    if (transportRunId) void bridge.cancel(transportRunId)
  }
  input.signal?.addEventListener('abort', handleAbort, { once: true })
  try {
    if (input.signal?.aborted) throw abortError()
    const started = await bridge.start({
      providerId: input.providerId,
      endpoint: input.endpoint,
      endpointType: input.endpointType,
      model: input.model,
      messages: input.messages,
      options: { ...input.options, tools: input.tools },
    })
    transportRunId = started?.runId || ''
    if (!transportRunId) throw new Error('Desktop provider runtime did not return a run identifier.')
    for (const payload of pendingPayloads.splice(0)) {
      if (payload.runId !== transportRunId || settled) continue
      try {
        const state = {}
        dispatchEvent({ event: payload.event?.type, payload: payload.event }, handlers, state)
        if (state.completed) {
          settled = true
          resolveRun(state.completed)
        }
      } catch (error) {
        settled = true
        rejectRun(error)
      }
    }
    if (input.signal?.aborted) {
      await bridge.cancel(transportRunId)
      throw abortError()
    }
    return await completion
  } finally {
    settled = true
    cleanupEvent()
    input.signal?.removeEventListener('abort', handleAbort)
  }
}

export async function streamProviderResponse({ providerId, endpoint, endpointType, apiKey, model, messages, tools, options, signal, onDelta, onReasoningDelta, onToolCallDelta, onEvent }) {
  const handlers = { onDelta, onReasoningDelta, onToolCallDelta, onEvent }
  const runtime = getRuntimeAdapter()
  if (runtime.providerRuns.available) {
    return streamDesktopProviderResponse({ providerId, endpoint, endpointType, model, messages, tools, options, signal }, handlers)
  }
  const response = await runtime.providers.streamResponse({
    providerId,
    endpoint,
    endpointType,
    apiKey,
    model,
    messages,
    options: { ...options, tools },
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.error || `Provider request failed (${response.status}).`)
  }
  if (!response.body) throw new Error('The local provider runtime returned an empty stream.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const state = {}
  const handle = (parsed) => dispatchEvent(parsed, handlers, state)
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) handle(parseEventBlock(block))
    if (done) break
  }
  handle(parseEventBlock(buffer))
  if (!state.completed) throw new Error('Provider stream ended before completion.')
  return state.completed
}
