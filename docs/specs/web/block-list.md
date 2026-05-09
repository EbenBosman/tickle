# Spec — `web/block-list`

> Path: `web/src/components/BlockList.tsx` · Layer: `features/task-editor/` (post-refactor target) · Spec owner: `TaskEditor` (sole caller), and the persisted `Block` schema in `domain/` (every field rendered must round-trip through `tasks.steps` JSON)

## 1. Why

`BlockList` is the editing surface for the _typed program_ a task consists of. Tasks are not free text; they are an ordered list of typed blocks (`server/src/blocks.ts` is the durable schema, `web/src/blocks.ts` mirrors it). Each block kind needs a distinct, kind-shaped editor — a URL field for `navigate`, a text-area for `goal`, a target+role pair for `click`, a recursive nested editor for `for_each`. This component owns: per-kind inputs, drag-drop reordering, insert/remove, the per-block `pauseAfter` toggle, and the recursion into `for_each.body`. It is purely presentational over `Block[]` — no fetches, no SSE — driven entirely by `(blocks, onChange)`.

> **Non-obvious why:**
>
> - **Persisted-schema mirror.** Every input here writes to a field that lands in SQLite `tasks.steps` JSON and is read back by `agent.ts`'s executor. UI fields that don't exist on the server side are dead UI; server fields not exposed in the UI cannot be configured. Drift is silent.
> - **God file by accumulation.** Started as one editor with a switch; grew per kind. The mechanical fix is one file per kind under `BlockEditor/<kind>.tsx`, listed in §7.
> - **`for_each` recurses into the same component.** This is intentional — there is exactly one nesting site in the schema (`for_each.body`), so the recursion has natural depth bounds.

## 2. Public contract

### Exports

| Symbol           | Kind      | Signature / shape                                                                                                              | Stability                            |
| ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `BlockList`      | component | `({ blocks: Block[], onChange: (next: Block[]) => void, statusMap?: BlockStatusMap, runningBlockId?: string \| null }) => JSX` | stable                               |
| `BlockStatusMap` | type      | `Record<string, "pending" \| "running" \| "done" \| "failed" \| "skipped">`                                                    | stable; mirrors agent runtime states |

Internal-only (not exported): `BlockCard`, `BlockBody`, `Field`, `StatusBadge`, `AddBlockMenu`, `SmallAddMenu`, `DropZone`.

### Props contract

- `blocks` — controlled. Rendered as-is, in order. Must each carry a stable `id` (used as React key, drag handle, locking key).
- `onChange(next)` — invoked with the _whole new array_ on any structural change (add, remove, reorder, field edit). The parent owns persistence.
- `statusMap?` — optional `id → status` map; drives ring colour, "running"/"done"/"failed"/"skipped" badge, and the lock predicate.
- `runningBlockId?` — id of the currently-executing block. Drives the pulsing ring and the lock predicate.

### Lock predicate

A block is **locked** (read-only, undraggable, undeletable, "stop after" disabled) when:
`isRunning || status === "done" || status === "failed"`.
`pending` and `skipped` and unknown remain editable. Lock is per-block, not global.

### Errors

This component never throws and surfaces no async errors. Invalid block shapes (e.g. unknown `kind`) cause `BlockBody`'s switch to render nothing — no warning. See §6.

## 3. Invariants

- **`onChange` is the only write path.** Internal helpers (`update`, `remove`, `insertAt`, `move`) all funnel through `onChange(next)` with a freshly-constructed array; no in-place mutation of `blocks`.
- **Reorder uses correct adjusted index.** `move(id, beforeIdx)`: when the source precedes the target slot, the splice index is `beforeIdx - 1`; when the source follows, it's `beforeIdx`. A no-op move (drop into the source's own slot or the slot immediately after) returns without calling `onChange`.
- **DropZones bracket every block plus the tail.** N blocks render N+1 drop zones; dropping into zone `i` moves the dragged block to position `i`. A drop with no `dragId` is ignored.
- **Locked blocks are not draggable.** `draggable={!isLocked}` on the card. The "✕" remove and the `pauseAfter` checkbox are also disabled when locked. Per-field inputs in `BlockBody` receive `disabled={isLocked}`.
- **`AddBlockMenu` appends; `SmallAddMenu` inserts after the focused block.** Top menu calls `insertAt(blocks.length, newBlock(kind))`. Per-card "+ add below" calls `insertAt(idx + 1, newBlock(kind))`. There is no "insert above" action.
- **`newBlock(kind)` is the only block constructor.** Defaults (`role: "any"`, `on_fail: "halt"`, `unanswered_var: "unanswered"`, `item_var: "item"`) are owned by `web/src/blocks.ts`; this file does not invent fields.
- **`for_each` recurses by re-rendering `<BlockList>`** with `blocks={block.body}, onChange={(body) => onChange({ body })}`. No depth limit is enforced in code; the schema permits unbounded nesting. `statusMap` and `runningBlockId` are **not** propagated into nested lists (see §6).
- **`pauseAfter` is rendered for every kind.** The "stop after" checkbox is in the card header, outside the kind switch, so it works uniformly. Toggling on a `pause` block is permitted; behaviour at runtime is a server-side question (see `server/blocks.md` §6).
- **`AddBlockMenu` order is `BLOCK_KINDS` order**, which intentionally puts `pause` last. This is a UX choice owned by `web/src/blocks.ts`, not this file.

