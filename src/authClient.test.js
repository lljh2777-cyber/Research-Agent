import assert from 'node:assert/strict'
import test from 'node:test'

import { AUTH_SERVICE_UNAVAILABLE, createAuthServiceUnavailableError } from './authClient.js'

test('auth service network failures produce an actionable local-service error', () => {
  const cause = new TypeError('fetch failed')
  const error = createAuthServiceUnavailableError(cause)

  assert.equal(error.code, AUTH_SERVICE_UNAVAILABLE)
  assert.equal(error.cause, cause)
  assert.match(error.message, /127\.0\.0\.1:4318/)
  assert.match(error.message, /npm run dev/)
})
