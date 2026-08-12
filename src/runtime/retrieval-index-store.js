import {
  RETRIEVAL_INDEX_V2_MAX_CHUNKS,
  normalizeRetrievalIndexIdentity,
  normalizeRetrievalIndexV2,
} from '../retrievalContracts.js'

export const RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION = 1
export const RETRIEVAL_INDEX_CACHE_PREFIX = 'bioresearch-os:retrieval-index:v1:'
export const RETRIEVAL_INDEX_CACHE_MAX_BYTES = 128 * 1024 * 1024
export const RETRIEVAL_INDEX_BATCH_MAX = 128
export const RETRIEVAL_INDEX_BATCH_MAX_BYTES = 256 * 1024
export const RETRIEVAL_INDEX_TEXT_MAX_BYTES = 16_384
export const RETRIEVAL_INDEX_STATES = Object.freeze([
  'unavailable',
  'not-built',
  'building',
  'ready',
  'stale',
  'degraded',
  'failed',
  'cancelled',
])

const INDEX_CACHE_KIND = 'retrieval-index-cache'
const SAFE_ERROR_CODES = new Set([
  'cancelled',
  'runtime_restarted',
  'malformed_response',
  'provider_unavailable',
  'authentication_failed',
  'rate_limited',
  'overloaded',
  'timeout',
  'network_error',
  'invalid_request',
  'provider_error',
  'storage_error',
  'build_in_progress',
  'retrieval_index_invalid',
])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asErrorCode(value, fallback = 'provider_error') {
  const code = String(value || '').trim()
  return SAFE_ERROR_CODES.has(code) ? code : fallback
}

function safeError(error, fallbackCode = 'provider_error') {
  const code = asErrorCode(error?.code, fallbackCode)
  const messages = {
    cancelled: 'Index build was cancelled.',
    runtime_restarted: 'Index build was interrupted by a runtime restart.',
    malformed_response: 'Embedding provider returned a malformed response.',
    provider_unavailable: 'Embedding capability is unavailable.',
    authentication_failed: 'Embedding provider authentication failed.',
    rate_limited: 'Embedding provider rate limit was reached.',
    overloaded: 'Embedding provider is temporarily overloaded.',
    timeout: 'Embedding provider timed out.',
    network_error: 'Embedding provider could not be reached.',
    invalid_request: 'Embedding request was invalid.',
    storage_error: 'Retrieval Index storage failed.',
    build_in_progress: 'An equivalent Retrieval Index build is already in progress.',
    retrieval_index_invalid: 'Retrieval Index data failed validation.',
    provider_error: 'Embedding provider request failed.',
  }
  return { code, message: messages[code] || messages.provider_error }
}

function hashIdentity(identity) {
  const text = JSON.stringify(identity)
  let hash = 2_166_136_261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function retrievalIndexIdentityKey(identity) {
  const normalized = normalizeRetrievalIndexIdentity(identity)
  return `${RETRIEVAL_INDEX_CACHE_PREFIX}${hashIdentity(normalized)}`
}

function identityDifference(previous, requested) {
  if (!previous) return 'schema_changed'
  if (previous.schemaVersion !== requested.schemaVersion) return 'schema_changed'
  if (previous.vault.id !== requested.vault.id || previous.vault.revision !== requested.vault.revision) return 'vault_revision_changed'
  if (JSON.stringify(previous.chunking) !== JSON.stringify(requested.chunking)) return 'chunk_settings_changed'
  if (JSON.stringify(previous.embedding) !== JSON.stringify(requested.embedding)) return 'embedding_configuration_changed'
  return 'manual'
}

function normalizedStoredIdentity(value) {
  if (!value) return null
  try {
    return normalizeRetrievalIndexIdentity(value)
  } catch {
    return null
  }
}

function storageEnvelope(identity, state, fields = {}) {
  return {
    schemaVersion: RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION,
    kind: INDEX_CACHE_KIND,
    key: retrievalIndexIdentityKey(identity),
    identity,
    state,
    ...fields,
  }
}

function validateVectorRecord(value, index, dimensions, chunkIds) {
  if (!isRecord(value)) throw new TypeError(`Vector ${index} must be an object.`)
  const allowedKeys = ['chunkId', 'index', 'vector']
  if (Object.keys(value).sort().join('|') !== allowedKeys.join('|')) throw new TypeError(`Vector ${index} has unexpected keys.`)
  if (typeof value.chunkId !== 'string' || !chunkIds.has(value.chunkId)) throw new TypeError(`Vector ${index} has an unknown chunk identity.`)
  if (!Number.isInteger(value.index) || value.index < 0 || value.index >= chunkIds.size) throw new TypeError(`Vector ${index} has an invalid index.`)
  if (!Array.isArray(value.vector) || value.vector.length !== dimensions || value.vector.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`Vector ${index} has invalid dimensions.`)
  }
  return { chunkId: value.chunkId, index: value.index, vector: value.vector.map(Number) }
}