## 4. Per-kind UI surface

The bulk of the file is the `BlockBody` switch. Each row is a falsifiable claim about which schema fields are exposed. Hidden fields and drift are flagged.

| Kind            | Exposed fields                                                                                                                  | Hidden / not exposed | Validation                                                          | Drift |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------- | ----- |
| `navigate`      | `url` (single `<input type="url">`)                                                                                             | —                    | none (empty string allowed)                                         | —     |
| `goal`          | `description` (textarea, monospace), `max_steps` (optional number input, default 12, range 1–100)                               | —                    | `max_steps` clamped via the input range                             | —     |
| `pause`         | `message` (single text input, optional)                                                                                         | —                    | none                                                                | —     |
| `click`         | `target` (text), `role` (select over `CLICK_ROLES`)                                                                             | —                    | role constrained by `<select>`                                      | —     |
| `fill`          | `target` (text), `value` (text; `$var` interpolated server-side)                                                                | —                    | none                                                                | —     |
| `extract`       | `target` (text), `var_name` (text, sanitised on input)                                                                          | —                    | `var_name` strips any char outside `[a-zA-Z0-9_]` on each keystroke | —     |
| `verify`        | `condition` (text), `on_fail` (select: `halt` \| `pause`)                                                                       | —                    | `on_fail` constrained by `<select>`                                 | —     |
| `questionnaire` | `context` (text, optional), `unanswered_var` (text, sanitised)                                                                  | —                    | `unanswered_var` strips non-`[a-zA-Z0-9_]`                          | —     |
| `for_each`      | `items` (text — accepts `$name` or literal JSON; never `substituteVars`'d), `item_var` (text), `body` (recursive `<BlockList>`) | —                    | none on `items`; user-typed sanity unchecked                        | —     |

All inputs receive `disabled={isLocked}`. All editable rows call `onChange({ field } as Partial<Block>)` — the unsafe cast is necessary because `Block` is a discriminated union and TypeScript cannot narrow `Partial<Block>` to the active variant.

## 5. Drag-drop

- **Library:** none. Native HTML5 DnD only — `draggable`, `onDragStart/End`, `onDragOver/Leave/Drop`. No `react-dnd`, no `@hello-pangea/dnd`.
- **State:** a single `useState<string | null>(dragId)` in the parent. Dropping anywhere with `dragId === null` is a no-op.
- **Cross-`for_each` boundaries:** supported. `dragId` is lifted into a `DragCtx` provider at the root, so a drag started in the outer list and dropped into a nested `for_each.body` (or vice-versa) completes via a single tree-mutating `moveBlockInTree(tree, sourceId, parentBlockId, beforeIdx)` helper. The helper refuses to drop a `for_each` into itself or its own descendants (cycle prevention). Same-list moves preserve their pre-removal-index semantics so the visual drop gap matches the user's intent. Regression: `web/src/__tests__/moveBlockInTree.test.ts`.
- **Empty `for_each` body:** the recursive `<BlockList>` renders one terminal `<DropZone>` plus the "Add block" menu, so a user can drop a sibling-level block into an empty body via the inner top-level `AddBlockMenu`, but **not** by drag (see above).
- **Visual feedback:** `DropZone` flips to `bg-emerald-500/40` while `dragOver` is true; the `e.preventDefault()` on `onDragOver` is what makes drop legal in HTML5 DnD.
- **Locked blocks remain visible drop _targets_**, since drop zones are siblings of the cards, not children. They simply cannot be picked up.

## 6. Drift / open questions

- **Resolved — `goal.max_steps` editor.** Goal blocks now show an optional "Max LLM turns" number input (default 12, range 1–100) wired to `block.max_steps`.
- **Resolved — `statusMap` / `runningBlockId` propagated to `for_each.body`.** The recursive `<BlockList>` in `BlockBody`'s `for_each` case receives both props, so inner blocks show running/done state during a run.
- **Resolved — unknown `kind` renders a placeholder.** `BlockBody`'s switch ends in a `default` branch that renders an "Unsupported block kind" placeholder. `blockMeta()` falls back to a generic record (label "Unknown", color "zinc") so `meta.color` can never throw on a future schema kind. Regression: `web/src/__tests__/blocks.test.ts`.
- ⚠️ **Drift — `for_each.items` is taken literally; the UI does not hint that `substituteVars` is _not_ applied.** A user typing `$prefix$suffix` will see no substitution and no error. Consider an inline help line: "Use `$varname` to reference an extracted list, or paste a JSON array."
- ❓ **Question — should there be an "insert above" affordance?** Today only "add below" exists per-card; "add at top of list" is the global `AddBlockMenu`. Inserting between two existing blocks requires drag-drop after creation.

## 7. Decomposition target (post-refactor)

The mechanical split is one file per block kind. After refactor, `web/src/components/BlockList.tsx` ceases to exist; the contents move under `web/src/features/task-editor/`:

```
features/task-editor/
├── BlockList.tsx                ← orchestration only: render order, recursion entry
├── BlockListShell.tsx           ← drag-drop container, DropZone, useBlockListState wiring
├── useBlockListState.ts         ← {update, remove, insertAt, move, dragId} hook
├── AddBlockMenu.tsx             ← top-of-list menu (full kind palette)
├── SmallAddMenu.tsx             ← per-card "+ add below" popover
├── BlockCard.tsx                ← header (icon, label, status, pauseAfter, ✕), body slot
├── StatusBadge.tsx              ← extracted from internal
└── BlockEditor/
    ├── index.ts                 ← `kindToEditor` lookup
    ├── NavigateEditor.tsx       (1 field)
    ├── GoalEditor.tsx           (description; add max_steps to fix drift)
    ├── PauseEditor.tsx          (1 field)
    ├── ClickEditor.tsx          (target + role)
    ├── FillEditor.tsx           (target + value)
    ├── ExtractEditor.tsx        (target + var_name w/ sanitiser)
    ├── VerifyEditor.tsx         (condition + on_fail)
    ├── QuestionnaireEditor.tsx  (context + unanswered_var w/ sanitiser)
    └── ForEachEditor.tsx        (items + item_var + recursive <BlockList>)
```

Each `<Kind>Editor` takes `({ block: KindBlock, onChange: (patch: Partial<KindBlock>) => void, disabled: boolean })` — a _narrowed_ prop type, eliminating the `as Partial<Block>` casts. The colour-class `Record`s (`COLOR_BORDER`, `COLOR_BG`, `COLOR_LABEL`) move next to `blockMeta` in `domain/blocks` (or a `ui/` shim), since they are mechanically derived from `meta.color`.

## 8. How tested

There are no tests for this component yet.

| Spec section / claim                                               | Test file                                   | Test name                                                       | Status     |
| ------------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------- | ---------- |
| §3 lock predicate (`isRunning \|\| done \|\| failed` → uneditable) | —                                           | `locked block: inputs disabled, drag disabled, remove disabled` | TODO(test) |
| §3 `move` no-op when source maps to its own slot                   | —                                           | `move: identical-position drop is no-op`                        | TODO(test) |
| §3 `move` index adjustment when source precedes target             | —                                           | `move: source-before-target adjusts beforeIdx down by 1`        | TODO(test) |
| §3 `AddBlockMenu` appends; `SmallAddMenu` inserts at idx+1         | —                                           | `add menus: top appends, per-card adds below`                   | TODO(test) |
| §3 every change funnels through `onChange` (no in-place mutation)  | —                                           | `onChange: receives a new array reference each edit`            | TODO(test) |
| §4 each kind exposes exactly the fields claimed in the table       | —                                           | per-kind: `editor exposes <fields>` (×9)                        | TODO(test) |
| §4 `extract.var_name` sanitiser strips non-alnum-underscore        | —                                           | `extract: var_name input strips illegal chars`                  | TODO(test) |
| §4 `questionnaire.unanswered_var` sanitiser                        | —                                           | `questionnaire: unanswered_var input strips illegal chars`      | TODO(test) |
| §5 native HTML5 DnD only (no library import)                       | —                                           | `imports: no react-dnd / hello-pangea/dnd`                      | TODO(test) |
| §5 drag crosses `for_each` boundary via `moveBlockInTree`          | `web/src/__tests__/moveBlockInTree.test.ts` | tree-move cases                                                 | done       |
| §6 unknown `kind` renders placeholder without crash                | `web/src/__tests__/blocks.test.ts`          | unknown-kind cases                                              | done       |

### Deliberately not tested

- Tailwind class output. Visual regression is out of scope; component snapshot tests are brittle on class strings.
- Drag-drop cursor visuals. Native HTML5 DnD is hard to drive in jsdom; a Playwright component test is the right level if needed.
