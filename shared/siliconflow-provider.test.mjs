import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifySiliconFlowModel,
  SILICONFLOW_DEFAULT_BASE_URL,
  SILICONFLOW_PROVIDER_DESCRIPTOR,
  siliconFlowModelCapabilities,
  withSiliconFlowModelProfile,
} from './siliconflow-provider.mjs'

test('publishes the SiliconFlow descriptor and default OpenAI-compatible endpoint', () => {
  assert.equal(SILICONFLOW_PROVIDER_DESCRIPTOR.id, 'siliconflow')
  assert.equal(SILICONFLOW_PROVIDER_DESCRIPTOR.defaultBaseUrl, SILICONFLOW_DEFAULT_BASE_URL)
  assert.equal(SILICONFLOW_PROVIDER_DESCRIPTOR.protocol, 'openai-chat-completions')
  assert.deepEqual(SILICONFLOW_PROVIDER_DESCRIPTOR.capabilities, {
    chat: true,
    modelDiscovery: true,
    embedding: true,
    rerank: true,
  })
})

test('classifies account-visible SiliconFlow chat, embedding, and reranker models', () => {
  assert.equal(classifySiliconFlowModel({ id: 'Qwen/Qwen3-8B' }), 'chat')
  assert.equal(classifySiliconFlowModel({ id: 'BAAI/bge-m3' }), 'embedding')
  assert.equal(classifySiliconFlowModel({ id: 'BAAI/bge-reranker-v2-m3' }), 'rerank')
  assert.equal(classifySiliconFlowModel({ id: 'custom-model', task: 'embedding' }), 'embedding')
})

test('normalizes retrieval capability flags without persisting credentials', () => {
  const model = withSiliconFlowModelProfile({ id: 'BAAI/bge-m3', name: 'BGE M3' })
  assert.equal(model.kind, 'embedding')
  assert.deepEqual(siliconFlowModelCapabilities(model), {
    chat: false,
    embedding: true,
    embeddings: true,
    rerank: false,
  })
  assert.equal(model.capabilities.embedding, true)
  assert.equal(model.capabilities.rerank, false)
  assert.equal('apiKey' in model, false)
  assert.equal('apiKey' in model.capabilities, false)
})