export function normalizeRetrievalIndexCache(value) {
  if (!isRecord(value)) throw new TypeError('Retrieval Index cache must be an object.')
  const expectedKeys = ['createdAt', 'identity', 'index', 'kind', 'key', 'provenance', 'schemaVersion', 'state', 'updatedAt', 'vectors']
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.join('|') !== expectedKeys.sort().join('|')) throw new TypeError('Retrieval Index cache has unexpected or missing keys.')
  if (value.schemaVersion !== RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION || value.kind !== INDEX_CACHE_KIND) throw new TypeError('Retrieval Index cache version is unsupported.')
  const identity = normalizeRetrievalIndexIdentity(value.identity)
  const key = retrievalIndexIdentityKey(identity)
  if (value.key !== key) throw new TypeError('Retrieval Index cache identity key is invalid.')
  if (value.state !== 'ready') throw new TypeError('Only ready Retrieval Index caches may be normalized.')
  if (typeof value.createdAt !== 'string' || !value.createdAt) throw new TypeError('Retrieval Index cache createdAt is invalid.')
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) throw new TypeError('Retrieval Index cache updatedAt is invalid.')
  const index = normalizeRetrievalIndexV2(value.index)
  if (index.status !== 'ready' || JSON.stringify(index.identity) !== JSON.stringify(identity)) throw new TypeError('Retrieval Index cache index identity is inconsistent.')
  if (!isRecord(value.provenance) || Object.keys(value.provenance).sort().join('|') !== 'modelId|providerId') throw new TypeError('Retrieval Index cache provenance is invalid.')
  if (value.provenance.providerId !== identity.embedding.providerId || value.provenance.modelId !== identity.embedding.modelId) throw new TypeError('Retrieval Index cache provenance is inconsistent.')
  if (!Array.isArray(value.vectors) || value.vectors.length !== index.chunks.length) throw new TypeError('Retrieval Index cache vectors are incomplete.')
  const chunkIds = new Set(index.chunks.map((chunk) => chunk.id))
  const vectors = value.vectors.map((vector, vectorIndex) => validateVectorRecord(vector, vectorIndex, identity.embedding.dimensions, chunkIds))
  if (new Set(vectors.map((vector) => vector.chunkId)).size !== vectors.length || new Set(vectors.map((vector) => vector.index)).size !== vectors.length) {
    throw new TypeError('Retrieval Index cache vectors must be unique.')
  }
  return { ...storageEnvelope(identity, 'ready', { createdAt: value.createdAt, updatedAt: value.updatedAt, index, vectors, provenance: value.provenance }) }
}

function summarizeEnvelope(value) {
  return {
    key: value.key,
    state: value.state,
    identity: value.identity || null,
    progress: value.progress || null,
    error: value.error || null,
    staleReason: value.staleReason || null,
    updatedAt: value.updatedAt || null,
  }
}

function nowIso(now) {
  return new Date(now()).toISOString()
}

function byteLength(value) {
  return new TextEncoder().encode(value).length
}

