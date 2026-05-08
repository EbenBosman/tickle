# Spec — `http-runs`

> Path: `server/src/routes/runs.ts` · Layer: `interface/http/routes/` · Spec owner: `web/src/components/RunView.tsx`, `web/src/api.ts`, anything that drives a run from the outside.

## 1. Why

This module is the only seam through which the outside world starts, observes, controls, and tears down a run. Every other server module either runs in-process (the agent loop, the bus, the pause/cancel registries) or is invoked synchronously from a route. Routes here are the boundary that translates HTTP/SSE into in-process side effects, persisting the durable record (`runs` row) at start and finalizing it at end. The SSE endpoint is the central live-telemetry pipe and uses the **replay-then-subscribe** pattern so a UI that connects late or reconnects mid-run sees the full history followed by live events.

> **Non-obvious why — fire-and-forget agent IIFE.** The `POST /run` handler returns the `run_id` synchronously and starts `runAgent` in a detached `(async () => { … })()` IIFE so the HTTP response is not blocked on (potentially many minutes of) agent execution. The IIFE owns the eventual UPDATE of the `runs` row and the terminal `end` event publish.
>
> **Non-obvious why — zombie-cancel path.** If the server reloads (tsx-watch) or crashes mid-run, the `runs` row says `running` but there is no live in-process cancel handler. `POST /cancel` falls through to a "force" path that flips the row to `cancelled` directly so the UI unblocks. Without it, a stale row would forever show as active.
>
> **Non-obvious why — synthetic `paused` replay.** `GET /stream` re-emits a synthetic `paused` event on connect if the in-memory pause registry says the run is paused. A page refresh during a pause would otherwise leave the UI showing "running" because the original `paused` event has already been consumed.

## 2. Public contract

### HTTP / SSE surface

| Method | Path                                | Auth | Purpose                                                              |
|--------|-------------------------------------|------|----------------------------------------------------------------------|
| `POST` | `/api/tasks/:id/run`                | none | Start a new run for a task. Returns `run_id` immediately.            |
| `GET`  | `/api/tasks/:taskId/runs`           | none | List runs for a task (newest first), each annotated with `is_paused`.|
| `DELETE` | `/api/tasks/:taskId/runs`         | none | Bulk-delete all runs for a task. Query: `force`, `reset_ids`.        |
| `GET`  | `/api/runs/:id`                     | none | Single run + ordered `steps[]` + `pause_info`.                       |
| `POST` | `/api/runs/:id/cancel`              | none | Cancel a live run, or force-clear a zombie.                          |
| `POST` | `/api/runs/:id/pause`               | none | Pause an active run (user-initiated).                                |
| `POST` | `/api/runs/:id/resume`              | none | Resume a paused run.                                                 |
| `DELETE` | `/api/runs/:id`                   | none | Delete a finalized run + its screenshot files.                       |
| `GET`  | `/api/runs/:id/stream`              | none | SSE: replay persisted steps then subscribe to live events.           |
| `GET`  | `/screenshots/*`                    | none | Static PNG file serving from `screenshots/<rest>`.                   |

> ⚠️ **Drift / security.** All endpoints are unauthenticated. Fastify is bound to `127.0.0.1` (`server/src/index.ts`), so reachable only locally — but CORS is registered with `origin: true`, meaning any browser origin (including a malicious page the user happens to visit) can issue these requests against `127.0.0.1:8787` and start, cancel, or delete runs. Acceptable for the local-only design today; document and re-evaluate before any non-loopback bind.

### Endpoint contracts

#### `POST /api/tasks/:id/run`

- **Request:** no body.
- **Response 200:** `{ run_id: number }` (returned synchronously; agent runs detached).
- **Response 404:** `{ error: "task not found" }` if the task id is unknown.
- **Side effects:**
  1. INSERT into `runs (task_id, status='running')`; `started_at` defaults to UTC `datetime('now')`.
  2. Detached IIFE invokes `runAgent(runId, taskId, instruction, steps, publish)`.
  3. On agent completion the IIFE updates the row to `done` (with `result`), `cancelled`, or `error` (with `error`) and sets `finished_at` to ISO `toISOString()`.
  4. Publishes a terminal `{ kind: "end", status, result?, error? }` event onto the per-run bus topic.
  5. Schedules `endTopic(runId)` 5 seconds later to drop subscribers.

