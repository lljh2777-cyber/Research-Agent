import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBailianResponseResourceRequest,
  buildProviderChatRequest,
  buildProviderEmbeddingRequest,
  buildProviderRerankRequest,
  createProviderRequestSignal,
  executeProviderEmbedding,
  executeProviderRerank,
  normalizeProviderEmbeddingResponse,
  normalizeProviderRerankResponse,
  streamProviderChat,
} from './provider-runtime.mjs'

const messages = [
  { role: 'system', content: 'Use vault evidence.' },
  { role: 'user', content: 'Summarize this result.' },
]

test('combines caller cancellation with an independent provider timeout', async () => {
  const caller = new AbortController()
  const combined = createProviderRequestSignal(caller.signal, 10)
  assert.equal(combined.signal.aborted, false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(combined.timeoutSignal.aborted, true)
  assert.equal(combined.signal.aborted, true)

  const cancelled = new AbortController()
  const callerCombined = createProviderRequestSignal(cancelled.signal, 1_000)
  cancelled.abort()
  assert.equal(callerCombined.signal.aborted, true)
  assert.equal(callerCombined.timeoutSignal.aborted, false)
})

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

test('builds bounded SiliconFlow embedding requests without leaking credentials into the URL', () => {
  const request = buildProviderEmbeddingRequest({
    providerId: 'siliconflow',
    endpoint: 'https://api.siliconflow.cn/v1/',
    apiKey: 'secret-key',
    model: 'BAAI/bge-m3',
    inputs: ['first chunk', 'second chunk'],
    dimensions: 1024,
  })
  assert.equal(request.url, 'https://api.siliconflow.cn/v1/embeddings')
  assert.equal(request.headers.Authorization, 'Bearer secret-key')
  assert.equal(request.headers.Accept, 'application/json')
  assert.deepEqual(request.body, { model: 'BAAI/bge-m3', input: ['first chunk', 'second chunk'], dimensions: 1024 })
  assert.equal(request.url.includes('secret-key'), false)
  assert.throws(() => buildProviderEmbeddingRequest({
    providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'secret', model: 'BAAI/bge-m3', inputs: Array(129).fill('chunk'),
  }), /1 to 128 inputs/)
})

test('builds bounded SiliconFlow rerank requests with candidate IDs kept outside the upstream body', () => {
  const request = buildProviderRerankRequest({
    providerId: 'siliconflow',
    endpoint: 'https://api.siliconflow.cn/v1',
    apiKey: 'secret-key',
    model: 'BAAI/bge-reranker-v2-m3',
    query: 'ligand receptor',
    candidates: [{ chunkId: 'chunk-1', excerpt: 'first evidence' }, { chunkId: 'chunk-2', excerpt: 'second evidence' }],
    topK: 1,
  })
  assert.equal(request.url, 'https://api.siliconflow.cn/v1/rerank')
  assert.deepEqual(request.body, {
    model: 'BAAI/bge-reranker-v2-m3',
    query: 'ligand receptor',
    documents: ['first evidence', 'second evidence'],
    top_n: 1,
    return_documents: false,
  })
  assert.deepEqual(request.candidates, [{ candidateId: 'chunk-1', text: 'first evidence' }, { candidateId: 'chunk-2', text: 'second evidence' }])
  assert.equal(JSON.stringify(request.body).includes('chunk-1'), false)
  assert.throws(() => buildProviderRerankRequest({
    providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'secret', model: 'reranker', query: 'q', candidates: Array(51).fill({ chunkId: 'x', excerpt: 'candidate' }),
  }), /1 to 50 candidates/)
})

test('validates embedding dimensions and rerank scores while returning safe provenance', () => {
  const embeddings = normalizeProviderEmbeddingResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }] }, {
    providerId: 'siliconflow', modelId: 'BAAI/bge-m3', requestedDimensions: 2,
  })
  assert.deepEqual(embeddings, {
    ok: true,
    providerId: 'siliconflow',
    modelId: 'BAAI/bge-m3',
    dimensions: 2,
    embeddings: [{ index: 0, vector: [0.1, 0.2] }],
    provenance: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3' },
  })
  const rerank = normalizeProviderRerankResponse({ results: [{ index: 1, relevance_score: 0.91 }, { index: 0, relevance_score: 0.4 }] }, {
    providerId: 'siliconflow', modelId: 'reranker', candidates: [{ candidateId: 'chunk-1' }, { candidateId: 'chunk-2' }], topK: 2,
  })
  assert.deepEqual(rerank.results, [
    { candidateId: 'chunk-2', score: 0.91, rank: 0 },
    { candidateId: 'chunk-1', score: 0.4, rank: 1 },
  ])
  assert.deepEqual(rerank.provenance, { providerId: 'siliconflow', modelId: 'reranker' })
  assert.throws(() => normalizeProviderEmbeddingResponse({ data: [{ embedding: [0.1] }, { embedding: [0.2, 0.3] }] }), /inconsistent dimensions/)
  assert.throws(() => normalizeProviderRerankResponse({ results: [{ index: 0, relevance_score: 1.5 }] }, {
    candidates: [{ candidateId: 'chunk-1' }], topK: 1,
  }), /invalid rerank indexes or scores/)
})

