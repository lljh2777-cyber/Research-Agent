# Runtime Retrieval Index Cache v1

This document defines the Runtime-owned persistence envelope for the Retrieval Index v2 vectors. It is additive to the pure Knowledge Base contract in [`retrieval-v2.md`](./retrieval-v2.md); Runtime is responsible for transport, storage, lifecycle, and invalidation.

## Surface

Web and Desktop-compatible consumers use `getRuntimeAdapter().retrievalIndexes`:

- `list({ signal })` returns persisted lifecycle summaries;
- `status({ identity, signal })` reports `unavailable`, `not-built`, `building`, `ready`, `stale`, `degraded`, `failed`, or `cancelled`;
- `build({ identity, chunks, texts, provider, batchSize, signal, onProgress })` builds bounded batches through `providers.embed`;
- `progress({ identity, signal })` reads the current truthful status and progress;
- `cancel({ identity, signal })` requests abort; the active `build` promise settles only after the build reaches a terminal state;
- `rebuild(input)` cancels an active same-identity build before starting a new one;
- `read({ identity, signal })` returns only a fully validated ready v2 index and safe vectors.

`provider` is transient input. It may contain the session API key and endpoint for the Runtime request, but neither is accepted by the persistence envelope.

## Identity and invalidation

The identity is normalized by `normalizeRetrievalIndexIdentity` and is bound to:

- v2 schema version;
- Vault id and revision;
- deterministic chunking algorithm, size, and overlap;
- embedding provider id, model id, and dimensions.

The storage key is derived from the normalized identity. A request for an identity with the same Vault id but a different revision, chunk configuration, embedding configuration, or schema reports `stale` with a typed reason. Vectors are never returned for a different identity.

## Persistence and lifecycle

The cache envelope is versioned as `retrieval-index-cache` schema `1`. It stores only the normalized ready Retrieval Index v2, chunk identities, vectors, creation/update timestamps, and `{ providerId, modelId }` provenance. It never stores credentials, endpoints, headers, approval values, request text, or raw provider errors.

IndexedDB is preferred in Web when available. The localStorage fallback replaces one complete serialized record at a time; temporary or malformed records are never treated as ready. A persisted `building` record is converted to `cancelled` with `runtime_restarted` on the next Runtime initialization. Only a complete embedding result whose vectors pass count, index, chunk-id, dimension, and finite-number checks is published as `ready`.

All storage initialization, enumeration, reads, writes, removals, transactions, serialization, and recovery errors are normalized at the Runtime boundary. Consumers receive only typed `storage_unavailable`/`storage_failed` results with the existing collection/status/read shapes; raw quota errors, stacks, payloads, and provider data never cross the boundary. A read or status failure returns no vectors. If a failed write cannot quarantine or remove a possibly old record, the in-process store is marked untrusted and list/status/read fail closed until a successful verified rebuild clears that trust block. Recovery never reuses an old `ready` record without re-reading and validating its complete envelope and identity.

Builds use at most 128 embedding inputs per batch and enforce the Runtime embedding bounds for each text. An equivalent active build is replayed rather than duplicated. A different identity for the same Vault cancels the older build before replacement. Cancellation is checked after every provider response and before every progress or ready commit, so an aborted build cannot publish a partial ready index.

The Runtime surface is shared by Web and the existing Desktop adapter composition. No new Electron IPC or React storage access is introduced.
