# Spec — `web/blocks` (frontend block model + UI metadata)

> Path: `web/src/blocks.ts` · Layer: `domain/` for the type union; `ui/` for `KIND_META` / `summaryOf` (post-refactor split) · Spec owner: `components/BlockList.tsx` (primary editor), `components/TaskEditor.tsx`, `components/CompileFromText.tsx`, `api.ts` (`Block` type re-export)

## 1. Why

The frontend renders a typed-block editor and replays SSE events keyed by `block.id`. To do that it needs the same `Block` discriminated union the server persists, plus presentation-only metadata (`icon`, `color`, `label`, `description`) the server has no business knowing about. Today the file mixes both concerns: a re-declared mirror of `server/src/blocks.ts` types **and** UI metadata. The mirror is a copy, not an import, because there is no shared `domain/` package yet.

> **Non-obvious why:**
>
> - **Persisted schema.** The type union is the wire format of `tasks.steps` JSON. Drift from the server union breaks save/load round-trips. See §6.
> - **Two-file split is intentional going forward.** `_LAYERS.md` puts types in `web/src/domain/` and presentation maps in `web/src/ui/`. `KIND_META`, `summaryOf`, `BLOCK_KINDS`, `CLICK_ROLES` (UI ordering) belong on the `ui/` side; types and `newBlock` belong on the `domain/` side.
> - **`newBlock` duplication is required only until shared `domain/`.** Server's `newBlock` uses `node:crypto.randomUUID`; web's wraps `crypto.randomUUID` with a non-cryptographic `Math.random`+`Date.now` fallback for environments where Web Crypto is missing. Once shared, the fallback becomes the only path the browser code uses.

## 2. Public contract

### Exports

| Symbol               | Kind      | Signature / shape                                                                                                                | Stability                     |
| -------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `BlockKind`          | type      | `"navigate" \| "goal" \| "pause" \| "click" \| "fill" \| "extract" \| "verify" \| "questionnaire" \| "for_each"`                 | persisted — must match server |
| `ClickRole`          | type      | `"any" \| "button" \| "link" \| "tab" \| "menuitem" \| "checkbox" \| "radio" \| "switch" \| "combobox" \| "option" \| "textbox"` | must match server             |
| `BaseBlock`          | interface | `{ id: string; kind: BlockKind; pauseAfter?: boolean }`                                                                          | must match server             |
| `NavigateBlock`      | interface | `BaseBlock & { kind: "navigate"; url: string }`                                                                                  | persisted                     |
| `GoalBlock`          | interface | `BaseBlock & { kind: "goal"; description: string; max_steps?: number }`                                                          | persisted                     |
| `PauseBlock`         | interface | `BaseBlock & { kind: "pause"; message?: string }`                                                                                | persisted                     |
| `ClickBlock`         | interface | `BaseBlock & { kind: "click"; target: string; role?: ClickRole }`                                                                | persisted                     |
| `FillBlock`          | interface | `BaseBlock & { kind: "fill"; target: string; value: string }`                                                                    | persisted                     |
| `ExtractBlock`       | interface | `BaseBlock & { kind: "extract"; target: string; var_name: string }`                                                              | persisted                     |
| `VerifyBlock`        | interface | `BaseBlock & { kind: "verify"; condition: string; on_fail?: "halt" \| "pause" }`                                                 | persisted                     |
| `QuestionnaireBlock` | interface | `BaseBlock & { kind: "questionnaire"; context?: string; unanswered_var?: string }`                                               | persisted                     |
| `ForEachBlock`       | interface | `BaseBlock & { kind: "for_each"; items: string; item_var?: string; body: Block[] }`                                              | persisted                     |
| `Block`              | type      | discriminated union over `kind`                                                                                                  | persisted                     |
| `blockMeta`          | function  | `(kind: BlockKind) => { label: string; icon: string; color: string; description: string }` — UI presentation map                 | UI only                       |
| `BLOCK_KINDS`        | const     | `BlockKind[]` — order shown in the "Add block" menu (note: `pause` last, not the alphabetical/server order)                      | UI only                       |
| `CLICK_ROLES`        | const     | `ClickRole[]` — order shown in the role `<select>`                                                                               | UI only                       |
| `newBlock`           | function  | `(kind: BlockKind) => Block` — fresh `id`, kind-specific defaults                                                                | duplicated from server        |
| `summaryOf`          | function  | `(block: Block) => string` — human-readable one-line summary used in compact views                                               | UI only                       |

### `blockMeta(kind)` shape

