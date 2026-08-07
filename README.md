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
- Visual concept in `design/concept-desktop.png`

## Next integration steps

1. Connect the Obsidian vault through a local filesystem adapter or MCP server for broader browser support.
2. Add vector retrieval and source-aware answer generation.
3. Add automatic file-change synchronization and note editing safeguards.
4. Move the stable Web app into an Electron shell with the same renderer.