> ⚠️ **Drift — concurrency invariant not enforced here.** `CLAUDE.md` Quirks state only one run executes at a time (shared persistent Chromium context). This route does **not** check for an existing in-flight run; a second `POST /run` succeeds, inserts a second `runs` row, and starts a second `runAgent` IIFE. The runs will then race on the shared context. The single-run invariant is a property of the system, not enforced by code.

#### `POST /api/runs/:id/cancel`

- **Response 200, live path:** `{ ok: true, mode: "live" }` when an in-process cancel handler is registered (typical case). Calls `requestCancel` which fires the registered abort fn.
- **Response 200, force path:** `{ ok: true, mode: "force" }` when no live handler exists but the row is `running`. The route updates the row to `cancelled` with error `"Force-stopped by user (no live handler — likely server restarted mid-run)"`, sets `finished_at`, and publishes a terminal `end` event.
- **Response 404:** `{ error: "run not found" }` when no row matches.
- **Response 409:** `{ error: "run is already <status>" }` when the row exists, has no live handler, and is in any non-`running` state (`done`, `cancelled`, `error`).

#### `POST /api/runs/:id/pause`

- **Response 200:** `{ ok: true }`. Calls `pause(runId)` (returns `true`) and publishes `{ kind: "paused", reason: "Paused by user", auto: false }`.
- **Response 409:** `{ error: "run not active or already paused" }` when `pause(runId)` returns `false` — i.e. no entry registered (run never started, already finished, or already paused).

#### `POST /api/runs/:id/resume`

- **Response 200:** `{ ok: true }`. Calls `resume(runId)` and publishes `{ kind: "resumed" }`.
- **Response 409:** `{ error: "run not active or not paused" }` when `resume(runId)` returns `false`.

#### `DELETE /api/runs/:id`

- **Response 200:** `{ ok: true, screenshots_removed: number }`. Deletes screenshot files referenced by `steps.screenshot_path`, then `DELETE FROM runs WHERE id = ?` (cascade removes `steps`).
- **Response 404:** `{ error: "run not found" }`.
- **Response 409:** `{ error: "run is still active — cancel it first, then delete" }` when `status='running'`.

#### `DELETE /api/tasks/:taskId/runs`

Bulk-clear all runs for a task.

- **Query params:** `force` (`"true"` | `"1"` allows clearing while runs are active), `reset_ids` (`"true"` | `"1"` resets the `runs` autoincrement *only* if zero runs remain in the entire DB after the delete).
- **Response 200:** `{ ok: true, deleted: number, forced: number, screenshots_removed: number }`.
- **Response 409:** `{ error: "<n> run(s) still active", active: number }` if any run is `running` and `force` is not set. With `force`, active runs are best-effort `requestCancel`'d (return value ignored), then their rows are forced to `cancelled`.

> ⚠️ **Drift — `reset_ids` global side effect.** The route resets `sqlite_sequence` for the `runs` table only when `COUNT(*) FROM runs == 0`, but a successful reset affects future `runs.id` values *globally*. The guard makes it safe in practice; the parameter name (`reset_ids`) does not telegraph that "global" condition.

#### `GET /api/tasks/:taskId/runs` and `GET /api/runs/:id`

- **`/api/tasks/:taskId/runs` 200:** `Array<Run & { is_paused: boolean }>`, ordered `id DESC`. No 404 for unknown task — empty array.
- **`/api/runs/:id` 200:** `{ run: Run & { is_paused }, steps: Step[], pause_info: { reason?, auto? } | null }`.
- **`/api/runs/:id` 404:** `{ error: "not found" }`.

#### `GET /api/runs/:id/stream` (SSE)

