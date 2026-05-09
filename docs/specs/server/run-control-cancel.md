# Spec — `cancel` (run-control / cancel registry)

> Path: `server/src/cancel.ts` · Layer: `application/` (post-refactor target) · Spec owner: `agent.ts` (run loop, registers the cancel callback) and `routes/runs.ts` (`POST /api/runs/:id/cancel`)

## 1. Why

A user pressing **Stop** in the UI must terminate an in-flight run promptly, even when the agent is mid-LLM-call (which can be tens of seconds for a local model under load) or parked on an `awaitIfPaused`. The cancel registry is the cooperative bridge between the HTTP route — which knows `runId` but nothing about the running agent's internals — and the agent's per-run state (its `AbortController`, its pause registration, its `cancelled` boolean). The route calls `requestCancel(id)`; the agent's pre-registered callback fires synchronously, aborts the in-flight LLM request, wakes any paused awaiter, and flips the cooperative `cancelled` flag the executor checks at every safe boundary.

The shape — a per-run `Map<number, () => void>` of opaque cancel callbacks — is dictated by three constraints: (a) the route must not need any knowledge of the agent's internal controller; (b) the cancel callback must be cheap to invoke synchronously from a Fastify handler; (c) the agent owns the _meaning_ of cancellation (which controller to abort, which pause to resume, which flag to set) — the registry is just dispatch.

> **Non-obvious why:**
>
> - **Cancel does NOT close the browser context.** The persistent Chromium profile at `server/data/profile/` must survive across runs (cookies, localStorage, passkeys). The cancel callback aborts the LLM call and lets the executor unwind cleanly to its `finally`, which closes the _tab_ via `session.close()` but not the shared context.
> - **Cancel cooperates with — and short-circuits — pause.** A paused run is sitting on a `Promise` from `awaitIfPaused`. The cancel callback calls `resumePause(runId)` so the awaiter wakes; the executor then observes `isCancelled() === true` on its next safe-boundary check and exits. Without this wake-up, cancelling a paused run would hang forever.
> - **Two ways to abort the LLM.** `chatWithRetry` constructs a fresh `AbortController` per attempt and registers it via `setActiveController`; the cancel callback reads that handle through a closure and calls `.abort()`. This interrupts the underlying `fetch` so the OpenAI/Anthropic SDK promise rejects with `aborted by`, which `chatWithRetry` recognises as terminal (not a transient retry).
> - **Rescue mode hijacks cancel.** When `rescue_on_cancel` is enabled and an Anthropic key is present, the cancel callback flips `rescueRequested` instead of `cancelled` — same plumbing (abort the local LLM, wake the pause), different terminal action (retry the step against Claude). This is implemented in `agent.ts`, not here; the registry is agnostic to what the callback does.
> - **In-process only.** State is module-local. Multiple server processes would each have their own registry — fine because tickle is single-process by design.

## 2. Public contract

### Exports

| Symbol           | Kind     | Signature                                 | Stability |
| ---------------- | -------- | ----------------------------------------- | --------- |
| `registerCancel` | function | `(runId: number, fn: () => void) => void` | stable    |
| `requestCancel`  | function | `(runId: number) => boolean`              | stable    |
| `clearCancel`    | function | `(runId: number) => void`                 | stable    |
| `CancelFn`       | —        | (intentionally not exported)              | —         |

### Return-value semantics

- `registerCancel` returns `void` and **replaces** any previously registered callback for the same `runId`. (See §3 — last-writer-wins.) It does not invoke the prior callback.
- `requestCancel` returns `true` iff a callback was registered for `runId` and was invoked. Returns `false` if no callback is registered (run never started, already cleaned up, or wrong `runId`). Callers in `routes/runs.ts` treat `false` as "no live handler — fall through to force-cancel the DB row."
- `clearCancel` returns `void` and is unconditional: idempotent, safe on unknown IDs, and does NOT invoke the callback before deleting it.

### Synchronous vs async

- All three exports are **synchronous**. `requestCancel` calls the callback inline on the caller's stack frame. The callback itself is expected to be non-blocking (set a flag, abort a controller, wake a pause); it must not await.

### HTTP / SSE surface (consumers, not part of this module)

This module emits no events itself. It is invoked from:

