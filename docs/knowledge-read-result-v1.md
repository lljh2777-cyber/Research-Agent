# Executable Knowledge Read Result v1

Status: frozen by Research Core for KA3-01.

This contract makes `knowledge.query` and `knowledge.explain` real model-backed reads. It is a thin normalization layer over Research Run v1, not a second run engine. Runtime supplies a concrete Provider request/executor and credentials; Core builds messages, normalizes terminal results, enforces bounds and read-only behavior, and consumes the existing event/cursor lifecycle.

## Callable surface

`src/research/knowledgeReadRun.js` exports:

- `createKnowledgeReadRunRequest(toolId, input)`
- `consumeKnowledgeReadRunRequest(value)`
- `createKnowledgeReadRunMessages(request)`
- `knowledgeReadCapabilityState(runtimeCapabilities, toolId)`
- `normalizeKnowledgeReadCompletedResult(request, providerResult)`
- `consumeKnowledgeReadResult(request, value)`
- `consumeKnowledgeReadTerminalEvent(request, event)`
- `consumeKnowledgeReadReplay(request, envelopes)`
- `executeKnowledgeReadRun(options)`
- `isCompletedKnowledgeReadResult(value)`
- `requireCompletedKnowledgeReadText(value)`

`executeKnowledgeReadRun` requires an injected `executeRun`. A renderer-owned path may also inject `providerRequest`; a loopback Runtime maps `knowledgeReadRequest` and Core-built messages to the existing `/api/research/runs` create/start/follow/cancel routes. No provider credential or endpoint is stored in the Core request.

## Request

The exact serialized request keys are:

```json
{
  "schemaVersion": 1,
  "kind": "knowledge-read-run",
  "agentId": "knowledge-curator",
  "toolId": "knowledge.explain",
  "requestId": "explain-request-1",
  "sessionId": "knowledge-session-1",
  "runId": "knowledge-run-1",
  "context": { "schemaVersion": 1 },
  "input": { "question": "Explain the selected evidence." }
}
```

Only `knowledge.query` and `knowledge.explain` are accepted. Their existing descriptor input schemas validate `input`. Knowledge Context v1 is cloned and preserved opaquely; Core does not reinterpret its note, selection, attachment, or extension fields. Context remains limited to 65,536 UTF-8 bytes and the complete request to 131,072 bytes.

`createKnowledgeReadRunMessages` returns exactly two provider-neutral messages: a system instruction and a user message containing the descriptor-validated input and opaque Context JSON. The system message identifies the context as untrusted evidence and forbids tool requests, Vault writes, annotation creation, or claims that a write occurred. The derived message array is limited to 524,288 UTF-8 bytes to account for JSON string escaping while remaining below the existing Research Run request ceiling.

## Completed output

A Provider terminal with non-empty `result.text` is normalized before `run.completed` into the existing KnowledgeActionOutputV1 top level:

```json
{
  "schemaVersion": 1,
  "toolId": "knowledge.explain",
  "requestId": "explain-request-1",
  "runId": "knowledge-run-1",
  "status": "completed",
  "effect": "read",
  "summary": "Explanation complete.",
  "data": {
    "schemaVersion": 1,
    "kind": "knowledge-read-result",
    "agentId": "knowledge-curator",
    "sessionId": "knowledge-session-1",
    "runId": "knowledge-run-1",
    "text": "The model-generated explanation."
  },
  "artifacts": [],
  "error": null
}
```

The complete output is limited to 65,536 UTF-8 bytes. Text is trimmed but otherwise preserves Unicode, Markdown, and CJK content. A provided non-empty summary is retained; otherwise the first non-empty line of text becomes the bounded summary.

Only `isCompletedKnowledgeReadResult(value) === true` or a successful `requireCompletedKnowledgeReadText(value)` authorizes a consumer to place model text into `AnnotationV1.sections.ai`. Canned UI strings, raw Provider payloads, empty text, failed outputs, and cancelled outputs do not pass this gate.

## Failure, cancellation, and empty output

Failed and cancelled outcomes reuse KnowledgeActionOutputV1 with the same tool/request/run identity, `effect: "read"`, `data: null`, `artifacts: []`, and a bounded error. Their statuses are `failed` and `cancelled` respectively.

- Provider failure becomes the existing `run.failed` event and is never followed by `run.completed`.
- Abort becomes the existing `run.cancelled` event and retains `AbortError` behavior.
- Empty, whitespace-only, oversized, or tool-calling Provider output fails normalization before `run.completed`.
- Defensive replay consumption converts an invalid historical `run.completed.result` into a failed Knowledge read output, so it cannot become completed AI annotation text.

The optional `knowledgeRead` field accepted by the existing loopback executor is not a new endpoint. It replaces caller-supplied messages with Core-built messages, forces `tools: []`, verifies request run/session identity against the Research Run record, and normalizes Provider terminal text before the Agent Engine emits completion.

## Runtime capability

Availability is explicit and fail-closed. `knowledgeReadCapabilityState` accepts a Runtime capabilities object only when it contains:

```json
{
  "knowledgeReads": {
    "available": true,
    "transport": "research-run",
    "capabilities": {
      "knowledge.query": true,
      "knowledge.explain": true
    },
    "reason": null
  }
}
```

The Runtime, not Core or UI, decides availability from a concrete selected Provider and executable Research Run path. The final Runtime checkpoint advertises this only for full local-web. Vite Web, Desktop, Hosted Web, malformed/absent surfaces, wrong transport tokens, and missing capability booleans remain unavailable with a reason and no probing.

## Replay, cursor, and handoff

Research Run v1 remains authoritative:

1. `model.text.delta` streams partial model text.
2. SSE envelopes retain monotonic cursors.
3. `consumeKnowledgeReadReplay` returns `{ cursor, output }` from the latest terminal envelope.
4. `run.completed`, `run.failed`, and `run.cancelled` remain terminal and reject later transitions.
5. Existing `reattachResearchRun` obtains snapshots/events; the consumer passes replay envelopes to `consumeKnowledgeReadReplay`.
6. Existing Knowledge Agent session handoff preserves `agentId`, `sessionId`, `runId`, cursor, and opaque Context between sidebar and Research.

Cursor and Context are intentionally not duplicated inside the 65,536-byte completed output: cursor belongs to the replay envelope and Context belongs to the bounded request/session handoff.

## Fixture

`docs/contracts/knowledge-read-result-v1.fixture.json` freezes a CJK `knowledge.explain` request and completed KnowledgeActionOutputV1. The request includes an opaque Context extension to prove Core preserves unknown Knowledge Base-owned fields.
