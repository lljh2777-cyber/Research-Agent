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

The renderer has `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. It cannot access `ipcRenderer`, Node.js, the filesystem, or decrypted stored credentials directly.

## Provider credentials

Electron `safeStorage` encrypts each provider key before it is written under the application's user-data directory. The encrypted record also contains a bounded list of allowed endpoint origins captured when the user enters the key.

The preload exposes configured status, set, delete, and fixed Provider run operations. During a provider request, the desktop host resolves a stored key only when the requested endpoint origin matches the saved scope. Changing to a new gateway requires entering the key again, preventing a compromised renderer from redirecting an existing credential to an attacker-controlled endpoint. Once a key is saved, the renderer keeps only a configured marker and never receives the decrypted value again.

## Loopback host

Packaged builds serve the application from a random `127.0.0.1` port. Requests must use the exact generated Host and Origin. The host applies a restrictive Content Security Policy and does not accept cross-origin API requests.

Provider model discovery and MCP transport remain loopback-backed. Long-running Provider streams are owned by the Electron main process behind fixed IPC methods. The main process resolves credentials, enforces per-window concurrency limits, combines cancellation with a two-minute timeout, and emits provider-neutral lifecycle events. The packaged loopback host rejects the legacy Provider streaming route, so stored credentials cannot be exercised through renderer HTTP requests.

## Current release limits

- Development artifacts are unsigned and use Electron's default icon.
- ChatGPT subscription login requires an installed official `codex` executable.
- Vault access still uses the browser directory picker or the optional read-only loopback Vault adapter.
- Provider run recovery after a full application restart is not implemented. Switching workspace tabs keeps active run state, while closing a running tab cancels its request.
- Hosted multi-user deployment is not supported by the desktop trust model.
