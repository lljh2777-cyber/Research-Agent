import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeepSeekEndpoints,
  DEEPSEEK_ENDPOINT_TYPES,
  getDeepSeekRuntimeOptions,
  getDeepSeekModelProfile,
  normalizeDeepSeekThinking,
  resolveDeepSeekEndpoint,
} from './deepseek-provider.mjs'

test('enables only officially documented DeepSeek interfaces by default', () => {
  const endpoints = createDeepSeekEndpoints()
  assert.equal(endpoints[DEEPSEEK_ENDPOINT_TYPES.CHAT].enabled, true)
  assert.equal(endpoints[DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC].enabled, true)
  assert.equal(endpoints[DEEPSEEK_ENDPOINT_TYPES.RESPONSES].enabled, true)
})

test('describes the documented endpoint matrix conservatively', () => {
  assert.deepEqual(getDeepSeekModelProfile('deepseek-v4-flash').endpointTypes, [
    DEEPSEEK_ENDPOINT_TYPES.CHAT,
    DEEPSEEK_ENDPOINT_TYPES.RESPONSES,
    DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC,
  ])
  assert.deepEqual(getDeepSeekModelProfile('deepseek-v4-pro').endpointTypes, [
    DEEPSEEK_ENDPOINT_TYPES.CHAT,
    DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC,
  ])
  assert.deepEqual(getDeepSeekModelProfile('unknown-future-model').endpointTypes, [DEEPSEEK_ENDPOINT_TYPES.CHAT])
})

test('auto routing stays on documented interfaces while manual routing can opt into Responses', () => {
  const endpoints = createDeepSeekEndpoints()
  assert.deepEqual(resolveDeepSeekEndpoint({ endpoints, defaultEndpointType: 'auto' }, 'deepseek-v4-flash'), {
    endpointType: DEEPSEEK_ENDPOINT_TYPES.CHAT,
    endpoint: 'https://api.deepseek.com',
    automatic: true,
    fellBack: false,
  })

  assert.deepEqual(resolveDeepSeekEndpoint({ endpoints, defaultEndpointType: DEEPSEEK_ENDPOINT_TYPES.RESPONSES }, 'deepseek-v4-flash'), {
    endpointType: DEEPSEEK_ENDPOINT_TYPES.RESPONSES,
    endpoint: 'https://api.deepseek.com',
    automatic: false,
    fellBack: false,
  })

  assert.deepEqual(resolveDeepSeekEndpoint({ endpoints, defaultEndpointType: DEEPSEEK_ENDPOINT_TYPES.RESPONSES }, 'deepseek-v4-pro'), {
    endpointType: DEEPSEEK_ENDPOINT_TYPES.CHAT,
    endpoint: 'https://api.deepseek.com',
    automatic: true,
    fellBack: true,
  })
})

test('normalizes DeepSeek thinking settings and emits only explicit runtime options', () => {
  assert.deepEqual(normalizeDeepSeekThinking({ thinkingMode: 'invalid', reasoningEffort: 'medium' }), {
    thinkingMode: 'auto', reasoningEffort: 'auto',
  })
  assert.deepEqual(getDeepSeekRuntimeOptions({ thinkingMode: 'auto', reasoningEffort: 'auto' }), {})
  assert.deepEqual(getDeepSeekRuntimeOptions({ thinkingMode: 'enabled', reasoningEffort: 'max' }), {
    thinkingEnabled: true, reasoningEffort: 'max',
  })
  assert.deepEqual(getDeepSeekRuntimeOptions({ thinkingMode: 'disabled', reasoningEffort: 'high' }), {
    thinkingEnabled: false, reasoningEffort: 'high',
  })
})
