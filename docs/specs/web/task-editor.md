# Spec — `web/task-editor`

> Path: `web/src/components/TaskEditor.tsx` · Layer: `features/task-editor/` (post-refactor target; sister of `BlockList.tsx`) · Spec owner: `App.tsx` (sole caller); persistence contract owned by `api.updateTask` and the `tasks.steps` JSON column

## 1. Why

`TaskEditor` is the middle column of the three-column shell. It is the only writable surface for a task's two persisted user-editable fields — `name` and `steps` — and the launch point for runs of that task. Its sole job is to (a) hold local edit state for those two fields, (b) compose `BlockList` with a name input and a `CompileFromText` "natural-language → blocks" affordance above it, (c) compute a `dirty` flag against the last-loaded server snapshot, and (d) wire **Save** and **Run** actions, where Run auto-saves any pending edits first. It is deliberately thin — almost all real editing logic lives one level down in `BlockList`.

> **Non-obvious why:**
>
> - **Local-state controlled, parent-snapshot reset.** The component holds `name` / `blocks` in `useState`, but a `useEffect` keyed on `[task.id, task.steps, task.name]` re-seeds them whenever the parent passes a different `Task` (selection change) **or** the same task with new server-side fields (e.g. after a save round-trip). Without the `task.steps`/`task.name` deps, switching tabs back to the same task would show stale local edits from a previous session.
> - **`steps` is JSON-as-string on the wire.** `Task.steps` is `string | null` (raw JSON from SQLite); `BlockList` operates on `Block[]`. `parseSteps` is the boundary — and it is intentionally lenient (returns `[]` on `null`, on parse error, or on non-array root) so the editor never crashes on malformed legacy rows.
> - **Run during a run.** The "Run" button is disabled when `runningBlockId` is set, but the editor itself remains interactive — pending blocks can still be edited. This is the contract `RunView` and the agent rely on for "edit-ahead" mid-run.

## 2. Public contract

### Exports

| Symbol       | Kind      | Signature / shape                                                                                                              | Stability |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `TaskEditor` | component | `({ task: Task, onSaved: () => void, onRun: () => void, statusMap?: BlockStatusMap, runningBlockId?: string \| null }) => JSX` | stable    |

Internal-only (not exported): `parseSteps`.

### Props contract

- `task` — controlled snapshot of the persisted task. Identity changes (`task.id` differs) **or** field changes (`task.steps` / `task.name` differ) reset local state from props. Other field changes (e.g. `created_at`) do not reset state.
- `onSaved()` — called after a successful `api.updateTask` round-trip. The parent uses this to refresh its task list / cached `Task` object. Not awaited.
- `onRun()` — called to launch a run. Called **after** `save()` if there are unsaved changes; called immediately otherwise. The parent owns the `POST /api/tasks/:id/run` call, the resulting `run_id`, and the right-column SSE subscription.
- `statusMap?` / `runningBlockId?` — passed through unchanged to `BlockList`. This component never reads them itself except to render the "Running block is locked" hint and to disable the **Run** button and the `CompileFromText` panel.

### Errors

The component does not catch errors from `api.updateTask`. A failed save lets the rejection propagate up the click handler (becoming an unhandled promise rejection in the console) and **does not** advance to `onRun()` — the `await save()` in the Run handler short-circuits the rest of the handler on throw. There is no toast/banner for save failure; this is drift (see §6).

## 3. Invariants

- **`name` and `blocks` are local state, never read directly from `task` after mount of a given `task.id`.** Reads after mount go through `useState` setters; `task.*` is only read in the reset effect and in the `dirty` comparison.
- **Reset effect is the only path that overwrites local state from props.** Triggered by `task.id`, `task.steps`, or `task.name` changing. It must overwrite _both_ fields together, never one without the other, otherwise `dirty` would be inconsistent.
- **`dirty` is true iff `name !== task.name` OR `JSON.stringify(blocks) !== initialBlocksJson`.** `initialBlocksJson` is `task.steps ?? "[]"`, memoised on `task.steps`. Whitespace-only changes in `name` count as dirty (no trim). Reordering blocks counts as dirty (string comparison is order-sensitive).
- **`save()` always calls `onSaved()` after the network round-trip.** It does not gate on `dirty` — calling `save()` when nothing changed still issues a no-op PUT and still fires `onSaved`. (`save()` is only invoked by user action, not auto, so this is fine in practice.)
- **`save()` updates `savedAt` to a `toLocaleTimeString()` stamp, but does not clear `dirty`.** `dirty` clears naturally on the next prop reset (when the parent re-fetches the task and passes the new `task.steps`). Until then the footer reads "Saved at HH:MM:SS" — `savedAt` overrides the dirty/saved label.
- **Run button is disabled when `blocks.length === 0` OR `runningBlockId` is set.** No other gating. An empty `name` does **not** disable Run (see §4).
- **Save button is disabled when `!dirty`.** No other gating.
- **Run handler awaits `save()` only when `dirty`.** When clean, it goes straight to `onRun()` with no network round-trip.
- **`CompileFromText.onApply` writes through `setBlocks`**, never through `onChange`/`api.updateTask`. The result is purely local until the user clicks Save (or Run, which auto-saves). Compile output never touches the server until the user commits.
- **`CompileFromText` is disabled when `runningBlockId` is set**, even though `BlockList` itself remains editable. The reason is that compile output replaces or appends _all at once_, which is harder to reason about against a live run.

