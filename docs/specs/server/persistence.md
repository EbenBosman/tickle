# Spec — `persistence`

> Path: `server/src/db.ts` · Layer: mixed today (domain types + infrastructure SQLite). Post-refactor: types in `domain/`, store implementations in `infrastructure/persistence/sqliteRunStore.ts`, `sqliteTaskStore.ts`, etc. · Spec owner: `routes/tasks.ts`, `routes/runs.ts`, `agent.ts` (writer of `steps`), `web/src/components/RunView.tsx` (consumer of timestamp shape).

## 1. Why

Tickle persists three things across process lifetimes: user-defined task definitions, run history, and a per-run trace of every event the agent emits. Persistence has to survive `tsx watch` reloads, OS restarts, and crash-mid-run, because the SSE stream replays from SQLite when a UI reconnects late. SQLite is the smallest thing that does the job: a single file at `server/data/tickle.db`, no daemon, no network, accessible synchronously from the Node event loop.

> **Non-obvious why — `node:sqlite`, not `better-sqlite3`.** The project explicitly chose Node's built-in SQLite (stable in Node ≥24) so Windows users without Visual Studio C++ toolchain can install and run with no native compile. Switching to `better-sqlite3` would silently break that audience. Captured in `CLAUDE.md` "Things to avoid".
>
> **Non-obvious why — UTC timestamp string format.** `datetime('now')` returns space-separated UTC text (`"2026-05-08 13:42:01"`), no `Z` suffix. `Date.parse` reads that as _local_ time and is off by hours. The contract is normalised on the consumer side, not the producer side — see §3 I3 and §4.

## 2. Public contract

### Exports

| Symbol          | Kind     | Signature / shape                                                                     | Stability |
| --------------- | -------- | ------------------------------------------------------------------------------------- | --------- |
| `db`            | value    | `DatabaseSync` instance (singleton, opened at module-load)                            | stable    |
| `Task`          | type     | `{ id; name; instruction; steps: string \| null; created_at }`                        | stable    |
| `Run`           | type     | `{ id; task_id; status: RunStatus; result; error; started_at; finished_at }`          | stable    |
| `Step`          | type     | `{ id; run_id; idx; kind; payload; screenshot_path; created_at }`                     | stable    |
| `Lesson`        | type     | `{ id; run_id; block_id; lesson; situation; created_at }`                             | stable    |
| `getSetting`    | function | `(key: string) => string \| undefined`                                                | stable    |
| `setSetting`    | function | `(key: string, value: string) => void` (UPSERT)                                       | stable    |
| `addLesson`     | function | `(runId, blockId, lesson, situation) => void` (writes both `lessons` + `lessons_fts`) | stable    |
| `searchLessons` | function | `(query, limit?=5) => Lesson[]` (FTS5 with recency fallback)                          | stable    |
| `listLessons`   | function | `(offset?=0, limit?=50) => { lessons; total }`                                        | stable    |

`RunStatus` is the literal union `"running" | "done" | "error" | "cancelled"`. `Step["kind"]` is the literal union `"thought" | "tool_call" | "tool_result" | "error" | "final"` — see §6 drift, the agent persists more kinds than this type admits.

### Schema

