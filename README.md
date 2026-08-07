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

## Current slice

- Research chat workspace with evidence-trail stages
- Linked-note inspector and retrieval path
- Simulated research-agent run with a completed answer
- Research / Knowledge Graph / Pipelines / Runs navigation
- Responsive desktop and mobile layouts
- Local Obsidian Vault folder import with Markdown/frontmatter/`[[wikilink]]` parsing
- Local wikilink graph view without requiring paper2MD
- IndexedDB-backed Vault snapshot persistence and in-app Markdown note preview
- Persistent browser directory handle with manual Vault rescan when File System Access API is available
- Optional loopback-only local Vault adapter with 15-second revision polling and read-only Markdown access
- Local model registry with chat-model selector and a persisted knowledge-base retrieval profile
- Visual concept in `design/concept-desktop.png`

## Local Vault adapter

For a Web browser that cannot use the File System Access API, start the read-only local adapter with the Vault root you want to expose:

```bash
npm run vault-server -- "D:\Obsidian Vault\paper-knowledge-base\knowledge-base"
```

The adapter listens only on `127.0.0.1:4317`, serves Markdown files under the selected root, ignores `.obsidian`, `.trash`, and `node_modules`, and exposes `GET /api/health` plus `GET /api/vault`. The Web app attempts this adapter first, falls back to browser folder selection when it is unavailable, and polls for revisions every 15 seconds after a local connection succeeds.

Use `BIORESEARCH_VAULT_PORT` to change the port or `VITE_VAULT_API_URL` when the adapter runs at another local URL.

## Model and retrieval profile

The composer model selector currently stores a local profile choice without making provider calls. The `Settings` action opens the knowledge-base profile with Markdown parsing, embedding model, optional reranker, Top K, chunk size/overlap, similarity threshold, hybrid search, and citation settings. Provider connections and real vector indexing are the next integration layer.

## Next integration steps

1. Connect the model registry to OpenAI-compatible, Ollama, Gemini, and other providers.
2. Add vector retrieval and source-aware answer generation.
3. Add note editing safeguards and explicit change conflict handling.
4. Add an MCP bridge over the same local Vault adapter, then move the stable Web app into Electron.
