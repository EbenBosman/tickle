# Spec — `web-api-client`

> Path: `web/src/api.ts` · Layer: `state/` (per `_LAYERS.md`; the only seam through which `state/` and `features/` reach the server). Must **not** be imported from `ui/`. · Spec owner: `web/src/App.tsx`, `web/src/components/RunView.tsx`, `web/src/components/TaskEditor.tsx`, `web/src/components/TaskList.tsx`, `web/src/components/BlockList.tsx`, `web/src/components/CompileFromText.tsx`, `web/src/components/SettingsPage.tsx`.

## 1. Why

The frontend speaks to the Fastify server through exactly one module: this one. Concentrating every `fetch` here gives the codebase a single audit surface for HTTP shape, a single place to evolve when an endpoint changes, and a single seam tests can stub. The shapes exported alongside (`Task`, `Run`, `Step`, `Settings`, `Lesson`) are what every screen passes through props — they are effectively the frontend's domain types in lieu of a real `domain/` module.

> **Non-obvious why — relative URLs, no base.** Every fetch is to a relative path (`/api/...`). In dev, the Vite proxy (`web/vite.config.ts`) forwards `/api` and `/screenshots` to `http://127.0.0.1:8787`. In production (no current shipped configuration) the same-origin assumption needs to hold or an equivalent reverse proxy must be configured. There is no `BASE_URL` env knob.
>
> **Non-obvious why — Promise rejection, not discriminated union.** `j<T>` throws a plain `Error` on non-2xx with body `${status} ${text}`. Every screen handles errors via try/catch or `.catch(console.error)`; nothing in the contract is `Result<T, E>`-shaped.
>
> **Non-obvious why — type drift with server is intentional today.** `Task`, `Run`, `Step` here are hand-copies of `server/src/db.ts` types; `Block` is re-exported from a hand-copy in `web/src/blocks.ts`. Per `_LAYERS.md`, the post-refactor target is a shared `domain/` module on each side that mirrors server `domain/`. Until then this duplication is load-bearing — it is what lets the web build avoid a TS path into `server/`.

## 2. Public contract

### Exports

| Symbol               | Kind   | Signature / shape                                                                                  | Stability |
|----------------------|--------|----------------------------------------------------------------------------------------------------|-----------|
| `Task`               | type   | `{ id, name, instruction, steps: string \| null, created_at }` (steps is JSON-encoded `Block[]`)   | mirrors `server/src/db.ts`; ⚠️ duplication |
| `Run`                | type   | `{ id, task_id, status: "running"\|"done"\|"error"\|"cancelled", result, error, started_at, finished_at, is_paused? }` | mirrors `server/src/db.ts`; ⚠️ duplication |
| `Step`               | type   | `{ id, run_id, idx, kind: "thought"\|"tool_call"\|"tool_result"\|"error"\|"final", payload: string, screenshot_path, created_at }` | ⚠️ kind union narrower than server (see §6) |
| `Settings`           | type   | `{ rescue_enabled, rescue_model, rescue_on_cancel, api_key_configured, lesson_count }`             | matches `http-settings.md` §2 |
| `Lesson`             | type   | `{ id, run_id, block_id, lesson, situation, created_at }`                                          | stable |
| `api`                | const  | object literal with the methods below; not a class                                                  | stable |

### Function table — client method ↔ server endpoint

