import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeepSeekEndpoints,
  DEEPSEEK_ENDPOINT_TYPES,
  getDeepSeekModelProfile,
  resolveDeepSeekEndpoint,
} from './deepseek-provider.mjs'

test('enables only officially documented DeepSeek interfaces by default', () => {
  const endpoints = createDeepSeekEndpoints()
  assert.equal(endpoints[DEEPSEEK_ENDPOINT_TYPES.CHAT].enabled, true)
  assert.equal(endpoints[DEEPSEEK_ENDPOINT_TYPES.ANTHROPIC].enabled, true)
  assert.equal(endpoints[DEEPSEEK_ENDPOINT_TYPES.RESPONSES].enabled, false)
})

test('describes the documented endpoint matrix conservatively', () => {
  assert.deepEqual(getDeepSeekModelProfile('deepseek-v4-flash').endpointTypes, [
    DEEPSEEK_ENDPOINT_TYPES.CHAT,
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

  endpoints[DEEPSEEK_ENDPOINT_TYPES.RESPONSES].enabled = true
  assert.deepEqual(resolveDeepSeekEndpoint({ endpoints, defaultEndpointType: DEEPSEEK_ENDPOINT_TYPES.RESPONSES }, 'deepseek-v4-flash'), {
    endpointType: DEEPSEEK_ENDPOINT_TYPES.RESPONSES,
    endpoint: 'https://api.deepseek.com',
    automatic: false,
    fellBack: false,
  })
})
