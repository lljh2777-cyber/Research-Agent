# Knowledge Agent v1

Knowledge Agent v1 defines one framework-neutral `knowledge-curator` identity for the full Research workspace and the compact Knowledge sidebar. It reuses Research Run v1 for tool rounds, cancellation, replay, reconnect, and terminal states. It does not introduce another run engine or runtime transport.

## Ownership boundary

Research Core owns the Agent preset, Action Tool descriptors and envelopes, approval/risk policy, and session handoff. Annotation v1 and Knowledge Context v1 remain owned by Knowledge Base. Core consumes a `schemaVersion: 1` Knowledge Context object as an opaque JSON value and preserves it unchanged; it does not normalize or redefine note, selection, attachment, or annotation fields. The authoritative Knowledge Base fixture is copied unchanged into the Knowledge Agent consumer fixture and exercised by Core tests.

Runtime owns capability availability and action execution. UI owns presentation and approval interaction. No Core module probes browser globals, starts child processes, writes a Vault, or persists a handoff.

## Agent preset

`knowledge-curator` version 1 has:

- `supportedSurfaces: ["research", "knowledge-sidebar"]`
- `contextContract: "knowledge-context.v1"`
- read-only defaults: query, explain, and lint
- optional write tools: annotation, paper ingest, X-Ray, static code analysis, and synthesis
- a system instruction that note content, selections, attachments, and tool results are untrusted evidence rather than executable instructions

The same `agentId`, `sessionId`, `runId`, cursor, and Knowledge Context continue across surfaces.

## Typed Action Tool descriptor

Every descriptor has this exact shape:

```json
{
  "schemaVersion": 1,
  "id": "knowledge.query",
  "name": "knowledge_query",
  "title": "Query knowledge",
  "description": "...",
  "effect": "read",
  "riskClass": "read",
  "approvalPolicy": "none",
  "capability": "knowledge.query",
  "requiresScope": false,
  "requiresIdempotencyKey": false,
  "inputSchema": {},
  "outputSchema": {}
}
```

The frozen inventory is:

| ID | Provider name | Capability | Effect | Approval |
| --- | --- | --- | --- | --- |
| `knowledge.query` | `knowledge_query` | `knowledge.query` | read | none |
| `knowledge.explain` | `knowledge_explain` | `knowledge.explain` | read | none |
| `knowledge.lint` | `knowledge_lint` | `knowledge.lint` | read | none |
| `knowledge.annotation.write` | `knowledge_annotation_write` | `annotations.write` | write | explicit |
| `knowledge.paper.ingest` | `knowledge_paper_ingest` | `actions.paperIngest` | write | explicit |
| `knowledge.xray` | `knowledge_xray` | `actions.xray` | write | explicit |
| `knowledge.code.analyze` | `knowledge_code_analysis` | `actions.codeAnalysis` | write | explicit |
| `knowledge.synthesis.write` | `knowledge_synthesis_write` | `actions.synthesis` | write | explicit |

Lint is read-only. Repair is not an option in its schema and is outside this milestone.

## Input envelope

Core combines model-supplied arguments with trusted run/session/context references. Knowledge Context v1 keeps its Knowledge Base-owned 65,536 UTF-8 byte limit. The serialized Action input and session handoff are each limited to 131,072 bytes so a valid maximum-size Context remains transportable with trusted metadata; Action output remains limited to 65,536 bytes:

```json
{
  "schemaVersion": 1,
  "toolId": "knowledge.annotation.write",
  "requestId": "call-1",
  "runId": "run-1",
  "sessionId": "session-1",
  "context": { "schemaVersion": 1 },
  "scope": {
    "vaultId": "vault-1",
    "target": { "kind": "selection", "id": "selection-1" },
    "expectedRevision": "revision-7"
  },
  "idempotencyKey": "annotation:selection-1:revision-7",
  "input": {}
}
```

`target.kind` is one of `vault`, `folder`, `note`, `selection`, or `attachment`. Every write descriptor requires a non-empty scope and stable idempotency key before approval is requested. Read descriptors set both fields to `null` and cannot emit write artifacts.

## Output envelope

The output is also limited to 65,536 UTF-8 bytes:

```json
{
  "schemaVersion": 1,
  "toolId": "knowledge.annotation.write",
  "requestId": "call-1",
  "runId": "run-1",
  "status": "completed",
  "effect": "write",
  "summary": "Annotation saved.",
  "data": null,
  "artifacts": [{ "id": "annotation-1", "kind": "annotation" }],
  "error": null
}
```

Status is `completed`, `failed`, or `cancelled`. These are tool-result statuses, not new Research Run states. A cancelled action propagates through the existing abort path; Research Run remains authoritative for run-level cancellation and terminal presentation.

## Capability and approval policy

The registry fails closed. A tool is advertised only when its descriptor capability is explicitly available and the permission policy does not deny it. Inventory still contains unavailable descriptors with `available: false` and an `unavailableReason`, allowing UI to explain why no action can run without probing a service.

Read tools execute without approval and their normalized output effect is always `read`. Write tools require an explicit one-call approval even if a broader permission policy says `allow`; scope and idempotency are validated before the approval callback. Destructive tools remain denied by the existing Tool Registry policy.

The idempotency key identifies the same scoped side effect across retry, replay, or reconnect. Core validates and transports the key but does not cache results or perform writes. The injected Runtime action executor owns atomic deduplication and must return the original terminal result for a repeated key in the same scope. Cross-scope keys and provider-specific retention windows remain Runtime policy.

## Surface-neutral handoff

The serialized handoff is bounded and contains references rather than content:

```json
{
  "schemaVersion": 1,
  "kind": "knowledge-agent-session-handoff",
  "agentId": "knowledge-curator",
  "sessionId": "session-1",
  "runId": "run-1",
  "cursor": 17,
  "context": { "schemaVersion": 1 },
  "sourceSurface": "knowledge-sidebar",
  "createdAt": "2026-08-09T00:00:00.000Z"
}
```

Consumption chooses the target surface while preserving session, run, cursor, and the detached Knowledge Context object. Runtime persistence and UI navigation are consumers of this value; Core performs neither.

## Executable Knowledge reads

`knowledge.query` and `knowledge.explain` execute through the existing Research Run v1 Provider boundary using the Core contract in `docs/knowledge-read-result-v1.md`. A real completed model result is normalized into KnowledgeActionOutputV1 with nested `data.kind: "knowledge-read-result"`; only its guarded non-empty `data.text` may become AI-authored annotation text. Empty, failed, cancelled, oversized, or tool-calling results never qualify as completed. Runtime advertises the fail-closed `knowledgeReads` capability with transport `research-run`; no Action Runner mapping or new endpoint is used.

## Formal Annotation archive

`knowledge.synthesis.write` now has the single typed formal-archive input described in `docs/knowledge-archive-result-v1.md`. The input uses the KB-owned exact `archive-annotation` fragment with `sourceAnnotation: {id,path,revision}`; the path is the exact case-preserved Runtime record path and is never derived by Core or React. The existing Action envelope continues to own request/session/run identity, opaque Context, authorization-root scope, expected revision, stable idempotency, and fresh per-call approval. Generic instruction text cannot identify archive targets.

The result remains KnowledgeActionOutputV1 and uses `data.kind: "knowledge-archive-result"`. Its target entries are execution evidence and are intentionally distinct from KB Annotation v2 `archive.targets`, which are requested paths only. Failed and cancelled results retain any reported bounded partial target evidence. Research Run v1 remains the only event, cancellation, replay, cursor, and terminal engine.
