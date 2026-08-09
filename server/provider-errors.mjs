const AUTH_PATTERN = /\b(401|403|api[ -]?key|auth(?:entication|orization)?|credential|unauthorized|forbidden)\b/i
const RATE_LIMIT_PATTERN = /\b(429|rate[ -]?limit|too many requests|quota)\b/i
const TIMEOUT_PATTERN = /\b(timeout|timed out|deadline)\b/i

function redactSecrets(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted credential]')
    .replace(/([?&](?:api_?key|token)=)[^&\s]+/gi, '$1[redacted]')
}

export function normalizeProviderError(error, { cancelled = false } = {}) {
  if (cancelled || error?.name === 'AbortError') {
    return {
      code: 'cancelled',
      message: 'Generation stopped.',
      retryable: false,
      statusCode: null,
    }
  }

  const statusCode = Number.isFinite(Number(error?.statusCode)) ? Number(error.statusCode) : null
  const rawMessage = redactSecrets(error?.message || 'Provider request failed.').slice(0, 500)
  if (statusCode === 504 || error?.name === 'TimeoutError' || TIMEOUT_PATTERN.test(rawMessage)) {
    return { code: 'timeout', message: 'The provider did not complete the response before the timeout.', retryable: true, statusCode: 504 }
  }
  if (statusCode === 401 || statusCode === 403 || AUTH_PATTERN.test(rawMessage)) {
    return { code: 'authentication_failed', message: 'The provider rejected the configured credential. Verify the API key and endpoint.', retryable: false, statusCode: statusCode || 401 }
  }
  if (statusCode === 429 || RATE_LIMIT_PATTERN.test(rawMessage)) {
    return { code: 'rate_limited', message: 'The provider rate limit or quota was reached. Wait and try again.', retryable: true, statusCode: 429 }
  }
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return { code: 'invalid_request', message: rawMessage, retryable: false, statusCode }
  }
  if (/could not reach|fetch failed|network/i.test(rawMessage)) {
    return { code: 'network_error', message: rawMessage, retryable: true, statusCode: statusCode || 502 }
  }
  return { code: 'provider_error', message: rawMessage, retryable: !statusCode || statusCode >= 500, statusCode }
}
