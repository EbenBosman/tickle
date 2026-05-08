# Spec — `event-bus`

> Path: `server/src/bus.ts` · Layer: `infrastructure/observability/` (post-refactor target) · Spec owner: `routes/runs.ts` (SSE handler), `agent.ts` (publisher)

## 1. Why

The agent executor produces a stream of events (thoughts, tool calls, tool results, block transitions, stats) while a run is in flight. SSE clients want to consume that stream live, but the executor must not know or care how many HTTP listeners are attached — it must remain free to run when nobody is watching, and it must continue running if a client disconnects mid-run. The bus is the seam: a per-run, in-process pub/sub registry keyed by `runId`, decoupling production (single agent loop) from consumption (zero or more SSE subscribers, plus the persistence sink).

> **Non-obvious why:** Single-process pub/sub is sufficient because tickle is single-process by design (CLAUDE.md "Quirks": only one run executes at a time, sharing the persistent Chromium context). No Redis, no message broker, no cross-worker fan-out is needed. If multi-process is ever introduced, this module is the seam to swap.

## 2. Public contract

### Exports

| Symbol        | Kind     | Signature / shape                                                                  | Stability |
|---------------|----------|------------------------------------------------------------------------------------|-----------|
| `subscribe`   | function | `(runId: number, fn: Subscriber) => () => void` — returns idempotent unsubscribe   | stable    |
| `publish`     | function | `(runId: number, event: AgentEvent \| EndEvent) => void`                           | stable    |
| `endTopic`    | function | `(runId: number) => void` — drop all subscribers for the run                       | stable    |
| `Subscriber`  | —        | (intentionally not exported; internal callback alias)                              | —         |

### Event payload contract

The bus is **schema-agnostic at runtime**: it carries whatever the publisher hands it. The compile-time type union is:

- `AgentEvent` (re-exported from `agent.ts`): `block_start`, `block_end`, `thought`, `tool_call`, `tool_result`, `page_state`, `stats`, `var_set`, `remember`, `paused`, `resumed`, `error`, `final`.
- Plus an inline `EndEvent`: `{ kind: "end"; status: string; result?: string; error?: string }` — emitted by the route handler once the run row is finalized, signalling SSE close.

The set of valid `kind` values that flow through the bus is therefore: `block_start | block_end | thought | tool_call | tool_result | page_state | stats | var_set | remember | paused | resumed | error | final | end`.

> **Drift / refactor target:** the `EndEvent` shape lives inline in both `bus.ts` and `routes/runs.ts`. Post-refactor, the full `SseEvent = AgentEvent | EndEvent` union should be defined once in `domain/run.ts` and imported by both producer and consumer. The bus itself stays generic over the event type.

### Errors

| Error                       | Returned when                          | Caller should…                              |
|-----------------------------|----------------------------------------|---------------------------------------------|
| (none thrown)               | subscriber callback throws             | bus swallows; other subscribers still get the event |
| (none thrown)               | publish to runId with zero subscribers | bus is a no-op; safe to fire-and-forget      |
| (none thrown)               | unsubscribe called twice / after end   | second call is a no-op                       |

## 3. Invariants

- **I1 — Subscriber isolation by runId.** A subscriber registered for run `A` never receives events published to run `B`. Falsifiable: subscribe two callbacks under different ids, publish to one, only the matching callback fires.
- **I2 — Empty-topic publish is a no-op.** `publish(id, ev)` when no subscribers exist returns without error and without allocating a set. Falsifiable: call `publish(999, ev)` cold; expect no throw, and a subsequent `subscribe(999, fn)` followed by `publish(999, ev2)` only delivers `ev2`.
- **I3 — Unsubscribe is idempotent.** Calling the returned disposer twice is safe; calling it after `endTopic` is safe.
- **I4 — Subscriber exception isolation.** If subscriber `f1` throws inside its handler, subscriber `f2` registered for the same run still receives that same event. Falsifiable: subscribe two callbacks where the first throws; assert the second was invoked.
- **I5 — Synchronous fan-out.** `publish` invokes every current subscriber synchronously before returning. Subscribers added during a publish (re-entrant `subscribe` from inside a handler) are *not* guaranteed to receive the in-flight event — this depends on `Set` iteration semantics during mutation and is brittle; callers should not rely on it either way.
- **I6 — `endTopic` is destructive and immediate.** After `endTopic(id)`, all previously-registered subscribers for that run are discarded; subsequent `publish(id, …)` calls are no-ops until someone resubscribes.