## 4. Validation

The component performs no validation of its own. Specifically:

- **Empty `name`.** Permitted. `task.name` was required at task-create time, but `TaskEditor` allows the user to clear the input and Save. The server's `PUT /api/tasks/:id` accepts an empty string (see `routes/tasks.ts`); this is drift.
- **Whitespace-only `name`.** Permitted. No `trim()` anywhere.
- **Duplicate names across tasks.** Not checked. The task list sorts by id, not name, so duplicates are visually disambiguated only by position.
- **Block validation.** Delegated entirely to `BlockList` (which itself does little — see `web/block-list.md` §4). Empty `blocks` is the _only_ condition that disables Run.
- **JSON round-trip integrity.** `parseSteps` is lenient: `null`, malformed JSON, and non-array roots all collapse to `[]`. A user opening a task whose `steps` was hand-edited to an object would silently see an empty editor and lose the original on next Save. Drift (see §6).

## 5. Composition with `BlockList` and `CompileFromText`

`TaskEditor` is essentially a four-piece layout:

1. **Name input** (top) — single `<input>`, no label-association beyond a sibling `<label>`.
2. **`CompileFromText`** — banner that turns natural-language descriptions into `Block[]`. Receives `disabled={!!runningBlockId}`, `existingCount={blocks.length}`, `onApply={(newBlocks, mode) => setBlocks(mode === "replace" ? newBlocks : [...blocks, ...newBlocks])}`. The append-mode spread reads `blocks` from the closure, which is fine because compile is a one-shot user action, not a stream.
3. **`BlockList`** — receives `blocks={blocks}`, `onChange={setBlocks}` (raw setter — no validation/normalisation interposed), `statusMap={statusMap}`, `runningBlockId={runningBlockId ?? null}`. The `?? null` is meaningful: `BlockList` distinguishes `undefined` from `null` (see `web/block-list.md` §2), and `TaskEditor` chooses to normalise to `null`.
4. **Footer** — saved-at/dirty label on the left, Save + Run on the right.

`TaskEditor` does **not** memoise `setBlocks` — every render passes a fresh function reference to `BlockList`. This is fine because `BlockList` is not memoised either; if it becomes a perf problem, the fix is at the `BlockList` boundary, not here.

## 6. Drift / open questions

- ⚠️ **Drift — save errors are silent.** A 500 on `api.updateTask` becomes an unhandled promise rejection. The user sees no feedback; the dirty state remains; clicking Save again retries. Run-after-save inherits the same: a save failure in the Run handler aborts `onRun()` with no UI signal. Should add a try/catch with a toast or inline error.
- ⚠️ **Drift — empty/whitespace `name` is accepted.** No client-side validation. The server also doesn't reject. Either trim+require here, or document that empty names are intentional.
- ⚠️ **Drift — `parseSteps` silently swallows malformed JSON.** A task whose `steps` column was hand-edited to a non-array root (`{}`, `null`, garbage) opens with `[]` in the editor; if the user saves, the original content is overwritten and lost. At minimum this should surface as a banner ("steps could not be parsed; editing as empty list will overwrite") so the loss is visible.
- ⚠️ **Drift — `dirty` does not clear after `save()`** until the parent re-passes the task. If the parent forgets to refetch (or the refetch is delayed), the footer keeps reading "Saved at HH:MM:SS" while the Save button stays disabled because `dirty` flipped via the prop reset, but in pathological cases (parent uses cached `task` without refresh) you can see "Unsaved changes" reappear after the saved-at timestamp resets. Local source of truth for "what's persisted" should live in this component, not the parent.
- ⚠️ **Drift — `JSON.stringify(blocks) !== initialBlocksJson` is comparing serialised forms.** Whitespace differences in the _server's_ JSON serialisation (e.g. a future SQLite that pretty-prints, or a server that re-orders object keys) would yield false-positive dirtiness. Today both sides use the default `JSON.stringify` shape, so this works, but a structural deep-compare would be safer.
- ❓ **Question — should `CompileFromText` live inside `TaskEditor` at all, or hoist into `BlockList`?** It only writes to `blocks`. Hoisting would remove `existingCount={blocks.length}` from the `TaskEditor` API surface and let `BlockList` own its own "compile" affordance. Counter-argument: the natural-language → blocks UI is large and would crowd the `BlockList` component, which is already a god file (see `web/block-list.md` §7).
- ❓ **Question — should Run-while-clean still re-fetch?** Today, clicking Run on a clean editor goes straight to `onRun()` without contacting the server. If another tab edited the task between fetches, the run uses the stale `blocks` snapshot. A `getTask` round-trip before launching would catch this — at the cost of a network hop on every Run.

