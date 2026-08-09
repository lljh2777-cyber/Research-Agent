import { createRuntimeManifest, isRuntimeManifest, RUNTIME_TARGETS } from '../../shared/runtime-capabilities.mjs'
import { getRuntimeAdapter } from './adapter.js'

let manifestPromise

export function failClosedRuntimeManifest() {
  return createRuntimeManifest({ target: RUNTIME_TARGETS.HOSTED_WEB, buildMode: 'production' })
}

export async function fetchRuntimeManifest(fetchImpl = fetch) {
  const response = await getRuntimeAdapter().runtime.getManifest(fetchImpl)
  if (!(response instanceof Response) && isRuntimeManifest(response)) return response
  if (!(response instanceof Response)) throw new Error('Runtime capability discovery returned an invalid response.')
  if (!response.ok) throw new Error(`Runtime capability discovery failed (${response.status}).`)
  const payload = await response.json()
  if (!isRuntimeManifest(payload)) throw new Error('Runtime capability discovery returned an invalid manifest.')
  return payload
}

export function loadRuntimeManifest(fetchImpl = fetch) {
  if (!manifestPromise) {
    manifestPromise = fetchRuntimeManifest(fetchImpl).catch(() => failClosedRuntimeManifest())
  }
  return manifestPromise
}

export function resetRuntimeManifestForTests() {
  manifestPromise = undefined
}
