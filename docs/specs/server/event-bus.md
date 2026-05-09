# Spec — `event-bus`

> Path: `server/src/bus.ts` · Layer: `infrastructure/observability/` (post-refactor target) · Spec owner: `routes/runs.ts` (SSE handler), `agent.ts` (publisher)

## 1. Why

The agent executor produces a stream of events (thoughts, tool calls, tool results, block transitions, stats) while a run is in flight. SSE clients want to consume that stream live, but the executor must not know or care how many HTTP listeners are attached — it must remain free to run when nobody is watching, and it must continue running if a client disconnects mid-run. The bus is the seam: a per-run, in-process pub/sub registry keyed by `runId`, decoupling production (single agent loop) from consumption (zero or more SSE subscribers, plus the persistence sink).

> **Non-obvious why:** Single-process pub/sub is sufficient because tickle is single-process by design (CLAUDE.md "Quirks": only one run executes at a time, sharing the persistent Chromium context). No Redis, no message broker, no cross-worker fan-out is needed. If multi-process is ever introduced, this module is the seam to swap.

## 2. Public contract

### Exports

| Symbol       | Kind     | Signature / shape                                                                | Stability |
| ------------ | -------- | -------------------------------------------------------------------------------- | --------- |
| `subscribe`  | function | `(runId: number, fn: Subscriber) => () => void` — returns idempotent unsubscribe | stable    |
| `publish`    | function | `(runId: number, event: AgentEvent \| EndEvent) => void`                         | stable    |
| `endTopic`   | function | `(runId: number) => void` — drop all subscribers for the run                     | stable    |
| `Subscriber` | —        | (intentionally not exported; internal callback alias)                            | —         |

### Event payload contract

The bus is **schema-agnostic at runtime**: it carries whatever the publisher hands it. The compile-time type union is:

- `AgentEvent` (re-exported from `agent.ts`): `block_start`, `block_end`, `thought`, `tool_call`, `tool_result`, `page_state`, `stats`, `var_set`, `remember`, `paused`, `resumed`, `error`, `final`.
- Plus `EndEvent` (sourced from `domain/run.ts`): `{ kind: "end"; status: string; result?: string; error?: string }` — emitted by the route handler once the run row is finalized, signalling SSE close.

The set of valid `kind` values that flow through the bus is therefore: `block_start | block_end | thought | tool_call | tool_result | page_state | stats | var_set | remember | paused | resumed | error | final | end`.

> Resolved: `EndEvent`, `STEP_KINDS` / `StepKind`, and `LIVE_ONLY_KINDS` are hoisted to `domain/run.ts`. `bus.ts`, `routes/runs.ts` (end-event construction), and `agent.ts` (persist signature) consume them. The bus itself stays generic over the event type.

### Errors

| Error         | Returned when                          | Caller should…                                      |
| ------------- | -------------------------------------- | --------------------------------------------------- |
| (none thrown) | subscriber callback throws             | bus swallows; other subscribers still get the event |
| (none thrown) | publish to runId with zero subscribers | bus is a no-op; safe to fire-and-forget             |
| (none thrown) | unsubscribe called twice / after end   | second call is a no-op                              |

## 3. Invariants

- **I1 — Subscriber isolation by runId.** A subscriber registered for run `A` never receives events published to run `B`. Falsifiable: subscribe two callbacks under different ids, publish to one, only the matching callback fires.
- **I2 — Empty-topic publish is a no-op.** `publish(id, ev)` when no subscribers exist returns without error and without allocating a set. Falsifiable: call `publish(999, ev)` cold; expect no throw, and a subsequent `subscribe(999, fn)` followed by `publish(999, ev2)` only delivers `ev2`.
- **I3 — Unsubscribe is idempotent.** Calling the returned disposer twice is safe; calling it after `endTopic` is safe.
- **I4 — Subscriber exception isolation.** If subscriber `f1` throws inside its handler, subscriber `f2` registered for the same run still receives that same event. Falsifiable: subscribe two callbacks where the first throws; assert the second was invoked.
- **I5 — Synchronous fan-out.** `publish` invokes every current subscriber synchronously before returning. Subscribers added during a publish (re-entrant `subscribe` from inside a handler) are _not_ guaranteed to receive the in-flight event — this depends on `Set` iteration semantics during mutation and is brittle; callers should not rely on it either way.
- **I6 — `endTopic` is destructive and immediate.** After `endTopic(id)`, all previously-registered subscribers for that run are discarded; subsequent `publish(id, …)` calls are no-ops until someone resubscribes.

