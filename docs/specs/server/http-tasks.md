# Spec — `http-tasks`

> Path: `server/src/routes/tasks.ts` · Layer: `interface/http/routes/` · Spec owner: `web/src/api.ts`, `web/src/components/TaskList.tsx`, `web/src/components/TaskEditor.tsx`. Run-trigger lives next door in `routes/runs.ts` (`POST /api/tasks/:id/run`) — see `http-runs.md`.

## 1. Why

Task definitions are the persistent input the agent operates on. This module is the CRUD seam between the React editor and the `tasks` table, plus the home of the one-shot lazy migration that converts pre-block-era free-text `instruction` rows into the typed `Block[]` shape the executor consumes today. Keeping the migration on the read-path (rather than at module load in `db.ts`) avoids touching every legacy row at startup and lets a never-opened task lie dormant indefinitely. Task triggering — `POST /api/tasks/:id/run` — is intentionally **not** here; it lives in `routes/runs.ts` because it owns the run lifecycle.

> **Non-obvious why — `instruction` is preserved post-migration.** Even after `steps` is populated, the original instruction text stays in the row. It is the fallback for `parseBlocks` when `steps` JSON is corrupted, and it is what `instructionToBlocks` re-runs on if a future migration needs to re-derive blocks.

## 2. Public contract

### HTTP surface

| Method | Path                | Body                                                  | Success | Errors |
|--------|---------------------|-------------------------------------------------------|---------|--------|
| `GET`  | `/api/tasks`        | —                                                     | `200 Task[]` (newest first by `id DESC`); each row run through `ensureSteps` | — |
| `GET`  | `/api/tasks/:id`    | —                                                     | `200 Task` (post-`ensureSteps`) | `404 { error: "not found" }` |
| `POST` | `/api/tasks`        | `{ name: string; instruction?: string; steps?: Block[] }` | `200 Task` (the inserted row) | `400 { error: "name required" }` if `name` empty/whitespace |
| `PUT`  | `/api/tasks/:id`    | `{ name?; instruction?; steps?: Block[] }` (partial)  | `200 Task` (post-update) | `404 { error: "not found" }` |
| `DELETE` | `/api/tasks/:id`  | —                                                     | `200 { ok: true }` | — (idempotent: missing id still 200) |

`Task` shape: see `persistence.md` §2. `Block[]` shape: see `blocks.md`.

### Errors

| Error                          | Returned when                                | Caller should…                          |
|--------------------------------|----------------------------------------------|-----------------------------------------|
| `400 { error: "name required" }` | `POST` with empty/whitespace `name`        | Show validation, keep editor open.      |
| `404 { error: "not found" }`   | `GET`/`PUT` for unknown id                   | Treat as deleted; refresh list.         |

> ⚠️ **Drift — `DELETE` returns 200 for unknown id.** No row check; SQL DELETE is silent on no-match. Cascades via `runs(task_id) ON DELETE CASCADE` (see `persistence.md` §3 I6).

## 3. Invariants

- **I1 — Read returns blocks-shaped JSON.** Every `Task` returned by `GET /api/tasks` and `GET /api/tasks/:id` has `steps` populated as a JSON-encoded `Block[]` (possibly `"[]"`), never `null`. Falsifiable: insert a row with `steps IS NULL`, GET it, observe `steps` is a JSON array string and the row in DB is now non-null.
- **I2 — `ensureSteps` is idempotent.** Calling `ensureSteps` on a row whose `steps` is already non-null returns the row unchanged and does not write. Falsifiable: `PUT` a task with explicit `steps`, then `GET` it twice and observe identical `steps` and no extra UPDATE.
- **I3 — Empty instruction migrates to `[]`.** A task whose `instruction` is empty or whitespace-only migrates to `steps = "[]"`, not to a goal block with empty description. Falsifiable: insert legacy row with `instruction=""`, `steps=NULL`; GET; observe `steps === "[]"`.
- **I4 — Non-empty instruction migrates to a single `goal` block.** `instructionToBlocks` produces exactly `[{ id: <uuid>, kind: "goal", description: <trimmed instruction> }]`. Falsifiable: insert legacy row with `instruction="do X"`, GET, parse `steps`, expect length 1, kind `goal`, description `"do X"`.
- **I5 — Migration is single-shot and persisted.** First GET writes the JSON back to the row; subsequent GETs hit the I2 idempotent branch. Falsifiable: GET legacy row, inspect DB directly, observe `steps` is now non-null without further GETs.
- **I6 — `POST` and `PUT` accept `Block[]` as trusted input.** No schema validation of block `kind`, `id`, or required per-kind fields is performed on write. Whatever the client sends is `JSON.stringify`-ed into the column. The executor (`agent.ts`) is the only enforcer of block validity, at run time. ⚠️ See §6.
- **I7 — `PUT` preserves unspecified fields.** Omitting `name`/`instruction`/`steps` keeps the existing values; sending `steps: []` explicitly clears blocks; sending `name: "  "` becomes `existing.name` (because `?.trim() ?? existing.name` falls through on empty string — see §6).

