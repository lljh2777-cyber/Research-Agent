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
