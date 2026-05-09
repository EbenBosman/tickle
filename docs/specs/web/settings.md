# Spec — `settings`

> Path: `web/src/components/SettingsPage.tsx` · Layer: `features/settings/` (post-refactor target per `_LAYERS.md`) · Spec owner: `web/src/App.tsx` (renders as overlay drawer per `app-shell.md`).

## 1. Why

The Claude Rescue feature needs three user-flippable toggles (on/off, model, on-cancel handoff) and a viewer for the lesson corpus it produces. SettingsPage is the only screen that consumes `/api/settings` and `/api/lessons`, plus the JSONL export endpoint. It is rendered by `App.tsx` as an overlay drawer, not a route — close is a parent-supplied callback so the shell controls visibility.

> **Non-obvious why — `api_key_configured` gates everything.** `ANTHROPIC_API_KEY` lives in `process.env` on the server (see `http-settings.md` §1) and never crosses the wire. The UI receives only a boolean and uses it to disable the rescue toggle, on-cancel toggle, and model radios. There is no UI to edit the key — message says "set env var and restart server."
>
> **Non-obvious why — explicit Save, not autosave.** All three rescue settings are buffered in local state and committed by one `PUT /api/settings` on Save. Closing the drawer without Save discards local edits. Lessons by contrast are deleted immediately on click (no confirmation) — different mutation cost, different UX.

## 2. Public contract

### Exports

| Symbol         | Kind      | Signature / shape                          | Stability |
| -------------- | --------- | ------------------------------------------ | --------- |
| `SettingsPage` | component | `({ onClose: () => void }) => JSX.Element` | stable    |

### Props

| Prop      | Type         | Required | Purpose                                                 |
| --------- | ------------ | -------- | ------------------------------------------------------- |
| `onClose` | `() => void` | yes      | Invoked by the ✕ button. Parent owns drawer visibility. |

### Sections rendered

1. **Claude Rescue** — API-key status row, three controls (enable toggle, on-cancel toggle, model radio group), Save button + transient "Saved" confirmation.
2. **Learned Lessons** — count, paginated list (first 20, "Showing N of M" footer), per-row delete on hover.
3. **Training Data Export** — two buttons that download JSONL blobs.

### Server endpoints consumed (via `api.ts`)

| Endpoint                                             | When                 | Notes                                                |
| ---------------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `GET /api/settings`                                  | mount (in `load()`)  | Populates local state.                               |
| `PUT /api/settings`                                  | Save click           | Sends all three fields; result replaces local state. |
| `GET /api/lessons?offset=0&limit=20`                 | mount + after delete | First page only; no UI to load further.              |
| `DELETE /api/lessons/:id`                            | row ✕ click          | Followed by full reload.                             |
| `GET /api/export?status=rescued` / `GET /api/export` | export buttons       | Blob download with timestamped filename.             |

### Settings field display

| Field                | UI control                 | Disabled when                                            | Notes                                                       |
| -------------------- | -------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `api_key_configured` | Read-only status row (✓/✗) | always read-only                                         | Boolean from server; key itself never displayed.            |
| `rescue_enabled`     | Toggle                     | `!api_key_configured`                                    | String-encoded server-side (see `http-settings.md` I1).     |
| `rescue_on_cancel`   | Toggle                     | `!api_key_configured \|\| !rescue_enabled` (local state) | Cascading disable.                                          |
| `rescue_model`       | Radio group (3 options)    | `!api_key_configured`                                    | Local `MODELS` allowlist — see drift §6.                    |
| `lesson_count`       | (received but ignored)     | —                                                        | UI shows `totalLessons` from `listLessons`, not this field. |

## 3. Invariants

- **I1 — Save commits all three fields atomically.** A single `PUT /api/settings` carries `rescue_enabled`, `rescue_model`, and `rescue_on_cancel`, even if the user changed only one. Falsifiable: toggle one field, click Save, observe request body has all three.
- **I2 — Local edits discard on close.** No `beforeunload` guard, no dirty flag. Closing the drawer (parent-controlled) and reopening replays GET. Falsifiable: edit toggle, do not Save, close, reopen — server state shown.
- **I3 — `disabled = !api_key_configured` cascades through all rescue controls.** The toggle, the on-cancel toggle, and every radio share this gate. Falsifiable: GET returns `api_key_configured: false`, all four controls disabled.
- **I4 — Lesson delete has no confirmation and reloads the full first page.** `deleteLesson` calls `api.deleteLesson` then re-runs `load()` (which also re-fetches settings). Falsifiable: click ✕; observe two network calls (DELETE then GET settings + GET lessons).
- **I5 — The export filename is `tickle-training-${Date.now()}.jsonl`.** Both buttons share the same filename pattern; the only difference is the URL (`?status=rescued` vs none). Falsifiable: click each, inspect `download` attribute.
- **I6 — While the initial `load()` is in flight, only "Loading…" is rendered.** No partial state; the component returns the loading view if `settings === null`. Falsifiable: throttle the GET, observe loading view until both promises resolve.
- **I7 — "Saved" confirmation auto-clears at 2000 ms.** Falsifiable: Save, assert `Saved` visible; advance 2s of fake timers, assert removed.

