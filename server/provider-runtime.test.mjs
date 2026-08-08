import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProviderChatRequest, streamProviderChat } from './provider-runtime.mjs'

const messages = [
  { role: 'system', content: 'Use vault evidence.' },
  { role: 'user', content: 'Summarize this result.' },
]

function sseResponse(blocks) {
  return new Response(blocks.join('\n\n') + '\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

test('builds OpenAI Responses requests without translating them to chat completions', () => {
  const request = buildProviderChatRequest({
    providerId: 'openai', endpoint: 'https://api.openai.com/v1/', apiKey: 'secret', model: 'gpt-current', messages,
  })
  assert.equal(request.url, 'https://api.openai.com/v1/responses')
  assert.equal(request.protocol, 'openai-responses')
  assert.equal(request.headers.Authorization, 'Bearer secret')
  assert.deepEqual(request.body.input, messages)
})

test('builds provider-native Anthropic and Gemini requests', () => {
  const anthropic = buildProviderChatRequest({
    providerId: 'anthropic', endpoint: 'https://api.anthropic.com', apiKey: 'a-key', model: 'claude-current', messages,
  })
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropic.body.system, 'Use vault evidence.')
  assert.deepEqual(anthropic.body.messages, [{ role: 'user', content: 'Summarize this result.' }])

  const gemini = buildProviderChatRequest({
    providerId: 'gemini', endpoint: 'https://generativelanguage.googleapis.com', apiKey: 'g-key', model: 'gemini/current', messages,
  })
  assert.equal(gemini.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini%2Fcurrent:streamGenerateContent?alt=sse')
  assert.equal(gemini.headers['x-goog-api-key'], 'g-key')
  assert.equal(gemini.url.includes('g-key'), false)
})

test('normalizes OpenAI-compatible streaming into runtime lifecycle events', async () => {
  let captured
  const events = []
  for await (const event of streamProviderChat({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'secret', model: 'deepseek-chat', messages,
  }, async (url, options) => {
    captured = { url, body: JSON.parse(options.body) }
    return sseResponse([
      'data: {"id":"response-1","choices":[{"delta":{"content":"Vault "}}]}',
      'data: {"id":"response-1","choices":[{"delta":{"content":"answer"}}],"usage":{"total_tokens":12}}',
      'data: [DONE]',
    ])
  })) events.push(event)

  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(captured.body.stream, true)
  assert.deepEqual(events.map((event) => event.type), ['run.started', 'message.delta', 'message.delta', 'usage.updated', 'run.completed'])
  assert.equal(events.at(-1).text, 'Vault answer')
  assert.deepEqual(events.at(-1).usage, { total_tokens: 12 })
})

test('normalizes OpenAI Responses typed events', async () => {
  const events = []
  for await (const event of streamProviderChat({
    providerId: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: 'secret', model: 'gpt-current', messages,
  }, async () => sseResponse([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Evidence"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","usage":{"total_tokens":8}}}',
  ]))) events.push(event)
  assert.equal(events.at(-1).text, 'Evidence')
  assert.equal(events.at(-1).responseId, 'resp-1')
})

test('keeps custom OpenAI-compatible endpoints keyless and omits optional stream options', () => {
  const request = buildProviderChatRequest({
    providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model', messages,
  })
  assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.equal('Authorization' in request.headers, false)
  assert.equal('stream_options' in request.body, false)
})

