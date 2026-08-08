import { describe, expect, it } from 'vitest'

import { buildProviderChatRequest } from '../../server/provider-runtime.mjs'

const messages = [
  { role: 'system', content: 'Use the supplied evidence.' },
  { role: 'user', content: 'Summarize the result.' },
]

const providers = [
  {
    name: 'DeepSeek native',
    input: {
      providerId: 'deepseek',
      endpoint: 'https://api.deepseek.com',
      endpointType: 'openai-chat-completions',
      apiKey: 'test-key',
      model: 'deepseek-chat',
      messages,
    },
    expectedUrl: 'https://api.deepseek.com/chat/completions',
    expectedProtocol: 'openai-chat-completions',
  },
  {
    name: 'Alibaba Bailian OpenAI compatibility',
    input: {
      providerId: 'bailian',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      endpointType: 'openai-chat-completions',
      apiKey: 'test-key',
      model: 'qwen3.5-plus',
      messages,
    },
    expectedUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    expectedProtocol: 'openai-chat-completions',
  },
]

describe.each(providers)('$name provider contract', ({ input, expectedUrl, expectedProtocol }) => {
  it('normalizes requests to the common streaming runtime contract', () => {
    const request = buildProviderChatRequest(input)

    expect(request.url).toBe(expectedUrl)
    expect(request.protocol).toBe(expectedProtocol)
    expect(request.headers.Authorization).toBe('Bearer test-key')
    expect(request.body).toMatchObject({
      model: input.model,
      messages,
      stream: true,
    })
  })
})

