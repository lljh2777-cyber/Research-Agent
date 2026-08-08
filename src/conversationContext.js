const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096
const MESSAGE_OVERHEAD_TOKENS = 4
const CONTEXT_SAFETY_RATIO = 0.9

export function estimateTextTokens(value = '') {
  let cjkCharacters = 0
  let otherCharacters = 0
  for (const character of String(value)) {
    if (CJK_CHARACTER.test(character)) cjkCharacters += 1
    else otherCharacters += 1
  }
  return Math.max(1, Math.ceil((cjkCharacters * 0.6) + (otherCharacters * 0.3)))
}

export function estimateMessageTokens(message) {
  return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message?.content || '')
}

export function composeResearchUserMessage(evidenceContext, question) {
  return [
    String(evidenceContext || '').trim(),
    `<research_question>\n${String(question || '').trim()}\n</research_question>`,
  ].filter(Boolean).join('\n\n')
}

function completedTurns(history = []) {
  const turns = []
  let userMessage = null
  for (const message of history) {
    if (message?.role === 'user') {
      userMessage = message
      continue
    }
    if (message?.role !== 'assistant' || !userMessage) continue
    const assistantText = String(message.text || '').trim()
    const question = String(userMessage.text || '').trim()
    if (assistantText && question) {
      turns.push([
        { role: 'user', content: composeResearchUserMessage(userMessage.evidenceContext, question) },
        { role: 'assistant', content: assistantText },
      ])
    }
    userMessage = null
  }
  return turns
}

function messagesTokenCount(messages) {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}

export function buildConversationContext({
  history = [],
  systemMessage,
  evidenceContext,
  question,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const safeWindow = Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
    ? contextWindowTokens
    : DEFAULT_CONTEXT_WINDOW_TOKENS
  const outputReserve = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
    ? maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS
  const inputBudgetTokens = Math.max(1_024, Math.floor(safeWindow * CONTEXT_SAFETY_RATIO) - outputReserve)
  const fixedMessages = [
    { role: 'system', content: String(systemMessage || '').trim() },
    { role: 'user', content: composeResearchUserMessage(evidenceContext, question) },
  ]
  const turns = completedTurns(history)
  const retainedTurns = []
  let estimatedInputTokens = messagesTokenCount(fixedMessages)

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const turnTokens = messagesTokenCount(turn)
    if (estimatedInputTokens + turnTokens > inputBudgetTokens) break
    retainedTurns.unshift(turn)
    estimatedInputTokens += turnTokens
  }

  return {
    messages: [fixedMessages[0], ...retainedTurns.flat(), fixedMessages[1]],
    estimatedInputTokens,
    inputBudgetTokens,
    retainedTurns: retainedTurns.length,
    omittedTurns: turns.length - retainedTurns.length,
  }
}

export function providerUsageSummary(usage) {
  if (!usage || typeof usage !== 'object') return null
  const hitTokens = Number(usage.prompt_cache_hit_tokens ?? usage.input_tokens_details?.cached_tokens)
  const missTokens = Number(usage.prompt_cache_miss_tokens)
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens)
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens)
  return {
    hitTokens: Number.isFinite(hitTokens) ? hitTokens : null,
    missTokens: Number.isFinite(missTokens) ? missTokens : null,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
  }
}

export function compactTokenCount(value) {
  if (!Number.isFinite(value)) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`
  return String(Math.round(value))
}
