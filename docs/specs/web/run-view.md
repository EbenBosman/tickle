# Spec — `run-view`

> Path: `web/src/components/RunView.tsx` · Layer: `features/run-view/` (post-refactor target — currently a single ~601-line god component) · Spec owner: `web/src/App.tsx` (mounts it), and the SSE protocol contract in `docs/specs/server/http-runs.md` and `docs/specs/server/event-bus.md` which it consumes verbatim.

## 1. Why

`RunView` is the live-telemetry surface of a run. It is the single client of `GET /api/runs/:id/stream` and the only place in the app that translates the bus event union into UI. It must (a) survive the **replay-then-subscribe** contract — render persisted history identically to live events; (b) freeze a credible **elapsed time** even if the canonical `finished_at` is delayed; (c) surface **pause** in a way that works whether the user just clicked Pause, the server auto-paused, or the page was refreshed mid-pause (the server replays a synthetic `paused` per `http-runs` I5); and (d) keep the agent's chain-of-thought, tool calls, page state, and screenshots legible while hundreds of events arrive over minutes.

> **Non-obvious why — synthetic `paused` on reconnect.** Per `http-runs` I5, the server re-emits `paused` after replay if the run is still paused. The component must accept that the same logical pause may arrive twice (once originally persisted/live, once synthetic) without flickering or double-counting. Today it idempotently sets `paused = true`; deduping is implicit via boolean state.
>
> **Non-obvious why — UTC parsing.** SQLite `datetime('now')` returns `"YYYY-MM-DD HH:MM:SS"` with no zone. Naive `Date.parse` treats it as **local** time, producing elapsed-time errors of ±the user's timezone offset. `parseSqliteUtc` forces UTC. This is the same fix `parseSqliteUtc` will own once extracted to `state/parseSqliteUtc.ts`.
>
> **Non-obvious why — fallback `getRun` on mount and on `end`.** The SSE stream may join late or miss a transient `paused`/`end` boundary. The component fetches `GET /api/runs/:id` on mount (to seed `started_at`, `finished_at`, `is_paused`) and again on `end` (to overwrite the locally-stamped `finished_at` with the canonical value). Without these, paused-on-reconnect runs would show no Resume button and total durations would drift by network latency.

## 2. Public contract

### Exports

| Symbol           | Kind     | Signature / shape                                                                                                | Stability |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| `RunView`        | function | `(props: RunViewProps) => JSX.Element` — default export of the file (named).                                     | stable    |
| `BlockStatus`    | type     | `"pending" \| "running" \| "done" \| "failed" \| "skipped"`                                                      | stable    |
| `RunStatsSample` | type     | `{ model: string; prompt_tokens: number; output_tokens: number; eval_duration_ms: number; tps: number }`         | stable    |
| `EntryCard`      | —        | local; not exported.                                                                                             | —         |
| `parseSqliteUtc` | —        | imported from `web/src/state/parseSqliteUtc.ts` (with sibling `formatDuration` and `runDuration`). | stable    |

### Props (`RunViewProps`)

| Prop            | Type                                                                                  | Required | Purpose                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `runId`         | `number`                                                                              | yes      | Run to subscribe to. Identity-reset effect: changing `runId` clears all state.                                                 |
| `onClose`       | `() => void`                                                                          | no       | Renders a "← Back" affordance; absent in pinned-pane usage.                                                                    |
| `onDeleted`     | `() => void`                                                                          | no       | Fires after `DELETE /api/runs/:id` succeeds (terminal-state Delete button).                                                    |
| `onStats`       | `(sample: RunStatsSample) => void`                                                    | no       | Forwarded for every `stats` event so the parent footer can show tok/s.                                                         |
| `onBlockStatus` | `(info: { blockId: string \| null; statusMap: Record<string, BlockStatus> }) => void` | no       | Fires on every `block_start` / `block_end`. `blockId` is the _currently running_ block (or `null`). `statusMap` is cumulative. |

### Consumed HTTP / SSE surface

- `GET /api/runs/:id` on mount and on `end` (via `api.getRun`).
- `EventSource` to `/api/runs/:id/stream` — full event union per `http-runs` §2 SSE.
- `POST /api/runs/:id/{pause,resume,cancel}` and `DELETE /api/runs/:id` via `api.*`.

### Errors surfaced

| Source                                                          | Surface                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `api.pauseRun` / `resumeRun` / `cancelRun` / `deleteRun` reject | Surfaced via `useUiPrompts().toast.error(...)` (auto-dismissing toast). No retry. |
| `EventSource.onerror`                                           | `es.close()` — no auto-reconnect, no UI signal. See §6.          |
| `api.getRun` reject (mount or post-`end`)                       | Silently swallowed (`.catch(() => {})`).                         |

