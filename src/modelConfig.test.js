import assert from 'node:assert/strict'
import test from 'node:test'

import { chatgptCatalogToModels, getModelById } from './modelConfig.js'

test('chatgptCatalogToModels creates selectable account model records', () => {
  const models = chatgptCatalogToModels([{
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    description: 'Frontier model',
    reasoningLevels: ['medium', 'high'],
    defaultReasoningLevel: 'high',
  }])

  assert.deepEqual(models[0], {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    provider: 'ChatGPT account',
    role: 'chat',
    authProvider: 'chatgpt',
    detail: 'Frontier model',
    reasoningLevels: ['medium', 'high'],
    defaultReasoningLevel: 'high',
    ready: true,
    discovered: true,
  })
})

test('getModelById resolves a dynamically discovered model', () => {
  const registry = [{ id: 'smart-default' }, { id: 'gpt-5.6-terra' }]
  assert.equal(getModelById('gpt-5.6-terra', registry).id, 'gpt-5.6-terra')
})
