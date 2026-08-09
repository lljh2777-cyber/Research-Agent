# Knowledge Base v1 data contracts

Knowledge Base v1 is a deterministic, runtime-neutral contract. Its parsing, link
resolution, graph construction, retrieval, and pipeline execution functions do not
access browser, Electron, provider, credential, or filesystem APIs.

## Versioned outputs

| Output | Version field | Value |
| --- | --- | --- |
| Vault Note | `schemaVersion` | `VAULT_NOTE_SCHEMA_VERSION` (1) |
| Vault Index | `schemaVersion` | `VAULT_INDEX_SCHEMA_VERSION` (1) |
| Knowledge Graph | `schemaVersion` | `KNOWLEDGE_GRAPH_SCHEMA_VERSION` (1) |
| Retrieval Index | `schemaVersion` | `RETRIEVAL_INDEX_SCHEMA_VERSION` (1) |
| Evidence Packet | `schemaVersion` | `EVIDENCE_PACKET_SCHEMA_VERSION` (1) |

## Vault Note v1

Every Note emitted by a Vault parser or normalizer contains these required fields:

- `schemaVersion`, `id`, `path`, `name`, `title`, `body`, `frontmatter`,
  `wikilinks`, `wordCount`, and `type`.
- `id` and `path` identify the source Markdown document. Paths use `/` separators.
- `frontmatter` is a parsed object; unsupported YAML constructs remain outside this
  compact parser contract.
- `wikilinks` is the ordered, de-duplicated list of target expressions, without an
  alias or heading suffix.

Wikilinks resolve in this order: a `./` or `../` path relative to the source Note,
an exact Vault path, then a unique title, file-name, basename, or `alias`/`aliases`
frontmatter value. A multiple-match alias is unresolved with reason `ambiguous`; a
missing target is unresolved with reason `missing`. This prevents note order from
deciding a graph edge.

## Graph and retrieval v1

`buildVaultIndex` returns `notes`, `edges`, `linkedNotes`, and `sources`. Each edge
has `source` and `target`; an unresolved target has `missing: true` and `reason`.
`createKnowledgeGraph` returns deterministic nodes, links, neighbors, stats, and
types. Both graph creation and retrieval graph expansion use the same wikilink
resolver.

`buildRetrievalIndex` returns the source Notes, chunks, chunk lookup maps, document
frequency, average length, and an undirected one-hop wikilink graph. Chunk IDs are
stable within an index build: `<noteId>::<zero-based-index>`.

## Evidence Packet v1

`retrieveEvidence` always returns:

- `schemaVersion`, `question`, `retrieval`, `evidence`, and `error`.
- `retrieval` includes `strategy`, `topK`, `candidateCount`, `directCount`, and
  `graphExpanded`.
- Each evidence item contains `id`, `noteId`, `source`, `title`, `path`, `type`,
  `heading`, `excerpt`, `score`, `links`, `relationship`, and `relatedFrom`.
- `source` contains `chunkId`, `noteId`, `path`, and `heading`, so any answer
  citation can be mapped to a retrieval chunk and its Markdown source.

No lexical match is a successful empty result: `evidence: []` and `error: null`.
An unavailable index returns `error.code: retrieval_index_unavailable`; a query with
no searchable terms returns `error.code: query_empty`. Callers must not present
either error as source-backed evidence.

`evidenceSources(packet)` returns one source per Note with `chunkIds`, preserving
the reverse map from displayed source to every contributing evidence chunk.
`search_vault` serializes the complete consumer packet envelope: `schemaVersion`,
`query`, `question`, `retrieval`, `evidence`, `sources`, and `error`. Evidence
items retain `id`, `noteId`, and `source`; `sources` retains every contributing
`chunkIds` mapping even when excerpts are shortened for the tool result.

## Consumer impact

- Research Core must preserve `EvidencePacket.error` and the evidence `source`
  object when composing grounded answers or Research Run snapshots.
- Web Runtime must preserve these JSON fields across runtime/tool boundaries.
- Research Web UI may use `schemaVersion`, `error`, and `chunkIds` to show an
  evidence gap or navigate an answer citation to the exact Markdown source.

All v1 additions are backward-compatible fields; no UI, provider, credential, or
runtime adapter API was changed in this commit.