## 3. Invariants

- **I1 — Identity-reset on `runId` change.** Changing the `runId` prop discards `entries`, `status`, `paused`, `pauseInfo`, `pageState`, `memory`, `startedAt`, `finishedAt`, and the `latestStatusMap` / `latestRunningRef` refs before opening a new `EventSource`. Falsifiable: render `<RunView runId={1}/>`, mount entries, swap to `runId={2}`, observe an empty entry list before the new stream emits.
- **I2 — Replay precedes live, deterministically.** All `replay: true` envelopes render before any post-replay live event, because the server writes them serially before `subscribe()` (per `http-runs` I4). The component preserves arrival order via `setEntries((p) => [...p, …])`.
- **I3 — Timer freezes on terminal status.** The `setInterval(setNow…)` only runs while `status === "running"`. On `end`, `finishedAt` is stamped immediately (`new Date().toISOString()`) and may be overwritten by the canonical value from `GET /api/runs/:id`. After freeze, `computeElapsed` returns a duration computed against `finishedAt`, not `now`.
- **I4 — Pause UI is the OR of two signals.** The Resume button shows when `paused === true`, set by either an SSE `paused` event or the `is_paused` flag from the mount fetch. `resumed` clears both.
- **I5 — Auto-pause banner is gated on `pauseInfo.auto`.** The amber "Auto-paused / The browser is yours" panel only renders when `paused && pauseInfo.auto === true`. User-initiated pauses suppress it (the Resume button is the only affordance).
- **I6 — Status pill reflects pause when running.** When `status === "running" && paused`, the pill renders `"paused"`; otherwise it renders the raw status. Falsifiable: `paused=true` on a `running` run shows amber, not blue.
- **I7 — Auto-scroll on entry append.** The scroller scrolls to bottom every time `entries.length` changes. Manual mid-stream scroll-up is **not** preserved across new events. ⚠️ Drift: this is mildly annoying when reading old output during a long run; documented for the refactor.
- **I8 — `latestRunningRef` tracks the most recent un-ended block.** On `block_start` it is set to that `block_id`; on `block_end` it is cleared **only** if it currently equals `block_id`. Nested blocks (`for_each` body) may set/clear in non-LIFO order; the ref reflects "the last `block_start` that hasn't yet seen its `block_end`" without modeling a stack. ⚠️ Drift: with `for_each` nesting, two blocks may be running at once; the ref is the last-started, not a stack. Acceptable for the parent's "highlight currently-running block" UX.

## 4. How (briefly)

### SSE event-kind → UI behaviour

