import {
  DEFAULT_RESEARCH_RUN_POLICY,
  RESEARCH_RUN_EVENT,
  normalizeResearchRunPolicy,
} from './runProtocol.js'

export const MAX_AGENT_TOOL_ROUNDS = DEFAULT_RESEARCH_RUN_POLICY.maxToolRounds
export const MAX_TOOL_CALLS_PER_ROUND = DEFAULT_RESEARCH_RUN_POLICY.maxToolCallsPerRound

function abortError() {
  return Object.assign(new Error('Generation stopped.'), { name: 'AbortError' })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

function safeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || 'Research run failed.',
    code: error?.code || null,
    retryable: Boolean(error?.retryable),
  }
}

export class InsufficientEvidenceError extends Error {
  constructor() {
    super('This Agent requires evidence, but no evidence is available for the current research question.')
    this.name = 'InsufficientEvidenceError'
    this.code = 'insufficient_evidence'
  }
}

export async function runResearchAgent({
  runId = '',
  messages,
  tools = [],
  request,
  executeTool,
  policy,
  evidenceCount = 0,
  signal,
  onEvent,
  onToolRound,
}) {
  if (typeof request !== 'function') throw new Error('Research Agent requires a request function.')
  const resolvedPolicy = normalizeResearchRunPolicy(policy)
  const emit = async (type, payload = {}) => onEvent?.({ type, runId, ...payload })
  let agentMessages = Array.isArray(messages) ? [...messages] : []
  const toolTrace = []

  try {
    throwIfAborted(signal)
    if (resolvedPolicy.requireEvidence && resolvedPolicy.stopOnInsufficientEvidence && evidenceCount < 1) {
      throw new InsufficientEvidenceError()
    }
    await emit(RESEARCH_RUN_EVENT.RUN_STARTED, { policy: resolvedPolicy, evidenceCount })

    for (let round = 0; round < resolvedPolicy.maxToolRounds; round += 1) {
      throwIfAborted(signal)
      await emit(RESEARCH_RUN_EVENT.MODEL_STARTED, { iteration: round + 1 })
      const result = await request(agentMessages, { iteration: round + 1, signal, onEvent: emit })
      throwIfAborted(signal)
      const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : []

      if (!toolCalls.length) {
        const output = { result, toolTrace, messages: agentMessages, iterations: round + 1, policy: resolvedPolicy }
        await emit(RESEARCH_RUN_EVENT.RUN_COMPLETED, { iteration: round + 1, result, toolTrace: [...toolTrace] })
        return output
      }
      if (!tools.length || typeof executeTool !== 'function') {
        throw new Error('The model requested a tool, but no research tools are available for this run.')
      }
      if (toolCalls.length > resolvedPolicy.maxToolCallsPerRound) {
        throw new Error(`The model requested more than ${resolvedPolicy.maxToolCallsPerRound} tools in one round.`)
      }
      if (round === resolvedPolicy.maxToolRounds - 1) {
        throw new Error(`The agent exceeded the ${resolvedPolicy.maxToolRounds}-round tool limit.`)
      }

      await emit(RESEARCH_RUN_EVENT.TOOL_ROUND_STARTED, { iteration: round + 1, toolCalls })
      const results = await Promise.all(toolCalls.map(async (call) => {
        throwIfAborted(signal)
        return executeTool(call, { iteration: round + 1, signal })
      }))
      throwIfAborted(signal)
      const traceRound = { content: result.text || '', reasoning: result.reasoning || '', toolCalls, results }
      toolTrace.push(traceRound)
      agentMessages = [
        ...agentMessages,
        { role: 'assistant', content: traceRound.content, reasoning: traceRound.reasoning, toolCalls },
        ...results.map((toolResult) => ({ role: 'tool', toolCallId: toolResult.id, name: toolResult.name, content: toolResult.content })),
      ]
      await emit(RESEARCH_RUN_EVENT.TOOL_ROUND_COMPLETED, { iteration: round + 1, round: traceRound, toolTrace: [...toolTrace] })
      await onToolRound?.(traceRound, [...toolTrace])
    }
  } catch (error) {
    const cancelled = error?.name === 'AbortError' || signal?.aborted
    await emit(cancelled ? RESEARCH_RUN_EVENT.RUN_CANCELLED : RESEARCH_RUN_EVENT.RUN_FAILED, {
      iteration: toolTrace.length + 1,
      error: safeError(cancelled ? abortError() : error),
      toolTrace: [...toolTrace],
    })
    throw cancelled ? abortError() : error
  }

  throw new Error('The research agent ended without a final response.')
}
