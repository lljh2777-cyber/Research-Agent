import assert from 'node:assert/strict'
import test from 'node:test'

import { discoverProviderModels, inferModelCapabilities, normalizeProviderModels } from './provider-api.mjs'

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