| Client method | HTTP call | Server spec | Returns | Notes |
|---|---|---|---|---|
| `api.listTasks()` | `GET /api/tasks` | `http-tasks` §2 | `Task[]` | newest first |
| `api.getTask(id)` | `GET /api/tasks/:id` | `http-tasks` §2 | `Task` | 404 → throw |
| `api.createTask(name, instruction)` | `POST /api/tasks` body `{ name, instruction }` | `http-tasks` §2 | `Task` | does **not** send `steps` |
| `api.updateTask(id, patch)` | `PUT /api/tasks/:id` body `{ name?, instruction?, steps? }` | `http-tasks` §2 | `Task` | partial; `steps` is `Block[]` (JSON-stringified by `JSON.stringify(patch)`) |
| `api.deleteTask(id)` | `DELETE /api/tasks/:id` | `http-tasks` §2 | `unknown` | server always 200 (idempotent) |
| `api.startRun(taskId)` | `POST /api/tasks/:id/run` | `http-runs` §2 | `{ run_id: number }` | |
| `api.cancelRun(runId)` | `POST /api/runs/:id/cancel` | `http-runs` §2 | `{ ok: boolean }` | client discards `mode` field returned by server |
| `api.pauseRun(runId)` | `POST /api/runs/:id/pause` | `http-runs` §2 | `{ ok: boolean }` | |
| `api.resumeRun(runId)` | `POST /api/runs/:id/resume` | `http-runs` §2 | `{ ok: boolean }` | |
| `api.deleteRun(runId)` | `DELETE /api/runs/:id` | `http-runs` §2 | `{ ok: boolean }` | server returns `screenshots_removed` too — discarded |
| `api.clearTaskRuns(taskId, opts?)` | `DELETE /api/tasks/:taskId/runs?force&reset_ids` | `http-runs` §2 | `{ ok, deleted, forced }` | **special-cases 409** (see Errors below); discards `screenshots_removed` |
| `api.compileBlocks(prompt)` | `POST /api/blocks/compile` body `{ prompt }` | `http-compile` §2 | `{ blocks: Block[] }` | |
| `api.listRuns(taskId)` | `GET /api/tasks/:taskId/runs` | `http-runs` §2 | `Run[]` | each row carries `is_paused` |
| `api.getRun(runId)` | `GET /api/runs/:id` | `http-runs` §2 | `{ run, steps, pause_info }` | |
| `api.getSettings()` | `GET /api/settings` | `http-settings` §2 | `Settings` | |
| `api.updateSettings(patch)` | `PUT /api/settings` | `http-settings` §2 | `Settings` (read-after-write) | |
| `api.listLessons(offset?, limit?)` | `GET /api/lessons?offset&limit` | `http-settings` §2 | `{ lessons: Lesson[]; total: number }` | defaults `offset=0`, `limit=50` |
| `api.deleteLesson(id)` | `DELETE /api/lessons/:id` | `http-settings` §2 | `{ ok: boolean }` | idempotent server-side |
| `api.exportTrainingData(onlyRescued?)` | `GET /api/export?status=rescued` (when true) | `http-export` §2 | `Blob` (`application/x-ndjson`) | `onlyRescued=false` omits the query param |

### SSE / streaming surface

This module **does not own SSE**. `EventSource` for `GET /api/runs/:id/stream` (per `http-runs` §2) is constructed inline in `web/src/components/RunView.tsx:134`. ⚠️ Per `_LAYERS.md`, the run-stream subscription belongs in `state/useRunStream.ts` — a `ui/`-tier component should not be opening sockets. See §6.

### Errors

`j<T>(res)` is the central response unwrapper:

| Condition                  | Behaviour                                                              |
|----------------------------|------------------------------------------------------------------------|
| `res.ok` (2xx)             | `res.json()` parsed and returned as `T`. No schema validation.         |
| Non-2xx                    | Throws `new Error(`${status} ${await res.text()}`)`.                   |
| Network failure (`fetch` rejects) | `fetch`'s rejection propagates unchanged (typically `TypeError: Failed to fetch`). |
| 204 / empty body on 2xx    | `res.json()` will throw a SyntaxError. ⚠️ No 204 path is exercised today (every server route returns a JSON body), but the contract is fragile here. |

Special-case: `api.clearTaskRuns` does **not** route through `j<T>`. It inspects `res.status === 409`, parses the JSON body, and throws a decorated error: `Object.assign(new Error(body.error ?? "runs still active"), { status: 409, active: body.active })`. Callers (`App.tsx` "Clear all runs" path) read `err.status === 409` to offer a "force" retry. This is the **only** typed-error path in the module.

