import { statSync } from 'node:fs'
import { BUILD_MODES, createRuntimeManifest, RUNTIME_TARGETS } from '../shared/runtime-capabilities.mjs'

function buildModeFromEnvironment(value) {
  if (value === 'test') return BUILD_MODES.TEST
  if (value === 'production') return BUILD_MODES.PRODUCTION
  return BUILD_MODES.DEVELOPMENT
}

function isVaultDirectory(value) {
  if (!value) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

export function createKnowledgeReadServiceEvidence({
  providerId,
  endpoint,
  model,
  credential,
  researchRunExecutable = false,
} = {}) {
  return {
    provider: { selected: true, providerId, endpoint, model, credential },
    researchRun: { executable: researchRunExecutable === true, transport: 'research-run' },
  }
}

export function createLocalWebRuntimeManifest({
  nodeEnv = process.env.NODE_ENV,
  version = process.env.npm_package_version || '0.1.0',
  vaultRoot = process.env.BIORESEARCH_VAULT_ROOT,
  services,
} = {}) {
  const vaultAvailable = isVaultDirectory(vaultRoot)
  return createRuntimeManifest({
    buildMode: buildModeFromEnvironment(nodeEnv),
    target: RUNTIME_TARGETS.LOCAL_WEB,
    version,
    services: {
      annotations: services?.annotations ?? vaultAvailable,
      actions: services?.actions ?? vaultAvailable,
      knowledgeReads: services?.knowledgeReads,
    },
  })
}

export function createViteWebRuntimeManifest({
  nodeEnv = process.env.NODE_ENV,
  version = process.env.npm_package_version || '0.1.0',
} = {}) {
  return createRuntimeManifest({
    buildMode: buildModeFromEnvironment(nodeEnv),
    target: RUNTIME_TARGETS.VITE_WEB,
    version,
  })
}

export function createRuntimeApiMiddleware(options = {}) {
  const manifest = options.manifest || createLocalWebRuntimeManifest(options)
  return function runtimeApiMiddleware(request, response, next) {
    const path = new URL(request.url || '/', 'http://localhost').pathname
    if (path !== '/api/runtime') return next()
    if (request.method !== 'GET') {
      response.statusCode = 405
      response.setHeader('Allow', 'GET')
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(JSON.stringify({ error: 'Method not allowed.' }))
      return
    }
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.end(JSON.stringify(manifest))
  }
}