test('executes embedding and rerank through abortable JSON provider requests', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return new Response(url.endsWith('/embeddings')
      ? JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] })
      : JSON.stringify({ results: [{ index: 0, relevance_score: 0.8 }] }), { status: 200 })
  }
  const controller = new AbortController()
  const embedding = await executeProviderEmbedding({ providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'secret', model: 'embed', input: 'text', dimensions: 2, signal: controller.signal }, fetchImpl)
  const rerank = await executeProviderRerank({ providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'secret', model: 'rerank', query: 'q', candidates: [{ chunkId: 'chunk-1', excerpt: 'text' }], signal: controller.signal }, fetchImpl)
  assert.equal(embedding.dimensions, 2)
  assert.deepEqual(rerank.scores, [{ chunkId: 'chunk-1', score: 0.8 }])
  assert.equal(calls[0].options.signal instanceof AbortSignal, true)
  assert.equal(calls[0].options.signal.aborted, false)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret')
  assert.equal(calls[0].url.endsWith('/embeddings'), true)
  assert.equal(calls[1].url.endsWith('/rerank'), true)
})

test('builds SiliconFlow chat requests through the shared Runtime Provider boundary', () => {
  const request = buildProviderChatRequest({
    providerId: 'siliconflow', endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'secret', model: 'Qwen/Qwen3-8B', messages,
  })
  assert.equal(request.url, 'https://api.siliconflow.cn/v1/chat/completions')
  assert.equal(request.protocol, 'openai-chat-completions')
  assert.equal(request.headers.Authorization, 'Bearer secret')
  assert.deepEqual(request.body.messages, messages)
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

test('enables DeepSeek hosted web search and normalizes its Responses lifecycle', async () => {
  const request = buildProviderChatRequest({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-responses', apiKey: 'secret', model: 'deepseek-v4-flash', messages,
    options: { enableWebSearch: true },
  })
  assert(request.body.tools.some((tool) => tool.type === 'web_search'))

  const events = []
  for await (const event of streamProviderChat({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', endpointType: 'openai-responses', apiKey: 'secret', model: 'deepseek-v4-flash', messages,
    options: { enableWebSearch: true },
  }, async () => sseResponse([
    'event: response.web_search_call.in_progress\ndata: {"type":"response.web_search_call.in_progress","item_id":"ws_1"}',
    'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching","item_id":"ws_1","query":"latest spatial transcriptomics"}',
    'event: response.web_search_call.completed\ndata: {"type":"response.web_search_call.completed","item_id":"ws_1"}',
    'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.org/paper","title":"Paper"}}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Current evidence"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-search","usage":{"total_tokens":12}}}',
  ]))) events.push(event)
  assert.deepEqual(events.filter((event) => event.type === 'web_search.status').map((event) => event.status), ['in_progress', 'searching', 'completed'])
  assert.equal(events.at(-1).webSearchEvents.length, 3)
  assert.equal(events.at(-1).citations[0].url, 'https://example.org/paper')
})

test('keeps custom OpenAI-compatible endpoints keyless and omits optional stream options', () => {
  const request = buildProviderChatRequest({
    providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model', messages,
  })
  assert.equal(request.url, 'http://127.0.0.1:1234/v1/chat/completions')
  assert.equal('Authorization' in request.headers, false)
  assert.equal('stream_options' in request.body, false)
})

test('builds Bailian DashScope native and OpenAI-compatible requests', () => {
  const native = buildProviderChatRequest({
    providerId: 'bailian', endpoint: 'https://dashscope.aliyuncs.com/api/v1', endpointType: 'dashscope-generation', apiKey: 'sk-bailian', model: 'qwen3.5-plus', messages,
    options: { tools: [vaultTool], thinkingEnabled: true, thinkingBudget: 12000, enableWebSearch: true, maxOutputTokens: 4096 },
  })
  assert.equal(native.url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(native.headers.Authorization, 'Bearer sk-bailian')
  assert.equal(native.headers['X-DashScope-SSE'], 'enable')
  assert.deepEqual(native.body.input.messages[1].content, [{ text: 'Summarize this result.' }])
  assert.equal(native.body.parameters.result_format, 'message')
  assert.equal(native.body.parameters.incremental_output, true)
  assert.equal(native.body.parameters.enable_thinking, true)
  assert.equal(native.body.parameters.thinking_budget, 12000)
  assert.equal(native.body.parameters.enable_search, true)
  assert.equal(native.body.parameters.tools[0].function.name, 'search_vault')

  const compatible = buildProviderChatRequest({
    providerId: 'bailian', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', endpointType: 'openai-chat-completions', apiKey: 'sk-bailian', model: 'qwen3.5-flash', messages,
    options: { thinkingEnabled: false },
  })
  assert.equal(compatible.url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
  assert.equal(compatible.body.enable_thinking, false)
})

test('builds Bailian Responses, Anthropic, text-native, and response-resource requests', () => {
  const responses = buildProviderChatRequest({
    providerId: 'bailian', endpoint: 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', endpointType: 'openai-responses', apiKey: 'sk-bailian', model: 'qwen3.8-max', messages,
    options: { tools: [vaultTool], thinkingEnabled: true, reasoningEffort: 'high', enableWebSearch: true, enableSessionCache: true, storeResponses: true },
  })
  assert.equal(responses.url, 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses')
  assert.equal(responses.headers['x-dashscope-session-cache'], 'enable')
  assert.deepEqual(responses.body.reasoning, { effort: 'high' })
  assert.equal(responses.body.store, true)
  assert(responses.body.tools.some((tool) => tool.type === 'web_search'))
  assert(responses.body.tools.some((tool) => tool.type === 'function' && tool.name === 'search_vault'))

  const anthropic = buildProviderChatRequest({
    providerId: 'bailian', endpoint: 'https://ws.cn-beijing.maas.aliyuncs.com/apps/anthropic', endpointType: 'anthropic-messages', apiKey: 'sk-bailian', model: 'qwen3.8-max', messages,
    options: { thinkingEnabled: true, thinkingBudget: 2048 },
  })
  assert.equal(anthropic.url, 'https://ws.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages')
  assert.equal(anthropic.headers['x-api-key'], 'sk-bailian')
  assert.equal('Authorization' in anthropic.headers, false)
  assert.deepEqual(anthropic.body.thinking, { type: 'enabled', budget_tokens: 2048 })

  const nativeText = buildProviderChatRequest({
    providerId: 'bailian', endpoint: 'https://dashscope.aliyuncs.com/api/v1', endpointType: 'dashscope-generation', apiKey: 'sk-bailian', model: 'qwen-plus', messages,
  })
  assert.equal(nativeText.url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation')

  const resource = buildBailianResponseResourceRequest({ endpoint: 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-bailian', responseId: 'resp_abc-123', operation: 'input_items', limit: 500, order: 'asc' })
  assert.equal(resource.method, 'GET')
  assert.equal(resource.url, 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses/resp_abc-123/input_items?limit=100&order=asc')
})

test('normalizes Bailian DashScope reasoning, content, tools, and usage', async () => {
  const events = []
  for await (const event of streamProviderChat({
    providerId: 'bailian', endpoint: 'https://dashscope.aliyuncs.com/api/v1', endpointType: 'dashscope-generation', apiKey: 'secret', model: 'qwen3.5-plus', messages,
    options: { tools: [vaultTool] },
  }, async () => sseResponse([
    'data: {"request_id":"req-1","output":{"choices":[{"message":{"role":"assistant","content":[],"reasoning_content":"Need evidence."}}]}}',
    'data: {"request_id":"req-1","output":{"choices":[{"message":{"role":"assistant","content":[],"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search_vault","arguments":"{\\"query\\":\\"Qwen\\"}"}}]}}]},"usage":{"total_tokens":16}}',
  ]))) events.push(event)
  assert.equal(events.at(-1).reasoning, 'Need evidence.')
  assert.deepEqual(events.at(-1).toolCalls, [{ id: 'call-1', name: 'search_vault', arguments: '{"query":"Qwen"}' }])
  assert.deepEqual(events.at(-1).usage, { total_tokens: 16 })
})
