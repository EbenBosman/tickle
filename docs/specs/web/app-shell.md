# Spec — `app-shell`

> Path: `web/src/App.tsx` · Layer: `features/app-shell/` (post-refactor target — currently a single ~380-line god component mixing routing, top-level state, layout chrome, screen embedding, recent-runs sidebar, and a stats footer) · Spec owner: `web/src/main.tsx` (mounts it as the React tree root); structurally also owned by Phase 5 of the refactor plan in `docs/specs/_LAYERS.md`.

## 1. Why

`App` is the single React tree root. Its job is small in principle — pick a task, pick (or start) a run, give the right child screen the right props — but the file has grown to absorb every cross-cutting concern that didn't have an obvious home: aggregate token/throughput stats, server-model + context-window discovery, block-status mirroring from `RunView` so `TaskEditor` can highlight the running block, the Settings drawer overlay, the "Recent runs" sidebar, the stats footer, and the empty-state placeholders. It is the canonical god file the Phase 5 refactor must dismantle into `state/` hooks plus `features/<screen>/` folders per `_LAYERS.md` §Web.

> **Non-obvious why — block status flows up then down.** `RunView` is the only owner of the SSE stream, but `TaskEditor` (in a sibling pane) needs per-block status to render colored chips on the block list. `App` mediates: it accepts `onBlockStatus({ blockId, statusMap })` from `RunView` and passes the latest `statusMap` + `runningBlockId` down to `TaskEditor`. After the refactor this becomes a shared `state/useRunStream.ts` store that both screens read directly.
>
> **Non-obvious why — stats footer accumulates across the whole run, not per LLM call.** `handleStats` adds each `RunStatsSample` to running totals (`totalOutputTokens`, `totalEvalMs`) so the footer can show **average** tok/s in addition to last-call tok/s. Resets when `activeRunId` changes (see I3). `RunView` is stateless about totals — it only forwards samples up.
>
> **Non-obvious why — `/api/health` polled on focus + 30s interval.** The server's reported `model` and `context_window` may change without the page reloading (user edits `.env` and restarts the server, or hot-swaps a model in LM Studio). Re-fetching on `window.focus` catches the common "server restart while page open" case; the 30s timer covers the "page left open in background" case. Cheap call (`GET /api/health` is a static JSON read), so polling is fine.

## 2. Public contract

### Exports

| Symbol                    | Kind     | Signature / shape                                                                                                                     | Stability |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `App`                     | function | `() => JSX.Element` — default export. **No props.**                                                                                   | stable    |
| `AggStats`                | —        | local type; not exported. Belongs in `domain/run-stats.ts`.                                                                           | drift     |
| `StatsFooter`             | —        | local component; not exported.                                                                                                        | —         |
| `Empty`                   | —        | local component; not exported.                                                                                                        | —         |
| `RecentRuns`              | —        | local component; not exported.                                                                                                        | —         |
| `runDuration`             | —        | imported from `web/src/state/parseSqliteUtc.ts` (sibling of `parseSqliteUtc` and `formatDuration`).                                   | stable    |
| `formatTokens`            | —        | local helper; belongs in `ui/formatTokens.ts`.                                                                                        | drift     |
| `CONTEXT_WINDOW_FALLBACK` | —        | local constant `32_768`. Used only when `/api/health` omits `context_window`.                                                         | —         |

### Consumed HTTP / SSE surface

- `GET /api/health` on mount, on `window.focus`, every 30s. Reads `{ model, context_window }`.
- `GET /api/tasks` via `api.listTasks()` — once on mount and after every mutation (create / delete / save).
- `POST /api/tasks` via `api.createTask("Untitled task", "")` — from the "+ New" button in the task list.
- `DELETE /api/tasks/:id` via `api.deleteTask(id)` — from the per-row delete control.
- `POST /api/tasks/:id/run` via `api.startRun(id)` — from the Run button in `TaskEditor`.
- `GET /api/tasks/:id/runs` via `RecentRuns` (a child of `App`) — when no run is active and a task is selected.
- `DELETE /api/runs/:id`, `DELETE /api/tasks/:id/runs?...` via `api.deleteRun` / `api.clearTaskRuns` — from the recent-runs row affordances.

### Errors surfaced

