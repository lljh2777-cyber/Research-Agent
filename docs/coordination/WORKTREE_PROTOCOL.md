# Multi-Worktree Coordination Protocol

## Objective

Develop the Web application first using independent worktrees divided by responsibility. Keep Electron compatible, but defer concentrated Electron adaptation until the Web implementation is stable.

All business features must access API, Vault, providers, credentials, MCP, and browser persistence through shared runtime adapters. React components must not embed runtime-specific browser or Electron logic.

## Branches and worktrees

| Task | Branch | Worktree |
|---|---|---|
| Knowledge Base | `codex/round5-retrieval-contracts` | `D:\research_agent-worktree\round5\knowledge-base` |
| Research Core | `codex/round5-hybrid-retrieval` | `D:\research_agent-worktree\round5\research-core` |
| Research Web UI | `codex/round5-retrieval-ui` | `D:\research_agent-worktree\round5\research-web-ui` |
| Web Runtime | `codex/round5-siliconflow-runtime` | `D:\research_agent-worktree\round5\web-runtime` |
| Web Integration | `integration/web` | `D:\research_agent-worktree\integration\web` |

The formal baseline is recorded in `D:\research_agent-worktree\.coordination\shared\current-baseline.json`. All worktrees must be created from the same formal baseline.

## Sources of truth

- Git commit and worktree state are the source of truth for code.
- `D:\research_agent-worktree\.coordination\status\*.json` is the source of truth for live task state.
- `D:\research_agent-worktree\.coordination\handoff\*.md` contains detailed integration handoffs.
- Task messages provide immediate notification but never replace status files or Git verification.

## Task lifecycle

Allowed states are:

1. `not_started`
2. `in_progress`
3. `blocked`
4. `ready_for_integration`
5. `integrated`
6. `failed`

A feature task must update its status when it:

- starts work;
- starts or completes a planned step;
- becomes blocked or unblocked;
- changes a shared contract;
- creates a commit;
- obtains a test result;
- becomes ready for integration;
- receives an integration failure that requires a fix.

## Shared contracts

Shared contracts include:

- Research Run states and events;
- Runtime Adapter methods and runtime capabilities;
- Vault, retrieval, evidence packet, and knowledge graph data shapes;
- Tool Registry definitions and execution results;
- persisted workspace and run snapshot formats.

The owning task must make contract changes in a focused commit, update contract tests, record affected tasks, and notify Integration. Integration validates and publishes contract checkpoints before dependent tasks adopt the new interface.

## Ready-for-integration gate

`readyForIntegration` may be set to `true` only when:

- the requested scope is complete;
- all changes are committed;
- the feature worktree is clean;
- `headCommit` equals the actual branch HEAD;
- relevant tests pass;
- shared contract changes and affected tasks are documented;
- the task handoff is complete;
- blockers and known issues are recorded.

## Integration behavior

Integration checks status files and independently verifies each worktree using Git. It must not merge based only on a self-reported status.

Integration merges one feature branch at a time, runs targeted tests after each merge, and runs the complete suite only after all eligible branches are integrated. A functional defect is returned to the owning feature task. Integration owns cross-module wiring and mechanical merge conflicts, not silent rewrites of feature logic.

The Round 5 dependency and merge order is:

1. `codex/round5-retrieval-contracts`
2. `codex/round5-siliconflow-runtime`
3. `codex/round5-hybrid-retrieval`
4. `codex/round5-retrieval-ui`

The order may change when explicit dependencies require it.

After all branches are integrated, run:

```powershell
npm test
npm run test:e2e
npm run build
```

Browser acceptance must cover first-run state, Vault connection, Research configuration, tool-free and tool-enabled runs, cancellation, refresh recovery, provider failure, Settings, Knowledge Graph, and Pipeline behavior.

Only a clean, fully verified `integration/web` may be proposed for merge into `main`.

## Task communication

Send immediate task messages for:

- `CONTRACT CHANGE`
- `BLOCKED`
- `READY FOR INTEGRATION`
- `INTEGRATION FAILED`
- `INTEGRATED`

When task messaging is unavailable, update the status and handoff files. Integration polling is the fallback.