`{ label, icon, color, description }` per kind. `color` is one of `indigo, violet, amber, blue, cyan, emerald, teal, rose, pink` — these are class-name keys consumed by `BlockList.tsx` lookup tables (`COLOR_BORDER` / `COLOR_BG` / `COLOR_LABEL`). Adding a new kind requires both a `KIND_META` entry **and** new entries in those Tailwind colour maps in `BlockList.tsx`, otherwise the card renders without border/background classes.

### `newBlock` defaults

Identical to server's `newBlock` defaults: `click.role = "any"`, `for_each.item_var = "item"`, `questionnaire.unanswered_var = "unanswered"`, `verify.on_fail = "halt"`. Empty string for everything else; empty body array for `for_each`.

### `summaryOf` semantics

- `navigate` → `url || "(no url)"`.
- `goal` → first 200 chars of `description`, else `"(empty goal)"`.
- `pause` → first 200 chars of `message`, else `"Pause for human"`.
- `click` → `Click [<role>: ]<target | "(no target)">`. Role omitted when `"any"`.
- `fill` → `Fill <target | "(no target)"> → <first 60 chars of value | "(empty)">`.
- `extract` → `<target | "(no target)"> → $<var_name | "var">`.
- `verify` → `condition || "(no condition)"`.
- `questionnaire` → `Context: <first 60>` if context set, else `"Auto-fill all questions"`.
- `for_each` → `<items | "(no items)"> (<n> sub-block[s])`.

### Errors

This module never throws. `newBlock`'s switch is exhaustive over `BlockKind`; `summaryOf`'s switch is exhaustive over the `Block` union.

## 3. Invariants

- **`Block.id` is a string.** `newBlock` generates `crypto.randomUUID()`; falls back to `Math.random().toString(36) + Date.now().toString(36)` (NOT a UUID, NOT collision-resistant) when Web Crypto is unavailable.
- **Type union mirrors server.** Any field added on `server/src/blocks.ts` MUST be added here in the same shape, or save/load will silently drop the field on round-trip through the editor.
- **`KIND_META` is exhaustive.** `Record<BlockKind, …>` — TypeScript fails compile if a kind is missing.
- **`newBlock` switch is exhaustive over `BlockKind`.** Adding a kind without a `case` is a TS error.
- **`BLOCK_KINDS` is the UI ordering, not the canonical kind list.** Consumers that need "every kind" should use `Object.keys(KIND_META) as BlockKind[]` or iterate a type-derived list — `BLOCK_KINDS` order is product-decision, not authoritative.
- **`summaryOf` is total and pure.** Every `Block` produces a non-empty string; no I/O, no allocation beyond the result string.
- **No `parseBlocks` / `instructionToBlocks` / `substituteVars` / `walkBlocks` / `countBlocks` here.** Frontend never parses persisted JSON (the API returns already-parsed `Block[]`) and never resolves variables (the executor does). If you find yourself adding these, the fix is the shared `domain/` module, not duplication.

## 4. How (briefly)

- **No state.** Pure functions and constants.
- **`newBlock` UUID fallback** uses `Math.random` + `Date.now` to avoid throwing in environments without `crypto.randomUUID`. The collision rate is acceptable for client-side draft IDs because the server never trusts these — saved blocks keep their client-assigned ids, but uniqueness is enforced socially (a single editor instance) not cryptographically.
- **`KIND_META` colour values are tokens, not Tailwind classes.** `BlockList.tsx` translates `meta.color` into `border-{color}-500/40` etc. via lookup tables. This indirection lets the JIT see static class strings (Tailwind cannot scan template-string concatenations).
- **`BLOCK_KINDS` ordering is intentional:** `navigate, goal, click, fill, extract, verify, questionnaire, for_each, pause`. `pause` is last because it is the least common addition; `navigate` is first because new tasks usually start with one.

## 5. How tested

There are no tests for this module yet.

| Spec section / claim                                        | Test file | Test name                                                              | Status     |
| ----------------------------------------------------------- | --------- | ---------------------------------------------------------------------- | ---------- |
| §3 every `BlockKind` value is constructable via `newBlock`  | —         | `newBlock: handles every BlockKind exhaustively`                       | TODO(test) |
| §3 `newBlock` returns distinct ids across calls             | —         | `newBlock: ids are unique across calls`                                | TODO(test) |
| §3 fallback id path used when `crypto.randomUUID` is absent | —         | `newBlock: falls back without crypto.randomUUID`                       | TODO(test) |
| §2 `summaryOf` is total over the union                      | —         | `summaryOf: returns non-empty for every kind`                          | TODO(test) |
| §2 `summaryOf` truncation rules per kind                    | —         | `summaryOf: 200-char and 60-char truncations apply`                    | TODO(test) |
| §2 `blockMeta` returns metadata for every kind              | —         | `blockMeta: every BlockKind resolves`                                  | TODO(test) |
| §3 `BLOCK_KINDS` covers every `BlockKind` (set equality)    | —         | `BLOCK_KINDS: set-equal to BlockKind union`                            | TODO(test) |
| §6 web↔server type union parity                             | —         | `web Block union matches server Block union` (cross-package type test) | TODO(test) |
| §6 web↔server `newBlock` defaults parity                    | —         | `web newBlock defaults match server newBlock defaults`                 | TODO(test) |

