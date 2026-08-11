# Annotation v2 provenance and archive contract

Status: frozen for Round 4 (KB4-01). Annotation v1 remains frozen and supported. Knowledge Base owns normalization, migration, Markdown representation, anchoring, relocation, fixtures, and pure reference validation.

The implementation is runtime-neutral. It performs no React, Runtime I/O, Provider or credential access, approval execution, Core run execution, Obsidian access, source Markdown rewrite, or wikilink insertion.

## Dual-version behavior

`normalizeAnnotation`, `parseAnnotationMarkdown`, and `serializeAnnotationMarkdown` accept schema versions 1 and 2. They preserve the input version. `migrateAnnotationToV2` is the only implicit-v1-to-explicit-v2 conversion API.

Annotation v1 retains its exact normalized keys, frontmatter order, Manual/AI markers, archive timestamp invariants, and `AnnotationPatchIntentV1` representation. Existing Web quote+position/range anchors and deterministic relocation are unchanged.

Annotation v2 has these exact normalized top-level keys in order:

```json
{
  "schemaVersion": 2,
  "id": "annotation-cjk-1",
  "source": {
    "vaultId": "vault-1",
    "noteId": "note-1",
    "path": "论文/发现.md",
    "revision": "note-rev-8"
  },
  "anchor": "TextAnchorV1",
  "sections": { "manual": "...", "ai": "..." },
  "aiProvenance": {
    "providerId": "provider-safe-id",
    "modelId": "model-safe-id",
    "generatedAt": "2026-08-11T04:10:00.000Z"
  },
  "archive": {
    "state": "completed",
    "targets": ["knowledge/findings.md"],
    "runId": "archive-run-1",
    "error": null
  },
  "archived": true,
  "timestamps": {
    "createdAt": "2026-08-11T04:00:00.000Z",
    "updatedAt": "2026-08-11T04:15:00.000Z",
    "archivedAt": "2026-08-11T04:15:00.000Z"
  },
  "relocation": "RelocationV1"
}
```

`source` identifies the authoritative note and note revision that supplied the anchor. It is not the formal archive source reference and is never rewritten by archive lifecycle changes.

## Safe AI provenance

`aiProvenance` is exactly `null` or `{providerId, modelId, generatedAt}`. Provider and model values are display-safe opaque identifiers, each limited to 256 UTF-8 bytes. Credentials, endpoints, headers, prompts, and arbitrary Provider metadata are not normalized or serialized. Provenance requires non-empty `sections.ai`, and `generatedAt` must fall from `timestamps.createdAt` through `timestamps.updatedAt`, inclusive. Migration never fabricates provenance.

## Archive lifecycle

`archive.state` is one of `none`, `pending`, `completed`, or `failed`.

- `none`: `targets` is empty and `runId`/`error` are null.
- `pending`: has at least one target and a non-empty `runId`; `error` is null.
- `completed`: `error` is null. A new completed execution has non-empty targets and a non-null `runId`. Empty targets plus null `runId` is reserved exclusively for the v1 `archived=true` migration representation and cannot authorize or describe a new execution. The two forms are paired invariants: empty targets with a run ID and non-empty targets with a null run ID are invalid and fail normalize/parse/serialize.
- `failed`: has a typed `error`; targets and `runId` preserve whatever bounded lifecycle identity is known.

`error` is null or exactly `{code, message}`. `code` is `archive_cancelled` or `archive_failed`, limited to 64 UTF-8 bytes; `message` is non-empty and limited to 1,024 UTF-8 bytes. Cancellation is `failed` with `code: "archive_cancelled"`. `createArchiveCancellationError()` returns the authoritative default error fixture.

The legacy `archived` field is a derived projection in v2. It is true only when `archive.state` is `completed`; supplied contradictory values are normalized away. `timestamps.archivedAt` is required for `completed` and must be null for `none`, `pending`, and `failed`. Pending or failed archive work therefore never hides a saved annotation. Archive lifecycle changes do not alter `source`, `anchor`, `sections`, or `relocation`.

Legacy v1 migration is exact:

- `archived: false` becomes `archive: {state:"none", targets:[], runId:null, error:null}`;
- `archived: true` becomes `archive: {state:"completed", targets:[], runId:null, error:null}`;
- `aiProvenance` is always null.

## Archive targets and source annotation reference

