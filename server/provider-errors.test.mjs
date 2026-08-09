import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeProviderError } from './provider-errors.mjs'

test('normalizes provider failures without exposing credentials', () => {
  assert.deepEqual(normalizeProviderError(Object.assign(new Error('Unauthorized for api key sk-secretvalue123'), { statusCode: 401 })), {
    code: 'authentication_failed',
    message: 'The provider rejected the configured credential. Verify the API key and endpoint.',
    retryable: false,
    statusCode: 401,
  })
  const network = normalizeProviderError(new Error('fetch failed at https://gateway.example?api_key=secretvalue'))
  assert.equal(network.code, 'network_error')
  assert.equal(network.message.includes('secretvalue'), false)
})
