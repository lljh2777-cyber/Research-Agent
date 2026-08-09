# Runtime adapters

The React application is Web-first. Business features use the adapter returned by `src/runtime/adapter.js` for runtime-dependent operations instead of reaching into browser globals or Electron preload APIs.

## Boundary

The adapter owns five runtime surfaces:

- `api`: HTTP transport used by ChatGPT, Provider, MCP, Vault, and runtime-manifest clients.
- `vault`: loopback loading, browser folder selection and parsing, plus the optional Electron Vault bridge.
- `credentials`: browser-session Provider keys or opaque OS-keychain operations.
- `providerRuns`: optional Electron-owned streaming runs.
- `dataFiles`: browser downloads or native Electron backup dialogs.

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