## 4. How (briefly)

- **Data structure:** module-level `Map<number, Set<Subscriber>>`. Lazy creation in `subscribe`; lazy deletion via `endTopic` (or implicit via `unsubscribe` leaving an empty set behind — the empty set is *not* GC'd, see drift below).
- **Lifetime / cleanup:** the bus does **not** auto-clean. The caller (today: the `(async () => { … })` IIFE in `routes/runs.ts` that owns the run) is responsible for calling `endTopic(runId)` after publishing the terminal `end` event. It does so via `setTimeout(() => endTopic(runId), 5000)` — a 5-second grace window so a late SSE reconnect can still receive the final replay before the topic dies.
- **Replay-then-subscribe pattern (consumer side):** `GET /api/runs/:id/stream` (1) reads all persisted `steps` rows from SQLite and writes them to the SSE socket as `{ replay: true, step }` envelopes, (2) emits a synthetic `paused` event if `isPaused(runId)`, then (3) calls `subscribe(runId, send)`. Live events from the bus are written verbatim. The route also handles socket close by calling the returned `unsubscribe`.
- **Concurrency:** Node single-threaded; no locks needed. All operations are synchronous within a single tick.

## 5. How tested

| Spec section / claim       | Test file | Test name | Status |
|----------------------------|-----------|-----------|--------|
| §3 I1 subscriber isolation | —         | —         | TODO(test) |
| §3 I2 empty-topic no-op    | —         | —         | TODO(test) |
| §3 I3 unsubscribe idempotent | —       | —         | TODO(test) |
| §3 I4 subscriber error isolation | —   | —         | TODO(test) |
| §3 I6 endTopic destructive | —         | —         | TODO(test) |
| §4 replay-then-subscribe end-to-end | — | —      | TODO(test) — integration scope |

### Deliberately not tested

- The 5-second `setTimeout` window in `routes/runs.ts`. That's a route-level decision, not a bus invariant.

## 6. Drift / open questions

- **⚠️ Drift — replay/subscribe ordering window.** Between the SQLite `SELECT * FROM steps` in the SSE handler and the `subscribe()` call a few lines later, the agent could publish a new event that is neither in the replay (not yet persisted) nor delivered live (not yet subscribed). In single-process Node this window is bounded by the synchronous code between the two calls — but the SQLite query is synchronous and the agent's `emit` runs on the same event loop, so an event emitted during a microtask checkpoint inside the route handler is theoretically droppable. No test enforces ordering. Either: (a) document this as best-effort, (b) buffer events in the bus per-run with a high-water mark and let subscribers replay from a cursor, or (c) write to SQLite *before* publishing and have the SSE handler dedupe by `step.idx`.
- **⚠️ Drift — empty-set leak.** `subscribe`'s returned disposer does `subs.get(runId)?.delete(fn)` but never deletes the now-empty `Set` from the map. Topics whose subscribers all disconnect before `endTopic` is called retain an empty `Set` indefinitely. Negligible memory in practice (one empty Set per ever-streamed run since process start) but worth flagging.
- **⚠️ Drift — `EndEvent` type duplication.** The inline `{ kind: "end"; status; result?; error? }` shape is declared in both `bus.ts` and constructed in `routes/runs.ts`. Post-refactor, hoist to `domain/run.ts` as part of the `SseEvent` union.
- **❓ Question — should `endTopic` be the bus's responsibility on terminal events?** Currently the *route* schedules `endTopic` via `setTimeout`. If the bus knew which event kinds were terminal (`end`), it could self-clean. Trade-off: bus would need to know event semantics, breaking its current schema-agnostic posture. Probably keep as-is.
