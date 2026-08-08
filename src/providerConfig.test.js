import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultProviderConfigs, fetchProviderModels, normalizeProviderConfigs, providerConfigsToModels } from './providerConfig.js'

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
  assert.equal(configs.deepseek.schemaVersion, 2)

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
  const configs = normalizeProviderConfigs({ deepseek: { thinkingMode: 'enabled', reasoningEffort: 'max' } })
  assert.equal(configs.deepseek.thinkingMode, 'enabled')
  assert.equal(configs.deepseek.reasoningEffort, 'max')
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
  assert.equal(configs.deepseek.schemaVersion, 2)
  assert.equal(configs.deepseek.endpoints['openai-responses'].enabled, true)
})
