# BioResearch OS

Web-first research agent workspace for a linked Markdown/Obsidian-style knowledge vault.

Licensed under AGPL-3.0-only.

## Start

```bash
npm install
npm run auth-server
npm run dev
```

Open the local Vite URL shown in the terminal. A production build can be checked with:

```bash
npm run build
```

## Current slice

- Research chat workspace with evidence-trail stages
- Linked-note inspector with a query-specific retrieval path and source preview
- Offline retrieval preview that does not invent an answer when no live model is connected
- Research / Knowledge Graph / Pipelines / Runs navigation
- Responsive desktop and mobile layouts
- Local Obsidian Vault folder import with Markdown/frontmatter/`[[wikilink]]` parsing
- Local wikilink graph view without requiring paper2MD
- IndexedDB-backed Vault snapshot persistence and in-app Markdown note preview
- Persistent browser directory handle with manual Vault rescan when File System Access API is available
- Optional loopback-only local Vault adapter with 15-second revision polling and read-only Markdown access
- Local model registry with chat-model selector and a persisted knowledge-base retrieval profile
- Markdown-aware chunking, multilingual BM25 ranking, one-hop `[[wikilink]]` expansion, and per-note evidence diversification
- Provider-neutral evidence packets injected into the user-selected ChatGPT answer model with numbered source citations
- Loopback-only ChatGPT/Codex OAuth bridge with PKCE, refresh-token rotation, account status, logout, and streaming Responses proxy
- Visual concept in `design/concept-desktop.png`

## ChatGPT subscription bridge

The local auth bridge is an optional companion process for Web-first development:

```bash
npm run auth-server
```

It listens on `127.0.0.1:4318` for the app and temporarily uses `localhost:1455` for the OAuth callback. Credentials are stored outside the repository at `%LOCALAPPDATA%\\bioresearch-os\\auth.json` on Windows (or `$XDG_DATA_HOME/bioresearch-os/auth.json` on Linux/macOS). Override the location with `BIORESEARCH_AUTH_FILE` when needed.

The browser receives only connection status and streamed answer events. The local service keeps the OAuth access/refresh tokens, refreshes them before expiry, retries once after an upstream `401`, adds the Codex-specific headers, and routes ChatGPT subscription requests through the Codex backend. Requests use a Responses-style SSE stream with `store: false` and encrypted-reasoning round trips.

This is a ChatGPT/Codex compatibility route, not the public OpenAI Platform API. Public API usage and ChatGPT subscriptions are separate products. The endpoint and accepted models are provider-specific and may change. Do not enable the bridge on a public host without replacing the loopback trust boundary with a server-side OAuth session and encrypted secret storage. No other subscription login is included at this stage.

The implementation notes and source comparison are in [`docs/chatgpt-api-integration.md`](docs/chatgpt-api-integration.md).
The future multi-provider protocol boundary is documented in [`docs/provider-api-architecture.md`](docs/provider-api-architecture.md); those providers are researched but not enabled.

## Local Vault adapter

For a Web browser that cannot use the File System Access API, start the read-only local adapter with the Vault root you want to expose:

```bash
npm run vault-server -- "D:\Obsidian Vault\paper-knowledge-base\knowledge-base"
```

The adapter listens only on `127.0.0.1:4317`, serves Markdown files under the selected root, ignores `.obsidian`, `.trash`, and `node_modules`, and exposes `GET /api/health` plus `GET /api/vault`. The Web app attempts this adapter first, falls back to browser folder selection when it is unavailable, and polls for revisions every 15 seconds after a local connection succeeds.

Use `BIORESEARCH_VAULT_PORT` to change the port or `VITE_VAULT_API_URL` when the adapter runs at another local URL.

## Model and retrieval profile

The composer model selector stores the answer model independently from retrieval settings. `Smart (Default)` provides a retrieval-only preview while disconnected and routes to GPT-5.4 when ChatGPT is connected; GPT-5.4 and GPT-5.4 mini can also be selected explicitly. Future provider profiles remain visible but disabled until their API adapters exist.

The `Settings` action opens the knowledge-base profile with Markdown parsing, embedding model, optional reranker, Top K, chunk size/overlap, similarity threshold, hybrid search, and citation settings. The current retrieval engine uses multilingual BM25 plus one-hop Wikilink expansion, limits a single note to two selected chunks, and returns a provider-neutral evidence packet. When a connected answer model runs, only the retrieved excerpts—not the entire Vault—are included in its system context. Changing the answer model does not rebuild the retrieval index; changing chunk settings does.

## Next integration steps

1. Add optional embedding and reranker adapters behind the existing evidence-packet boundary.
2. Persist stream state so an interrupted Web view can reattach to an active run.
3. Add note editing safeguards and explicit change conflict handling.
4. Add an MCP bridge over the same local Vault adapter, then move the stable Web app into Electron.
