import { expect } from '@playwright/test'

export const DISCONNECTED_CHATGPT_AUTH_STATUS = Object.freeze({
  provider: 'chatgpt',
  connected: false,
  type: null,
  email: null,
  planType: null,
  requiresOpenaiAuth: true,
  pending: false,
  loginAttemptId: null,
  loginState: 'idle',
  loginError: null,
  credentialOwner: 'codex',
})

export async function installChatgptAuthStatusRoute(page) {
  await page.route('**/api/auth/status', async (route) => {
    const request = route.request()
    expect(request.method()).toBe('GET')
    expect(new URL(request.url()).pathname).toBe('/api/auth/status')

    const response = { ...DISCONNECTED_CHATGPT_AUTH_STATUS }
    expect(response).toEqual(DISCONNECTED_CHATGPT_AUTH_STATUS)
    expect(Object.keys(response).sort()).toEqual(Object.keys(DISCONNECTED_CHATGPT_AUTH_STATUS).sort())
    expect(JSON.stringify(response)).not.toMatch(/accessToken|refreshToken|apiKey|authorization|secret/i)

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: response,
    })
  })
}
