import { expect, test } from '@playwright/test'

test('full local Runtime launcher advertises the Auth and Vault loopback services it owns', async ({ request }) => {
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
    },
  })
})
