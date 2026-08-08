export const MAX_AGENT_TOOL_ROUNDS = 4
export const MAX_TOOL_CALLS_PER_ROUND = 8

export async function runProviderAgent({ messages, tools = [], request, executeTool, onToolRound }) {
  if (typeof request !== 'function') throw new Error('Provider Agent requires a request function.')
  if (typeof executeTool !== 'function') throw new Error('Provider Agent requires a tool executor.')
  let agentMessages = [...messages]
  const toolTrace = []
  let result

  for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
    result = await request(agentMessages)
    const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : []
    if (!toolCalls.length) return { result, toolTrace, messages: agentMessages }
    if (!tools.length) throw new Error('The model requested a tool, but no research tools are available for this session.')
    if (toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) throw new Error(`The model requested more than ${MAX_TOOL_CALLS_PER_ROUND} tools in one round.`)
    if (round === MAX_AGENT_TOOL_ROUNDS - 1) throw new Error(`The agent exceeded the ${MAX_AGENT_TOOL_ROUNDS}-round tool limit.`)

    const results = await Promise.all(toolCalls.map((call) => executeTool(call)))
    const traceRound = { content: result.text || '', reasoning: result.reasoning || '', toolCalls, results }
    toolTrace.push(traceRound)
    agentMessages = [
      ...agentMessages,
      { role: 'assistant', content: traceRound.content, reasoning: traceRound.reasoning, toolCalls },
      ...results.map((toolResult) => ({ role: 'tool', toolCallId: toolResult.id, name: toolResult.name, content: toolResult.content })),
    ]
    await onToolRound?.(traceRound, [...toolTrace])
  }

  throw new Error('The provider agent ended without a final response.')
}
