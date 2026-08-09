import { createRuntimeManifest, isRuntimeManifest, RUNTIME_TARGETS } from '../../shared/runtime-capabilities.mjs'
import { getRuntimeAdapter } from './adapter.js'

let manifestPromise

export function failClosedRuntimeManifest() {
  return createRuntimeManifest({ target: RUNTIME_TARGETS.HOSTED_WEB, buildMode: 'production' })
}

export async function fetchRuntimeManifest(fetchImpl = fetch) {
  const adapter = getRuntimeAdapter()
  const response = await adapter.runtime.getManifest(fetchImpl)
  if (!(response instanceof Response) && isRuntimeManifest(response)) {
    adapter.runtime.setManifest(response)
    return response
  }
  if (!(response instanceof Response)) throw new Error('Runtime capability discovery returned an invalid response.')
  if (!response.ok) throw new Error('Runtime capability discovery failed (' + response.status + ').')
  const payload = await response.json()
  if (!isRuntimeManifest(payload)) throw new Error('Runtime capability discovery returned an invalid manifest.')
  adapter.runtime.setManifest(payload)
  return payload
}

export function loadRuntimeManifest(fetchImpl = fetch) {
  if (!manifestPromise) {
    manifestPromise = fetchRuntimeManifest(fetchImpl).catch(() => {
      const manifest = failClosedRuntimeManifest()
      getRuntimeAdapter().runtime.setManifest(manifest)
      return manifest
    })
  }
  return manifestPromise
}

export function resetRuntimeManifestForTests() {
  manifestPromise = undefined
}
