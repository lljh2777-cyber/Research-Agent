# Knowledge Archive Result v1

Status: frozen by Research Core for CORE4-01 against integrated KB4 baseline `70ce934296ebd0249eb0c8c03ad9b60fa4221da9`.

This contract makes formal knowledge archive a later, separately approved operation after Annotation review and save. It reuses `knowledge.synthesis.write`, KnowledgeActionOutputV1, the existing Tool Registry approval path, and Research Run v1. It adds no endpoint, run engine, Provider logic, persistence, React behavior, automatic Annotation write, or rollback transaction.

## Callable surface

`src/research/knowledgeArchive.js` exports:

- `createKnowledgeArchiveActionInput`
- `consumeKnowledgeArchiveActionInput`
- `normalizeKnowledgeArchiveTargetEvidence`
- `createKnowledgeArchiveResult`
- `consumeKnowledgeArchiveExecutionResult`
- `consumeKnowledgeArchiveResult`
- `isCompletedKnowledgeArchiveResult`
- `requireCompletedKnowledgeArchiveResult`
- `createKnowledgeArchivePendingState`
- `knowledgeArchiveResultToAnnotationArchive`
- `consumeKnowledgeArchiveTerminalEvent`
- `consumeKnowledgeArchiveReplay`

## Request and approval

The complete request is the existing Knowledge Action input. `toolId` is `knowledge.synthesis.write`; request, session, and run IDs are non-empty; Knowledge Context remains opaque; write scope, `expectedRevision`, and idempotency retain their v1 meanings.

The exact nested input is KB-owned and normalized through `normalizeArchiveAnnotationInput`:

```json
{
  "operation": "archive-annotation",
  "sourceAnnotation": {
    "id": "annotation-cjk-1",
    "path": "wiki/annotations/annotation-cjk-1.MD",
    "revision": "annotation-rev-7"
  },
  "targets": [
    "knowledge/findings.md",
    "知识/证据汇总.md"
  ]
}
```

`sourceAnnotation` is exactly `{id,path,revision}`. `path` is the exact loaded Runtime Annotation record path, validated but never derived or rewritten by Core: it stays under `wiki/annotations/`, preserves actual casing, accepts the Markdown extension case-insensitively, and is bounded to 512 JavaScript UTF-16 code units. `revision` is the opaque Runtime content revision for that exact path, not the source-note or archive-target revision. Runtime must re-read that path and compare the revision before execution; UI carries all three values from the same loaded record. The archive request `runId` additionally obeys the KB-owned 256 UTF-8-byte archive lifecycle bound without changing generic Research Run IDs. Targets are 1..32 ordered, unique, normalized relative Vault `.md` paths under the KB-owned 1,024-byte-per-path and 16,384-byte serialized-list ceilings. Extra/free-text input keys fail before owner normalization. Scope is the authorization root; every invocation requires a fresh explicit approval that includes both the root scope and exact normalized targets. Stable scope-bound idempotency remains Runtime-owned for atomic dedupe/replay.

## Result

The top level is exactly KnowledgeActionOutputV1. The completed data subtype is:

```json
{
  "schemaVersion": 1,
  "kind": "knowledge-archive-result",
  "sourceAnnotation": {
    "id": "annotation-cjk-1",
    "path": "wiki/annotations/annotation-cjk-1.MD",
    "revision": "annotation-rev-7"
  },
  "targets": [
    {
      "path": "knowledge/findings.md",
      "status": "updated",
      "revision": "target-rev-8"
    }
  ]
}
```

Target status is exactly `created`, `updated`, or `unchanged`; revision is null or an opaque non-empty string of at most 256 UTF-8 bytes. Evidence paths must be requested, unique, and in requested order. A completed result requires evidence for every requested path in exact order. New execution never accepts the KB migration-only empty-target/null-run form. `artifacts` is empty because execution evidence belongs only in `data.targets`. The complete Action output retains the existing 65,536-byte ceiling.

## Failure, cancellation, and partial effects

Failed and cancelled Core results keep their Research Run truth with statuses `failed` and `cancelled`. Their exact errors are `{code,message}` using `archive_failed` and `archive_cancelled`. They may contain an ordered subset of successful target evidence when earlier targets committed before the terminal failure. Missing evidence never implies no side effect: Runtime must either report every committed target or guarantee atomic/cancel-before-commit behavior.

`knowledgeArchiveResultToAnnotationArchive` maps both failed and cancelled Core results to KB Annotation v2 `archive.state: "failed"`; cancellation uses `archive_cancelled`. KB `archive.targets` always remains the complete requested path list and is never commit proof. The saved Annotation is a prerequisite and is not rolled back, hidden, or rewritten by archive failure.

Action terminal placement is exact and preserves the full bounded KnowledgeActionOutputV1: `run.completed` uses `event.output`; `run.failed` and `run.cancelled` use optional `event.result` so legacy terminals without partial evidence remain valid. The Action output/result JSON is bounded to 65,536 UTF-8 bytes. Provider and Knowledge Read terminal `result` semantics are unchanged. Research Run v1 adds no event or status; terminal protection remains authoritative, and replay returns the latest terminal Action value plus its cursor.

## Fixtures and ownership

`docs/contracts/knowledge-archive-result-v1.fixture.json` freezes the Core request plus completed, partial-failed, and partial-cancelled outputs. Tests also consume the integrated owner fixture `docs/contracts/annotation-archive-v1.fixture.json` directly.

- Knowledge Base owns input/path/source-reference normalization and Annotation v2 persistence shapes.
- Core owns Action descriptor/input enforcement, output/evidence normalization, completion guards, approval evidence, and Research Run terminal consumption.
- Runtime owns archive execution, durable scoped idempotency, atomicity or truthful partial evidence, paths/revisions produced by writes, and transport.
- UI owns staged review/save/archive interaction and never treats requested paths as commit proof.