`api.exportTrainingData` does its own `if (!r.ok) throw new Error(${r.status})` — note no body text, status only.

## 3. Invariants

- **I1 — All requests are same-origin relative.** No method hard-codes `http://127.0.0.1:8787`. Falsifiable: `grep "http" web/src/api.ts` returns 0 hits in URLs. Implication: production hosting must same-origin or proxy `/api` and `/screenshots`.
- **I2 — Non-2xx becomes a thrown `Error` whose `message` starts with the HTTP status.** Callers may pattern-match on the status prefix today; the only structured field is `error.status === 409` set by `clearTaskRuns`.
- **I3 — JSON request bodies always set `content-type: application/json`.** Every `POST`/`PUT` with a body sets the header explicitly. Falsifiable: each `fetch` with `method: "POST"` or `"PUT"` and a `body` has the header.
- **I4 — Read methods do not retry.** A transient 502 from `/api/blocks/compile` (`http-compile.md` I10) surfaces as a thrown error on the first try. Frontend retry is user-driven (click again).
- **I5 — `clearTaskRuns` is the only method with a 409 fast-path.** All other 409s (`/cancel`, `/pause`, `/resume`, `DELETE /api/runs/:id`) become generic thrown errors stringifying status + body.
- **I6 — Method names mirror server resources, not REST verbs.** `startRun`/`cancelRun`/`pauseRun`/`resumeRun`/`deleteRun` are intent-named, not e.g. `runs.create()`. New endpoints should follow the same pattern.
- **I7 — `Block` is imported from `web/src/blocks.ts`, not from `server/`.** TypeScript path constraint: this module's only project-relative import is `./blocks.ts`. Falsifiable: `import` graph audit.
- **I8 — `parseSqliteUtc` is not in this module.** Lives in `web/src/components/RunView.tsx:570`. ⚠️ Per `_LAYERS.md` it should be promoted to `state/parseSqliteUtc.ts` (or `domain/`) so other consumers don't reinvent it. See §6.

## 4. How (briefly)

