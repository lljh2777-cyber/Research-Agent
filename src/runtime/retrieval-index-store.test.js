import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RETRIEVAL_INDEX_CACHE_PREFIX,
  createMemoryRetrievalIndexStorage,
  createRetrievalIndexStore,
  normalizeRetrievalIndexCache,
  retrievalIndexIdentityKey,
} from './retrieval-index-store.js'

const identity = {
  schemaVersion: 2,
  vault: { id: 'vault-1', revision: 'revision-1' },
  chunking: { algorithm: 'section-window-v1', size: 900, overlap: 120 },
  embedding: { providerId: 'siliconflow', modelId: 'BAAI/bge-m3', dimensions: 2 },
}

const chunks = [
  { id: 'note-a::0', noteId: 'note-a', sourceId: 'source:note-a', path: 'note-a.md', ordinal: 0, heading: 'A' },
  { id: 'note-a::1', noteId: 'note-a', sourceId: 'source:note-a', path: 'note-a.md', ordinal: 1, heading: null },
  { id: 'note-b::0', noteId: 'note-b', sourceId: 'source:note-b', path: 'note-b.md', ordinal: 0, heading: 'B' },
]
const texts = ['ligand receptor', 'cell signaling', 'single cell']

function embeddingStub(calls, { delay = 0, fail = false } = {}) {
  return async (input) => {
    calls.push(input)
    if (delay) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay)
      input.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'cancelled' }))
      }, { once: true })
    })
    if (fail) throw Object.assign(new Error('malformed provider response'), { code: 'malformed_response' })
    return { ok: true, embeddings: input.inputs.map((value, index) => ({ index, vector: [index + 0.1, value.length / 100] })) }
  }
}

test('reports unavailable when the runtime has no local persistence backend', async () => {
  const unavailable = { available: false, async read() {}, async write() {}, async remove() {}, async list() { return [] } }
  const store = createRetrievalIndexStore({ storage: unavailable, embed: embeddingStub([]) })
  assert.equal((await store.list()).state, 'unavailable')
  assert.equal((await store.status({ identity })).state, 'unavailable')
  assert.equal((await store.read({ identity })).state, 'unavailable')
})

test('builds a bounded ready cache, round-trips it, and persists no secrets or chunk text', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const calls = []
  const store = createRetrievalIndexStore({ storage, embed: embeddingStub(calls), now: () => 1_700_000_000_000 })
  const result = await store.build({
    identity,
    chunks,
    texts,
    batchSize: 2,
    provider: { endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'session-secret' },
  })

  assert.equal(result.state, 'ready')
  assert.equal(result.index.status, 'ready')
  assert.equal(result.vectors.length, chunks.length)
  assert.deepEqual(calls.map(({ inputs }) => inputs.length), [2, 1])
  const raw = await storage.read(retrievalIndexIdentityKey(identity))
  assert.equal(raw.includes('session-secret'), false)
  assert.equal(raw.includes('api.siliconflow'), false)
  assert.equal(raw.includes('ligand receptor'), false)

  const roundTrip = await store.read({ identity })
  assert.equal(roundTrip.state, 'ready')
  assert.deepEqual(roundTrip.index, result.index)
  assert.deepEqual(roundTrip.vectors, result.vectors)
})

test('returns stale for every identity dimension change and never reuses mismatched vectors', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const store = createRetrievalIndexStore({ storage, embed: embeddingStub([]) })
  await store.build({ identity, chunks, texts })

  for (const changed of [
    { vault: { ...identity.vault, revision: 'revision-2' } },
    { chunking: { ...identity.chunking, overlap: 80 } },
    { embedding: { ...identity.embedding, modelId: 'BAAI/bge-m3-v2' } },
    { embedding: { ...identity.embedding, dimensions: 3 } },
    { schemaVersion: 2, vault: identity.vault, chunking: { ...identity.chunking, algorithm: 'different-v2' }, embedding: identity.embedding },
  ]) {
    const requested = { ...identity, ...changed }
    const status = await store.status({ identity: requested })
    assert.equal(status.state, 'stale')
    assert.notEqual(status.staleReason, null)
    const read = await store.read({ identity: requested })
    assert.equal(read.state, 'not-built')
    assert.deepEqual(read.vectors, [])
  }
})