function safeProgress(value) {
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort().join('|')
  if (keys !== 'batches|completed|total') return null
  if (![value.completed, value.total, value.batches].every((item) => Number.isInteger(item) && item >= 0)) return null
  if (value.completed > value.total) return null
  return { completed: value.completed, total: value.total, batches: value.batches }
}

function minimalFailedTombstone(key, identity, now) {
  const safeIdentity = normalizedStoredIdentity(identity)
  return {
    schemaVersion: RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION,
    kind: INDEX_CACHE_KIND,
    key,
    ...(safeIdentity ? { identity: safeIdentity } : {}),
    state: 'failed',
    progress: null,
    error: safeError({ code: 'retrieval_index_invalid' }),
    updatedAt: nowIso(now),
  }
}

function normalizePersistedLifecycle(value) {
  if (!isRecord(value) || !RETRIEVAL_INDEX_STATES.includes(value.state)) return null
  const common = ['identity', 'key', 'kind', 'schemaVersion', 'state', 'updatedAt']
  const stateKeys = value.state === 'building'
    ? [...common, 'progress']
    : value.state === 'stale'
      ? [...common, 'progress', 'staleReason']
      : [...common, 'error', 'progress']
  if (Object.keys(value).sort().join('|') !== stateKeys.sort().join('|')) return null
  if (value.schemaVersion !== RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION || value.kind !== INDEX_CACHE_KIND) return null
  const identity = normalizedStoredIdentity(value.identity)
  if (!identity || value.key !== retrievalIndexIdentityKey(identity)) return null
  if (typeof value.updatedAt !== 'string' || !value.updatedAt) return null
  const progress = safeProgress(value.progress)
  if (!progress && value.progress !== null) return null
  if (value.state === 'stale' && !['vault_revision_changed', 'chunk_settings_changed', 'embedding_configuration_changed', 'schema_changed', 'manual'].includes(value.staleReason)) return null
  if (value.state !== 'building' && (!isRecord(value.error) || asErrorCode(value.error.code) !== value.error.code || value.error.message !== safeError(value.error).message)) return null
  return {
    schemaVersion: RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION,
    kind: INDEX_CACHE_KIND,
    key: value.key,
    identity,
    state: value.state,
    ...(value.state === 'stale' ? { staleReason: value.staleReason } : {}),
    progress,
    ...(value.state !== 'building' ? { error: safeError(value.error) } : {}),
    updatedAt: value.updatedAt,
  }
}

function createLocalStorageBackend(storage) {
  return {
    available: Boolean(storage),
    async read(key) {
      return storage?.getItem(key) || null
    },
    async write(key, value) {
      storage?.setItem(key, value)
    },
    async remove(key) {
      storage?.removeItem(key)
    },
    async list() {
      const keys = []
      for (let index = 0; storage && index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key?.startsWith(RETRIEVAL_INDEX_CACHE_PREFIX)) keys.push(key)
      }
      return keys
    },
  }
}

function createIndexedDbBackend(indexedDB) {
  const databaseName = 'bioresearch-os-runtime-v1'
  const storeName = 'retrieval-indexes'
  let databasePromise
  function open() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(storeName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'))
      })
    }
    return databasePromise
  }
  function transaction(mode, action) {
    return open().then((database) => new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode)
      const request = action(transaction.objectStore(storeName))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('IndexedDB transaction failed.'))
    }))
  }
  return {
    available: Boolean(indexedDB),
    async read(key) { return transaction('readonly', (store) => store.get(key)) },
    async write(key, value) { return transaction('readwrite', (store) => store.put(value, key)) },
    async remove(key) { return transaction('readwrite', (store) => store.delete(key)) },
    async list() { return transaction('readonly', (store) => store.getAllKeys()) },
  }
}

export function createRetrievalIndexStorage({ windowRef = globalThis.window, storage } = {}) {
  if (storage) return createLocalStorageBackend(storage)
  if (windowRef?.indexedDB) return createIndexedDbBackend(windowRef.indexedDB)
  return createLocalStorageBackend(windowRef?.localStorage)
}