### Deliberately not tested (here)

- `BlockList.tsx`'s drag-drop and rendering logic — covered by `web/block-list.md`.
- Tailwind class string correctness — would require a JIT compile in test, not worth it; visual regression catches it.

## 6. Drift / open questions

### Drift table — `web/src/blocks.ts` vs `server/src/blocks.ts`

| Concern                       | Server                                                 | Web                                                        | Notes                                                                          |
| ----------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `BlockKind` union             | 9 kinds                                                | 9 kinds                                                    | ✅ Identical.                                                                  |
| `ClickRole` union             | 11 values                                              | 11 values                                                  | ✅ Identical.                                                                  |
| `BaseBlock` shape             | `{ id, kind, pauseAfter? }`                            | `{ id, kind, pauseAfter? }`                                | ✅ Identical.                                                                  |
| Per-kind interface fields     | matches                                                | matches                                                    | ✅ Field names, types, optionality all match.                                  |
| `newBlock` defaults           | identical values                                       | identical values                                           | ✅ But re-implemented, not imported.                                           |
| UUID source                   | `node:crypto.randomUUID`                               | `crypto.randomUUID` with `Math.random`+`Date.now` fallback | ⚠️ Fallback is non-UUID; relies on saved-block id being client-generated only. |
| `instructionToBlocks`         | exported                                               | NOT present                                                | server-only — UI does not migrate legacy text.                                 |
| `parseBlocks`                 | exported                                               | NOT present                                                | server-only — UI receives `Block[]` from API.                                  |
| `substituteVars`              | exported                                               | NOT present                                                | server-only — substitution happens in executor.                                |
| `countBlocks` / `walkBlocks`  | exported                                               | NOT present                                                | server-only walkers.                                                           |
| `KIND_META` / `blockMeta`     | NOT present                                            | exported                                                   | web-only — UI presentation.                                                    |
| `BLOCK_KINDS`                 | NOT present                                            | exported (custom order)                                    | web-only — menu ordering.                                                      |
| `CLICK_ROLES` (runtime array) | NOT present (only the type)                            | exported                                                   | web-only — `<select>` options.                                                 |
| `summaryOf`                   | NOT present (server uses `blockSummary` in `agent.ts`) | exported                                                   | web-only; subtly different output than server's `blockSummary`.                |
| JSDoc comments                | present on most fields                                 | none                                                       | doc-only drift; no behavioural impact.                                         |

### Open notes

- ⚠️ **Drift — duplicated source of truth.** Per `_LAYERS.md`, the resolution is a shared `web+server` `domain/blocks.ts` (types + `newBlock`) imported by both. UI metadata stays in `web/src/ui/blockMeta.ts`. Until then, every server-side type change requires a manual web-side mirror; CI has no check.
- ⚠️ **Drift — UI metadata in a domain-named file.** `web/src/blocks.ts` is consumed by `domain` users (`api.ts` re-exports `Block`) and `ui` users (`BlockList`). Splitting on the `domain/` vs `ui/` line would let `api.ts` import only types and let UI components import only metadata.
- ⚠️ **Drift — `summaryOf` (web) and `blockSummary` (server) compute different strings.** SSE events use the server version; the editor uses the web version. Aligning them would let the SSE stream surface labels matching what the user sees in the editor.
- ⚠️ **Drift — `BlockStatusMap` lives in `BlockList.tsx`.** That status union (`pending | running | done | failed | skipped`) is part of the run-view contract, not block-editor presentation. It belongs in `domain/` next to the `Block` type or alongside the SSE event union.
- ⚠️ **Drift — colour token coupling.** Adding a new kind requires editing both `KIND_META` here and three lookup tables in `BlockList.tsx`. A single source (`KIND_META.classes: { border, bg, label }`) would remove the cross-file coordination.
- ❓ **Question — should the UUID fallback be removed?** Every supported browser has `crypto.randomUUID` (Safari 15.4+, Firefox 95+, Chrome 92+). The fallback pads bundle size and produces non-UUID ids that downstream code might assume are UUIDs.
- ❓ **Question — should `newBlock` and types live in a separately-published shared package, or just a path-aliased shared folder?** Path alias is cheaper; package gives lint-able boundaries.