## 4. How (briefly)

- **`ensureSteps` algorithm.** Read-path lazy backfill. If `task.steps` is truthy, return as-is. Otherwise compute `blocks = trim(instruction) ? instructionToBlocks(instruction) : []`, `JSON.stringify`, `UPDATE tasks SET steps = ? WHERE id = ?`, return a *copy* of the task with `steps` set to the new JSON. The DB write and the in-memory row update are separate; a crash between them yields a row that gets re-migrated on the next GET — still safe because `instructionToBlocks` is deterministic *modulo `randomUUID`*. (The block id will differ across runs; see §6.)
- **No transactions.** Each handler is a single prepared-statement `.run()` or `.get()`. SQLite auto-commit is sufficient because no handler does multi-row writes.
- **Validation surface.** Only `POST.name` is validated. `instruction` is trimmed but accepted empty. `steps` is type-asserted via `Array.isArray` only — element shapes are not checked.
- **`PUT` merge semantics.** `req.body.name?.trim() ?? existing.name` — note this uses `??` (null-coalesce) on the result of `trim()`; an empty body field stays as `""` after `trim()`, which is **truthy enough to bypass `??`** and overwrites the row with `""`. ⚠️ §6.
- **Atomicity of migration.** A given task can race two concurrent GETs; both compute identical block content (Empty → `[]`; non-empty → goal block, but with *different* random uuids). The last UPDATE wins. Practically irrelevant — the UI is single-user — but worth knowing.

## 5. How tested

| Spec section / claim                               | Test file | Test name | Status     |
|----------------------------------------------------|-----------|-----------|------------|
| §2 `POST` 400 on empty name                        | —         | —         | TODO(test) |
| §2 `GET /:id` 404 on unknown id                    | —         | —         | TODO(test) |
| §3 I1 read always returns non-null `steps`         | —         | —         | TODO(test) |
| §3 I2 `ensureSteps` idempotency / no extra UPDATE  | —         | —         | TODO(test) |
| §3 I3 empty instruction migrates to `[]`           | —         | —         | TODO(test) |
| §3 I4 non-empty instruction yields single `goal` block | —     | —         | TODO(test) |
| §3 I5 first-GET persistence to DB                  | —         | —         | TODO(test) |
| §3 I7 `PUT` field preservation when omitted        | —         | —         | TODO(test) |
| §6 drift — `PUT name: ""` should reject (currently overwrites) | — | —    | TODO(test) — pin current buggy behaviour or fix |
| §6 drift — `POST steps` rejects malformed block    | —         | —         | TODO(test) — currently no validation |

### Deliberately not tested

- The `node:sqlite` driver itself.
- `instructionToBlocks` shape — covered in `blocks.md` tests.

## 6. Drift / open questions

- **⚠️ Drift — `PUT` empty-string overwrite.** `req.body.name?.trim() ?? existing.name` does not preserve when client sends `name: ""`: `"".trim()` is `""`, which is not nullish, so `??` returns `""` and the row's `name` is wiped. Same bug for `instruction`. Should be `req.body.name?.trim() || existing.name` *or* explicit-presence checks. The 400 validation on `POST` does not protect `PUT`.
- **⚠️ Drift — no block validation on write.** §3 I6: a malformed `Block[]` round-trips through the column and only blows up at run time inside `runAiSubGoal`. Either (a) parse with a Zod schema mirroring `domain/block.ts`, or (b) document explicitly that the editor (`web/src/components/BlockList.tsx`) is the only producer and trusted. Today's behaviour is accidentally permissive.
- **⚠️ Drift — `DELETE` always 200.** §2 errors row absence: deleting an unknown id silently succeeds. Either return `404` (consistent with `GET`/`PUT`) or document the idempotent contract. Pick one.
- **⚠️ Drift — lazy migration leaks block-id volatility.** I5 + the `randomUUID` in `instructionToBlocks` mean a legacy task that has *never* been GETed has no stable block id; a race between two concurrent GETs produces two different ids and a last-write-wins UPDATE. In a single-user UI this never bites, but it violates the spirit of "block ids are stable identifiers." Fix by computing the migration during the `db.ts` schema bootstrap once, *or* by deriving the id deterministically from `(task_id, 0)`.
- **⚠️ Drift — layer split.** Per `_LAYERS.md`, this file is `interface/http/routes/` and should depend on a `TaskStore` interface in `domain/`, not on `db` and `instructionToBlocks` directly. The `ensureSteps` migration belongs in `infrastructure/persistence/sqliteTaskStore.ts` (called from a store method like `getOrMigrate(id)`), not inline in the route handler. Captured at the system level in `persistence.md` §6.
- **❓ Open question — block-schema validation.** Should `POST/PUT` reject malformed `steps`? If yes, that schema needs a single source-of-truth (`domain/block.ts` with a runtime parser); see `blocks.md`.
- **❓ Open question — concurrent-edit semantics.** No `If-Match`/etag/version; two browser tabs editing the same task last-write-wins. Acceptable for a local single-user tool but should be documented as such.