`archive.targets` is an ordered, duplicate-free array of relative Vault Markdown paths. Paths use forward slashes, contain no control character or empty, `.` or `..` segment, have no drive/root prefix, and end in `.md` case-insensitively. Knowledge Base does not resolve, create, rewrite, or check these paths. Limits are 32 targets, 1,024 UTF-8 bytes per path, and 16,384 UTF-8 bytes for the serialized target array.

The typed fragment required in Core formal archive input is exactly `{operation:"archive-annotation", sourceAnnotation:{id,revision}, targets:string[]}`. A new request has 1–32 targets normalized by the same rules. `normalizeArchiveAnnotationInput` validates this fragment. The existing Knowledge Action scope remains the authorization root; approval must display both that root scope and the exact ordered target list. Generic instruction/free text cannot encode target identity.

`sourceAnnotation.id` must equal `AnnotationV1|V2.id`; `sourceAnnotation.revision` is the non-empty opaque Runtime annotation revision captured for approval/concurrency, not `annotation.source.revision` (the source note revision) and not any archive-target expected/result revision. `archive.targets` records requested normalized paths. It is not proof that every path committed. Core result per-target status/revision is execution evidence; failed/cancelled results may enumerate partial commits, and consumers must not infer success for every requested path. The authoritative typed-input fixture is `docs/contracts/annotation-archive-v1.fixture.json`.

## Deterministic Markdown and bounds

V2 frontmatter is JSON-valued and ordered as: `annotation_schema`, `id`, `source`, `anchor`, `ai_provenance`, `archive`, `archived`, `created_at`, `updated_at`, `archived_at`, `relocation`. The stable headings and machine markers remain:

```markdown
## Manual
<!-- annotation:manual:start -->
...
<!-- annotation:manual:end -->

## AI
<!-- annotation:ai:start -->
...
<!-- annotation:ai:end -->
```

Each section is limited to 65,536 UTF-8 bytes. The pure KB parser accepts direct external/legacy diagnostic input up to 262,144 UTF-8 bytes. That tolerance applies only outside `runtime.annotations.read/list`: connected Runtime records above 65,536 bytes cannot be listed/read and are not a supported save/reload path.

A persistable record has a stricter total ceiling. `createAnnotationPatchIntent` byte-counts its exact serialized `content`—frontmatter, headings, markers, section text, and trailing newlines—and accepts at most 65,536 UTF-8 bytes. Exactly 65,536 passes; 65,537 or more fails before a patch intent is returned or Runtime is invoked. Thus a directly parsed/normalized oversized record may be inspected diagnostically but is not saveable until reduced. `AnnotationPatchIntentV1` keys and semantics remain unchanged.

Runtime independently owns the final raw JSON request ceiling of 131,072 bytes, including JSON escaping, approval, and idempotency. KB does not assemble or validate that Runtime envelope, and UI must not duplicate the logic in React. `docs/contracts/annotation-write-boundary-v1.fixture.json` freezes the exact content-boundary recipe and an escaping-heavy consumer case for Runtime4 parity tests.

Annotation/source reference IDs are limited to 256 UTF-8 bytes; source paths to 4,096; run IDs and annotation revisions to 256. Reserved section markers remain rejected. LF is canonical; CRLF parses to the same normalized record.

The required byte-level invariant is:

```text
serializeAnnotationMarkdown(parseAnnotationMarkdown(serializeAnnotationMarkdown(v2)))
=== serializeAnnotationMarkdown(v2)
```

The enriched authoritative record is `docs/contracts/annotation-v2.fixture.json`, including UTF-8/CJK sections, provenance, completed archive targets, the original source/anchor, and relocation.

## Consumer boundary

- Core validates/authenticates provenance inputs and embeds the frozen typed archive fragment in its existing scoped/approved Action contract. New pending/completed execution requires non-empty targets and a run ID.
- Runtime persists serialized Annotation Markdown opaquely through the existing Annotation Adapter and unchanged patch intent. Runtime4 owns final-envelope preflight at 131,072 bytes and service parity for the escaping adversary; it does not reinterpret v2 fields.
- UI renders and edits through the KB normalizer/serializer, uses the KB patch-intent guard before save, and does not hard-code Runtime envelope logic. It treats only `archived === true` (therefore only completed archive) as the legacy hidden projection.
- Archive execution and result atomicity remain Core/Runtime responsibilities. Knowledge Base performs no archive action.
