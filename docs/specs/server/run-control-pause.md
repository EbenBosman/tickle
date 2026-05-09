# Spec — `pause` (run-control / pause registry)

> Path: `server/src/pause.ts` · Layer: `application/` (post-refactor target) · Spec owner: `agent.ts` (run loop) and `routes/runs.ts` (pause/resume HTTP endpoints, SSE stream replay)

## 1. Why

Tickle drives a real headed Chromium against arbitrary websites. Many tasks need a human in the loop briefly — typing a password into Google SSO, finishing a passkey prompt, eyeballing a checkout — without losing the persistent profile, the open tab, or the agent's accumulated state. The pause registry is the cooperative mechanism that lets the executor _suspend_ a sub-agent loop at safe boundaries so the user can act in the browser, then resume from exactly where it stopped. It also backs the auto-pause guardrails (login detection, stall detection, `pauseAfter` breakpoints, `pause` blocks, `on_fail: "pause"` verify branches).

The shape — a per-run `Map` of `paused` flag + waiter callbacks — is dictated by three constraints: (a) pause must be checkable synchronously between every tool call without allocating a Promise on the hot path; (b) when paused, the executor must `await` cooperatively rather than spin or sleep; (c) cancellation has to be able to break a pause without cooperating with it (cancel calls `resume` to wake the waiter so the loop can observe `isCancelled()` on the next iteration).

> **Non-obvious why:**
>
> - **Pause is not cancel.** `pause` must NOT abort the in-flight LLM request — that is `cancel.ts`'s job (which calls `client.abort()`). Pause only blocks at the _next_ safe boundary in the executor; the current tool call / chat response runs to completion first.
> - **Resume is the cancel-unblock path.** `requestCancel` invokes `resumePause(runId)` so a paused run wakes up, sees `isCancelled()`, and exits cleanly. Without this, cancelling a paused run would hang forever on the awaiter.
> - **In-process only.** State is module-local. Multiple server processes would each have their own registry — fine because tickle is single-process by design (one shared Chromium context).

## 2. Public contract

### Exports

| Symbol          | Kind     | Signature                                                                | Stability |
| --------------- | -------- | ------------------------------------------------------------------------ | --------- |
| `registerRun`   | function | `(runId: number) => void`                                                | stable    |
| `pause`         | function | `(runId: number, info?: { reason?: string; auto?: boolean }) => boolean` | stable    |
| `resume`        | function | `(runId: number) => boolean`                                             | stable    |
| `isPaused`      | function | `(runId: number) => boolean`                                             | stable    |
| `getPauseInfo`  | function | `(runId: number) => { reason?: string; auto?: boolean } \| null`         | stable    |
| `awaitIfPaused` | function | `(runId: number) => Promise<void>`                                       | stable    |
| `clear`         | function | `(runId: number) => void`                                                | stable    |
| `PauseEntry`    | —        | (intentionally not exported)                                             | —         |

### Return-value semantics

- `pause` returns `true` iff state transitioned `not-paused → paused`. Returns `false` if (a) the run was never registered, or (b) the run is already paused. Callers (e.g. `routes/runs.ts`) treat `false` as `409 Conflict`.
- `resume` returns `true` iff state transitioned `paused → not-paused`. Returns `false` if the run is unknown or was not paused.
- `isPaused` returns `false` for unknown run IDs (does not throw, does not register).
- `getPauseInfo` returns `null` when the run is unknown OR is registered but not paused. Non-null only while paused.
- `awaitIfPaused` resolves immediately (already-resolved Promise) for unknown or not-paused runs; otherwise resolves on the next `resume` _or_ `clear` for that run.

### HTTP / SSE surface (consumers, not part of this module)

This module emits no events itself. Callers in `routes/runs.ts` and `agent.ts` are responsible for publishing the SSE `paused` / `resumed` events when their `pause()` / `resume()` calls return `true`. The reason for paired control:

- HTTP `POST /api/runs/:id/pause` — calls `pause(id, { reason, auto: false })`; on `true`, publishes `{ kind: "paused", reason, auto: false }`.
- HTTP `POST /api/runs/:id/resume` — calls `resume(id)`; on `true`, publishes `{ kind: "resumed" }`.
- SSE replay (`/api/runs/:id/stream`) — on connect, reads `isPaused` + `getPauseInfo` to inject a synthetic `paused` event so a late subscriber sees the current state.

### Errors

This module never throws. All failure modes are encoded as `false` / `null` returns.

## 3. Invariants

- **Per-run-id, not global.** Pausing run A does not pause run B. (Today only one run executes at a time, but the registry is keyed by `runId` and must not assume singleton.)
- **`pause` is idempotent in the "already paused" direction:** calling `pause(id)` twice returns `true` then `false`; the second call does not overwrite `reason` / `auto`.
- **`resume` is idempotent in the "already resumed" direction:** calling `resume(id)` when not paused returns `false` and is a no-op.
- **`clear` is unconditional and idempotent:** wakes any waiters, drops the entry, and returns `void` whether or not the run was ever registered or paused.
- **Waiters fire exactly once per pause cycle.** A `Promise` returned by `awaitIfPaused` resolves the first time `resume` or `clear` is called for that run; subsequent pauses produce _new_ promises with their own waiter list.
- **Resume drains all waiters** before returning. Multiple concurrent `awaitIfPaused` calls all resolve from a single `resume`.
- **`pause` requires prior `registerRun`.** Calling `pause` on an unregistered run returns `false` and does NOT lazily create an entry. (`isPaused`, `awaitIfPaused`, and `getPauseInfo` tolerate unknown IDs by returning a falsy value; `clear` tolerates unknown IDs as a no-op.)
- **Reason metadata is cleared on resume.** After `resume(id)`, `getPauseInfo(id)` returns `null` (not the stale reason).

## 4. How (briefly)

- **Data structure:** module-local `Map<number, PauseEntry>` where `PauseEntry = { paused: boolean; reason?: string; auto?: boolean; waiters: (() => void)[] }`. No external storage; state is lost on server restart (acceptable — runs do not survive restart).
- **Awaitable mechanism:** `awaitIfPaused` reads the entry; if not paused, returns `Promise.resolve()` (no allocation of a pending promise on the hot path). If paused, constructs a new `Promise` and pushes its `resolve` callback into the entry's `waiters` array. `resume` and `clear` swap `waiters` for a fresh `[]` and synchronously invoke each captured resolver.
- **Lifecycle:** `runAgent` calls `registerPause(runId)` on entry and `clearPause(runId)` in its `finally` block. The cancel callback registered with `cancel.ts` calls `resumePause(runId)` so a paused run can observe cancellation on the next safe-boundary check.
- **Safe boundaries:** the executor (`agent.ts`) calls `await awaitIfPaused(ctx.runId)` between every block, between every sub-agent step, before and after auto-pause publication, and at the top of the questionnaire loop. Each call is paired with an `isCancelled()` check before and after.
- **Concurrency model:** single-threaded JS event loop. `pause` / `resume` / `clear` are synchronous and execute atomically with respect to each other; the only concurrency is between async awaiters and synchronous mutators, which is safe because mutators swap arrays before iterating.

## 5. How tested

There are no tests for this module yet. Every behavioural claim below is `TODO(test)`.

