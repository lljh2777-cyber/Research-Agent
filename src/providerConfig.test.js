import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultProviderConfigs, DESKTOP_STORED_KEY, fetchProviderModels, getProviderSessionKey, hydrateProviderSessionKeys, loadProviderSessionKeys, normalizeProviderConfigs, providerConfigsToModels, providerCredentialEndpoints, saveProviderSessionKeys } from './providerConfig.js'

test('hydrates and persists desktop provider keys through the narrow credential bridge', async () => {
  const credentials = new Map([['deepseek', 'desktop-secret']])
  const bridge = {
    hasProviderKey: async (providerId) => credentials.has(providerId),
    setProviderKey: async (providerId, value, allowedEndpoints) => { credentials.set(providerId, value); credentials.set(`${providerId}:endpoints`, allowedEndpoints) },
    deleteProviderKey: async (providerId) => { credentials.delete(providerId) },
  }
  globalThis.window = { researchDesktop: { credentials: bridge } }
  try {
    await hydrateProviderSessionKeys(['deepseek', 'bailian'], bridge)
    assert.deepEqual(loadProviderSessionKeys(), { deepseek: DESKTOP_STORED_KEY })
    assert.equal(await getProviderSessionKey('deepseek'), '')

    await saveProviderSessionKeys({ bailian: 'new-secret' }, undefined, { bailian: ['https://dashscope.aliyuncs.com/compatible-mode/v1'] })
    assert.equal(credentials.has('deepseek'), false)
    assert.equal(credentials.get('bailian'), 'new-secret')
    assert.deepEqual(credentials.get('bailian:endpoints'), ['https://dashscope.aliyuncs.com/compatible-mode/v1'])
    assert.equal(await getProviderSessionKey('bailian'), '')

    let requestBody
    await fetchProviderModels({ providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: DESKTOP_STORED_KEY }, async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    assert.equal(requestBody.apiKey, '')
  } finally {
    delete globalThis.window
  }
})

test('derives endpoint scopes from provider configuration profiles', () => {
  const configs = createDefaultProviderConfigs()
  assert.deepEqual(providerCredentialEndpoints('openai', configs.openai), ['https://api.openai.com/v1'])
  assert(providerCredentialEndpoints('deepseek', configs.deepseek).includes('https://api.deepseek.com'))
  assert(providerCredentialEndpoints('bailian', configs.bailian).length >= 3)
  assert.deepEqual(providerCredentialEndpoints('siliconflow', configs.siliconflow), ['https://api.siliconflow.cn/v1'])
})

test('normalizes persisted provider settings without accepting stale selections', () => {
  const configs = normalizeProviderConfigs({
    openai: {
      endpoint: 'https://gateway.example/v1',
      enabled: true,
      models: [{ id: 'current-model', name: 'Current Model', kind: 'chat' }],
      selectedModelIds: ['current-model', 'removed-model'],
    },
  })
  assert.equal(configs.openai.endpoint, 'https://gateway.example/v1')
  assert.deepEqual(configs.openai.selectedModelIds, ['current-model'])
  assert.equal(configs.anthropic.endpoint, createDefaultProviderConfigs().anthropic.endpoint)
  assert.equal('apiKey' in configs.openai, false)
  assert.equal(normalizeProviderConfigs({ openai: { enabled: true, models: [], selectedModelIds: ['removed'] } }).openai.enabled, false)
})

test('exposes only enabled, selected chat models to the application model picker', () => {
  const configs = createDefaultProviderConfigs()
  configs.openai = {
    ...configs.openai,
    enabled: true,
    models: [
      { id: 'chat-current', name: 'Chat Current', kind: 'chat' },
      { id: 'embed-current', name: 'Embed Current', kind: 'embedding' },
    ],
    selectedModelIds: ['chat-current', 'embed-current'],
  }
  assert.deepEqual(providerConfigsToModels(configs), [{
    id: 'api:openai:chat-current',
    apiModelId: 'chat-current',
    name: 'Chat Current',
    provider: 'OpenAI',
    providerId: 'openai',
    authProvider: 'api',
    role: 'chat',
    detail: 'Discovered from OpenAI.',
    ready: true,
    discovered: true,
    capabilities: { chat: true },
  }])
})

test('explains when the local provider adapter route is missing', async () => {
  await assert.rejects(
    fetchProviderModels({ providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'secret' }, async () => (
      new Response('<!doctype html>', { status: 404, headers: { 'Content-Type': 'text/html' } })
    )),
    /Local provider adapter is unavailable.*npm run dev/,
  )
})

test('preserves provider errors returned by the local adapter', async () => {
  await assert.rejects(
    fetchProviderModels({ providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'secret' }, async () => (
      new Response(JSON.stringify({ error: 'Provider rejected model discovery: invalid key' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    )),
    /Provider rejected model discovery: invalid key/,
  )
})

test('migrates legacy DeepSeek settings and routes selected models through the configured interface', () => {
  const configs = normalizeProviderConfigs({
    deepseek: {
      endpoint: 'https://gateway.example/deepseek',
      enabled: true,
      models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', kind: 'chat' }],
      selectedModelIds: ['deepseek-v4-pro'],
    },
  })
  assert.equal(configs.deepseek.endpoints['openai-chat-completions'].baseUrl, 'https://gateway.example/deepseek')
  assert.equal(configs.deepseek.endpoints['openai-responses'].enabled, true)
  assert.equal(configs.deepseek.schemaVersion, 3)

  const [model] = providerConfigsToModels(configs)
  assert.equal(model.endpointType, 'openai-chat-completions')
  assert.equal(model.endpoint, 'https://gateway.example/deepseek')
  assert.deepEqual(model.endpointTypes, ['openai-chat-completions', 'anthropic-messages'])
})

test('allows an explicit DeepSeek Responses compatibility endpoint without selecting it automatically', () => {
  const configs = createDefaultProviderConfigs()
  configs.deepseek = {
    ...configs.deepseek,
    enabled: true,
    defaultEndpointType: 'openai-responses',
    endpoints: {
      ...configs.deepseek.endpoints,
      'openai-responses': { baseUrl: 'https://gateway.example/v1', enabled: true },
    },
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', kind: 'chat' }],
    selectedModelIds: ['deepseek-v4-flash'],
  }
  const [model] = providerConfigsToModels(configs)
  assert.equal(model.endpointType, 'openai-responses')
  assert.equal(model.endpoint, 'https://gateway.example/v1')
})

test('normalizes persisted DeepSeek thinking controls', () => {
  const configs = normalizeProviderConfigs({ deepseek: { thinkingMode: 'enabled', reasoningEffort: 'max', enableWebSearch: true } })
  assert.equal(configs.deepseek.thinkingMode, 'enabled')
  assert.equal(configs.deepseek.reasoningEffort, 'max')
  assert.equal(configs.deepseek.enableWebSearch, true)
  const defaults = normalizeProviderConfigs({ deepseek: { thinkingMode: 'sometimes', reasoningEffort: 'medium' } })
  assert.equal(defaults.deepseek.thinkingMode, 'auto')
  assert.equal(defaults.deepseek.reasoningEffort, 'auto')
})

test('preserves an intentional Responses disable after the DeepSeek v2 migration', () => {
  const configs = normalizeProviderConfigs({
    deepseek: {
      schemaVersion: 2,
      endpoints: {
        'openai-responses': { baseUrl: 'https://api.deepseek.com', enabled: false },
      },
    },
  })
  assert.equal(configs.deepseek.endpoints['openai-responses'].enabled, false)
})

test('enables the newly official Responses endpoint when migrating an unversioned DeepSeek config', () => {
  const configs = normalizeProviderConfigs({
    deepseek: {
      endpoints: {
        'openai-responses': { baseUrl: 'https://api.deepseek.com', enabled: false },
      },
    },
  })
  assert.equal(configs.deepseek.schemaVersion, 3)
  assert.equal(configs.deepseek.endpoints['openai-responses'].enabled, true)
})

test('normalizes Bailian interfaces and exposes selected Qwen models through native routing', () => {
  const configs = normalizeProviderConfigs({
    bailian: {
      enabled: true,
      defaultEndpointType: 'auto',
      thinkingMode: 'enabled',
      thinkingBudget: 12000,
      enableWebSearch: true,
      models: [{ id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', kind: 'chat' }],
      selectedModelIds: ['qwen3.5-plus'],
    },
  })
  assert.equal(configs.bailian.endpoints['dashscope-generation'].baseUrl, 'https://dashscope.aliyuncs.com/api/v1')
  assert.equal(configs.bailian.endpoints['openai-chat-completions'].baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(configs.bailian.endpoints['openai-responses'].enabled, true)
  assert.equal(configs.bailian.endpoints['anthropic-messages'].baseUrl, 'https://dashscope.aliyuncs.com/apps/anthropic')
  assert.equal(configs.bailian.thinkingBudget, 12000)
  assert.equal(configs.bailian.enableWebSearch, true)
  const [model] = providerConfigsToModels(configs)
  assert.equal(model.providerId, 'bailian')
  assert.equal(model.apiModelId, 'qwen3.5-plus')
  assert.deepEqual({ providerId: model.providerId, modelId: model.apiModelId }, {
    providerId: 'bailian',
    modelId: 'qwen3.5-plus',
  })
  assert.equal('apiKey' in model, false)
  assert.equal('credential' in model, false)
  assert.equal(model.endpointType, 'dashscope-generation')
  assert.equal(model.endpoint, 'https://dashscope.aliyuncs.com/api/v1')
  assert.equal(model.capabilities.vision, true)
  assert.equal(model.capabilities.tools, true)
  assert.deepEqual(model.endpointTypes, Object.values({ DASHSCOPE: 'dashscope-generation', OPENAI: 'openai-chat-completions', RESPONSES: 'openai-responses', ANTHROPIC: 'anthropic-messages' }))
})