- **Content-Type:** `text/event-stream`. Headers: `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` (nginx hint).
- **Frame format:** `data: <JSON>\n\n` per event. No `event:` field; no `id:` field; no retry hint.
- **Replay phase:** for every persisted row in `steps WHERE run_id = ?` ordered by `idx ASC`, sends `{ replay: true, step: Step }`.
- **Terminal-state short-circuit:** if the run row exists and is not `running`, sends one `{ kind: "end", status, result, error }` and closes the response. No subscribe.
- **Synthetic pause replay:** if `isPaused(runId)`, sends `{ kind: "paused", reason, auto }` after replay, before subscribing.
- **Live phase:** subscribes to the bus topic for `runId`. Each published event is forwarded verbatim as a JSON frame. The set of live `kind` values is governed by `event-bus.md` §2 (`block_start | block_end | thought | tool_call | tool_result | page_state | stats | var_set | remember | paused | resumed | error | final | end`).
- **End-of-stream:** the `end` event is the terminal frame the client should treat as "done". The route does not call `reply.raw.end()` on `end`; the connection is closed by the route only on the terminal-state short-circuit (not-running at connect time). For live runs, the connection is closed when the client disconnects — the route relies on `req.raw.on("close", unsubscribe)` and the eventual `endTopic(runId)` (scheduled 5 s after `end` by the `/run` IIFE) to release the topic.
- **Keepalive:** none. No heartbeat frames are sent. Long quiet stretches rely on TCP keepalive / proxy timeouts.
- **Disconnect handling:** `req.raw.on("close")` calls the unsubscribe disposer.

#### `GET /screenshots/*`

- **Response 200:** `image/png` body, streamed from `screenshots/<wildcard>`.
- **Response 404 (empty body):** when the file does not exist or the wildcard does not end in `.png`.
- **Path resolution:** literal string concat `` `screenshots/${req.params["*"]}` `` relative to the server's CWD. No path normalization, no sandbox check beyond the `.png` suffix.

> ⚠️ **Drift — path traversal & cross-platform concerns.** The wildcard is concatenated without normalization. A request like `/screenshots/../foo.png` reaches `existsSync("screenshots/../foo.png")` and, if the file exists and ends in `.png`, is served. The `127.0.0.1` bind plus the `.png` filter make this low-impact, but it is a path-traversal primitive nonetheless. On Linux/macOS the path is case-sensitive (e.g. `Screenshots/abc.png` will 404 if the directory is lowercase); on Windows it isn't. Captured paths in `steps.screenshot_path` are produced by `browser.ts` so case matches in practice — but any consumer constructing screenshot URLs by hand must respect the on-disk casing.

### Errors (summary)

| HTTP | Body                                                               | Triggered by                                                  |
|------|--------------------------------------------------------------------|---------------------------------------------------------------|
| 404  | `{ error: "task not found" }`                                      | `POST /api/tasks/:id/run` with unknown task                   |
| 404  | `{ error: "run not found" }`                                       | `POST /cancel`, `DELETE /api/runs/:id` with unknown id        |
| 404  | `{ error: "not found" }`                                           | `GET /api/runs/:id` with unknown id                           |
| 404  | (empty body)                                                       | `/screenshots/*` missing or non-`.png`                        |
| 409  | `{ error: "run is already <status>" }`                             | `POST /cancel` on a non-`running` row with no live handler    |
| 409  | `{ error: "run not active or already paused" }`                    | `POST /pause` when `pause()` returns false                    |
| 409  | `{ error: "run not active or not paused" }`                        | `POST /resume` when `resume()` returns false                  |
| 409  | `{ error: "run is still active — cancel it first, then delete" }`  | `DELETE /api/runs/:id` while `status='running'`               |
| 409  | `{ error: "<n> run(s) still active", active: <n> }`                | `DELETE /api/tasks/:taskId/runs` without `force` while active |

## 3. Invariants

