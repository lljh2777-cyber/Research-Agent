import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderRuntimeError, streamProviderResponse } from './providerRuntimeClient.js'

test('sends thinking options and exposes reasoning deltas separately from answer text', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  let requestBody
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return new Response([
      'event: reasoning.delta\ndata: {"delta":"Check evidence"}',
      'event: tool_call.delta\ndata: {"index":0,"id":"call-1","name":"search_vault","argumentsDelta":"{}"}',
      'event: message.delta\ndata: {"delta":"Final answer"}',
      'event: run.completed\ndata: {"text":"Final answer","reasoning":"Check evidence","model":"deepseek-v4-flash"}',
      '',
    ].join('\n\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  const answerDeltas = []
  const reasoningDeltas = []
  const toolCallDeltas = []
  const result = await streamProviderResponse({
    providerId: 'deepseek',
    endpoint: 'https://api.deepseek.com',
    endpointType: 'openai-responses',
    apiKey: 'secret',
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Question' }],
    options: { thinkingEnabled: true, reasoningEffort: 'high' },
    tools: [{ name: 'search_vault', description: 'Search Vault', parameters: { type: 'object' } }],
    onDelta: (delta) => answerDeltas.push(delta),
    onReasoningDelta: (delta) => reasoningDeltas.push(delta),
    onToolCallDelta: (delta) => toolCallDeltas.push(delta),
  })
  assert.deepEqual(requestBody.options, { thinkingEnabled: true, reasoningEffort: 'high', tools: [{ name: 'search_vault', description: 'Search Vault', parameters: { type: 'object' } }] })
  assert.deepEqual(answerDeltas, ['Final answer'])
  assert.deepEqual(reasoningDeltas, ['Check evidence'])
  assert.deepEqual(toolCallDeltas, [{ index: 0, id: 'call-1', name: 'search_vault', argumentsDelta: '{}' }])
  assert.equal(result.reasoning, 'Check evidence')
})

test('uses the desktop IPC bridge without sending a credential', async (context) => {
  const listeners = new Set()
  let startInput
  globalThis.window = {
    researchDesktop: {
      providerRuns: {
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async start(input) {
          startInput = input
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({ runId: 'desktop-run', event: { type: 'message.delta', delta: 'Desktop answer' } })
              listener({ runId: 'desktop-run', event: { type: 'run.completed', text: 'Desktop answer', model: 'deepseek-chat' } })
            }
          })
          return { runId: 'desktop-run' }
        },
        async cancel() { return { cancelled: true } },
      },
    },
  }
  context.after(() => { delete globalThis.window })

  const deltas = []
  const result = await streamProviderResponse({
    providerId: 'deepseek', endpoint: 'https://api.deepseek.com', apiKey: 'must-not-cross-ipc', model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Question' }], onDelta: (delta) => deltas.push(delta),
  })

  assert.equal('apiKey' in startInput, false)
  assert.equal(result.text, 'Desktop answer')
  assert.deepEqual(deltas, ['Desktop answer'])
})

test('turns normalized desktop failures into typed renderer errors', async (context) => {
  const listeners = new Set()
  globalThis.window = {
    researchDesktop: {
      providerRuns: {
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async start() {
          queueMicrotask(() => {
            for (const listener of listeners) listener({
              runId: 'failed-run',
              event: { type: 'run.failed', error: { code: 'rate_limited', message: 'Wait and try again.', retryable: true, statusCode: 429 } },
            })
          })
          return { runId: 'failed-run' }
        },
        async cancel() { return { cancelled: true } },
      },
    },
  }
  context.after(() => { delete globalThis.window })

  await assert.rejects(
    streamProviderResponse({ providerId: 'deepseek', endpoint: 'https://api.deepseek.com', model: 'deepseek-chat', messages: [{ role: 'user', content: 'Question' }] }),
    (error) => error instanceof ProviderRuntimeError && error.code === 'rate_limited' && error.retryable,
  )
})
