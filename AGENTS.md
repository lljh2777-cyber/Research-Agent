# Repository Agent Instructions

## Environment safety

- Close browser tabs that are no longer needed promptly.
- Use `D:\python\python.exe` when Python is required.
- Bulk deletion of files or directories is prohibited.
- Do not use `del /s`, `rd /s`, `rmdir /s`, `Remove-Item -Recurse`, or `rm -rf`.
- Delete only one explicitly named file at a time. Ask the user to perform bulk deletion manually.

## Multi-worktree development

This repository uses a Web-first, multi-worktree workflow. Before changing code, read:

1. `docs/coordination/WORKTREE_PROTOCOL.md`
2. `D:\research_agent-worktree\.coordination\README.md`
3. The task definition named for the current branch under `D:\research_agent-worktree\.coordination\tasks`
4. The task status named for the current branch under `D:\research_agent-worktree\.coordination\status`

Every Codex task must:

- verify its repository root, branch, HEAD, and worktree status before editing;
- modify only files within its assigned responsibility;
- keep Web implementation as the priority and maintain Electron compatibility without expanding Electron features;
- access API, Vault, provider, credential, MCP, and storage functionality through shared runtime adapters;
- avoid hard-coding browser or Electron runtime logic in React business components;
- update its own central status file when starting, completing a step, becoming blocked, changing a shared contract, committing, testing, or becoming ready for integration;
- update its own handoff document before requesting integration;
- update contract tests whenever a shared interface changes;
- merge through `integration/web`, never directly into `main`;
- never merge another feature branch into its own feature branch unless the integration protocol explicitly requires a contract checkpoint.

`src/main.jsx` and `src/styles.css` are primarily owned by `codex/research-web-ui`. Other tasks must coordinate before modifying them.

Only `integration/web` may perform cross-feature integration. Integration may inspect feature worktrees but must not edit them.