| Source                                  | Surface                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `api.createTask` reject                 | `useUiPrompts().toast.error(...)`. No state change.                                  |
| `api.deleteTask` reject                 | `useUiPrompts().toast.error(...)`. List not refreshed (stale UI).                    |
| `api.deleteRun` reject (`RecentRuns`)   | `useUiPrompts().toast.error(...)`.                                                   |
| `api.clearTaskRuns` 409 (active runs)   | `useUiPrompts().confirm({ destructive })` modal; on confirm retries with `force=true`. Second failure → `toast.error`. |
| `api.listTasks` / `api.listRuns` reject | `console.error`; UI stays at last-known-good state.                                  |
| `/api/health` reject                    | Silently swallowed (`.catch(() => {})`); model/context defaults retained.            |
| `api.startRun` reject                   | **Unhandled** — promise rejection escapes. ⚠️ Drift: should `alert` like the others. |

### Routing

There is no router. **All navigation is internal `useState`:** `selectedId`, `activeRunId`, `showSettings`. URLs do not encode which task or run is open; refreshing the page returns to the auto-selected most-recent task with no active run. ⚠️ Drift: a deep-link contract belongs in `state/useRoute.ts` (or react-router) once anyone needs to share a run URL.

## 3. Invariants

- **I1 — Auto-select most-recent task on empty selection.** When `selectedId === null && tasks.length > 0`, the effect sets `selectedId = tasks[0].id`. This fires on first load _and_ after the currently selected task is deleted. Falsifiable: render with `tasks=[]`, push a task in, observe `selectedId` becomes that task's id.
- **I2 — Selecting a task clears the active run.** `onSelect` and `onCreate` both call `setActiveRunId(null)`. Consequence: switching tasks always returns the right pane to the `RecentRuns` view. Falsifiable: with `activeRunId !== null`, click another task → `activeRunId === null` and `RunView` unmounts.
- **I3 — Stats and block status reset on `activeRunId` change.** A `useRef(lastRunRef)` compares the new `activeRunId` against the prior one; on change it clears `stats`, `blockStatusMap`, and `runningBlockId`. Falsifiable: accumulate stats from run #5, switch to run #7, observe footer reads "idle" / no totals before any `stats` event arrives from the new stream.
- **I4 — Settings drawer is an overlay, not a route.** `showSettings` toggles a `position: absolute` panel that overlays the three columns; the underlying state (selected task, active run, SSE) is unaffected. Falsifiable: open Settings during a live run; the run's SSE stream remains open and the entry list keeps growing in the (now-occluded) right pane.
- **I5 — `RecentRuns` mounts only when `activeRunId === null && selected !== null`.** The right pane is a three-way switch: `RunView` (if `activeRunId`), else `RecentRuns` (if a task is selected), else `Empty`. Falsifiable: with `activeRunId=null` and `selectedId=null`, the right pane shows the "No run" empty state, not `RecentRuns`.
- **I6 — `RecentRuns` refreshes on `taskId` change only.** The `useEffect([taskId])` re-fetches when the task changes; it does **not** poll. New runs started from `TaskEditor` won't appear here until the user navigates away and back, or until clear/delete forces a refresh. ⚠️ Drift: should refresh on `activeRunId` transitioning from non-null to null (run finished, user backed out).
- **I7 — Stats footer's context-percent uses `serverContextWindow` from `/api/health`, falling back to `32_768`.** A model with a 128k window will not show as "100% full" at 32k. Falsifiable: if `/api/health` returns `context_window: 131072`, a 33k-token sample shows ~25% bar; with the fallback it shows >100% clamped to 100%.
- **I8 — `formatTokens` is k/M-suffixed at thresholds 1_000 and 1_000_000.** `999 → "999"`, `1_000 → "1.0k"`, `999_999 → "1000.0k"` (yes, off by one — see drift), `1_000_000 → "1.0M"`. Falsifiable: trivial unit test once extracted.

## 4. How (briefly)

`App` is a single function component holding nine pieces of state plus one ref:

| State                 | Purpose                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `tasks`               | List of all tasks. Refreshed by `refresh()` after every create/delete/save.                     |
| `selectedId`          | Currently edited task id. Drives the middle and right panes.                                    |
| `activeRunId`         | Currently watched run id. When non-null, right pane is `RunView`; cleared on task switch.       |
| `showSettings`        | Boolean for the overlay drawer.                                                                 |
| `stats`               | Aggregated `AggStats` for the footer; `null` between runs.                                      |
| `serverModel`         | Last-known model name from `/api/health`; falls back into the footer when no `stats` yet.       |
| `serverContextWindow` | Last-known context window from `/api/health`; defaults to `32_768`.                             |
| `blockStatusMap`      | Mirror of `RunView`'s cumulative status map; passed down to `TaskEditor` for chip coloring.     |
| `runningBlockId`      | Currently running block id; passed down to `TaskEditor` for highlight.                          |
| `lastRunRef`          | Ref tracking the previously rendered `activeRunId` so I3's reset effect can detect transitions. |

Layout is a CSS grid: `header` row, `main` (3+5+4 of 12 cols), `footer`. Each column is `min-h-0 overflow-y-auto`, so each pane scrolls independently. The Settings drawer is `position: absolute; top: 46px; inset-0` with a click-to-close backdrop and a 480px right-aligned panel.

`RecentRuns` is a self-contained subtree that mounts beside the absent run pane: it owns its own `runs[]` state and refresh logic, and survives independently of the parent's task/run selection. It uses `confirm()` + `alert()` for destructive actions; on a 409 from `clearTaskRuns` it re-prompts the user before retrying with `force=true`.

The stats footer reads `stats.promptTokens + stats.outputTokens` for the _most recent_ call's context fill; it is **not** a "running max" or "current conversation length" — just whatever the last `chatOnce` reported. The progress-bar color thresholds are fixed at >50% amber, >80% red.

## 5. Decomposition target (post-refactor)

The current single file mixes **at least eight** concerns. The `_LAYERS.md` target carves them as follows. This list is the spec the refactor must produce:

| Concern in today's `App.tsx`                                                                                                      | Target file (`web/src/...`)                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Tasks list state + CRUD wiring (`tasks`, `selectedId`, `refresh`, `createTask`/`deleteTask` handlers, auto-select-most-recent I1) | `state/useTaskStore.ts`                                                                             |
| Active run selection + stats reset on change (`activeRunId`, `lastRunRef`, I2/I3)                                                 | `state/useActiveRun.ts`                                                                             |
| Aggregate stats accumulator (`AggStats`, `handleStats`, totals, avg tok/s)                                                        | `state/useRunStats.ts` + `domain/run-stats.ts` for the type                                         |
| Block status mirror (`blockStatusMap`, `runningBlockId`, `handleBlockStatus`)                                                     | Folded into `state/useRunStream.ts` (per `run-view.md` §5) — both panes subscribe.                  |
| Server-info polling (`/api/health`, focus listener, 30s interval, `serverModel`, `serverContextWindow`, fallback constant)        | `state/useServerInfo.ts`                                                                            |
| Top-level layout chrome (header, three-column grid, settings overlay drawer, `<aside>`/`<section>` wiring)                        | `features/app-shell/AppShell.tsx`                                                                   |
| Settings drawer overlay logic (`showSettings`, backdrop click, panel position)                                                    | `features/app-shell/SettingsDrawer.tsx`                                                             |
| Stats footer (`StatsFooter`, `formatTokens`, color thresholds)                                                                    | `features/app-shell/StatsFooter.tsx` + `ui/formatTokens.ts`                                         |
| Empty placeholder card                                                                                                            | `ui/EmptyState.tsx`                                                                                 |
| Recent-runs list panel (`RecentRuns`, `runDuration`, list/clear/delete handlers, 409 retry flow)                                  | `features/recent-runs/RecentRuns.tsx`; `runDuration` consumes `state/parseSqliteUtc.ts`             |
| **No router today** — internal-state navigation                                                                                   | `state/useRoute.ts` (new) once deep-linking is needed; or react-router. Out of scope for first cut. |

Cross-cutting:

- `AggStats` shape moves to `domain/run-stats.ts`; mirrors the server's `RunStatsSample`.
- `parseSqliteUtc` (today inlined inside `runDuration`, also in `RunView`) consolidates in `state/parseSqliteUtc.ts` per `run-view.md` §5.
- `CONTEXT_WINDOW_FALLBACK` belongs next to `useServerInfo.ts` as that's the only consumer.

Post-refactor, `App.tsx` shrinks to a ~30-line `<AppShell />` mount that wires three hooks and three feature folders together — no business logic in the root file.

## 6. How tested