## 4. How (briefly)

- **State.** Four `useState`s: `settings` (nullable), `lessons`, `totalLessons`, plus `saving` and `saved` flags. No reducer, no context. Local edits mutate `settings` directly via `setSettings((s) => s && { ...s, … })`.
- **Loading.** One `useEffect` on mount calls `load()` which `Promise.all`s settings + first lesson page. No retry, no error UI — `console.error` on failure.
- **Save.** Sends a fixed three-field PUT (always all three, never a partial write — see §2 / `http-settings.md` I3). The server's read-after-write response replaces local state, so any server-side normalisation surfaces immediately.
- **Lessons pagination.** Hard-coded `(0, 20)`; the "Showing N of M" footer is informational only — there is no Load-more control. Beyond 20, lessons are invisible in the UI but counted in `totalLessons`.
- **Sub-components are file-local.** `SectionHeader`, `Card`, `Row`, `Toggle` are not exported. Belong in `web/src/ui/` after the `_LAYERS.md` refactor — see drift §6.

## 5. How tested

| Spec section / claim                                 | Test file | Test name | Status     |
| ---------------------------------------------------- | --------- | --------- | ---------- |
| §2 props — `onClose` invoked by ✕                    | —         | —         | TODO(test) |
| §2 Save sends all three fields                       | —         | —         | TODO(test) |
| §2 lesson delete then reload                         | —         | —         | TODO(test) |
| §3 I1 atomic save                                    | —         | —         | TODO(test) |
| §3 I2 close discards local edits                     | —         | —         | TODO(test) |
| §3 I3 disabled cascade when key not configured       | —         | —         | TODO(test) |
| §3 I4 delete-without-confirm + full reload           | —         | —         | TODO(test) |
| §3 I5 export filename pattern                        | —         | —         | TODO(test) |
| §3 I6 loading view while `settings === null`         | —         | —         | TODO(test) |
| §3 I7 "Saved" 2s auto-clear (fake timers)            | —         | —         | TODO(test) |
| §6 model radio rejects out-of-allowlist server value | —         | —         | TODO(test) |

### Deliberately not tested

- The actual rescue / export server behaviour — covered by `http-settings.md` and `routes/export.ts`.
- Visual polish (hover states, transitions). Manual smoke.

## 6. Drift / open questions

- **⚠️ Drift — `MODELS` allowlist is duplicated.** The `MODELS` array (`SettingsPage.tsx:4`) lists the three Anthropic model IDs and a UI cost estimate; `VALID_MODELS` in `routes/settings.ts:4` lists the same IDs server-side. Adding a model requires editing both. Server-side spec already flags this (`http-settings.md` §6); the client-side copy carries extra metadata (`label`, `cost`) that the server doesn't need, so a shared constant should live in `domain/settings.ts` and be augmented on the client.
- **⚠️ Drift — `lesson_count` from `GET /api/settings` is unused.** The component renders `totalLessons` from `api.listLessons` instead. Either drop the field from the settings response or use it (and skip the second query on mount).
- **⚠️ Drift — server may return a `rescue_model` outside the local `MODELS` array.** Per `http-settings.md` I2, the server validates only on PUT, not on GET. If a row is set by direct DB edit to e.g. `"claude-opus-99"`, the radio group renders with no option checked and Save would fail with 400. UI should either fall back to the default or render the unknown value as a disabled fourth row.
- **⚠️ Drift — no error UI.** `load()` and `save()` `console.error` on failure but render no banner. `save()`'s `setSaving(false)` is in a `finally`, but a failed save still flashes "Saved" via no-op (actually no — `setSaved(true)` is _after_ the await, so a throw skips it; correct). Still, the user sees nothing for a network error.
- **⚠️ Drift — sub-components belong in `ui/`.** `SectionHeader`, `Card`, `Row`, `Toggle` are pure presentational and reused by no other file today, but the `_LAYERS.md` target moves them to `web/src/ui/` so other features can adopt them.
- **⚠️ Drift — lessons UX.** Hard-coded 20-item page, no Load-more, no search, no confirmation on delete. For a corpus that grows monotonically with rescues, this is a known cliff.
- **❓ Open — should Save be debounced/auto on toggle change?** Current model is explicit Save; matches `http-settings.md`'s "atomic save" framing. If we ever do auto-save, the server's partial-PUT support (I3 there) is already in place.
- **❓ Open — drawer keyboard handling.** `Esc`-to-close is the parent's responsibility per `app-shell.md`; this file only renders the ✕ button. Confirm parent wires `Esc`.