test('fails safe if a storage key collides with a different persisted identity', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const store = createRetrievalIndexStore({ storage, embed: embeddingStub([]) })
  await store.build({ identity, chunks, texts })
  const otherIdentity = { ...identity, vault: { ...identity.vault, revision: 'revision-collision' } }
  const requestedKey = retrievalIndexIdentityKey(otherIdentity)
  const originalKey = retrievalIndexIdentityKey(identity)
  const persisted = JSON.parse(await storage.read(originalKey))
  await storage.write(requestedKey, JSON.stringify({ ...persisted, key: requestedKey }))
  const read = await store.read({ identity: otherIdentity })
  assert.equal(read.state, 'stale')
  assert.equal(read.index, null)
  assert.deepEqual(read.vectors, [])
})

test('fails closed for corrupt and unknown-version cache records', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const key = retrievalIndexIdentityKey(identity)
  await storage.write(key, '{broken-json')
  const corrupt = await createRetrievalIndexStore({ storage, embed: embeddingStub([]) }).read({ identity })
  assert.equal(corrupt.state, 'failed')
  assert.equal(corrupt.index, null)

  await storage.write(key, JSON.stringify({ schemaVersion: 99, kind: 'retrieval-index-cache', key, state: 'ready' }))
  const unknown = await createRetrievalIndexStore({ storage, embed: embeddingStub([]) }).read({ identity })
  assert.equal(unknown.state, 'failed')
  assert.equal(unknown.index, null)
  assert.throws(() => normalizeRetrievalIndexCache({ schemaVersion: 99 }), /cache has unexpected or missing keys|unsupported/)
})

test('converts interrupted building state to cancelled on restart and never publishes partial ready data', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const key = retrievalIndexIdentityKey(identity)
  await storage.write(key, JSON.stringify({
    schemaVersion: 1,
    kind: 'retrieval-index-cache',
    key,
    identity,
    state: 'building',
    progress: { completed: 1, total: 3, batches: 1 },
    updatedAt: new Date().toISOString(),
  }))
  const restarted = createRetrievalIndexStore({ storage, embed: embeddingStub([]) })
  const status = await restarted.status({ identity })
  assert.equal(status.state, 'cancelled')
  assert.equal(status.error.code, 'runtime_restarted')
  const read = await restarted.read({ identity })
  assert.equal(read.state, 'cancelled')
  assert.equal(read.index, null)

  const failed = createRetrievalIndexStore({ storage: createMemoryRetrievalIndexStorage(), embed: embeddingStub([], { fail: true }) })
  const failure = await failed.build({ identity, chunks, texts })
  assert.equal(failure.state, 'degraded')
  assert.equal((await failed.read({ identity })).index, null)
})

test('replays the same active build and cancels before committing a rebuild', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const calls = []
  const store = createRetrievalIndexStore({ storage, embed: embeddingStub(calls, { delay: 20 }) })
  const first = store.build({ identity, chunks, texts })
  const replay = store.build({ identity, chunks, texts })
  const [firstResult, replayResult] = await Promise.all([first, replay])
  assert.equal(firstResult.state, 'ready')
  assert.equal(replayResult.state, 'ready')
  assert.equal(calls.length, 1)

  const cancelled = store.build({ identity, chunks, texts })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await store.cancel({ identity })
  const cancelledResult = await cancelled
  assert.equal(cancelledResult.state, 'cancelled')
  assert.equal((await store.read({ identity })).state, 'cancelled')
  assert.equal(RETRIEVAL_INDEX_CACHE_PREFIX.startsWith('bioresearch-os:'), true)
})

test('replaces a different identity for the same Vault only after the older build reaches quiescence', async () => {
  const storage = createMemoryRetrievalIndexStorage()
  const calls = []
  const store = createRetrievalIndexStore({ storage, embed: embeddingStub(calls, { delay: 20 }) })
  const changedIdentity = { ...identity, vault: { ...identity.vault, revision: 'revision-2' } }
  const first = store.build({ identity, chunks, texts, batchSize: 1 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const replacement = store.build({ identity: changedIdentity, chunks, texts, batchSize: 2 })
  const [firstResult, replacementResult] = await Promise.all([first, replacement])
  assert.equal(firstResult.state, 'cancelled')
  assert.equal(replacementResult.state, 'ready')
  assert.equal((await store.read({ identity })).state, 'cancelled')
  assert.equal((await store.read({ identity: changedIdentity })).state, 'ready')
  assert.equal(calls.some(({ signal }) => signal.aborted), true)
})