| Spec section / claim                                                         | Test file | Test name                                                   | Status     |
| ---------------------------------------------------------------------------- | --------- | ----------------------------------------------------------- | ---------- |
| §2 `pause` returns `true` on first call, `false` on second                   | —         | `pause: idempotent re-pause returns false`                  | TODO(test) |
| §2 `pause` on unregistered run returns `false`                               | —         | `pause: unknown run id returns false`                       | TODO(test) |
| §2 `resume` on not-paused run returns `false`                                | —         | `resume: not-paused returns false`                          | TODO(test) |
| §2 `resume` on unknown run returns `false`                                   | —         | `resume: unknown run id returns false`                      | TODO(test) |
| §2 `isPaused` returns `false` for unknown run                                | —         | `isPaused: unknown run id is false`                         | TODO(test) |
| §2 `getPauseInfo` returns `null` when not paused                             | —         | `getPauseInfo: returns null when not paused`                | TODO(test) |
| §2 `getPauseInfo` returns `{reason, auto}` when paused                       | —         | `getPauseInfo: surfaces info while paused`                  | TODO(test) |
| §2 `awaitIfPaused` on not-paused resolves immediately                        | —         | `awaitIfPaused: resolves synchronously when not paused`     | TODO(test) |
| §3 per-run isolation: pausing A does not pause B                             | —         | `pause: keyed per run id`                                   | TODO(test) |
| §3 `resume` drains all waiters                                               | —         | `awaitIfPaused: resume wakes multiple concurrent waiters`   | TODO(test) |
| §3 `clear` wakes waiters and forgets entry                                   | —         | `clear: wakes waiters and removes entry`                    | TODO(test) |
| §3 `clear` is a no-op for unknown run                                        | —         | `clear: unknown run id is a no-op`                          | TODO(test) |
| §3 second `pause` does not overwrite reason/auto                             | —         | `pause: second call preserves first reason`                 | TODO(test) |
| §3 `getPauseInfo` returns `null` after resume                                | —         | `resume: clears reason metadata`                            | TODO(test) |
| §3 waiters fire exactly once per pause cycle                                 | —         | `awaitIfPaused: waiter fires once per cycle`                | TODO(test) |
| §1 cancel-unblock: `resume` wakes a paused awaiter so cancel can be observed | —         | `awaitIfPaused: resume after cancel-resume unblocks waiter` | TODO(test) |
| §1 `clear` from `finally` wakes a still-paused waiter                        | —         | `clear: unblocks pending awaitIfPaused`                     | TODO(test) |

### Deliberately not tested (here)

- The **emit-on-pause** SSE behaviour is the caller's responsibility (`routes/runs.ts` and `agent.ts`); covered by `server/events.md` and `server/http-api.md` once authored.
- Login auto-pause heuristics (`loginDetect.ts`) and stall detection are tested under `server/login-guard.md` and `server/stall-guard.md`.
- End-to-end pause/resume across HTTP + SSE + browser is integration-tested via the smoke harness, not here.

## 6. Drift / open questions

- ⚠️ **Drift — module placement.** `_LAYERS.md` puts pause/cancel/bus in `application/` post-refactor. Today the file lives at `server/src/pause.ts` (flat). When the refactor lands, this spec's `Path` field moves to `server/src/application/pause.ts` (or similar) without contract changes.
- ⚠️ **Drift — index name.** `docs/specs/README.md` lists a single combined entry "Pause / Resume / Cancel registries" → `server/run-control.md`. This spec is `server/run-control-pause.md` (pause-only); a sibling `server/run-control-cancel.md` is expected. The orchestrator updates the index.
- ❓ **Question — should `pause` lazily register?** Today `pause(id)` on an unregistered run silently returns `false`. Routes treat this as `409 Conflict`, which is correct for "no such run", but masks a real bug class: the agent forgetting to call `registerRun`. A future hardening might log/throw on missing registration.
- ❓ **Question — should `clear` also signal cancellation distinctly?** Currently a waiter cannot tell whether it woke because of `resume` (user clicked Resume) or `clear` (run ended / cancel cleanup). The executor disambiguates via `isCancelled()` after the await, which works but couples pause-awareness to the cancel registry. Worth revisiting if the two registries merge.
- ❓ **Question — bounded waiter list?** No upper bound on `waiters.length`. In practice the executor only awaits at one site at a time per run, so the list rarely exceeds 1. A pathological caller could leak resolvers; not currently guarded against.
