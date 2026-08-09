# BioResearch OS

Web-first research agent workspace for a linked Markdown/Obsidian-style knowledge vault.

Licensed under AGPL-3.0-only.

## Start

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal. A production build can be checked with:

```bash
npm run build
```

## Runtime targets

The application uses one codebase with separate build and runtime dimensions. The current Vite host exposes a read-only `GET /api/runtime` manifest so the UI can fail closed when local-only capabilities are unavailable.

| Runtime target | Current status | Credential and local-data boundary |
| --- | --- | --- |
| `local-web` | Active development target | Provider keys stay in the browser session; ChatGPT OAuth stays in Codex/keyring; Vault access is user-selected or loopback-only |
| `desktop` | Electron host and unpacked/package build are available | Provider keys are encrypted with the OS credential service; streamed Provider requests and bounded read-only Vault access run through protected IPC, while model discovery and MCP remain on an ephemeral loopback origin; subscription OAuth remains in Codex/keyring |
| `hosted-web` | Restricted profile only; not deployable yet | Local Vault, ChatGPT subscription OAuth, and local MCP are disabled until a separate multi-user backend is designed |

Build mode (`development`, `test`, or `production`) is intentionally independent from runtime target.

## Desktop development

The desktop target reuses the same React application and starts it inside a hardened Electron window:

```bash
npm run dev:desktop       # Vite on loopback + Electron
npm run build:desktop     # unpacked desktop application under release/
npm run dist:desktop      # platform installer/package under release/
npm run verify:desktop    # validate packaged layout and secret exclusions
```

The renderer has no Node.js integration and receives only a narrow preload API. Existing provider keys are never returned to the renderer: Electron encrypts them with the operating-system credential service, binds each saved key to the endpoint origins confirmed when it was entered, and resolves it inside the desktop Provider adapter only for those origins. Changing a provider to a new gateway therefore requires entering its key again. The static application, Provider adapter, and MCP adapter use a random `127.0.0.1` port with exact Host/Origin checks. ChatGPT subscription login still requires the official `codex` executable and keeps OAuth credentials in Codex's keyring.

Desktop packaging reuses the platform-specific Electron runtime installed by `npm ci`, avoiding a second extraction step and making local and CI packaging deterministic. Project-owned SVG, PNG, ICO, and ICNS resources provide consistent application branding. The manual `Desktop package` GitHub Actions workflow builds a seven-day unsigned Windows artifact for review. Production distribution still requires platform signing, release provenance, and installer testing. API keys must never be embedded in the application bundle or supplied through `VITE_*` variables, because Vite variables are readable by the renderer.

## Testing

```bash
npm test                 # existing Node tests + Vitest unit and provider contracts
npm run test:desktop     # desktop host and encrypted-credential boundary tests
npm run test:e2e         # Playwright local-Web smoke tests
npm run build            # production bundle
npm run verify:desktop   # inspect an unpacked desktop artifact
npm run test:all         # all of the above
```

Playwright uses an installed Chrome locally and an isolated Chromium build in CI. GitHub Actions runs tests, production build, production dependency audit, and browser smoke tests on pushes and pull requests.

## Security and deployment scope

This repository is currently a local-first Web prototype, not a hardened multi-user hosted service. Making the source repository public does not make the running development services safe to expose to the Internet.

- Keep the Vite development server, ChatGPT/Codex auth bridge, Vault adapter, MCP runtime, and provider adapter bound to the local machine.
- Do not place these services behind a public reverse proxy or relay user credentials through a shared server.
- Do not commit `.env` files, API keys, OAuth tokens, local Vault data, or operating-system credential-store exports.
- A future hosted edition needs a separately designed backend with authentication and authorization, tenant isolation, CSRF/origin controls, secure secret storage, rate limiting, TLS, audit logging, and deployment-specific review.

Provider API credentials entered in the current Web prototype are intended for a local browser session. ChatGPT subscription credentials remain under the official Codex client and operating-system keyring boundary described below.

## Current slice

