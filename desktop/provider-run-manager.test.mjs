import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderRunManager } from './provider-run-manager.mjs'

const input = {
  providerId: 'deepseek',
  endpoint: 'https://api.deepseek.com',
  endpointType: 'openai-chat-completions',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Explain this result.' }],
}

function completionFrom(events, type) {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const match = events.find((item) => item.event.type === type)
      if (!match) return
      clearInterval(interval)
      resolve(match)
    }, 2)
  })
}

test('owns provider streaming in the desktop host without accepting renderer credentials', async () => {
  const events = []
  let authorization = ''
  const manager = new ProviderRunManager({
    credentialResolver: async (providerId, endpoint) => {
      assert.equal(providerId, 'deepseek')
      assert.equal(endpoint, 'https://api.deepseek.com')
      return 'desktop-secret'
    },
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization
      return new Response([
        'data: {"choices":[{"delta":{"content":"Host-owned answer"}}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    },
  })

  const started = manager.start(7, input, (event) => events.push(event))
  const completed = await completionFrom(events, 'run.completed')

  assert.equal(completed.runId, started.runId)
  assert.equal(completed.event.text, 'Host-owned answer')
  assert.equal(authorization, 'Bearer desktop-secret')
  assert.equal(manager.activeCount, 0)
  assert.throws(() => manager.start(7, { ...input, apiKey: 'renderer-secret' }, () => {}), /do not accept renderer credentials/)
})

test('cancels only runs owned by the requesting renderer', async () => {
  const events = []
  let markFetchStarted
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve })
  const manager = new ProviderRunManager({
    credentialResolver: async () => 'desktop-secret',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      markFetchStarted()
      if (options.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
  })

  const started = manager.start(9, input, (event) => events.push(event))
  await fetchStarted
  assert.deepEqual(manager.cancel(10, started.runId), { cancelled: false })
  assert.deepEqual(manager.cancel(9, started.runId), { cancelled: true })
  const cancelled = await completionFrom(events, 'run.cancelled')

  assert.equal(cancelled.event.error.code, 'cancelled')
  assert.equal(cancelled.event.error.message, 'Generation stopped.')
  assert.equal(manager.activeCount, 0)
})

test('prevents keyless compatible IPC runs from becoming a remote request proxy', async () => {
  const events = []
  let fetched = false
  const manager = new ProviderRunManager({
    credentialResolver: async () => '',
    fetchImpl: async () => { fetched = true; return new Response('') },
  })
  manager.start(11, {
    ...input,
    providerId: 'compatible',
    endpoint: 'https://attacker.example/v1',
    model: 'custom-model',
  }, (event) => events.push(event))
  const failed = await completionFrom(events, 'run.failed')
  assert.equal(failed.event.error.code, 'invalid_request')
  assert.match(failed.event.error.message, /limited to loopback/)
  assert.equal(fetched, false)
})
