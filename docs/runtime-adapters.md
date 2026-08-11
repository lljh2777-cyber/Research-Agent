# Runtime adapters

The React application is Web-first. Business features use the adapter returned by `src/runtime/adapter.js` for runtime-dependent operations instead of reaching into browser globals or Electron preload APIs.

## Boundary

Runtime Adapter v1 owns these stable runtime surfaces:

- `api.fetch(input, init)`: the low-level HTTP transport. It returns `Response` and passes an `AbortSignal` in `init` unchanged.
- `vault.selectDirectory()`, `syncDirectory(handle, options)`, and `parseSelectedFiles(files)`: browser directory and file access. `loadLoopback({ revision, timeout, signal })` and `probeLoopback({ timeout, signal })` return normalized payloads; the supplied signal is combined with the adapter timeout.
- `credentials.read/write` for Web session credentials, or `hasProviderKey/setProviderKey/deleteProviderKey` for opaque desktop keychain operations.
- `storage.readLocal/writeLocal/removeLocal`: browser-local configuration persistence with an optional injected storage target for tests.
- `providers.discoverModels({ providerId, endpoint, apiKey, signal })` and `providers.streamResponse({ providerId, endpoint, endpointType, apiKey, model, messages, options, signal })`: Web Provider HTTP transport. Both return `Response`; stream parsing and display remain client/domain behavior.
- `mcp.bootstrap({ signal })` and `mcp.request({ path, body, runtimeToken, signal })`: MCP loopback transport. Both return `Response`; the MCP client owns token lifecycle and response normalization.
- `providerRuns`: optional Electron-owned streaming runs with `available`, `start`, `cancel`, and `onEvent`.
- `researchRuns`: replayable run transport, including `follow(runId, after, signal)` for abortable SSE.
- `dataFiles`: browser downloads or native Electron backup dialogs.
- `runtime.getManifest()` and `browser` utilities for capability discovery, popup access, and timers.

Every capability is present as a stable property. Unsupported optional operations remain callable but either expose `available`/`native`/`hasDesktopBridge` as `false` or reject with a clear "unavailable" error; consumers must not probe browser globals or preload APIs directly.

## Request, error, and cancellation contract

Adapter transport methods deliberately return raw `Response` values. Their corresponding client modules normalize non-OK responses into domain errors, preserving server messages when available. Browser directory permission outcomes are returned as data (`{ permission, notes, handle }`), not thrown for a denied grant. Desktop-only operations reject when no allowlisted preload capability exists.

All long-lived network methods accept an optional `AbortSignal`. Provider and MCP signals are passed to `fetch`; Vault signals are composed with the existing bounded timeout, so either cancellation source stops the request. No Adapter method silently retries or changes a caller-supplied signal.

## Stable UI mock

UI and client tests can create the complete Web contract with `createWebRuntimeAdapter({ windowRef, fetchImpl, env })`. Supply only a fake `windowRef` and `fetchImpl`; the factory returns the same frozen v1 surface used in production, including disabled desktop capabilities. This is the supported mock boundary; tests should not construct `window.researchDesktop` or replace individual browser globals in business components.

Pure research logic, retrieval, pipelines, configuration normalization, and React presentation stay runtime-independent.

## Web-first delivery

`createWebRuntimeAdapter` is the default implementation and the primary feature target. It keeps Provider credentials in session storage, uses the local HTTP adapters, and owns File System Access API calls. Web tests should be completed before extending desktop behavior.

The Runtime manifest distinguishes the full `local-web` launcher from Vite-only `vite-web` development. `npm run dev` owns the loopback ChatGPT auth service and therefore advertises OAuth and the loopback Vault adapter. `npm run dev:web` advertises only services that Vite hosts itself: it disables subscription OAuth and the absent Vault loopback adapter while retaining browser directory selection and same-origin Provider, MCP, and research-run middleware.

React and client code must consume those capability values before using optional runtime services. They must not probe a loopback port to discover availability.

`createDesktopRuntimeAdapter` decorates the Web adapter with the allowlisted preload capabilities that are actually present. Existing IPC channels remain compatibility wrappers. A later Electron milestone should change this adapter and the main/preload host, not feature components.

## Rules for new features

1. Add pure domain behavior outside the adapter.
2. Put runtime I/O behind an adapter method and inject dependencies in its tests.
3. Implement and stabilize the Web method first.
4. Keep desktop behavior compatible until the Web flow and browser tests pass.
5. Add Electron-specific IPC only during the focused desktop adaptation milestone.

## Runtime Action/Annotation v1

Round 2 adds two optional, frozen Web surfaces. They are always present on the Adapter and fail closed with `{ ok: false, unavailable: true, code: 'runtime_unavailable', surface, reason }` until a validated manifest enables them.

### Annotations

- `annotations.list({ signal })`
- `annotations.read({ path, signal })`
- `annotations.write({ intent, approval, idempotencyKey, signal })`

The write transport accepts the Knowledge Base-owned Annotation Patch Intent v1 exactly:

```js
{
  kind: 'annotation.upsert',
  annotationId,
  target: { vaultId, path, expectedRevision },
  contentType: 'text/markdown',
  content,
}
```

Runtime validates the intent shape, explicit per-call approval, stable idempotency key, Vault identity, path scope, expected revision, and the 65,536-byte content ceiling. It treats `content` as opaque: source references, TextAnchor variants, independent manual/AI sections, archive timestamps, and relocation data are never parsed, collapsed, or rewritten. Writes are serialized per path, compare the revision again before rename, use an atomic same-directory rename, and replay only an identical idempotent request. A stale revision, changed scope, or reused key with different content returns a typed conflict.

