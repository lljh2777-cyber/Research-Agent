import { expect, test } from '@playwright/test'

test('configured full local Runtime advertises explicitly executable services', async ({ request }) => {
  const response = await request.get('/api/runtime')
  const manifest = await response.json()

  expect(response.ok()).toBe(true)
  expect(manifest).toMatchObject({
    schemaVersion: 1,
    target: 'local-web',
    capabilities: {
      chatgptSubscriptionOAuth: true,
      credentials: { subscriptionOAuth: 'os-keychain' },
      localVault: { adapters: ['browser-picker', 'loopback-adapter'] },
      providerTransport: 'loopback',
      mcp: 'loopback',
      researchRuns: 'loopback-event-buffer',
      researchExecution: 'loopback-provider',
      knowledgeReads: {
        available: true,
        transport: 'research-run',
        capabilities: {
          'knowledge.query': true,
          'knowledge.explain': true,
        },
        reason: null,
      },
      annotations: {
        available: true,
        transport: 'same-origin',
        maxContentBytes: 65_536,
        maxRequestBytes: 131_072,
      },
      actions: {
        available: true,
        transport: 'same-origin',
        maxInputBytes: 131_072,
        maxOutputBytes: 65_536,
        maxContextBytes: 65_536,
        maxSessionHandoffBytes: 131_072,
      },
    },
  })
  expect(JSON.stringify(manifest)).not.toContain('127.0.0.1:1234')
  expect(JSON.stringify(manifest)).not.toContain('local-e2e-model')

  const actions = await request.get('/api/runtime/actions')
  expect(actions.ok()).toBe(true)
  expect((await actions.json()).actions).toHaveLength(5)

  const annotations = await request.get('/api/runtime/annotations')
  expect(annotations.ok()).toBe(true)
  expect((await annotations.json()).annotations).toEqual([])
})
