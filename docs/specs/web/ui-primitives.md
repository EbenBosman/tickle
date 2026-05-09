# Spec — `ui-primitives`

> Path: `web/src/components/TaskList.tsx`, `web/src/components/StatusPill.tsx`, `web/src/main.tsx` · Layer: `ui/` (pure presentational — no `fetch`, no SSE, no stores) plus the React bootstrap entry point · Spec owner: `App.tsx` (mounts `TaskList`; consumes `StatusPill` indirectly via `RecentRuns`/`RunView`); `index.html` (loads `main.tsx`).

## 1. Why

Three tiny modules collected into one spec because each is too small to justify its own file but each carries a contract worth pinning down. `TaskList` is the left-column tasks pane: a stateless renderer that takes a list, a selection, and three callbacks. `StatusPill` is the canonical visual mapping from `RunStatus` (and the synthesised `"paused"` value) to colour and label — it is the _only_ place in the UI that decides what each run state looks like, so it must enumerate every status the server can emit. `main.tsx` is the React bootstrap; included here because it is ten lines and there is no other reasonable home.

> **Non-obvious why — `StatusPill` is the canonical status enum mirror.** The server's `RunStatus` is `running | done | error | cancelled` (see `web/src/api.ts` line 14), but `StatusPill` accepts an additional `"paused"` value synthesised by `RunView` from the orthogonal `is_paused` flag (a paused run still has `status === "running"` server-side; the UI maps `paused && status === "running"` → `"paused"` before handing the string to the pill — see `RunView.tsx` line 384). Any new server-side status that is not listed in §2's mapping table falls through to the grey fallback — that is the drift signal.
>
> **Non-obvious why — `TaskList` delete uses `useUiPrompts().confirm`.** Migrated from `window.confirm`; the rest of the app uses the same primitive (`<UiPromptsProvider>` + `useUiPrompts()`).
>
> **Non-obvious why — `main.tsx` wraps in `StrictMode`.** Double-invokes effects in dev to surface SSE-subscription leaks and effect-cleanup bugs early. Production builds skip the double-invoke.

## 2. Public contract

### 2a. `TaskList`

| Prop         | Type                   | Behaviour                                                                        |
| ------------ | ---------------------- | -------------------------------------------------------------------------------- |
| `tasks`      | `Task[]`               | Rendered top-to-bottom in array order. Empty array → "No tasks yet" placeholder. |
| `selectedId` | `number \| null`       | The matching row gets highlighted (`bg-zinc-800`). `null` → no row highlighted.  |
| `onSelect`   | `(id: number) => void` | Fires on row body click. Not fired by the delete affordance.                     |
| `onCreate`   | `() => void`           | Fires on the green "+ New task" button.                                          |
| `onDelete`   | `(id: number) => void` | Fires only after `useUiPrompts().confirm({ destructive })` resolves to `true`.  |

Behaviour: pure render of `tasks`, no internal state, no fetch. Empty-name rows display `"(untitled)"`. The delete `✕` button is `hidden group-hover:inline` — invisible until the row is hovered.

### 2b. `StatusPill`

| Prop     | Type     | Behaviour                                                                                                                  |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `status` | `string` | Mapped to colour classes per the table below. The label is the raw string, uppercased via CSS (`uppercase tracking-wide`). |

⚠️ Drift — `status: string` is too loose. Should be `RunStatus | "paused"` (i.e. `"running" | "done" | "error" | "cancelled" | "paused"`). Today an unknown status silently renders grey, hiding server/UI drift.

#### Status → colour mapping (canonical)

| `status`        | Tailwind classes                                                  | Origin                                                                                       |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `"running"`     | `bg-blue-500/10 text-blue-300 border-blue-500/30`                 | Server `RunStatus`.                                                                          |
| `"paused"`      | `bg-amber-500/10 text-amber-300 border-amber-500/30`              | Synthesised by `RunView` from `is_paused && status === "running"`. Not a server `RunStatus`. |
| `"done"`        | `bg-emerald-500/10 text-emerald-300 border-emerald-500/30`        | Server `RunStatus`.                                                                          |
| `"error"`       | `bg-red-500/10 text-red-300 border-red-500/30`                    | Server `RunStatus`.                                                                          |
| `"cancelled"`   | `bg-amber-500/10 text-amber-300 border-amber-500/30`              | Server `RunStatus`. Shares amber with `"paused"`.                                            |
| _anything else_ | `bg-zinc-500/10 text-zinc-300 border-zinc-500/30` (grey fallback) | **Drift signal** — server emitted a status the UI does not handle.                           |

### 2c. `main.tsx`

Bootstraps `<App />` into `document.getElementById("root")` via `ReactDOM.createRoot`, wrapped in `<React.StrictMode>`, and imports `./index.css` for Tailwind. No exports. Crashes with a non-null assertion error if `#root` is missing from `index.html`.

## 3. Invariants