## 7. Decomposition target (post-refactor)

The component is small enough (~113 lines) that mechanical splitting is not urgent. The natural seams under `features/task-editor/`:

```
features/task-editor/
├── TaskEditor.tsx              ← orchestration: state, dirty, save/run wiring
├── TaskEditorHeader.tsx        ← name input + label (5–10 lines)
├── TaskEditorFooter.tsx        ← saved-at label + Save/Run buttons (15–20 lines)
├── useTaskEditorState.ts       ← {name, blocks, dirty, save, parseSteps} hook; reset effect
└── (BlockList.tsx, CompileFromText.tsx — already separate)
```

Worthwhile only when a second similar editor surface appears, or when adding error handling / validation / autosave makes the orchestration component grow past ~200 lines. Today, leaving as one file is the right call.

## 8. How tested

There are no tests for this component yet.

| Spec section / claim                                                    | Test file | Test name                                                              | Status     |
| ----------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- | ---------- |
| §3 reset effect overwrites local state on `task.id` change              | —         | `select different task: name and blocks reset`                         | TODO(test) |
| §3 reset effect overwrites on same `task.id` with new `task.steps`      | —         | `parent updates task.steps: editor re-seeds`                           | TODO(test) |
| §3 `dirty` true when name differs                                       | —         | `dirty: edit name, dirty=true`                                         | TODO(test) |
| §3 `dirty` true when blocks reorder (string comparison order-sensitive) | —         | `dirty: reorder blocks, dirty=true`                                    | TODO(test) |
| §3 Save button disabled when `!dirty`                                   | —         | `save button disabled when clean`                                      | TODO(test) |
| §3 Run button disabled when `blocks.length === 0`                       | —         | `run button disabled when no blocks`                                   | TODO(test) |
| §3 Run button disabled when `runningBlockId` is set                     | —         | `run button disabled during run`                                       | TODO(test) |
| §3 Run handler awaits `save()` when dirty, skips when clean             | —         | `run: dirty → save then onRun; clean → onRun directly`                 | TODO(test) |
| §3 `CompileFromText.onApply` replace mode overwrites blocks             | —         | `compile replace: setBlocks(newBlocks)`                                | TODO(test) |
| §3 `CompileFromText.onApply` append mode concatenates                   | —         | `compile append: setBlocks([...blocks, ...newBlocks])`                 | TODO(test) |
| §3 `CompileFromText` disabled when `runningBlockId` set                 | —         | `compile: disabled during run`                                         | TODO(test) |
| §4 empty / whitespace-only `name` allowed (current behaviour)           | —         | `validation: empty name does not block save` (pin behaviour, then fix) | TODO(test) |
| §4 `parseSteps` returns `[]` for null / malformed / non-array           | —         | `parseSteps: null/garbage/non-array → []`                              | TODO(test) |
| §6 ⚠️ save errors are unhandled                                         | —         | `save error: rejection propagates, dirty stays true` (pin behaviour)   | TODO(test) |
| §6 ⚠️ malformed `steps` overwritten on save                             | —         | `malformed steps: save replaces with []` (pin behaviour, then fix)     | TODO(test) |

### Deliberately not tested

- Tailwind class output and visual layout. Out of scope; the three-column shell layout is owned by `App.tsx`.
- Network-level behaviour of `api.updateTask`. Owned by `web/api-client.md`.
- `BlockList` and `CompileFromText` internals. Owned by `web/block-list.md` and (eventually) a `web/compile-from-text.md`.