- **Single dispatcher.** `j<T>(res)` centralises `res.ok` checking and JSON parsing. Every method but `clearTaskRuns` and `exportTrainingData` chains `.then((r) => j<T>(r))`.
- **No request abstraction.** No retry helper, no global headers function, no auth header (server is unauth — `http-runs.md` §2 drift). Adding e.g. CSRF tokens later means touching every method, which is acceptable while the module stays at its current ~137 LOC.
- **Query params built ad hoc.** `clearTaskRuns` and `exportTrainingData` build query strings by hand. `listLessons` interpolates into the path. No `URLSearchParams` helper.
- **Response shapes are unchecked.** `j<T>` is `Promise<T>` because the caller asserts `T`; the body could be anything. There is no Zod / runtime validator. This is the corollary of §3 in `http-tasks.md` (server doesn't validate write input either) — both sides trust the wire.
- **Blob path.** `exportTrainingData` does not parse JSON; it returns the raw `Blob`. `SettingsPage.tsx` then constructs an object URL and triggers a download.

## 5. How tested

| Spec section / claim | Test file | Test name | Status |
|---|---|---|---|
| §2 each `api.*` method hits the documented endpoint with the documented method | — | — | TODO(test) |
| §2 `clearTaskRuns` 409 throws Error with `status` and `active` fields | — | — | TODO(test) |
| §2 `exportTrainingData(true)` appends `?status=rescued`; `false` omits | — | — | TODO(test) |
| §3 I1 no absolute `http://` URLs anywhere | — | — | TODO(test) — static |
| §3 I2 non-2xx throws Error whose message starts with status code | — | — | TODO(test) |
| §3 I3 JSON `content-type` header on all POST/PUT-with-body methods | — | — | TODO(test) |
| §3 I7 import graph: only project import is `./blocks.ts` | — | — | TODO(test) — static |
| §2 `j<T>` on empty 204 body — fragile, see §6 | — | — | TODO(test) — currently no 204 server path |

### Deliberately not tested

- The Vite dev proxy itself.
- Server-side response shapes (covered in their own `http-*` specs).
- `EventSource` reconnection semantics (lives in `RunView.tsx`; will move to a future `state/useRunStream.ts` spec).

## 6. Drift / open questions

- **⚠️ Drift — type duplication with server (`_LAYERS.md` target).** `Task`, `Run`, `Step` here are hand-copies of `server/src/db.ts`. `Block` and `BlockKind` in `web/src/blocks.ts` mirror `server/src/blocks.ts`. The post-refactor target is `web/src/domain/` mirroring `server/src/domain/` (per `_LAYERS.md`). Migration plan: extract a `domain/` package on each side, or a shared workspace package, before the next type addition.
- **⚠️ Drift — `Step.kind` union is narrower than server.** This module declares `"thought" | "tool_call" | "tool_result" | "error" | "final"` (5 variants). Server's bus events include also `block_start`, `block_end`, `var_set`, `page_state`, `stats`, `paused`, `resumed`, `remember`, `end` (see `http-runs` §2 SSE). Persisted `steps` rows can carry any of those `kind`s — the type lies. `RunView.tsx`'s SSE consumer reads `data.kind` as `string`, so the lie is invisible at runtime, but a caller switching on `step.kind` with TypeScript exhaustiveness would silently miss handlers. Resolve by widening to the full `SseEvent.kind` union sourced from `domain/`.
- **⚠️ Drift — `parseSqliteUtc` lives in `RunView.tsx`.** CLAUDE.md names it the canonical normaliser; it should be in `state/` (or `domain/`), not in a `ui/` component file. Promote when the next consumer appears.
- **⚠️ Drift — SSE not in `state/`.** `EventSource` for `/api/runs/:id/stream` is opened in `RunView.tsx:134`. `_LAYERS.md` requires `state/` to own subscriptions; `ui/` should consume a hook. Carve out `state/useRunStream.ts` in the next refactor pass.
- **⚠️ Drift — silent field discards.** `cancelRun` discards the server's `mode: "live" | "force"` (`http-runs` §2), `deleteRun` and `clearTaskRuns` discard `screenshots_removed`. Either type the return more accurately or document explicitly that the client doesn't need them. The "force" mode in particular is interesting telemetry the UI throws away.
- **⚠️ Drift — no client method for `/screenshots/*`.** Screenshot PNG URLs are constructed inline by `RunView.tsx` as `/screenshots/<path>`. Acceptable (it's an `<img src>`, not a fetch) but undocumented here.
- **⚠️ Drift — no coverage of the `messages_export` SSE event or any future `remember` events.** As `agent.ts` adds new `kind`s to the bus, this file does not need updates (untyped passthrough), but `Step.kind` does.
- **⚠️ Drift — fragile-on-204.** `j<T>` calls `res.json()` unconditionally on 2xx. If a server route ever returns 204 No Content, this will throw a SyntaxError. Today no route does (`api.deleteTask` for instance returns `{ ok: true }`); pin this contract with a test or harden `j<T>` to handle empty bodies.
- **⚠️ Drift — `api.deleteTask` typed as `Promise<unknown>`.** Other delete methods are `Promise<{ ok: boolean }>`. Inconsistent; widen all to a `DeleteResult` type or narrow this one.
- **❓ Open — production base URL.** No env-driven `VITE_API_BASE_URL`. Add when the first non-localhost deployment lands; until then, document "same-origin assumed" here.
- **❓ Open — should the export endpoint accept `since`/`run_id`?** Mirrors the `http-export.md` §6 question; the client would then need new optional args.

### Endpoint coverage check (drift the other way)

Endpoints declared by server specs but **not** called by this client:

- `GET /screenshots/*` — used as `<img src>`, not via fetch; intentional.
- (No other gaps detected against `http-tasks`, `http-runs`, `http-compile`, `http-export`, `http-settings`.)

Client methods targeting endpoints **not** present in any server spec: none detected.