## 4. How (briefly)

- **Data structure:** module-level `Map<number, Set<Subscriber>>`. Lazy creation in `subscribe`; lazy deletion via `endTopic` (or implicit via `unsubscribe` leaving an empty set behind — the empty set is _not_ GC'd, see drift below).
- **Lifetime / cleanup:** the bus does **not** auto-clean. The caller (today: the `(async () => { … })` IIFE in `routes/runs.ts` that owns the run) is responsible for calling `endTopic(runId)` after publishing the terminal `end` event. It does so via `setTimeout(() => endTopic(runId), 5000)` — a 5-second grace window so a late SSE reconnect can still receive the final replay before the topic dies.
- **Replay-then-subscribe pattern (consumer side):** `GET /api/runs/:id/stream` (1) reads all persisted `steps` rows from SQLite and writes them to the SSE socket as `{ replay: true, step }` envelopes, (2) emits a synthetic `paused` event if `isPaused(runId)`, then (3) calls `subscribe(runId, send)`. Live events from the bus are written verbatim. The route also handles socket close by calling the returned `unsubscribe`.
- **Concurrency:** Node single-threaded; no locks needed. All operations are synchronous within a single tick.

## 5. How tested

| Spec section / claim                | Test file | Test name | Status                         |
| ----------------------------------- | --------- | --------- | ------------------------------ |
| §3 I1 subscriber isolation          | —         | —         | TODO(test)                     |
| §3 I2 empty-topic no-op             | —         | —         | TODO(test)                     |
| §3 I3 unsubscribe idempotent        | —         | —         | TODO(test)                     |
| §3 I4 subscriber error isolation    | —         | —         | TODO(test)                     |
| §3 I6 endTopic destructive          | —         | —         | TODO(test)                     |
| §4 replay-then-subscribe end-to-end | —         | —         | TODO(test) — integration scope |

### Deliberately not tested

- The 5-second `setTimeout` window in `routes/runs.ts`. That's a route-level decision, not a bus invariant.

## 6. Drift / open questions

- **Resolved — replay/subscribe race fixed at the route.** `routes/runs.ts /stream` subscribes BEFORE the DB replay read and buffers live events. After replay, a tail-read of `steps WHERE idx > lastReplayedIdx` catches anything persisted during the race window; the buffer is then drained for live-only kinds (`paused`/`resumed`) and discarded for persistable kinds (already covered by tail). Persist-runs-before-emit ordering inside `runAgent` keeps the invariant that any persistable bus event is already in the DB by the time a subscriber sees it.
- **Resolved — empty-set leak.** The unsubscribe closure now `subs.delete(runId)` once `set.size === 0`, so a long-lived process doesn't accumulate one entry per run. Regression: `__tests__/bus.test.ts` (with `topicCount()` test hook).
- **Resolved — `EndEvent` type duplication.** Hoisted to `domain/run.ts`; `bus.ts` and `routes/runs.ts` import it.
- **❓ Question — should `endTopic` be the bus's responsibility on terminal events?** Currently the _route_ schedules `endTopic` via `setTimeout`. If the bus knew which event kinds were terminal (`end`), it could self-clean. Trade-off: bus would need to know event semantics, breaking its current schema-agnostic posture. Probably keep as-is.
