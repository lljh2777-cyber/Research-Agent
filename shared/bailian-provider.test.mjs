import assert from 'node:assert/strict'
import test from 'node:test'

import { BAILIAN_ENDPOINT_TYPES, getBailianModelProfile, getBailianRegionalEndpoints, getBailianRuntimeOptions, resolveBailianEndpoint } from './bailian-provider.mjs'

test('profiles Qwen3.5 Plus and Flash with official capabilities and limits', () => {
  const profile = getBailianModelProfile('qwen3.5-plus')
  assert.equal(profile.contextWindowTokens, 1_000_000)
  assert.equal(profile.maxOutputTokens, 65_536)
  assert.equal(profile.capabilities.vision, true)
  assert.equal(profile.capabilities.tools, true)
  assert.equal(profile.capabilities.webSearch, true)
  assert.deepEqual(profile.endpointTypes, Object.values(BAILIAN_ENDPOINT_TYPES))
  assert.equal(getBailianModelProfile('qwen-plus').nativeRoute, 'text-generation')
})

test('builds documented regional workspace endpoints for every Bailian interface', () => {
  const endpoints = getBailianRegionalEndpoints('cn-beijing', 'ws-123')
  assert.equal(endpoints[BAILIAN_ENDPOINT_TYPES.DASHSCOPE], 'https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1')
  assert.equal(endpoints[BAILIAN_ENDPOINT_TYPES.OPENAI], 'https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.equal(endpoints[BAILIAN_ENDPOINT_TYPES.RESPONSES], 'https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
  assert.equal(endpoints[BAILIAN_ENDPOINT_TYPES.ANTHROPIC], 'https://ws-123.cn-beijing.maas.aliyuncs.com/apps/anthropic')
  assert.equal(getBailianRegionalEndpoints('us-east-1', '')[BAILIAN_ENDPOINT_TYPES.OPENAI], 'https://dashscope-us.aliyuncs.com/compatible-mode/v1')
  assert.equal(getBailianRegionalEndpoints('eu-central-1', ''), null)
})

test('routes Bailian models to native DashScope by default with compatible fallback', () => {
  assert.equal(resolveBailianEndpoint({ defaultEndpointType: 'auto' }, 'qwen3.5-flash').endpointType, BAILIAN_ENDPOINT_TYPES.DASHSCOPE)
  const result = resolveBailianEndpoint({
    defaultEndpointType: BAILIAN_ENDPOINT_TYPES.DASHSCOPE,
    endpoints: {
      [BAILIAN_ENDPOINT_TYPES.DASHSCOPE]: { enabled: false, baseUrl: 'https://native.example/api/v1' },
      [BAILIAN_ENDPOINT_TYPES.OPENAI]: { enabled: true, baseUrl: 'https://compatible.example/v1' },
    },
  }, 'qwen3.5-plus')
  assert.equal(result.endpointType, BAILIAN_ENDPOINT_TYPES.OPENAI)
  assert.equal(result.fellBack, true)
})

test('emits explicit Bailian thinking, budget, and web-search options', () => {
  assert.deepEqual(getBailianRuntimeOptions({ thinkingMode: 'auto' }), { storeResponses: false })
  assert.deepEqual(getBailianRuntimeOptions({ thinkingMode: 'enabled', thinkingBudget: 12000, reasoningEffort: 'high', enableWebSearch: true, searchStrategy: 'agent', enableSessionCache: true, storeResponses: true }), {
    thinkingEnabled: true,
    thinkingBudget: 12000,
    reasoningEffort: 'high',
    enableWebSearch: true,
    searchStrategy: 'agent',
    returnSearchSources: true,
    enableSessionCache: true,
    storeResponses: true,
  })
})
