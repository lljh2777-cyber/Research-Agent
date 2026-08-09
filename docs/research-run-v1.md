# Research Run v1 Contract

Research Run v1 is the framework-neutral lifecycle contract shared by the renderer Agent Engine, loopback Research Run service, and any future runtime adapter. Provider, Vault, credential, and tool implementations are injected at the boundary; they are not part of this protocol.

## Record

A run record has `schemaVersion: 1`, a stable `id`, `sessionId`, model and policy snapshots, `evidenceCount`, `executionOwner`, timestamps, `iteration`, terminal error, and one status:

- `created`
- `running`
- `waiting-approval`
- `completed`
- `failed`
- `cancelled`

`completed`, `failed`, and `cancelled` are terminal. A terminal record never accepts later events, cannot be restarted, and retains its first terminal timestamp. Loopback execution can start only a `created` run whose `executionOwner` is `loopback`; renderer-owned runs remain renderer-owned.

## Events and transitions

Events are JSON-serializable, provider-neutral objects. The service assigns the monotonically increasing `cursor` and `recordedAt`; clients must not assign either field. An event envelope is:

```json
{ "cursor": 12, "recordedAt": "2026-08-09T00:00:00.000Z", "event": { "runId": "run-1", "type": "model.text.delta" } }
```

Only these transitions are legal:

| Current status | Accepted events | Result |
| --- | --- | --- |
| `created` | `run.started`, `run.failed`, `run.cancelled` | `running` or terminal |
| `running` | model/provider deltas, tool-round start, tool execution request, terminal events | unchanged, `waiting-approval`, or terminal |
| `waiting-approval` | more tool execution requests in the same round, tool execution completion, terminal events | remains waiting until all requests complete; then `running`, or terminal |
| terminal | none | unchanged |

`run.completed` is accepted only from `running`. Invalid non-terminal transitions receive a conflict response; later events after a terminal event are harmlessly ignored so a retried terminal batch remains safe.

## Cursor, replay, and reconnect

The in-memory loopback buffer uses strictly increasing cursors. `GET /api/research/runs/:runId/events?after=N` returns envelopes with a cursor greater than `N`, plus `oldestCursor`, `lastCursor`, and `truncated`. SSE accepts the same `after` cursor or `Last-Event-ID`, replays the retained window before following live events, and closes after replaying or observing a terminal event.

A reconnect that observes `truncated: true` must treat the run snapshot as authoritative and may render only the retained tail. Reattachment reconstructs completed tool request IDs before dispatching unresolved requests. Loopback execution is live-process work, not durable provider-job recovery: if the executor is gone, recovery reattaches to buffered state and cancels unresolved work rather than silently replaying a provider request.

## Delegated tool rounds and idempotency

Each `tool.execution.requested` event requires a unique non-empty `requestId` and a call with stable `id` and `name`. The manager records pending request IDs. A `tool.execution.completed` event must reference a currently pending request ID. Multiple requests may be outstanding in one round; the status remains `waiting-approval` until the last completion.

Posting the same completed request ID again while the live executor still retains it returns `{ "accepted": false, "duplicate": true }` and does not repeat the effect. A new request cannot reuse a pending request ID. Tool executions are at-least-once across the browser crash boundary: if a side effect finished locally before its completion acknowledgement was persisted, Research Core cannot prove exactly-once execution. Write-capable tools must therefore supply their own idempotency key and conflict detection. This round deliberately does not add Knowledge Base or Runtime-specific write behavior.

## Serialization and privacy

Run records and events must be JSON-serializable and within the manager's byte limits. Provider credentials stay only in the active executor closure and are cleared when execution ends; they are never placed in a run record, event buffer, replay, or workspace snapshot. Errors are normalized before being emitted as terminal failure events.
