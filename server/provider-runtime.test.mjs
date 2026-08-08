import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProviderChatRequest, streamProviderChat } from './provider-runtime.mjs'

const messages = [
  { role: 'system', content: 'Use vault evidence.' },
  { role: 'user', content: 'Summarize this result.' },
]

const vaultTool = {
  name: 'search_vault',
  description: 'Search the connected research Vault.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
}

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
    providerId: 'anthropic', endpoint: 'https://api.anthropic.com', apiKey: 'a-key', model: 'claude-current', messages, options: { temperature: 0.4 },
  })
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(anthropic.body.system, 'Use vault evidence.')
  assert.equal(anthropic.body.temperature, 0.4)
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

test('builds all three DeepSeek request profiles with protocol-specific authentication', () => {
  const native = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-chat-completions', apiKey: 'secret', model: 'deepseek-v4-pro', messages,
    options: { reasoningEffort: 'max', thinkingEnabled: false },
  })
  assert.equal(native.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(native.headers.Authorization, 'Bearer secret')
  assert.equal('reasoning_effort' in native.body, false)
  assert.deepEqual(native.body.thinking, { type: 'disabled' })

  const responses = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://gateway.example/v1', endpointType: 'openai-responses', apiKey: 'secret', model: 'deepseek-v4-flash', messages,
    options: { thinkingEnabled: false, reasoningEffort: 'max' },
  })
  assert.equal(responses.url, 'https://gateway.example/v1/responses')
  assert.equal(responses.headers.Authorization, 'Bearer secret')
  assert.deepEqual(responses.body.input, messages)
  assert.deepEqual(responses.body.reasoning, { effort: 'none' })

  const anthropic = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', endpointType: 'anthropic-messages', apiKey: 'secret', model: 'deepseek-v4-pro', messages,
    options: { thinkingEnabled: true, reasoningEffort: 'max' },
  })
  assert.equal(anthropic.url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(anthropic.headers['x-api-key'], 'secret')
  assert.equal('Authorization' in anthropic.headers, false)
  assert.equal(anthropic.body.system, 'Use vault evidence.')
  assert.deepEqual(anthropic.body.thinking, { type: 'enabled', budget_tokens: 1024 })
  assert.deepEqual(anthropic.body.output_config, { effort: 'max' })
})

test('maps protocol-neutral tool definitions, calls, reasoning, and results to all DeepSeek interfaces', () => {
  const toolMessages = [
    ...messages,
    { role: 'assistant', content: '', reasoning: 'Need focused evidence.', toolCalls: [{ id: 'call-1', name: 'search_vault', arguments: '{"query":"CellChat"}' }] },
    { role: 'tool', toolCallId: 'call-1', name: 'search_vault', content: '{"evidence":[]}' },
  ]
  const native = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-chat-completions', apiKey: 'secret', model: 'deepseek-v4-pro', messages: toolMessages,
    options: { tools: [vaultTool], thinkingEnabled: true },
  })
  assert.equal(native.body.tools[0].function.name, 'search_vault')
  assert.equal(native.body.messages[2].reasoning_content, 'Need focused evidence.')
  assert.equal(native.body.messages[2].tool_calls[0].function.arguments, '{"query":"CellChat"}')
  assert.equal(native.body.messages[3].tool_call_id, 'call-1')

  const responses = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-responses', apiKey: 'secret', model: 'deepseek-v4-flash', messages: toolMessages,
    options: { tools: [vaultTool] },
  })
  assert.equal(responses.body.tools[0].name, 'search_vault')
  assert(responses.body.input.some((item) => item.type === 'function_call' && item.call_id === 'call-1'))
  assert(responses.body.input.some((item) => item.type === 'function_call_output' && item.call_id === 'call-1'))

  const anthropic = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', endpointType: 'anthropic-messages', apiKey: 'secret', model: 'deepseek-v4-pro', messages: toolMessages,
    options: { tools: [vaultTool], thinkingEnabled: true },
  })
  assert.equal(anthropic.body.tools[0].input_schema.type, 'object')
  assert(anthropic.body.messages[1].content.some((block) => block.type === 'thinking' && block.thinking === 'Need focused evidence.'))
  assert(anthropic.body.messages[1].content.some((block) => block.type === 'tool_use' && block.id === 'call-1'))
  assert.equal(anthropic.body.messages[2].content[0].tool_use_id, 'call-1')
})

test('assembles streamed DeepSeek tool call argument fragments', async () => {
  const events = []
  for await (const event of streamProviderChat({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'secret', model: 'deepseek-v4-pro', messages,
    options: { tools: [vaultTool] },
  }, async () => sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"Need Vault evidence."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search_vault","arguments":"{\\"query\\":\\"Cell"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Chat\\"}"}}]}}]}',
    'data: [DONE]',
  ]))) events.push(event)
  assert.equal(events.filter((event) => event.type === 'tool_call.delta').length, 2)
  assert.deepEqual(events.at(-1).toolCalls, [{ id: 'call-1', name: 'search_vault', arguments: '{"query":"CellChat"}' }])
  assert.equal(events.at(-1).reasoning, 'Need Vault evidence.')
})

test('normalizes Responses and Anthropic streamed function calls', async () => {
  const responsesEvents = []
  for await (const event of streamProviderChat({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-responses', apiKey: 'secret', model: 'deepseek-v4-flash', messages,
    options: { tools: [vaultTool] },
  }, async () => sseResponse([
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-r","name":"search_vault","arguments":""}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"query\\":\\"GRO-seq\\"}"}',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call-r","name":"search_vault","arguments":"{\\"query\\":\\"GRO-seq\\"}"}}',
  ]))) responsesEvents.push(event)
  assert.deepEqual(responsesEvents.at(-1).toolCalls, [{ id: 'call-r', name: 'search_vault', arguments: '{"query":"GRO-seq"}' }])

  const anthropicEvents = []
  for await (const event of streamProviderChat({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', endpointType: 'anthropic-messages', apiKey: 'secret', model: 'deepseek-v4-pro', messages,
    options: { tools: [vaultTool] },
  }, async () => sseResponse([
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-a","name":"search_vault","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"CellChat\\"}"}}',
  ]))) anthropicEvents.push(event)
  assert.deepEqual(anthropicEvents.at(-1).toolCalls, [{ id: 'call-a', name: 'search_vault', arguments: '{"query":"CellChat"}' }])
})

test('rejects unsupported automatic DeepSeek model and interface combinations', () => {
  assert.throws(() => buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com/anthropic', endpointType: 'anthropic-messages', apiKey: 'secret', model: 'legacy-model', messages,
  }), /not available through the selected DeepSeek request interface/)
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

test('normalizes DeepSeek Responses reasoning text events', async () => {
  const events = []
  for await (const event of streamProviderChat({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-responses', apiKey: 'secret', model: 'deepseek-v4-flash', messages,
  }, async () => sseResponse([
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"Inspect evidence"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Answer"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-ds","usage":{"total_tokens":9}}}',
  ]))) events.push(event)
  assert.equal(events.at(-1).reasoning, 'Inspect evidence')
  assert.equal(events.at(-1).text, 'Answer')
})

test('keeps custom OpenAI-compatible endpoints keyless and omits optional stream options', () => {
  const request = buildProviderChatRequest({
    providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model', messages,
  })
  assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.equal('Authorization' in request.headers, false)
  assert.equal('stream_options' in request.body, false)
})
