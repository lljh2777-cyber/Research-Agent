# Research Runtime

## Current boundary

Research conversations use a versioned run protocol instead of treating a React request as the run itself:

```text
Research UI
  -> research/client
  -> loopback ResearchRunManager (identity + bounded event history)
  -> runtime-selected executor
     -> loopback Provider Agent Engine (local Web API providers)
     -> renderer Agent Engine (ChatGPT subscription, offline preview, desktop compatibility)
     -> model request adapter
     -> permission-filtered Tool Registry
     -> normalized run events
  -> versioned workspace run record
```

`src/research/client.js` is the replaceable UI boundary. Runtime capabilities choose the executor instead of React checking for a browser or Electron directly. Local-Web API providers use `researchExecution: loopback-provider`: the loopback process owns the Provider stream and Agent loop, while the client follows the run through replayable SSE. ChatGPT subscription, offline preview, and the current desktop compatibility path continue to use the framework-neutral renderer engine.

Provider credentials are sent only to the same-origin loopback start route, retained only in the active executor closure, cleared when the run finishes, and never written into the run record or event buffer. Both the Vite host and packaged desktop static host expose the same adapter contract; the desktop capability keeps Provider execution on its existing protected IPC compatibility path.

## Delegated browser tools

The loopback executor does not receive browser directory handles or bypass tool permissions. When the model requests a tool, it emits `tool.execution.requested` with a unique request ID and moves the run to `waiting-approval`. The Research client executes the call through the permission-filtered Tool Registry and posts the provider-neutral result to `/tool-results`. `tool.execution.completed` moves the run back to `running`.

On reattachment, the client first loads the complete bounded replay window and builds a set of completed tool request IDs before dispatching unresolved requests. A tool whose completion event is already recorded is never executed again. As with any crash boundary, a side effect that completed locally but crashed before its completion acknowledgement cannot be proven exactly-once; future write tools must therefore use their own idempotency keys and conflict checks.

## Run contract

Every run has a stable ID, session ID, model and policy snapshots, evidence count, timestamps, iteration count, terminal status, and a sanitized error. Events use provider-neutral names such as:

- `run.started`
- `model.started`
- `model.text.delta`
- `model.reasoning.delta`
- `tool.round.started`
- `tool.round.completed`
- `run.completed`, `run.failed`, or `run.cancelled`

The Agent Engine applies the conversation's `maxToolRounds`, `maxToolCallsPerRound`, and evidence policy. Tool-free ChatGPT/Codex responses and tool-capable API providers enter through this same engine. The current ChatGPT subscription bridge intentionally remains tool-free because its read-only Codex route explicitly disables tools.

## Event buffer and recovery

The loopback service stores a bounded, in-memory event history addressed by a monotonically increasing cursor. Event batches carry stable client event IDs, so retrying a batch does not duplicate events. Terminal runs reject later events, active and terminal records have separate expiry windows, and each event/run buffer has explicit count and byte limits.

The HTTP contract supports create, inspect, append, cancel, JSON replay, and SSE replay/follow under `/api/research/runs`. On workspace restoration, an interrupted snapshot reattaches by `runId` and replays buffered text, reasoning, tool-round, and completion events. If the renderer-owned executor was still marked active when the page disappeared, recovery cancels that orphan rather than pretending it resumed. A completed terminal event can repair a workspace snapshot that was persisted just before completion.

Terminal run records are also stored with the workspace snapshot. When the loopback service is unavailable, the existing fail-safe behavior remains: a restored non-terminal record becomes `cancelled` with a retryable `run_interrupted` error.

## Migration sequence

1. Keep the Web renderer executor stable while the run/event contract settles. (complete)
2. Add a loopback `ResearchRunManager` with an event buffer and `runId` reattachment. (complete)
3. Move API Provider stream ownership into that manager; delegate browser-only tool execution through explicit approval/result messages. (complete for local Web API providers)
4. Add retry and fallback rules that never replay a completed write tool.
5. Add citation verification and attachment ingestion before memory or self-authored skills.
6. Move the ChatGPT subscription stream behind the same server-owned contract, then replace only the runtime adapter for Electron IPC if needed.