- `POST /api/runs/:id/cancel` — calls `requestCancel(id)`. On `true`, returns `{ ok: true, mode: "live" }`. On `false`, the route checks the DB: if the row says `running` it force-updates the row to `cancelled` and publishes an SSE `end` event itself (the "zombie path" — agent died between turns).
- `DELETE /api/runs` (clear-all) — calls `requestCancel` on each active run before force-updating their rows.
- `agent.ts` registers the callback inside `runAgent` and calls `clearCancel(runId)` in the `finally` block.

### Errors

This module never throws. Exceptions raised by the registered callback propagate to the caller of `requestCancel` (today wrapped in a `try/catch` inside the agent's callback, so this is theoretical).

## 3. Invariants

- **Per-run-id, not global.** Cancelling run A does not cancel run B. Keyed by `runId`.
- **`registerCancel` is last-writer-wins.** A second `registerCancel(id, fn2)` replaces `fn1` without invoking it. (This matters if `runAgent` is ever re-entered for the same `runId` — currently it is not, but the contract guards against it.)
- **`requestCancel` is one-shot per registration cycle, not idempotent in the strict sense.** Calling it twice with no intervening `clearCancel` invokes the callback twice. The agent's callback is itself idempotent (setting `cancelled = true` twice is a no-op; `AbortController.abort()` is idempotent; `resumePause` returns `false` the second time). Callers should not rely on the registry to deduplicate.
- **`requestCancel` returns `false` after `clearCancel`.** Once `runAgent`'s `finally` runs, further cancel requests for that `runId` are no-ops. The route's zombie path handles the `false` case by force-updating the DB.
- **`clearCancel` does NOT invoke the callback.** It only removes the entry. The agent's `finally` is responsible for any cleanup; cancel-on-cleanup would double-fire whenever a run completes normally.
- **No lazy registration.** `requestCancel` on an unregistered `runId` returns `false` and creates no entry. The map is entirely populated by `registerCancel`.
- **Synchronous dispatch.** `requestCancel` invokes the callback on the calling stack before returning. There is no microtask hop. (The HTTP handler relies on this only for ordering relative to its DB read — it does not await the cancellation.)
- **Callback must be non-blocking.** The registry does not enforce this, but `routes/runs.ts` handles the cancel request synchronously and returns immediately; a long-running callback would stall the HTTP response.

## 4. How (briefly)

- **Data structure:** module-local `Map<number, () => void>`. No external storage; state is lost on server restart (acceptable — runs do not survive restart, see the "zombie path" in §2).
- **Lifecycle:** `runAgent` calls `registerCancel(runId, callback)` immediately after `registerPause(runId)` and calls `clearCancel(runId)` in its `finally` block, paired with `clearPause`. The callback closes over the agent's mutable `cancelled` flag, the `activeController` getter (set per-LLM-call by `chatWithRetry`), and `rescueRequested` for rescue-mode.
- **Cancellation propagation path** (the load-bearing sequence):
  1. Route receives `POST /api/runs/:id/cancel`, calls `requestCancel(id)`.
  2. Registry looks up the callback and invokes it synchronously.
  3. Callback sets `cancelled = true` (or `rescueRequested = true` in rescue mode), calls `resumePause(runId)` to wake any pause awaiter, then calls `activeController?.abort()` inside a `try/catch` (the controller may be null between LLM calls, or may already be aborted).
  4. The in-flight `chatOnce` rejects with an abort error; `chatWithRetry` checks `isCancelled()` and rethrows without retrying.
  5. The executor catches at its safe-boundary check (`if (ctx.isCancelled()) return { status: "cancelled" }`) and unwinds.
  6. `runAgent`'s `finally` calls `clearCancel(runId)`, `clearPause(runId)`, `session.close()`.
- **Cooperation contract with `pause.ts`:** they are separate primitives. Cancel is allowed (and required) to short-circuit pause by calling `resumePause(runId)`. Pause does NOT short-circuit cancel; pausing during a cancellation is a no-op because the executor checks `isCancelled()` first and exits.
- **Concurrency model:** single-threaded JS event loop. `register` / `request` / `clear` are synchronous and atomic with respect to each other.

## 5. How tested

There are no tests for this module yet. Every behavioural claim below is `TODO(test)`.

| Spec section / claim                                                             | Test file | Test name                                                     | Status     |
| -------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------- | ---------- |
| §2 `requestCancel` returns `true` after register, invokes callback               | —         | `requestCancel: invokes registered callback and returns true` | TODO(test) |
| §2 `requestCancel` returns `false` for unknown run id                            | —         | `requestCancel: unknown run id returns false`                 | TODO(test) |
| §2 `requestCancel` returns `false` after `clearCancel`                           | —         | `requestCancel: false after clearCancel`                      | TODO(test) |
| §2 `clearCancel` does NOT invoke the callback                                    | —         | `clearCancel: does not call the callback`                     | TODO(test) |
| §2 `clearCancel` is a no-op for unknown run id                                   | —         | `clearCancel: unknown run id is a no-op`                      | TODO(test) |
| §2 dispatch is synchronous (callback runs before `requestCancel` returns)        | —         | `requestCancel: dispatches synchronously`                     | TODO(test) |
| §3 per-run isolation: cancelling A does not invoke B's callback                  | —         | `requestCancel: keyed per run id`                             | TODO(test) |
| §3 last-writer-wins: second `registerCancel` replaces first without invoking it  | —         | `registerCancel: replaces prior without invoking`             | TODO(test) |
| §3 `requestCancel` twice fires callback twice                                    | —         | `requestCancel: not deduplicated within a registration`       | TODO(test) |
| §3 no lazy registration: `requestCancel` does not create an entry                | —         | `requestCancel: does not register on unknown id`              | TODO(test) |
| §1 integration: cancel aborts an in-flight `chatOnce` AbortController            | —         | `cancel: aborts active LLM controller`                        | TODO(test) |
| §1 integration: cancel wakes a paused awaiter (paired with `pause.ts`)           | —         | `cancel: resumes paused awaiter so isCancelled is observed`   | TODO(test) |
| §1 integration: rescue-on-cancel flips `rescueRequested` instead of `cancelled`  | —         | `cancel: rescue mode does not set cancelled flag`             | TODO(test) |
| §1 integration: persistent browser context survives cancel (only the tab closes) | —         | `cancel: profile survives, tab closes`                        | TODO(test) |

### Deliberately not tested (here)

- The **agent-side callback semantics** (rescue branching, controller-abort, pause-wake) are covered by `agent.ts`'s spec — this module owns only dispatch.
- The **HTTP route behaviour** including the zombie/force-cancel path is covered by `routes/runs.ts`'s spec.
- End-to-end cancel across HTTP + SSE + browser unwind is integration-tested via the smoke harness, not here.

## 6. Drift / open questions

- ⚠️ **Drift — module placement.** `_LAYERS.md` puts pause/cancel/bus in `application/` post-refactor. Today the file lives at `server/src/cancel.ts` (flat). When the refactor lands, this spec's `Path` field moves to `server/src/application/cancel.ts` (or similar) without contract changes.
- ⚠️ **Drift — index name.** `docs/specs/README.md` lists a single combined entry "Pause / Resume / Cancel registries" → `server/run-control.md`. This spec is `server/run-control-cancel.md` (cancel-only); the sibling `server/run-control-pause.md` exists. The orchestrator updates the index.
- ❓ **Question — should `clearCancel` invoke the callback as a "shutdown" signal?** Today it does not, deliberately, because `runAgent`'s normal `finally` runs `clearCancel` after the run completes successfully — invoking the callback there would falsely flip `cancelled = true` after a `done` outcome. A future API split (`disposeCancel` vs `cancelAndDispose`) might make this cleaner.
- ❓ **Question — should the registry know about `AbortController` directly?** Currently the agent owns the controller and exposes `abort()` through the closure. Folding `AbortController` into the registry would simplify callers but couples this module to the LLM transport (today abstracted behind `chatWithRetry`). Probably not worth it.
- ❓ **Question — should `requestCancel` deduplicate within a registration cycle?** It does not today; the agent's callback is idempotent so it doesn't matter. If a future callback had non-idempotent side effects (e.g. emitted an SSE event per call), a single-shot guard inside the registry would be safer.
- ❓ **Question — should the registry merge with `pause.ts`?** They share a lifecycle (registered together in `runAgent`, cleared together in `finally`) and a coupling (cancel calls `resumePause`). A single `RunControl` registry might reduce surface area; the cost is loss of independent testability.