- Research chat workspace with evidence-trail stages
- Linked-note inspector with a query-specific retrieval path and source preview
- Offline retrieval preview that does not invent an answer when no live model is connected
- Research / Knowledge Graph / Pipelines / Runs navigation
- Responsive desktop and mobile layouts
- Local Obsidian Vault folder import with Markdown/frontmatter/`[[wikilink]]` parsing
- Interactive local wikilink graph with search, type filters, backlinks, unresolved-link diagnostics, and note preview without requiring paper2MD
- Deterministic local Vault pipelines with persisted execution traces for link integrity, retrieval readiness, and knowledge inventory
- IndexedDB-backed Vault snapshot persistence and in-app Markdown note preview
- Persistent browser directory handle with manual Vault rescan when File System Access API is available
- Optional loopback-only local Vault adapter with 15-second revision polling and read-only Markdown access
- Electron-owned Vault picker with opaque session capabilities, bounded Markdown scans, and filesystem change notifications
- Versioned local workspace snapshots that restore tabs, conversation history, drafts, agent configuration, and run metadata without persisting credentials or active runtime capabilities
- Account-aware ChatGPT model discovery through the official Codex app-server, with a six-hour metadata-only cache and manual refresh
- Markdown-aware chunking, multilingual BM25 ranking, one-hop `[[wikilink]]` expansion, and per-note evidence diversification
- Provider-neutral evidence packets injected into the user-selected ChatGPT answer model with numbered source citations
- Loopback-only ChatGPT/Codex OAuth bridge with PKCE, refresh-token rotation, account status, logout, and streaming Responses proxy
- Runtime target capability matrix with fail-closed local feature discovery
- Electron main process, sandboxed renderer, allowlisted preload IPC, and OS-encrypted provider credential storage
- Vitest unit tests, provider contract tests, Playwright smoke tests, and GitHub Actions CI
- Visual concept in `design/concept-desktop.png`

## ChatGPT subscription bridge

The default development command starts both Vite and the loopback ChatGPT auth bridge:

```bash
npm run dev
```

Use `npm run dev:web` only when the auth bridge is already running separately with `npm run auth-server`. If the bridge is unavailable, the app reports the local service address and the restart command instead of a generic browser network error.

It listens on `127.0.0.1:4318` for the app and launches the locally installed official `codex app-server`. Codex owns the OAuth + PKCE flow and its localhost callback. Research Agent forces Codex's `keyring` credential mode, so refresh tokens go to the OS credential store (Windows Credential Manager, macOS Keychain, or the platform keyring) and are never written by this project. Any legacy Research Agent `auth.json` is removed when the local service starts.

The browser receives only connection status, account display metadata, model metadata, and normalized answer events. It never receives an access token, refresh token, authorization code, PKCE verifier, or API key. The local service communicates with Codex over line-delimited JSON-RPC and does not log Codex protocol payloads.

After login, the service calls app-server `model/list` and shows the non-hidden models returned for that account. The catalog is cached for six hours in `%LOCALAPPDATA%\\bioresearch-os\\models.json`, can be refreshed from the model picker, and is removed on logout or account replacement. A stale metadata cache may be used during temporary failures; no model version is hard-coded as a fallback.

This is a local integration with the official Codex client, not the public OpenAI Platform API and not a subscription-to-API-key converter. Public API usage and ChatGPT subscriptions remain separate products. Do not expose the bridge on a public host or relay user credentials through a shared server. No other subscription login is included at this stage.

The implementation notes and source comparison are in [`docs/chatgpt-api-integration.md`](docs/chatgpt-api-integration.md).
The multi-provider protocol boundary is documented in [`docs/provider-api-architecture.md`](docs/provider-api-architecture.md). DeepSeek and Alibaba Cloud Model Studio adapters are implemented; additional providers remain incremental integrations.
The Electron process, credential, and loopback boundaries are documented in [`docs/desktop-runtime.md`](docs/desktop-runtime.md).

## Local Vault adapter

For a Web browser that cannot use the File System Access API, start the read-only local adapter with the Vault root you want to expose:

```bash
npm run vault-server -- "D:\path\to\knowledge-base"
```

The adapter listens only on `127.0.0.1:4317`, serves Markdown files under the selected root, ignores `.obsidian`, `.trash`, and `node_modules`, and exposes `GET /api/health` plus `GET /api/vault`. The Web app attempts this adapter first, falls back to browser folder selection when it is unavailable, and polls for revisions every 15 seconds after a local connection succeeds.

Use `BIORESEARCH_VAULT_PORT` to change the port or `VITE_VAULT_API_URL` when the adapter runs at another local URL.

## Model and retrieval profile

The composer model selector stores the answer model independently from retrieval settings. `Smart (Default)` provides a retrieval-only preview while disconnected and routes to the first picker-visible model returned by the connected ChatGPT account. Discovered models can also be selected explicitly, so newly released models do not require a frontend release. Future provider profiles remain visible but disabled until their API adapters exist.

The `Settings` action opens the knowledge-base profile with Markdown parsing, embedding model, optional reranker, Top K, chunk size/overlap, similarity threshold, hybrid search, and citation settings. The current retrieval engine uses multilingual BM25 plus one-hop Wikilink expansion, limits a single note to two selected chunks, and returns a provider-neutral evidence packet. When a connected answer model runs, only the retrieved excerpts—not the entire Vault—are included in its system context. Changing the answer model does not rebuild the retrieval index; changing chunk settings does.

## Next integration steps

1. Add optional embedding and reranker adapters behind the existing evidence-packet boundary.
2. Persist stream state so an interrupted Web view can reattach to an active run.
3. Add note editing safeguards and explicit change conflict handling.
4. Move long-running stream ownership and user-approved filesystem operations from loopback adapters into dedicated desktop IPC services.
5. Add signed desktop release workflows and platform-specific installer smoke tests.
