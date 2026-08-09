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

`createDesktopRuntimeAdapter` decorates the Web adapter with the allowlisted preload capabilities that are actually present. Existing IPC channels remain compatibility wrappers. A later Electron milestone should change this adapter and the main/preload host, not feature components.

## Rules for new features

1. Add pure domain behavior outside the adapter.
2. Put runtime I/O behind an adapter method and inject dependencies in its tests.
3. Implement and stabilize the Web method first.
4. Keep desktop behavior compatible until the Web flow and browser tests pass.
5. Add Electron-specific IPC only during the focused desktop adaptation milestone.
