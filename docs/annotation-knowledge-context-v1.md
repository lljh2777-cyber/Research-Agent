# Annotation v1 and Knowledge Context v1

Status: frozen for Round 2. Knowledge Base owns both shapes. Consumers must preserve them without redefining, dropping, or flattening fields.

The implementation is runtime-neutral: it imports no React, browser, Electron, Obsidian, Provider, filesystem, storage, or credential API. A host may persist only the returned patch intent.

## Annotation v1

`AnnotationV1` is JSON-serializable and has this exact shape:

```json
{
  "schemaVersion": 1,
  "id": "annotation-1",
  "source": {
    "vaultId": "vault-1",
    "noteId": "note-1",
    "path": "papers/findings.md",
    "revision": "note-rev-4"
  },
  "anchor": {
    "schemaVersion": 1,
    "quote": {
      "exact": "selected evidence",
      "prefix": "# Findings\nThe ",
      "suffix": " is reproducible.\n"
    },
    "position": { "start": 15, "end": 32 },
    "heading": {
      "text": "Findings",
      "level": 1,
      "line": 1,
      "relativeStartLine": 1,
      "relativeEndLine": 1
    },
    "line": { "start": 2, "end": 2 }
  },
  "sections": {
    "manual": "Researcher-authored Markdown.",
    "ai": "AI-authored Markdown."
  },
  "archived": false,
  "timestamps": {
    "createdAt": "2026-08-09T12:00:00.000Z",
    "updatedAt": "2026-08-09T12:05:00.000Z",
    "archivedAt": null
  },
  "relocation": {
    "schemaVersion": 1,
    "status": "anchored",
    "strategy": "position",
    "start": 15,
    "end": 32,
    "candidates": 1
  }
}
```

An archived annotation must set `archived` to `true` and `timestamps.archivedAt` to a valid timestamp. An active annotation must use `null` for `archivedAt`. `sections.manual` and `sections.ai` are independent Markdown strings; serializers never merge them.

### Anchoring and deterministic relocation

`createTextAnchor(markdown, selection)` records four selectors: the exact quote with prefix/suffix context, the original character position, the nearest preceding ATX heading with relative line offsets, and absolute line offsets. It rejects selections overlapping YAML frontmatter, fenced or inline code, and HTML comments.

`relocateTextAnchor(markdown, anchor)` applies this fixed order:

1. Return `anchored/position` when the exact quote remains at the original unprotected position.
2. Find exact quote occurrences outside protected Markdown. One match returns `relocated/quote` or `relocated/quote_context`; multiple matches use the greatest prefix-plus-suffix match score. A tied top score returns `ambiguous/none` and no range.
3. If the quote disappeared, a unique matching heading plus relative lines returns `stale/heading_line`.
4. Otherwise, a still-valid absolute line range returns `stale/line`.
5. If no selector survives, return `missing/none`.

The relocation result always contains `schemaVersion`, `status`, `strategy`, nullable `start`/`end`, and `candidates`. It never silently chooses among tied candidates.

### Markdown representation and patch intent

`serializeAnnotationMarkdown` writes JSON-valued frontmatter followed by stable `## Manual` and `## AI` sections delimited with reserved HTML comments. `parseAnnotationMarkdown` accepts LF or CRLF and reconstructs the normalized contract. Section content containing a reserved marker is rejected.

Writes are data only:

```json
{
  "schemaVersion": 1,
  "kind": "annotation.upsert",
  "annotationId": "annotation-1",
  "target": {
    "vaultId": "vault-1",
    "path": ".annotations/annotation-1.md",
    "expectedRevision": "annotation-rev-2"
  },
  "contentType": "text/markdown",
  "content": "...serialized Annotation Markdown..."
}
```

Only a runtime/storage owner may execute this intent. Knowledge Base performs no write.

## Knowledge Context v1

`KnowledgeContextV1` is a surface-neutral, JSON-serializable envelope with this exact shape:

```json
{
  "schemaVersion": 1,
  "surface": "research",
  "vault": {
    "id": "vault-1",
    "name": "Lab Vault",
    "revision": "vault-rev-9"
  },
  "activeNote": {
    "id": "note-1",
    "path": "papers/findings.md",
    "title": "Findings",
    "revision": "note-rev-4"
  },
  "selection": {
    "noteId": "note-1",
    "anchor": "TextAnchorV1"
  },
  "attachments": [
    {
      "id": "attachment-1",
      "name": "Dataset",
      "kind": "artifact",
      "reference": "artifact://dataset-7",
      "mediaType": "text/csv"
    }
  ],
  "contextRevision": "context-rev-3"
}
```

`surface` is a non-empty producer-supplied string rather than a UI enum. `activeNote` and `selection` may each be `null`; a selection requires an active note and its `noteId` must match. The builders never fabricate an active note for a first-run or empty Vault. Attachment `kind` is one of `vault_note`, `artifact`, `file`, or `url`; `reference` remains an opaque string and `mediaType` may be `null`.

The UTF-8 byte length of the normalized JSON envelope must be at most 65,536 bytes. Oversize contexts are rejected before Core transport. Consumers must preserve the entire object opaquely.

## Consumer responsibilities

- Research Core: preserve `KnowledgeContextV1` unchanged in Action Tool inputs and session handoffs; do not redefine Annotation or Context fields.
- Web Runtime: transport the complete envelopes and execute patch intents through its runtime/storage adapters; do not collapse anchors or annotations.
- Research Web UI: build contexts and render relocation states/manual/AI sections using these shapes; do not add runtime probes to Knowledge Base.

Authoritative fixtures are `docs/contracts/annotation-v1.fixture.json` and `docs/contracts/knowledge-context-v1.fixture.json`. Contract tests parse and normalize both fixtures.