| Table         | Column            | Type    | Null | Default           | Notes                                                                                                                     |
| ------------- | ----------------- | ------- | ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tasks`       | `id`              | INTEGER | no   | autoincrement PK  |                                                                                                                           |
|               | `name`            | TEXT    | no   |                   |                                                                                                                           |
|               | `instruction`     | TEXT    | no   |                   | Original free-text instruction; preserved post-block migration.                                                           |
|               | `steps`           | TEXT    | yes  |                   | JSON-encoded `Block[]`. NULL on legacy rows; lazily populated.                                                            |
|               | `created_at`      | TEXT    | no   | `datetime('now')` | UTC space-separated.                                                                                                      |
| `runs`        | `id`              | INTEGER | no   | autoincrement PK  |                                                                                                                           |
|               | `task_id`         | INTEGER | no   |                   | FK `tasks(id) ON DELETE CASCADE`.                                                                                         |
|               | `status`          | TEXT    | no   |                   | One of `running \| done \| error \| cancelled`. Validated only at the type layer (no `CHECK`).                            |
|               | `result`          | TEXT    | yes  |                   | Final summary on `done`.                                                                                                  |
|               | `error`           | TEXT    | yes  |                   | Reason on `error` / `cancelled`.                                                                                          |
|               | `started_at`      | TEXT    | no   | `datetime('now')` | UTC space-separated.                                                                                                      |
|               | `finished_at`     | TEXT    | yes  |                   | ISO-8601 (`new Date().toISOString()`) — written by routes/agent. _Format mismatch with `started_at`; see §6._             |
| `steps`       | `id`              | INTEGER | no   | autoincrement PK  |                                                                                                                           |
|               | `run_id`          | INTEGER | no   |                   | FK `runs(id) ON DELETE CASCADE`.                                                                                          |
|               | `idx`             | INTEGER | no   |                   | Per-run monotonic; assigned by `agent.ts` via in-memory counter.                                                          |
|               | `kind`            | TEXT    | no   |                   | Free text in DB; agent writes `thought, tool_call, tool_result, error, final, block_start, block_end, var_set, remember`. |
|               | `payload`         | TEXT    | no   |                   | JSON-encoded event payload.                                                                                               |
|               | `screenshot_path` | TEXT    | yes  |                   | Relative path under `screenshots/`.                                                                                       |
|               | `created_at`      | TEXT    | no   | `datetime('now')` | UTC space-separated.                                                                                                      |
| `settings`    | `key`             | TEXT    | no   | PK                | Seeded with `rescue_enabled`, `rescue_model`, `rescue_on_cancel`.                                                         |
|               | `value`           | TEXT    | no   |                   | All values stored as text.                                                                                                |
| `lessons`     | `id`              | INTEGER | no   | autoincrement PK  |                                                                                                                           |
|               | `run_id`          | INTEGER | yes  |                   | No FK declared; lessons survive run deletion.                                                                             |
|               | `block_id`        | TEXT    | yes  |                   |                                                                                                                           |
|               | `lesson`          | TEXT    | no   |                   |                                                                                                                           |
|               | `situation`       | TEXT    | yes  |                   |                                                                                                                           |
|               | `created_at`      | TEXT    | no   | `datetime('now')` |                                                                                                                           |
| `lessons_fts` | (FTS5)            |         |      |                   | Virtual `content='lessons', content_rowid='id'`; written manually by `addLesson`, _not_ by triggers.                      |

**Indices:** `idx_runs_task ON runs(task_id)`, `idx_steps_run ON steps(run_id, idx)`, `idx_lessons_run ON lessons(run_id)`.

**PRAGMAs at open:** `journal_mode = WAL`, `foreign_keys = ON`.

### Errors

| Error               | Returned when                         | Caller should…                                         |
| ------------------- | ------------------------------------- | ------------------------------------------------------ |
| (synchronous throw) | DB file unwritable / disk full        | Crash at module load; unrecoverable.                   |
| (none)              | `searchLessons` FTS5 query syntax err | Caught internally; falls back to recency-ordered list. |
| (none)              | `getSetting` unknown key              | Returns `undefined`; caller picks a default.           |

## 3. Invariants

- **I1 — `runs.status` is one of four literals.** Type-system enforced on the read side (`Run["status"]`); not enforced by a `CHECK` constraint in the DB. Falsifiable: SELECT distinct status values across the prod DB; expect ⊆ `{running, done, error, cancelled}`.
- **I2 — `steps.idx` is dense and monotonic per `run_id`.** Assigned by an in-memory counter in `agent.ts` (`stepIdx++`). Falsifiable: for any run, `MAX(idx) + 1 == COUNT(*)` and ordering by `idx` reproduces emission order.
- **I3 — Timestamps are UTC.** `datetime('now')` writes UTC; ISO writes from JS use `toISOString()` (also UTC). The frontend's `parseSqliteUtc` (in `web/src/components/RunView.tsx`) is the canonical parser — it accepts both space-separated and ISO-with-`Z` forms. Falsifiable: feeding `2026-05-08 13:42:01` and `2026-05-08T13:42:01Z` to `parseSqliteUtc` yields the same epoch ms.
- **I4 — Stale `running` rows are swept at process start.** On module load, every row with `status='running'` is forced to `cancelled` with a "stale — server restarted" error and `finished_at` set. Falsifiable: insert a `running` row, restart the server, observe row is `cancelled` with non-null `finished_at`.
- **I5 — `tasks.steps` is JSON or NULL.** Either a JSON-encoded `Block[]` or NULL on legacy rows; never another shape. Lazy migration (§4) only adds, never removes.
- **I6 — Cascade delete.** Deleting a task removes all its runs; deleting a run removes all its steps. Screenshot files on disk are _not_ cascaded — `routes/runs.ts::deleteRunArtifacts` handles that out-of-band.
- **I7 — `lessons` are not cascaded by run deletion.** `lessons.run_id` has no FK constraint, so lessons outlive their run. Intentional: lessons are knowledge, not run telemetry.

## 4. How (briefly)

- **Single-file open, side-effectful.** Importing `db.ts` opens the database, runs `CREATE TABLE IF NOT EXISTS` for every table, applies the legacy `tasks.steps` ALTER, seeds settings, and sweeps zombie `running` rows. There is no `init()`. Any module that imports `db` pays the open cost.
- **Lazy migration strategy (single-shot).** The only schema migration today is `tasks.steps`: at module load, a `PRAGMA table_info(tasks)` scan adds the column if missing. The data backfill is even lazier — `routes/tasks.ts::ensureSteps` runs on first GET of each task, parses `instruction` via `instructionToBlocks`, and writes JSON back. Works once because there is exactly one migration. _No migration framework exists._ Adding a second migration in the same style means the file accumulates ad-hoc `if (column missing)` blocks; that path doesn't scale and is the open question for §6.
- **Timestamp duality.** `created_at` / `started_at` use `datetime('now')` (space-separated UTC). `finished_at` is written by application code as `new Date().toISOString()` (T-separated, `Z`-suffixed). The consumer normalises both; the producer is inconsistent.
- **Concurrency.** Single Node process, all DB calls synchronous (`DatabaseSync`). WAL mode is enabled but is largely defensive — only one writer exists. No transactions are used today; multi-statement writes (e.g. `addLesson` writing both `lessons` and `lessons_fts`) are _not_ wrapped in `BEGIN/COMMIT`, so a crash between the two leaves the FTS index out of sync. See §6.
- **FTS5 wired manually.** `lessons_fts` is `content='lessons'` but no `INSERT/UPDATE/DELETE` triggers exist. `addLesson` writes both rows by hand; there is no `updateLesson` or `deleteLesson`, so divergence is bounded.

## 5. How tested

| Spec section / claim                                | Test file | Test name | Status                                                    |
| --------------------------------------------------- | --------- | --------- | --------------------------------------------------------- |
| §3 I1 status enum                                   | —         | —         | TODO(test)                                                |
| §3 I2 `steps.idx` density per run                   | —         | —         | TODO(test)                                                |
| §3 I3 timestamp UTC round-trip via `parseSqliteUtc` | —         | —         | TODO(test)                                                |
| §3 I4 zombie sweep on module load                   | —         | —         | TODO(test)                                                |
| §3 I5 lazy `steps` migration backfill               | —         | —         | TODO(test) — exercised via `routes/tasks.ts::ensureSteps` |
| §3 I6 cascade delete tasks → runs → steps           | —         | —         | TODO(test)                                                |
| §3 I7 lessons survive run deletion                  | —         | —         | TODO(test)                                                |
| §2 `searchLessons` FTS5 fallback on bad query       | —         | —         | TODO(test)                                                |

### Deliberately not tested

- The `node:sqlite` driver itself.
- WAL behaviour under concurrent writers — there are none.

## 6. Drift / open questions

- **⚠️ Drift — `Step["kind"]` type understates reality.** The exported type names five kinds (`thought | tool_call | tool_result | error | final`); `agent.ts::persist` writes nine (adds `block_start, block_end, var_set, remember`). Anyone reading `steps` via the typed `Step` will mis-narrow real rows. Fix: widen the union to match `agent.ts`, or extract a single `StepKind` source-of-truth in `domain/run.ts`.
- **⚠️ Drift — timestamp format inconsistency.** `started_at` is `"2026-05-08 13:42:01"`; `finished_at` written by application code is `"2026-05-08T13:42:01.123Z"`. Consumers cope via `parseSqliteUtc`, which accepts both. Producer should be normalised — pick ISO and use `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` everywhere, _or_ always write via JS. The current dual format is an accident, not a design.
- **⚠️ Drift — `runs.status` has no `CHECK` constraint.** A bug or a renamed status would corrupt the column silently. Add `CHECK (status IN ('running','done','error','cancelled'))` on the next migration.
- **⚠️ Drift — `addLesson` is not transactional.** Two separate `INSERT`s; a crash between them leaves `lessons_fts` desynced. Wrap in `db.exec('BEGIN'); …; db.exec('COMMIT')` or use SQLite's FTS5 content-table triggers instead of hand-mirroring.
- **⚠️ Drift — non-obvious why for FTS5 design.** `lessons_fts` exists but the search query is sanitised by stripping non-word chars (`replace(/[^\w\s]/g, " ")`). The reason — FTS5 syntax errors on punctuation — should be a code comment or test, not folklore.
- **❓ Open question — migration framework.** Today's "ALTER if column missing" pattern works for one migration. With two or more, we need either (a) a tiny `user_version`-driven runner, or (b) a library (`umzug`, hand-rolled). Decide before the next schema change.
- **❓ Open question — layer split.** Per `_LAYERS.md`, this module today violates the layering by mixing `domain/` (the `Task`, `Run`, `Step`, `Lesson` types and the `RunStatus` union) with `infrastructure/` (the `DatabaseSync` instance, schema DDL, prepared statements, FTS handling, zombie sweep). **Recommendation:**
  - `domain/task.ts` — `Task` type.
  - `domain/run.ts` — `Run`, `RunStatus`, `Step`, `StepKind` (single source-of-truth, fixing the drift above).
  - `domain/lesson.ts` — `Lesson` type.
  - `domain/settings.ts` — known-key contract for `getSetting`/`setSetting` keys.
  - `infrastructure/persistence/sqliteConnection.ts` — singleton `db`, PRAGMAs, schema bootstrap, zombie sweep (as a named function called from app startup, not a side-effect of import).
  - `infrastructure/persistence/sqliteTaskStore.ts` — task CRUD, including the lazy `ensureSteps` backfill (move it out of `routes/tasks.ts`).
  - `infrastructure/persistence/sqliteRunStore.ts` — run + step writes (the prepared `insertStep` currently in `agent.ts` belongs here behind a `RunStore.appendStep` method).
  - `infrastructure/persistence/sqliteSettingsStore.ts`, `sqliteLessonsStore.ts`.
  - `infrastructure/persistence/migrations/` — empty today; the home for a future runner.

  Routes and `agent.ts` then depend on store _interfaces_ defined in `domain/`, which makes the SQLite choice swappable and enables fakes for tests.
