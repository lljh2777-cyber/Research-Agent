# Retrieval Index v2 and Evidence Packet v2

Status: KB5-01 additive contract checkpoint.

The v2 contract is a pure Knowledge Base data shape. It does not call a Provider, persist an index, access a browser or filesystem, or implement fusion/reranking. Runtime owns transport and storage; Research Core owns orchestration and algorithm execution.

## Retrieval Index v2

`src/retrievalContracts.js` freezes an index as:

- `identity.schemaVersion`: contract schema;
- `identity.vault.id` and `identity.vault.revision`;
- deterministic chunking algorithm, size, and overlap;
- embedding Provider/model/dimensions, or all three `null` for a lexical-only index;
- `status: ready | stale` and a typed `staleReason` when stale;
- bounded, unique chunk identities containing `id`, `noteId`, `sourceId`, path, ordinal, and heading.

An index is stale when its bound Vault revision, chunk settings, embedding configuration, or schema no longer matches the requested identity. Staleness is explicit and cannot be silently treated as a ready hybrid index.

## Evidence Packet v2

Every evidence item carries stable note, chunk, source, and citation identity. The normalized shape cross-checks repeated identity fields so a citation cannot point to a different source path or chunk. Source records list their chunk ids, and every evidence item must join to that list.

`scoreProvenance` always contains `lexical`, `vector`, `graph`, `fusion`, `rerank`, and `final`. Unused stages are `null`; scores are bounded to `[0, 1]`. The packet retrieval summary records `mode: lexical | hybrid` and the index status. Hybrid output is accepted only with a ready index; stale or unavailable indexes therefore remain truthful lexical paths.

The checkpoint bounds packets to 50 evidence items, ids to 512 characters, paths to 1024 UTF-8 bytes, and excerpts to 16384 UTF-8 bytes.

## v1 compatibility

`migrateRetrievalIndexV1` and `migrateEvidencePacketV1` are explicit migrations. They preserve v1 lexical meaning and final scores but never relabel a v1 packet as hybrid. Index identity must be supplied by the caller because a v1 in-memory index does not contain the Vault revision or embedding configuration required by v2.

The current v1 algorithm and packet shape remain unchanged. Consumers adopt v2 through the new pure contract module before Runtime, Core, or UI wiring is added.
