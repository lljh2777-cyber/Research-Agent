import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConversationContext, compactTokenCount, composeResearchUserMessage, estimateTextTokens, providerUsageSummary } from './conversationContext.js'

test('estimates mixed Chinese and English text using DeepSeek documented ratios', () => {
  assert.equal(estimateTextTokens('abcd'), 2)
  assert.equal(estimateTextTokens('中文'), 2)
  assert.equal(estimateTextTokens('ab中文'), 2)
})

test('keeps complete recent turns and preserves the prior request as a cacheable prefix', () => {
  const firstUser = composeResearchUserMessage('vault evidence one', 'first question')
  const context = buildConversationContext({
    history: [
      { role: 'user', text: 'first question', evidenceContext: 'vault evidence one' },
      { role: 'assistant', text: 'first answer', closing: 'UI-only provider metadata' },
    ],
    systemMessage: 'stable research rules',
    evidenceContext: 'vault evidence two',
    question: 'second question',
    contextWindowTokens: 1_000,
    maxOutputTokens: 100,
  })
  assert.deepEqual(context.messages.slice(0, 3), [
    { role: 'system', content: 'stable research rules' },
    { role: 'user', content: firstUser },
    { role: 'assistant', content: 'first answer' },
  ])
  assert.equal(context.retainedTurns, 1)
  assert.equal(context.omittedTurns, 0)
  assert(!context.messages.some((message) => message.content.includes('UI-only')))
})

test('drops whole old turns when the token budget is exhausted', () => {
  const context = buildConversationContext({
    history: [
      { role: 'user', text: 'old '.repeat(700), evidenceContext: 'old evidence '.repeat(700) },
      { role: 'assistant', text: 'old answer '.repeat(700) },
      { role: 'user', text: 'recent question', evidenceContext: 'recent evidence' },
      { role: 'assistant', text: 'recent answer' },
    ],
    systemMessage: 'rules',
    evidenceContext: 'current evidence',
    question: 'current question',
    contextWindowTokens: 1_200,
    maxOutputTokens: 100,
  })
  assert.equal(context.retainedTurns, 1)
  assert.equal(context.omittedTurns, 1)
  assert(context.messages.some((message) => message.content.includes('recent question')))
  assert(!context.messages.some((message) => message.content.includes('old answer')))
})

test('normalizes DeepSeek cache usage and compact token labels', () => {
  assert.deepEqual(providerUsageSummary({
    prompt_tokens: 1200,
    completion_tokens: 80,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 300,
  }), { hitTokens: 900, missTokens: 300, inputTokens: 1200, outputTokens: 80 })
  assert.equal(compactTokenCount(128_000), '128K')
  assert.equal(compactTokenCount(1_000_000), '1.0M')
})