| Spec section / claim                                                                                | Test file | Test name | Status                                                    |
| --------------------------------------------------------------------------------------------------- | --------- | --------- | --------------------------------------------------------- |
| §3 I1 — auto-select most-recent task on empty selection                                             | —         | —         | TODO(test)                                                |
| §3 I2 — selecting a task clears `activeRunId`                                                       | —         | —         | TODO(test)                                                |
| §3 I3 — stats and block-status reset on `activeRunId` change                                        | —         | —         | TODO(test)                                                |
| §3 I4 — Settings drawer overlays without unmounting the run pane                                    | —         | —         | TODO(test)                                                |
| §3 I5 — right-pane three-way switch (`RunView` / `RecentRuns` / `Empty`)                            | —         | —         | TODO(test)                                                |
| §3 I6 — `RecentRuns` refreshes on `taskId` change only                                              | —         | —         | TODO(test) — also covers the documented drift             |
| §3 I7 — context bar uses `/api/health`-reported window, not the fallback, when present              | —         | —         | TODO(test)                                                |
| §3 I8 — `formatTokens` thresholds                                                                   | —         | —         | TODO(test) — pure function, easy unit test once extracted |
| §2 errors — `createTask` / `deleteTask` / `deleteRun` rejection paths render alert without crashing | —         | —         | TODO(test)                                                |
| §2 errors — `api.startRun` rejection currently unhandled                                            | —         | —         | TODO(test) — should be added together with the alert fix  |
| §2 errors — `clearTaskRuns` 409 flow re-prompts and retries with `force=true`                       | —         | —         | TODO(test)                                                |
| §4 — `/api/health` re-fetched on `window.focus` and on 30s interval; cleanup on unmount             | —         | —         | TODO(test)                                                |
| §4 — average tok/s = `totalOutputTokens / totalEvalMs * 1000` over the run                          | —         | —         | TODO(test)                                                |
| §4 — `runDuration` parses SQLite space-separated UTC and ISO-with-Z identically                     | —         | —         | TODO(test) — pure once extracted                          |

### Deliberately not tested

- Tailwind class-name correctness and the exact pixel widths of the Settings drawer.
- The actual content of `TaskList`, `TaskEditor`, `RunView`, `SettingsPage` — covered by their own specs.
- `/api/health` payload shape — covered by `docs/specs/server/...` (server health route).

## 7. Drift / open questions

- **⚠️ Drift — no router.** All navigation is `useState`. Cannot share a URL to a specific task or run, cannot refresh into a specific view, cannot back-button between selections. `state/useRoute.ts` (or react-router) is the obvious fix once anyone wants deep links.
- **⚠️ Drift — `api.startRun` rejection is unhandled** (line 170-173). The other action handlers `try/catch` and `alert`; this one does not. A failed start (e.g. server returns 500) silently leaves `activeRunId` unset with no user feedback.
- **⚠️ Drift — `RecentRuns` does not refresh when a run finishes.** The list reflects the state at task-switch time. After a run completes via `RunView` and the user navigates back (clears `activeRunId`), the list is stale until they switch tasks twice.
- **Resolved — `runDuration` / `parseSqliteUtc` extracted.** Both consume `web/src/state/parseSqliteUtc.ts`. Regression: `web/src/__tests__/parseSqliteUtc.test.ts`.
- **Resolved — `alert` / `confirm` migrated to UiPrompts.** `<UiPromptsProvider>` exposes `useUiPrompts()` with `toast.error/info/success` and `confirm({ destructive })`. All call sites in `App.tsx`, `RunView.tsx`, `TaskList.tsx`, and `CompileFromText.tsx` migrated.
- **⚠️ Drift — `formatTokens` k-formatting overflows at 1M.** `999_999` formats as `"1000.0k"` instead of rolling into `"1.0M"`. Fix when extracted.
- **⚠️ Drift — block status flows up-then-down through `App`.** This is the textbook "lift state too high, then drill it back down" anti-pattern. The shared store (`useRunStream` per `run-view.md` §5) eliminates the round trip; `App` becomes a layout component with no run knowledge.
- **❓ Open question — should the Settings drawer survive a route change once routing exists?** Today it's pure local state; with a router, an `?settings=open` query param would let users link to it.
- **❓ Open question — should `serverContextWindow` be per-run instead of global?** A run started against one model and viewed after a server model swap will display the new model's context window against the old run's stats. Probably fine — runs are short-lived — but worth flagging for the refactor.