- **I1 — Run starts produce one durable row.** Every successful `POST /run` results in exactly one new `runs` row, regardless of whether the agent later succeeds, errors, or cancels. Falsifiable: count rows before and after a 200 response.
- **I2 — Terminal status is exclusive.** A `runs` row reaches exactly one of `done | error | cancelled` via the IIFE's UPDATE. The `running` state is observable only between INSERT and that UPDATE (or until a force-cancel / zombie sweep flips it). Falsifiable: a finalized row has `finished_at IS NOT NULL` and `status != 'running'`.
- **I3 — End-event emission.** Every detached agent IIFE publishes exactly one `{ kind: "end" }` event. Force-cancel publishes one `{ kind: "end" }` for the zombie path. SSE clients can therefore treat `end` as "stop reading".
- **I4 — Replay-then-subscribe ordering.** On `GET /stream`, all `replay: true` envelopes are written before any live event. Falsifiable: if a live event is delivered while replay is mid-flight, it is queued in the bus subscriber callback (synchronous fan-out per `event-bus.md` I5) — but in practice, `subscribe()` is called *after* the `for` loop completes, so the live phase begins strictly after replay ends.
- **I5 — Pause-state surfacing on reconnect.** A UI reconnecting to a paused run sees a `{ kind: "paused" }` event after replay and before any live events. Falsifiable: pause an in-flight run, open a fresh SSE connection, observe `paused` in the frame stream.
- **I6 — Cancel idempotence at the registry.** `POST /cancel` while a run is already `cancelled`/`done`/`error` returns 409, not 200. (`requestCancel` is itself idempotent — see `run-control-cancel`.)
- **I7 — Screenshot deletion precedes row deletion.** `deleteRunArtifacts` removes every PNG referenced by `steps.screenshot_path` (best-effort; individual `unlink` failures are swallowed) before `DELETE FROM runs WHERE id`. The cascade then removes `steps`.
- **I8 — `is_paused` annotation is read-through.** List and detail endpoints decorate `Run` rows with `is_paused: isPaused(id)` so consumers do not need a second round-trip. The flag is in-memory only; restarting the server resets all `is_paused` to `false` even if rows are still `status='running'` (which they shouldn't be, post zombie sweep — see `persistence.md` I4).
- **I9 — `pauseAfter` block flag is not part of this surface.** Pause from the route is always user-initiated; auto-pause (`auto: true`) flows through the bus from `loginDetect` / stall detection, not via this route.

## 4. How (briefly)

- **Detached IIFE owns finalization.** The route returns `{ run_id }` after INSERT; the agent loop runs in a fire-and-forget async IIFE that owns the terminal UPDATE and the terminal `end` event. Errors thrown by `runAgent` are caught inside `runAgent` and surface as `outcome.status === "error"`; a throw escaping the IIFE would land in the Node unhandled-rejection handler with no row finalization. `runAgent`'s contract guarantees it does not throw — see `agent.ts`. *No defensive try/catch in the IIFE.*
- **Force-cancel zombie path.** `requestCancel` returns `false` when no in-process handler is registered for the run id. The route uses that as the signal to do a DB-only force-clear. Without this, a `tsx watch` reload during a run would leave the UI permanently spinning.
- **SSE write strategy.** Replays are synchronous SQLite reads serialized to the socket via `reply.raw.write`. No flush, no chunking strategy beyond what Node's HTTP layer applies. For very large run histories, the entire replay is written in one synchronous burst before `subscribe()` is called.
- **Bulk-delete rationale.** The `DELETE /api/tasks/:taskId/runs` shape supports the UI's "Clear all runs" affordance. `force` is required to clear active runs because the alternative would silently abandon them; `reset_ids` is a developer-affordance for keeping the autoincrement low after wipes.
- **No request validation.** Route handlers take params as strings and `Number()` them without bounds checking. `Number("abc")` becomes `NaN`, which fails the SQLite lookup and returns 404. Acceptable, but no schema (`zod`, etc.) is enforced.

## 5. How tested

| Spec section / claim                                | Test file | Test name | Status     |
|-----------------------------------------------------|-----------|-----------|------------|
| §2 `POST /run` 200 returns `run_id`                 | —         | —         | TODO(test) |
| §2 `POST /run` 404 for unknown task                 | —         | —         | TODO(test) |
| §2 `POST /cancel` live mode                         | —         | —         | TODO(test) |
| §2 `POST /cancel` force mode (zombie path)          | —         | —         | TODO(test) |
| §2 `POST /cancel` 404 for unknown run               | —         | —         | TODO(test) |
| §2 `POST /cancel` 409 for already-finalized run     | —         | —         | TODO(test) |
| §2 `POST /pause` and `/resume` 200 + 409 paths      | —         | —         | TODO(test) |
| §2 `DELETE /api/runs/:id` removes screenshot files  | —         | —         | TODO(test) |
| §2 `DELETE /api/runs/:id` 409 while running         | —         | —         | TODO(test) |
| §2 `DELETE /api/tasks/:taskId/runs` force semantics | —         | —         | TODO(test) |
| §2 `DELETE /api/tasks/:taskId/runs` `reset_ids` guard | —       | —         | TODO(test) |
| §3 I1 one row per `POST /run`                       | —         | —         | TODO(test) |
| §3 I3 exactly one `end` event per run               | —         | —         | TODO(test) |
| §3 I4 replay-then-subscribe ordering                | —         | —         | TODO(test) — integration scope; see `event-bus.md` drift |
| §3 I5 synthetic `paused` on reconnect               | —         | —         | TODO(test) |
| §3 I7 screenshot deletion precedes row deletion     | —         | —         | TODO(test) |
| §2 `/screenshots/*` 404 for non-`.png`              | —         | —         | TODO(test) |
| §2 `/screenshots/*` path-traversal probe (drift)    | —         | —         | TODO(test) |
| §2 SSE terminal-state short-circuit                 | —         | —         | TODO(test) |
| §2 SSE close on client disconnect calls unsubscribe | —         | —         | TODO(test) |

### Deliberately not tested

- The `agent.ts` orchestration itself (covered by `agent` spec / integration runner).
- Correctness of bus delivery (covered by `event-bus.md`).
- The pause/cancel registries (covered by `run-control-pause.md` / `run-control-cancel.md`).

## 6. Drift / open questions

- **⚠️ Drift — single-run invariant unenforced.** Two concurrent `POST /run` calls produce two concurrent `runAgent` invocations against the shared persistent Chromium context. Either reject the second call (`409 { error: "another run is active" }`) or document this is an upstream-UI invariant. The current code does neither.
- **⚠️ Drift — CORS `origin: true` on unauthenticated local server.** Any browser origin can drive these endpoints while the user is browsing elsewhere. Acceptable today (local-only, low-value side effects, all destructive ops are confirmed in the UI), but should be tightened to `http://localhost:5173` (and the app's prod origin) before any non-loopback bind, or coupled with a per-origin token.
- **⚠️ Drift — path traversal in `/screenshots/*`.** No `path.normalize` / no startsWith-screenshots check. Add `const resolved = path.resolve("screenshots", req.params["*"]); if (!resolved.startsWith(path.resolve("screenshots") + path.sep)) return 404;`.
- **⚠️ Drift — fire-and-forget IIFE has no top-level error catch.** A throw escaping `runAgent` becomes an unhandled rejection, leaves the row at `running`, and never publishes `end`. `agent.ts` is contracted not to throw, but a defensive `try/catch` here would convert any future regression into a finalized `error` row.
- **⚠️ Drift — `DELETE /api/tasks/:taskId/runs` with `force` does not wait for cancellation.** It calls `requestCancel`, immediately UPDATEs the row to `cancelled`, then deletes screenshots. The agent IIFE for that run is still alive and may publish further events, eventually try to UPDATE the row, and find it gone (or already terminal). No corruption observed (UPDATE WHERE id matches nothing is a no-op), but the agent's screenshot writes can race with `deleteRunArtifacts`'s file unlinks.
- **⚠️ Drift — no SSE `id:` field, no `Last-Event-ID` resume.** The browser's native EventSource will reconnect on transient drop, but the server has no cursor — it replays *everything* persisted so far on each reconnect. Fine for short runs; pathological for runs with thousands of steps and a flaky network.
- **❓ Open question — should this file be split?** `interface/http/routes/runs.ts` mixes nine endpoints, the SSE handler, and the screenshots static. Per `_LAYERS.md`, the SSE handler may belong in `interface/sse/runStream.ts` and the screenshots static in `interface/http/routes/screenshots.ts`. Ten small files vs one ~270-line file — a judgment call, defer until we add the next route.
- **❓ Open question — request-shape validation.** No `zod` / `typebox` / `@fastify/schema` validation on params or query. Move `force`/`reset_ids` parsing into a Fastify schema once a validation layer is adopted.
