const DEFAULT_LOCAL_SERVICES = Object.freeze({
  auth: 'http://127.0.0.1:4318',
  vault: 'http://127.0.0.1:4317',
})

function cleanBaseUrl(value, fallback) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return candidate.replace(/\/$/, '')
}

export function getAuthServiceBaseUrl(env = import.meta.env) {
  return cleanBaseUrl(env?.VITE_AUTH_SERVER_URL, DEFAULT_LOCAL_SERVICES.auth)
}

export function getVaultServiceBaseUrl(env = import.meta.env) {
  return cleanBaseUrl(env?.VITE_VAULT_API_URL, DEFAULT_LOCAL_SERVICES.vault)
}