export function createMemoryRetrievalIndexStorage() {
  const values = new Map()
  return {
    available: true,
    async read(key) { return values.get(key) || null },
    async write(key, value) { values.set(key, value) },
    async remove(key) { values.delete(key) },
    async list() { return [...values.keys()] },
  }
}

export function createRetrievalIndexStore({ storage, embed, now = Date.now } = {}) {
  const backend = storage || createMemoryRetrievalIndexStorage()
  const active = new Map()
  const recoveryPromise = recoverInterruptedBuilds()

  async function quarantine(key, identity = null) {
    const tombstone = minimalFailedTombstone(key, identity, now)
    try {
      await writeEnvelope(key, tombstone)
    } catch {
      try {
        await backend.remove(key)
      } catch {
        // Do not expose the original payload when persistence itself fails.
      }
    }
    return tombstone
  }

  async function rawEnvelope(key, fallbackIdentity = null) {
    const raw = await backend.read(key)
    if (!raw) return null
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!isRecord(value) || value.key !== key || value.schemaVersion !== RETRIEVAL_INDEX_CACHE_SCHEMA_VERSION || value.kind !== INDEX_CACHE_KIND) throw new TypeError('unsupported cache')
      if (value.state === 'ready') return normalizeRetrievalIndexCache(value)
      const lifecycle = normalizePersistedLifecycle(value)
      if (!lifecycle) throw new TypeError('unsafe cache')
      return lifecycle
    } catch {
      return quarantine(key, fallbackIdentity)
    }
  }

  async function writeEnvelope(key, value) {
    const serialized = JSON.stringify(value)
    if (new TextEncoder().encode(serialized).length > RETRIEVAL_INDEX_CACHE_MAX_BYTES) throw Object.assign(new Error('Retrieval Index cache exceeds its storage bound.'), { code: 'storage_error' })
    await backend.write(key, serialized)
  }

  async function recoverInterruptedBuilds() {
    if (!backend.available) return
    for (const key of await backend.list()) {
      const value = await rawEnvelope(key)
      if (value?.state !== 'building') continue
      await writeEnvelope(key, {
        ...value,
        state: 'cancelled',
        error: safeError({ code: 'runtime_restarted' }),
        updatedAt: nowIso(now),
        progress: value.progress || { completed: 0, total: 0, batches: 0 },
      })
    }
  }

  async function list() {
    await recoveryPromise
    if (!backend.available) return { ok: false, state: 'unavailable', items: [], error: safeError({ code: 'provider_unavailable' }) }
    const items = []
    for (const key of await backend.list()) {
      const value = await rawEnvelope(key)
      if (value) items.push(summarizeEnvelope(value))
    }
    return { ok: true, items: items.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))) }
  }

  async function status({ identity } = {}) {
    await recoveryPromise
    if (!backend.available) return { ok: false, state: 'unavailable', error: safeError({ code: 'provider_unavailable' }) }
    const requested = identity ? normalizeRetrievalIndexIdentity(identity) : null
    if (!requested) return { ok: true, state: 'not-built', progress: null, identity: null, error: null }
    const key = retrievalIndexIdentityKey(requested)
      const exact = await rawEnvelope(key, requested)
      const storedIdentity = normalizedStoredIdentity(exact?.identity)
      if (storedIdentity && JSON.stringify(storedIdentity) !== JSON.stringify(requested)) {
      return { ok: true, key, state: 'stale', identity: requested, progress: null, staleReason: identityDifference(storedIdentity, requested), error: null }
    }
    if (exact) return summarizeEnvelope(exact)
    const items = await list()
    const previous = items.items.find((item) => item.identity?.vault?.id === requested.vault.id)
    if (previous) return { ...previous, key, identity: requested, state: 'stale', staleReason: identityDifference(previous.identity, requested), error: null }
    return { ok: true, key, state: 'not-built', identity: requested, progress: null, error: null }
  }

  async function read({ identity } = {}) {
    await recoveryPromise
    const requested = normalizeRetrievalIndexIdentity(identity)
    if (!backend.available) return { ok: false, state: 'unavailable', error: safeError({ code: 'provider_unavailable' }) }
    const key = retrievalIndexIdentityKey(requested)
     const value = await rawEnvelope(key, requested)
     if (!value) return { ok: true, key, state: 'not-built', identity: requested, index: null, vectors: [] }
     const storedIdentity = normalizedStoredIdentity(value.identity)
     if (storedIdentity && JSON.stringify(storedIdentity) !== JSON.stringify(requested)) {
      return { ok: true, key, state: 'stale', identity: requested, staleReason: identityDifference(storedIdentity, requested), index: null, vectors: [] }
    }
     if (value.state !== 'ready') return { ...summarizeEnvelope(value), index: null, vectors: [] }
     return { ok: true, key, state: 'ready', identity: value.identity, index: value.index, vectors: value.vectors, provenance: value.provenance }
  }

  async function progress({ identity } = {}) {
    return status({ identity })
  }

  async function cancel({ identity } = {}) {
    const requested = normalizeRetrievalIndexIdentity(identity)
    const key = retrievalIndexIdentityKey(requested)
    const job = active.get(key)
    if (!job) return status({ identity: requested })
     job.cancelRequested = true
     job.generation += 1
     job.controller.abort()
     await job.quiesced
     return { ok: true, key, state: job.result?.state || 'cancelled', identity: requested }
  }

  async function build(input = {}) {
    await recoveryPromise
    const identity = normalizeRetrievalIndexIdentity(input.identity)
    if (!identity.embedding.providerId || !identity.embedding.modelId || !identity.embedding.dimensions) {
      return { ok: false, state: 'failed', error: safeError({ code: 'invalid_request' }) }
    }
    const chunks = Array.isArray(input.chunks) ? input.chunks : []
    const texts = Array.isArray(input.texts) ? input.texts : []
    if (!chunks.length || chunks.length > RETRIEVAL_INDEX_V2_MAX_CHUNKS || texts.length !== chunks.length || texts.some((text) => typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > RETRIEVAL_INDEX_TEXT_MAX_BYTES)) {
      return { ok: false, state: 'failed', error: safeError({ code: 'invalid_request' }) }
    }
    const index = normalizeRetrievalIndexV2({ schemaVersion: 2, kind: 'retrieval-index', identity, status: 'ready', staleReason: null, chunks })
    const key = retrievalIndexIdentityKey(identity)
    const same = active.get(key)
    if (same) return same.promise
    const sameVault = [...active.values()].find((job) => job.identity.vault.id === identity.vault.id && job.key !== key)
    if (sameVault) {
      await cancel({ identity: sameVault.identity })
      await sameVault.promise.catch(() => {})
    }
    const controller = new AbortController()
     let resolveQuiesced
     const job = {
       key,
       identity,
       controller,
       cancelRequested: false,
       generation: 0,
       result: null,
       quiesced: new Promise((resolve) => { resolveQuiesced = resolve }),
       promise: null,
     }
    active.set(key, job)
    const total = index.chunks.length
    const batchSize = Math.min(RETRIEVAL_INDEX_BATCH_MAX, Math.max(1, Number(input.batchSize) || RETRIEVAL_INDEX_BATCH_MAX))
    const buildPromise = (async () => {
      const progressValue = { completed: 0, total, batches: 0 }
      const vectors = []
      const generation = job.generation
      const ensureActive = () => {
        if (controller.signal.aborted || job.cancelRequested || job.generation !== generation || active.get(key) !== job) {
          throw Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' })
        }
      }
      try {
        await writeEnvelope(key, storageEnvelope(identity, 'building', { progress: progressValue, updatedAt: nowIso(now) }))
        for (let offset = 0; offset < index.chunks.length;) {
          ensureActive()
          let end = offset
          let batchBytes = 0
          while (end < index.chunks.length && end - offset < batchSize) {
            const itemBytes = byteLength(texts[end])
            if (end > offset && batchBytes + itemBytes > RETRIEVAL_INDEX_BATCH_MAX_BYTES) break
            if (end === offset && itemBytes > RETRIEVAL_INDEX_BATCH_MAX_BYTES) {
              throw Object.assign(new Error('Embedding batch exceeds its byte bound.'), { code: 'invalid_request' })
            }
            batchBytes += itemBytes
            end += 1
          }
          const batch = index.chunks.slice(offset, end)
          const result = await embed({
            ...(input.provider || {}),
            providerId: identity.embedding.providerId,
            model: identity.embedding.modelId,
            dimensions: identity.embedding.dimensions,
             inputs: texts.slice(offset, end),
             signal: controller.signal,
           })
           ensureActive()
          if (result?.ok === false) throw Object.assign(new Error(result.error || 'Embedding failed.'), { code: result.code })
          const returned = Array.isArray(result?.embeddings) ? result.embeddings : []
          if (returned.length !== batch.length) throw Object.assign(new Error('Embedding batch shape was invalid.'), { code: 'malformed_response' })
          const seen = new Set()
          returned.forEach((item) => {
            const localIndex = Number(item?.index)
            if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= batch.length || seen.has(localIndex) || !Array.isArray(item.vector) || item.vector.length !== identity.embedding.dimensions || item.vector.some((value) => !Number.isFinite(value))) {
              throw Object.assign(new Error('Embedding vector dimensions were invalid.'), { code: 'malformed_response' })
            }
            seen.add(localIndex)
            vectors.push({ chunkId: batch[localIndex].id, index: offset + localIndex, vector: item.vector.map(Number) })
          })
           progressValue.completed = Math.min(total, offset + batch.length)
           progressValue.batches += 1
           await writeEnvelope(key, storageEnvelope(identity, 'building', { progress: { ...progressValue }, updatedAt: nowIso(now) }))
           ensureActive()
           input.onProgress?.({ ...progressValue, state: 'building', key, identity })
           offset = end
         }
         ensureActive()
        const cache = normalizeRetrievalIndexCache({
          ...storageEnvelope(identity, 'ready', {
            createdAt: nowIso(now),
            updatedAt: nowIso(now),
            index,
            vectors,
            provenance: { providerId: identity.embedding.providerId, modelId: identity.embedding.modelId },
          }),
         })
         await writeEnvelope(key, cache)
         ensureActive()
         const result = { ok: true, key, state: 'ready', identity, index: cache.index, vectors: cache.vectors, provenance: cache.provenance, progress: { completed: total, total, batches: progressValue.batches } }
         job.result = result
         return result
       } catch (error) {
        const cancelled = controller.signal.aborted || job.cancelRequested || error?.name === 'AbortError' || error?.code === 'cancelled'
        const finalState = cancelled ? 'cancelled' : error?.code === 'malformed_response' ? 'degraded' : 'failed'
        const finalError = safeError(cancelled ? { code: 'cancelled' } : error, cancelled ? 'cancelled' : 'provider_error')
         await writeEnvelope(key, storageEnvelope(identity, finalState, { progress: { ...progressValue }, error: finalError, updatedAt: nowIso(now) }))
         const result = { ok: false, key, state: finalState, identity, progress: { ...progressValue }, error: finalError }
         job.result = result
         return result
       } finally {
         active.delete(key)
         resolveQuiesced()
       }
    })()
    job.promise = buildPromise
    return buildPromise
  }

  async function rebuild(input = {}) {
    if (input.identity) {
      const key = retrievalIndexIdentityKey(input.identity)
      const job = active.get(key)
      if (job) {
        await cancel({ identity: input.identity })
        await job.promise.catch(() => {})
      }
    }
    return build(input)
  }

  return Object.freeze({
    get available() { return Boolean(backend.available && typeof embed === 'function') },
    list,
    status,
    build,
    progress,
    cancel,
    rebuild,
    read,
  })
}