### Actions

- `actions.list({ signal })` returns the five Runtime-executable Core descriptors for `knowledge.lint`, `knowledge.paper.ingest`, `knowledge.xray`, `knowledge.code.analyze`, and `knowledge.synthesis.write`; their capability keys remain `knowledge.lint`, `actions.paperIngest`, `actions.xray`, `actions.codeAnalysis`, and `actions.synthesis`.
- `actions.start({ schemaVersion, toolId, requestId, runId, sessionId, context, scope, idempotencyKey, input, approval, signal })` accepts the Core Knowledge Action input envelope plus Runtime's per-call approval proof.
- `actions.follow(runId, { after, signal })` returns an abortable SSE `Response`.
- `actions.cancel(runId, { signal })`

Descriptors retain the Core-owned fields and risk semantics. Every descriptor with `approvalPolicy: 'explicit'` requires approval on every call, even when a broader permission is `allow`. Write Actions require explicit scope and an idempotency key. Runtime owns atomic in-process dedupe/replay and returns the original run, including its terminal result, for an identical key and scoped request.

KnowledgeContext v1 is opaque. Runtime checks only object shape, `schemaVersion: 1`, JSON serializability, and the Knowledge Base-owned 65,536-byte normalized JSON ceiling; it passes all fields through unchanged. Superseding transport limits are:

- KnowledgeContext: 65,536 bytes.
- Action input and session handoff: 131,072 bytes.
- Action output: 65,536 bytes.
- Annotation content: 65,536 bytes.
- Annotation request: 131,072 bytes, so a maximum content value remains transportable with Patch Intent metadata.

Action progress and terminal events reuse Research Run v1. Terminal states are `run.completed`, `run.failed`, or `run.cancelled`; a late runner result cannot regress a terminal run.

The local Action runner maps those five IDs to the existing Research Vault lint, ingest, X-Ray, static-code-analysis, and synthesis skills. Process creation, credentials, filesystem permissions, and writes stay server-side. React imports neither plugin runtime code nor child-process APIs.

### Capability behavior

A configured full `local-web` manifest advertises same-origin Annotation and Action services plus their exact byte limits and per-Action capability map. `vite-web`, hosted Web, unconfigured local Web, and desktop fail closed without loopback probes. Browser directory selection and Vite-hosted Provider, MCP, Research Run, and research-execution capabilities are unchanged. Desktop compatibility is preserved without adding Electron IPC.


## Knowledge Read execution v1

Research Core owns the surface-neutral `knowledge.query` / `knowledge.explain` request and normalization contract. Runtime does not add another endpoint or map these reads to the Action Runner. Core calls the existing Research Run v1 adapter with `tools: []`; local Web executes `kind: 'provider'` through `/api/research/runs` and normalizes Provider HTTP/SSE into model deltas and a terminal event.

The request includes `schemaVersion`, `kind: 'knowledge-read-run'`, `agentId`, `toolId`, `requestId`, `sessionId`, `runId`, opaque KnowledgeContext v1, and descriptor-validated input. Context remains bounded to 65,536 UTF-8 bytes and the whole request to 131,072 bytes.

A successful Provider `result.text` is normalized by Core before `run.completed` into the existing KnowledgeActionOutput v1 shape. Its `data` is `{ schemaVersion: 1, kind: 'knowledge-read-result', agentId: 'knowledge-curator', sessionId, runId, text }`; the top level retains `toolId`, `requestId`, `status: 'completed'`, `effect: 'read'`, a non-empty summary, `artifacts: []`, and `error: null`. Failed and cancelled outcomes retain the same top-level envelope with `data: null` and a bounded error. The whole output remains bounded to 65,536 bytes. Empty, oversize, or tool-calling Provider output fails before completion.

The Runtime manifest publishes this exact fail-closed surface:

```js
capabilities.knowledgeReads = {
  available: true,
  transport: 'research-run',
  capabilities: {
    'knowledge.query': true,
    'knowledge.explain': true,
  },
  reason: null,
}
```

The `local-web` target name alone does not advertise this surface. The trusted Runtime service composition must provide both a concrete selected Provider path (`providerId`, HTTP(S) `endpoint`, `model`, and credential state) and an executable Research Run service using the exact `research-run` transport. Missing, incomplete, or malformed evidence fails closed with a reason and performs no network probe. `vite-web`, desktop, hosted Web, unknown targets, and absent surfaces also publish `available: false`, `transport: false`, false capability values, and a reason.

The local launcher accepts the selected Provider evidence from the server-side `BIORESEARCH_KNOWLEDGE_PROVIDER_ID`, `BIORESEARCH_KNOWLEDGE_PROVIDER_ENDPOINT`, `BIORESEARCH_KNOWLEDGE_PROVIDER_MODEL`, and `BIORESEARCH_KNOWLEDGE_PROVIDER_CREDENTIAL` composition inputs. The credential state is `available` or `not-required`; no credential value is placed in the manifest. Consumers must still verify the concrete selected Provider request at invocation and must not infer availability from the target name, probe a loopback service, or fabricate a read result.

Provider credential access and transport remain behind Runtime adapters and the local service boundary. Credentials are forwarded only to the upstream Provider request, cleared from active execution state, and never recorded in Research Run events. With `tools: []`, Knowledge Read execution cannot request browser tools or reach Vault/Annotation persistence.
