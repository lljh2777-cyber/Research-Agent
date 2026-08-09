# Desktop runtime

Research Agent uses the same React bundle for local Web development and Electron. The desktop host changes the trust boundary without forking the application.

## Process boundary

```text
Electron main process
├── sandboxed BrowserWindow
├── allowlisted preload IPC
│   ├── runtime manifest
│   └── provider credential status / set / delete
├── OS-encrypted provider credential store
├── ephemeral 127.0.0.1 application host
│   ├── static React bundle
│   ├── Provider adapter
│   └── MCP adapter
└── loopback Codex auth service
```

The renderer has `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. It cannot access `ipcRenderer`, Node.js, arbitrary filesystem paths, or decrypted stored credentials directly.

## Vault access

Desktop Vault access is owned by the Electron main process. The renderer asks the host to show the operating-system directory picker and receives an opaque, session-only Vault capability plus Markdown contents identified only by relative path. Later synchronization sends only that capability and a bounded revision string; absolute paths never cross the preload boundary.

The scanner is read-only, skips plugin/trash/dependency directories and symbolic links, canonicalizes every traversed path, and enforces limits of 20,000 Markdown files, 10 MB per note, and 200 MB per Vault. A filesystem watcher sends only a debounced change notification, after which the renderer requests a fresh bounded snapshot. Closing the renderer revokes all of its Vault capabilities.

## Workspace persistence

Workspace tabs, conversation messages, drafts, agent configuration snapshots, and completed run metadata are saved locally in a versioned IndexedDB snapshot, with a bounded localStorage fallback. Restored configuration is normalized against the current agent permission ceiling. Active requests, tool approvals, retrieval packets, decrypted credentials, OAuth tokens, directory handles, and desktop Vault capabilities are never persisted or resumed.

## Provider credentials

Electron `safeStorage` encrypts each provider key before it is written under the application's user-data directory. The encrypted record also contains a bounded list of allowed endpoint origins captured when the user enters the key.

The preload exposes configured status, set, delete, and fixed Provider run operations. During a provider request, the desktop host resolves a stored key only when the requested endpoint origin matches the saved scope. Changing to a new gateway requires entering the key again, preventing a compromised renderer from redirecting an existing credential to an attacker-controlled endpoint. Once a key is saved, the renderer keeps only a configured marker and never receives the decrypted value again.

## Loopback host

Packaged builds serve the application from a random `127.0.0.1` port. Requests must use the exact generated Host and Origin. The host applies a restrictive Content Security Policy and does not accept cross-origin API requests.

Provider model discovery and MCP transport remain loopback-backed. Long-running Provider streams are owned by the Electron main process behind fixed IPC methods. The main process resolves credentials, enforces per-window concurrency limits, combines cancellation with a two-minute timeout, and emits provider-neutral lifecycle events. The packaged loopback host rejects the legacy Provider streaming route, so stored credentials cannot be exercised through renderer HTTP requests.

## Current release limits

- Development artifacts are unsigned and use the project-owned BioResearch OS icon across Windows, macOS, and Linux packages.
- Desktop builds reuse the host platform and architecture from `node_modules/electron/dist`; cross-platform and cross-architecture packages must be built on matching CI runners.
- The manual Windows packaging workflow uploads review artifacts for seven days but does not publish a GitHub Release.
- ChatGPT subscription login requires an installed official `codex` executable.
- Desktop Vault capabilities are session-only. After a full application restart, the cached snapshot remains visible but the user must reselect the folder before live synchronization resumes.
- Provider run recovery after a full application restart is not implemented. Switching workspace tabs keeps active run state, while closing a running tab cancels its request.
- Hosted multi-user deployment is not supported by the desktop trust model.