- **I1 — `TaskList` is stateless.** No `useState`, `useEffect`, `useRef`. Falsifiable: grep the file; any hook import is a violation.
- **I2 — `TaskList` does no I/O.** No `fetch`, no `api.*` import, no SSE. All side effects flow through the four callback props. Required by `_LAYERS.md` `ui/` layer.
- **I3 — `TaskList` delete is gated on `useUiPrompts().confirm`.** `onDelete` is only invoked when the modal resolves to `true`. Falsifiable: stub the provider's confirm to return false → click `✕` → `onDelete` not called.
- **I4 — `TaskList` row order matches array order.** No internal sort, no filter. Falsifiable: pass `[{id:2},{id:1}]` → DOM order is 2 then 1.
- **I5 — `StatusPill` covers every `RunStatus` value plus `"paused"`.** The five rows in §2b's mapping table must each have a non-fallback branch. Falsifiable: a unit test that asserts each of `running | paused | done | error | cancelled` produces a non-grey class set, and an unknown string produces the grey fallback.
- **I6 — `StatusPill` mapping is the single source of truth for run-state colour.** No other component in `web/src/` should hard-code these classes. Falsifiable: grep for `bg-emerald-500/10` outside `StatusPill.tsx` — should match nowhere else for run-state purposes.
- **I7 — `StatusPill` has no DOM side effects.** Pure function of props; same input → same output. Falsifiable: render twice with same prop → identical markup.
- **I8 — `main.tsx` mounts exactly once into `#root` under `StrictMode`.** Falsifiable: in dev, `App`'s effects double-invoke; in prod build they do not.

## 4. How (briefly)

All three are intentionally trivial. `TaskList` is a single `<div>` with a header button and a mapped list of rows; selection is a className branch, hover-reveal of the delete button is a Tailwind `group`/`group-hover` pair, and the delete confirm is the platform `window.confirm`. `StatusPill` is a chained ternary mapping the `status` string to one of six class strings, then rendering a single `<span>` with a rounded border. `main.tsx` is the React 18+ `createRoot` boilerplate.

The interesting design decision is centralising status-colour logic in `StatusPill` rather than duplicating per call-site. Both `App.tsx` (for `RecentRuns`) and `RunView.tsx` consume it; if the colour scheme changes, one file edit covers both panes. The `"paused"` synthesis lives at the call-site (`RunView`) rather than inside `StatusPill` because the pill should not know about the `is_paused` flag — it is a presentational primitive that takes a string.

## 5. How tested

| Spec section / claim                                                                       | Test file | Test name | Status                             |
| ------------------------------------------------------------------------------------------ | --------- | --------- | ---------------------------------- |
| §2a — `TaskList` empty array shows "No tasks yet"                                          | —         | —         | TODO(test)                         |
| §3 I1/I2 — `TaskList` is stateless and does no I/O (lint or import-graph check)            | —         | —         | TODO(test)                         |
| §3 I3 — `TaskList` delete only fires `onDelete` when `window.confirm` returns true         | —         | —         | TODO(test)                         |
| §3 I4 — `TaskList` renders rows in array order                                             | —         | —         | TODO(test)                         |
| §2a — `selectedId` highlights matching row, `null` highlights none                         | —         | —         | TODO(test)                         |
| §3 I5 — `StatusPill` non-fallback branch for each of `running/paused/done/error/cancelled` | —         | —         | TODO(test) — table-driven          |
| §2b — `StatusPill` unknown status renders grey fallback (drift signal)                     | —         | —         | TODO(test)                         |
| §3 I6 — no other file hard-codes run-state colours (grep-based architecture test)          | —         | —         | TODO(test)                         |
| §3 I7 — `StatusPill` is referentially pure                                                 | —         | —         | TODO(test) — render-twice equality |
| §3 I8 — `main.tsx` mounts `<App />` into `#root` under `StrictMode`                        | —         | —         | TODO(test) — smoke render          |

### Deliberately not tested

- Tailwind class strings beyond presence/absence of the colour family. Visual regression would catch any breakage, and the chained-ternary structure makes typos low-risk.
- `window.confirm` text wording ("Delete \"<name>\"?") — incidental, not a contract.
- `index.css` content; covered by Tailwind's own pipeline.

## 6. Drift / open questions

- **⚠️ Drift — `StatusPill` typed as `string`.** Should be `RunStatus | "paused"` so a new server status fails type-check rather than silently rendering grey. Fix in lockstep with widening `Run["status"]` in `web/src/api.ts` if the server ever adds a status.
- **⚠️ Drift — `"cancelled"` and `"paused"` share amber.** Acceptable today because they never coexist in one pill, but visually conflating them is a small UX smell.
- **Resolved — `window.confirm` migrated to UiPrompts.** `<UiPromptsProvider>` + `useUiPrompts()` is the global toast/dialog primitive; `TaskList` delete now uses `confirm({ destructive })`.
- **⚠️ Drift — `"(untitled)"` placeholder is hard-coded in `TaskList`.** If empty-name handling becomes a system-wide concern (e.g. server returns `null` names), centralise in `domain/task.ts`.
- **❓ Open question — should `StatusPill` accept an explicit `paused` boolean prop instead of a synthesised string?** Would push the `is_paused && status === "running"` logic into the pill and remove the call-site coupling, but at the cost of a less primitive API. Worth revisiting once a third paused-aware consumer appears.
- **❓ Open question — does `main.tsx` belong here or in its own one-liner spec?** Combined for now because nothing else lives in `web/src/` root and a spec-per-file rule would create more noise than signal.
