import { randomUUID } from 'node:crypto'

import { normalizeProviderError } from '../server/provider-errors.mjs'
import { streamProviderChat } from '../server/provider-runtime.mjs'

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_ACTIVE_RUNS = 8
const MAX_OWNER_RUNS = 4

function requireAuthorizedKeylessEndpoint(input, apiKey) {
  if (apiKey || input.providerId !== 'compatible') return
  let endpoint
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw Object.assign(new Error('The compatible provider endpoint is invalid.'), { statusCode: 400 })
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) {
    throw Object.assign(new Error('Keyless compatible providers are limited to loopback endpoints in the desktop runtime.'), { statusCode: 400 })
  }
}

function cloneAndValidateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider run request.')
  if (!PROVIDER_ID_PATTERN.test(String(value.providerId || ''))) throw new Error('Invalid provider identifier.')
  if (typeof value.endpoint !== 'string' || !value.endpoint.trim() || value.endpoint.length > 2_048) throw new Error('Invalid provider endpoint.')
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256) throw new Error('Invalid provider model.')
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100) throw new Error('A provider run requires 1 to 100 messages.')
  if (value.apiKey) throw new Error('Desktop provider runs do not accept renderer credentials.')
  const serialized = JSON.stringify({
    providerId: value.providerId,
    endpoint: value.endpoint,
    endpointType: value.endpointType,
    model: value.model,
    messages: value.messages,
    options: value.options || {},
  })
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw new Error('Provider run request is too large.')
  return JSON.parse(serialized)
}

export class ProviderRunManager {
  #credentialResolver
  #fetchImpl
  #runs = new Map()

  constructor({ credentialResolver, fetchImpl = fetch } = {}) {
    if (typeof credentialResolver !== 'function') throw new Error('Provider run manager requires a credential resolver.')
    this.#credentialResolver = credentialResolver
    this.#fetchImpl = fetchImpl
  }

  get activeCount() {
    return this.#runs.size
  }

  start(ownerId, rawInput, emit) {
    if (!Number.isInteger(ownerId) || ownerId < 1) throw new Error('Invalid provider run owner.')
    if (typeof emit !== 'function') throw new Error('Provider run manager requires an event sink.')
    if (this.#runs.size >= MAX_ACTIVE_RUNS) throw new Error('Too many provider runs are active.')
    const ownerRuns = [...this.#runs.values()].filter((run) => run.ownerId === ownerId).length
    if (ownerRuns >= MAX_OWNER_RUNS) throw new Error('Too many provider runs are active in this window.')

    const input = cloneAndValidateInput(rawInput)
    const runId = randomUUID()
    const controller = new AbortController()
    const run = { ownerId, controller, emit }
    this.#runs.set(runId, run)
    queueMicrotask(() => void this.#execute(runId, input, run))
    return { runId }
  }

  cancel(ownerId, runId) {
    const run = this.#runs.get(String(runId || ''))
    if (!run || run.ownerId !== ownerId) return { cancelled: false }
    run.controller.abort()
    return { cancelled: true }
  }

  cancelOwner(ownerId) {
    let cancelled = 0
    for (const run of this.#runs.values()) {
      if (run.ownerId !== ownerId) continue
      run.controller.abort()
      cancelled += 1
    }
    return cancelled
  }

  async #execute(runId, input, run) {
    const send = (event) => {
      if (!this.#runs.has(runId)) return
      run.emit({ runId, event })
    }
    try {
      const apiKey = await this.#credentialResolver(input.providerId, input.endpoint)
      requireAuthorizedKeylessEndpoint(input, apiKey)
      for await (const event of streamProviderChat({ ...input, apiKey, signal: run.controller.signal }, this.#fetchImpl)) send(event)
    } catch (error) {
      const normalized = normalizeProviderError(error, { cancelled: run.controller.signal.aborted })
      send(normalized.code === 'cancelled'
        ? { type: 'run.cancelled', error: normalized }
        : { type: 'run.failed', error: normalized })
    } finally {
      this.#runs.delete(runId)
    }
  }
}
