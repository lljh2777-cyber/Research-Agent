import assert from 'node:assert/strict'
import test from 'node:test'

import { discoverProviderModels, inferModelCapabilities, manageBailianResponse, normalizeProviderModels } from './provider-api.mjs'

test('normalizes OpenAI-compatible model payloads and infers roles', () => {
  const models = normalizeProviderModels('openai', {
    data: [
      { id: 'gpt-frontier', owned_by: 'openai' },
      { id: 'text-embedding-latest', owned_by: 'openai' },
      { id: 'gpt-frontier', owned_by: 'duplicate' },
    ],
  })
  assert.deepEqual(models.map(({ id, kind }) => ({ id, kind })), [
    { id: 'gpt-frontier', kind: 'chat' },
    { id: 'text-embedding-latest', kind: 'embedding' },
  ])
})

test('normalizes Gemini names and supported methods', () => {
  const models = normalizeProviderModels('gemini', {
    models: [{ name: 'models/gemini-current', displayName: 'Gemini Current', supportedGenerationMethods: ['generateContent'] }],
  })
  assert.deepEqual(models[0], {
    id: 'gemini-current',
    name: 'Gemini Current',
    ownedBy: 'gemini',
    kind: 'chat',
    capabilities: {
      chat: true,
      embeddings: false,
      reasoning: false,
      vision: true,
      tools: true,
      webSearch: false,
    },
    methods: ['generateContent'],
  })
})

test('uses protocol-specific authentication without exposing Gemini keys in the URL', async () => {
  let captured
  const result = await discoverProviderModels({
    providerId: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/',
    apiKey: 'secret-key',
  }, async (url, options) => {
    captured = { url, options }
    return new Response(JSON.stringify({ models: [] }), { status: 200 })
  })
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models')
  assert.equal(captured.options.headers['x-goog-api-key'], 'secret-key')
  assert.equal(captured.url.includes('secret-key'), false)
  assert.equal(result.models.length, 0)
})

test('allows keyless OpenAI-compatible local model discovery', async () => {
  let capturedUrl
  await discoverProviderModels({ providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', apiKey: '' }, async (url) => {
    capturedUrl = url
    return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { status: 200 })
  })
  assert.equal(capturedUrl, 'http://127.0.0.1:1234/v1/models')
})

test('uses the documented DeepSeek model catalog route without adding v1', async () => {
  let capturedUrl
  await discoverProviderModels({ providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'secret' }, async (url) => {
    capturedUrl = url
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-current' }] }), { status: 200 })
  })
  assert.equal(capturedUrl, 'https://api.deepseek.com/models')
})

test('adds the documented DeepSeek endpoint matrix to discovered models', () => {
  const [model] = normalizeProviderModels('deepseek', {
    data: [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }],
  })
  assert.deepEqual(model.endpointTypes, ['openai-chat-completions', 'openai-responses', 'anthropic-messages'])
  assert.equal(model.preferredEndpointType, 'openai-chat-completions')
  assert.equal(model.capabilities.reasoning, true)
  assert.equal(model.capabilities.tools, true)
  assert.equal(model.capabilities.webSearch, true)
})

test('turns network failures into actionable provider errors', async () => {
  await assert.rejects(
    discoverProviderModels({ providerId: 'compatible', endpoint: 'http://127.0.0.1:1234/v1', apiKey: '' }, async () => {
      throw new TypeError('fetch failed')
    }),
    /Could not reach the provider endpoint: fetch failed/,
  )
})

test('uses provider metadata before conservative model-name capability inference', () => {
  const capabilities = inferModelCapabilities('openrouter', {
    id: 'vendor/plain-chat',
    supported_parameters: ['tools', 'tool_choice', 'web_search'],
    architecture: { input_modalities: ['text', 'image'] },
  }, 'chat')
  assert.deepEqual(capabilities, {
    chat: true,
    embeddings: false,
    reasoning: false,
    vision: true,
    tools: true,
    webSearch: true,
  })
  assert.equal(inferModelCapabilities('compatible', { id: 'unknown-chat-model' }, 'chat').tools, false)
})

test('profiles discovered Bailian Qwen3.5 models with official capabilities', () => {
  const [model] = normalizeProviderModels('bailian', { data: [{ id: 'qwen3.5-flash', owned_by: 'qwen' }] })
  assert.equal(model.capabilities.reasoning, true)
  assert.equal(model.capabilities.vision, true)
  assert.equal(model.capabilities.tools, true)
  assert.equal(model.capabilities.webSearch, true)
  assert.equal(model.contextWindowTokens, 1_000_000)
})

test('uses official Bailian Qwen3.5 profiles when the compatible endpoint has no model route', async () => {
  const result = await discoverProviderModels({
    providerId: 'bailian', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'secret',
  }, async () => new Response('{"message":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }))
  assert.equal(result.catalogSource, 'official-fallback')
  assert(result.models.some((model) => model.id === 'qwen3.5-plus'))
  assert(result.models.some((model) => model.id === 'qwen3.5-flash'))
})

test('retrieves and deletes stored Bailian Responses through the local adapter boundary', async () => {
  const captured = []
  const fetchImpl = async (url, options) => {
    captured.push({ url, options })
    return new Response(JSON.stringify(options.method === 'DELETE' ? { id: 'resp_abc', deleted: true } : { id: 'resp_abc', status: 'completed' }), { status: 200 })
  }
  const retrieved = await manageBailianResponse({ endpoint: 'https://workspace.example/compatible-mode/v1', apiKey: 'secret', responseId: 'resp_abc' }, fetchImpl)
  const deleted = await manageBailianResponse({ endpoint: 'https://workspace.example/compatible-mode/v1', apiKey: 'secret', responseId: 'resp_abc', operation: 'delete' }, fetchImpl)
  assert.equal(retrieved.status, 'completed')
  assert.equal(deleted.deleted, true)
  assert.equal(captured[0].options.headers.Authorization, 'Bearer secret')
  assert.equal(captured[1].options.method, 'DELETE')
})