| Event                    | UI effect                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ replay: true, step }` | Push one `Entry` reconstructed from the persisted `kind`/`payload`/`screenshot_path`. `renderBody()` formats per kind.                                                                                                                                                      |
| `thought`                | Push `Entry{ kind: "thought" }` with raw text body.                                                                                                                                                                                                                         |
| `tool_call`              | Push `Entry{ kind: "tool_call", toolName, body: JSON.stringify(args, null, 2) }`. Renders in a blue card with monospace pre.                                                                                                                                                |
| `tool_result`            | Push `Entry{ kind: "tool_result", toolName, ok, body: ok ? text : error, screenshot: screenshotPath }`. Image renders inline before body.                                                                                                                                   |
| `block_start`            | Push `Entry{ kind: "block_start", blockKind, body: summary }` (dashed card). Update `statusMap[blockId]="running"`, set `latestRunningRef`. Fire `onBlockStatus`.                                                                                                           |
| `block_end`              | Push `Entry{ kind: "block_end", blockKind, ok, body: result \| error, unanswered? }`. Card colour: amber if `unanswered.length>0` (questionnaire "needs review"), else green/red by `ok`. Update `statusMap`, clear `latestRunningRef` if it matches. Fire `onBlockStatus`. |
| `var_set`                | Push `Entry{ kind: "var_set", body: "$name = preview" }` (small green strip).                                                                                                                                                                                               |
| `remember`               | Push `Entry{ kind: "remember" }` AND append `note` to `memory[]` (collapsed violet panel above the entry list, count + toggle).                                                                                                                                             |
| `page_state`             | Replace `pageState = { url, title }`. Banner above the entry list always shows the latest.                                                                                                                                                                                  |
| `stats`                  | Forward to parent via `onStats`. Not rendered locally.                                                                                                                                                                                                                      |
| `paused`                 | Set `paused=true`, `pauseInfo={reason, auto}`. Header swaps Pause→Resume; status pill switches to amber `paused`; if `auto`, render the amber explainer banner.                                                                                                             |
| `resumed`                | Clear `paused` and `pauseInfo`.                                                                                                                                                                                                                                             |
| `error` (`block_id?`)    | Push `Entry{ kind: "error", body: error }` (red card). Does **not** terminate the stream.                                                                                                                                                                                   |
| `final`                  | Push `Entry{ kind: "final", body: answer }` (green "Final answer" card).                                                                                                                                                                                                    |
| `end`                    | Set `status = ev.status`, close `EventSource`, stamp `finishedAt = now()`, then refetch `GET /api/runs/:id` to overwrite with canonical `finished_at`. The interval timer effect tears down because `status !== "running"`.                                                 |

### Other implementation notes

- **Mount `getRun` seed:** before opening the SSE, fetch `GET /api/runs/:id` to populate `started_at`, `finished_at`, terminal `status`, and `is_paused`/`pause_info`. The replay phase will then re-deliver step events; the seed only sets timestamps and pause flag.
- **Entry id strategy:** monotonic `counter++` per event, prefixed by kind (`t-`, `tc-`, `tr-`, `bs-<bid>-`, `be-<bid>-`, `e-`, `var-`, `mem-`, `f-`, `r-<idx>` for replay). Stable across renders within one mount.
- **Timer cadence:** `setInterval(() => setNow(Date.now()), 1000)` only while running. `computeElapsed` reads `now` only when no `finishedAt`. `formatDuration` produces `Ns`, `Nm SSs`, or `Nh Nm Ss`.
- **Memory panel:** `memory[]` accumulates in arrival order; toggles open/closed via `memoryOpen`. Collapsed by default.
- **No virtualisation.** Entries are kept for the full lifetime of the mount in `entries: Entry[]` and rendered in full each render. ⚠️ Drift: at thousands of entries, this is heavy. The `EntryStream.tsx` carve-out is the natural place to add windowing.

## 5. Decomposition target (post-refactor)

The current single file mixes **eight** concerns. The `_LAYERS.md` target carves them as follows. This list is the spec for what the refactor must produce:

| Concern in today's `RunView.tsx`                                                                                                                                       | Target file (`web/src/features/run-view/` unless noted)                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| EventSource lifecycle, replay handling, identity-reset on `runId` change, mount/`end` `getRun` fallbacks                                                               | **done** — `state/useRunStream.ts` returns `{ entries, status, paused, pauseInfo, pageState, memory, startedAt, finishedAt }`; `renderStepBody` is exported as `renderStepBody`. Callbacks (`onStats`, `onBlockStatus`) flow through a ref so they don't force the effect to re-run. |
| `parseSqliteUtc`, `formatDuration`, `runDuration`                                                                                                                      | **done** — `state/parseSqliteUtc.ts`. The 1s interval and freeze-on-terminal logic still live in `RunView.tsx` (next step: `Timer.tsx`).                                                |
| Header (Run #, elapsed pill, Pause/Resume/Stop/Delete buttons, status pill)                                                                                            | `RunView.tsx` orchestration + a small `RunHeader.tsx`                                                                       |
| `pageState` banner                                                                                                                                                     | `PageStateBanner.tsx` (props: `{ url, title } \| null`)                                                                     |
| Auto-pause amber explainer panel                                                                                                                                       | `PauseBanner.tsx` (props: `{ reason?, auto? }`)                                                                             |
| `memory[]` collapsed violet panel                                                                                                                                      | `MemoryPanel.tsx` (props: `{ notes: string[] }`)                                                                            |
| Entry list rendering loop + auto-scroll-to-bottom                                                                                                                      | `EntryStream.tsx` (props: `{ entries }`); add windowing here.                                                               |
| Per-entry rendering switch (`EntryCard` and its kind-specific cards: thought / tool_call / tool_result / block_start / block_end / var_set / remember / error / final) | `EntryCard.tsx` + one card-per-kind (or a switch table) under `entry-cards/`                                                |

Cross-cutting:

- `Entry` and `StreamEvent` types belong in `domain/run-events.ts` (mirror of `server/src/domain/run.ts` `SseEvent`). Today they're inlined.
- The screenshot `<img src="/screenshots/...">` URL construction is the only piece that must respect on-disk casing per `http-runs` §2 `/screenshots/*` drift.

## 6. How tested

| Spec section / claim                                                                                                                                                                                        | Test file | Test name | Status                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | --------------------------------------------------------------------- |
| §3 I1 — identity reset on `runId` change                                                                                                                                                                    | —         | —         | TODO(test)                                                            |
| §3 I2 — replay-before-live ordering preserved (mock SSE)                                                                                                                                                    | —         | —         | TODO(test)                                                            |
| §3 I3 — timer freezes on `end` and tracks canonical `finished_at`                                                                                                                                           | —         | —         | TODO(test)                                                            |
| §3 I4 — paused state set by either SSE `paused` or `is_paused` mount fetch                                                                                                                                  | —         | —         | TODO(test)                                                            |
| §3 I5 — auto-pause banner only renders for `auto: true`                                                                                                                                                     | —         | —         | TODO(test)                                                            |
| §3 I6 — status pill switches to `paused` while running                                                                                                                                                      | —         | —         | TODO(test)                                                            |
| §3 I7 — auto-scroll on entry append                                                                                                                                                                         | —         | —         | TODO(test) — non-trivial in jsdom; consider Playwright component test |
| §3 I8 — `latestRunningRef` follows last-started/last-ended-matching-id semantics                                                                                                                            | —         | —         | TODO(test)                                                            |
| §4 event table — every kind produces the documented UI mutation (replay, thought, tool_call, tool_result, block_start, block_end, var_set, remember, page_state, stats, paused, resumed, error, final, end) | —         | —         | TODO(test) — one parameterised test per kind                          |
| §4 — synthetic `paused` on reconnect is idempotent (no flicker)                                                                                                                                             | —         | —         | TODO(test)                                                            |
| §4 — `parseSqliteUtc` handles space-separated UTC and ISO-with-Z inputs                                                                                                                                     | —         | —         | TODO(test) — pure function, easy unit test once extracted             |
| §2 errors — `api.*` rejection path renders alert without crashing the view                                                                                                                                  | —         | —         | TODO(test)                                                            |
| §2 props — `onStats` fired exactly once per `stats` event                                                                                                                                                   | —         | —         | TODO(test)                                                            |
| §2 props — `onBlockStatus` fired on `block_start` and `block_end` with correct cumulative `statusMap`                                                                                                       | —         | —         | TODO(test)                                                            |

### Deliberately not tested

- The actual SSE transport (covered by `http-runs.md` integration tests).
- Tailwind class-name correctness.
- Image rendering (`/screenshots/...`) — covered by `http-runs` static-route tests.

## 7. Drift / open questions

- **⚠️ Drift — no SSE auto-reconnect.** `es.onerror` calls `es.close()` and never reopens. A transient network blip during a long run leaves the user staring at a frozen UI. The native `EventSource` has built-in reconnect, but we override it. Either remove the `close()` and rely on browser reconnect (with the server's replay-on-connect behaviour, this is mostly safe — entries will duplicate; need an idempotency check) or implement a backoff reconnect in `useRunStream.ts`.
- **⚠️ Drift — replay-then-live can dupe entries on reconnect.** Because the server has no `Last-Event-ID` cursor (per `http-runs` §6), each reconnect re-replays from idx 0. If we ever do reconnect, the component will append a second copy of every prior entry. The `id` prefix scheme (`r-<idx>`, `t-<counter>`, …) does **not** dedupe across reconnects.
- **⚠️ Drift — unbounded entry array.** No pruning, no virtualisation. A 30-minute run with thousands of tool calls allocates thousands of `Entry` objects and renders them all on every state change. Carve into `EntryStream.tsx` and add windowing.
- **⚠️ Drift — auto-scroll fights the user.** The scroller jumps to bottom on every append, even if the user has scrolled up to read history. Standard fix: only auto-scroll when the scroller is already within ~50px of the bottom.
- **Resolved — toast/confirm UI prompts.** `<UiPromptsProvider>` exposes `useUiPrompts()` with `toast.error/info/success` and `confirm({ destructive })`. Pause/resume/cancel/delete failures now flow through `toast.error`. Provider mounted in `main.tsx` above `<App>`.
- **Resolved — `parseSqliteUtc` extracted.** Now at `web/src/state/parseSqliteUtc.ts`. Regression: `web/src/__tests__/parseSqliteUtc.test.ts`.
- **❓ Open question — should `RunView` own the `getRun` seed or should the parent pass `Run` as a prop?** Today `RunView` fetches `getRun` on mount. The parent `App.tsx` may have already fetched the same row. After the refactor, `useRunStream` could accept an optional `seedRun: Run` prop to avoid the second round-trip.
- **❓ Open question — `onBlockStatus` semantics for nested blocks.** With `for_each` body blocks, two `block_start`s can fire before either `block_end`. The current `latestRunningRef` is "last started, not yet ended (if matched)" — adequate for highlighting, but the parent's `BlockList` may want a stack-aware notion. Defer until a UX requirement appears.
