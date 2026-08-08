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

The preload exposes only configured status, set, and delete operations. During a provider request, the desktop host resolves a stored key only when the requested endpoint origin matches the saved scope. Changing to a new gateway requires entering the key again, preventing a compromised renderer from redirecting an existing credential to an attacker-controlled endpoint.

## Loopback host

Packaged builds serve the application from a random `127.0.0.1` port. Requests must use the exact generated Host and Origin. The host applies a restrictive Content Security Policy and does not accept cross-origin API requests.

Provider and MCP transport remain loopback-backed in this milestone. Long-running stream ownership, direct filesystem access, and MCP process ownership can move behind dedicated IPC services later without changing the provider-neutral frontend contracts.

## Current release limits

- Development artifacts are unsigned and use Electron's default icon.
- ChatGPT subscription login requires an installed official `codex` executable.
- Vault access still uses the browser directory picker or the optional read-only loopback Vault adapter.
- Hosted multi-user deployment is not supported by the desktop trust model.
