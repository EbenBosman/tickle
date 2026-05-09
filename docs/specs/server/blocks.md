# Spec — `blocks` (block domain model)

> Path: `server/src/blocks.ts` · Layer: `domain/` (post-refactor target) · Spec owner: `agent.ts` (the only runtime caller), `routes/tasks.ts` (lazy migration on read), and the SQLite `tasks.steps` JSON column (persisted shape)

## 1. Why

A tickle task is not free text — it is an ordered, typed program of **blocks**. Block kinds give the executor a finite, switchable surface (no free-form planning at the top level) and let the UI render distinct editors per kind. Because tasks are persisted as JSON in `tasks.steps` and replayed across server restarts, the block type union is a _durable schema_, not just an in-memory shape.

This module owns: (a) the canonical type union, (b) construction with sensible defaults (`newBlock`), (c) parsing/migration from legacy free-text instructions (`parseBlocks`, `instructionToBlocks`), (d) `$varname` interpolation (`substituteVars`), and (e) recursive walkers (`countBlocks`, `walkBlocks`) that handle `for_each.body` nesting. It is pure: no I/O, no LLM, no Playwright. The agent does the work; this file decides what the work _is shaped like_.

> **Non-obvious why:**
>
> - **Persisted schema.** Field renames or removals require a SQL/JSON migration; you cannot just edit a type. Same for `BlockKind` — dropping a value strands every saved task that uses it.
> - **Mirrored on the frontend.** `web/src/blocks.ts` redeclares the same union (plus UI metadata). The two files MUST stay in sync; the post-refactor target is one shared `domain/` module imported by both.
> - **`$var` is in domain.** Substitution rules belong with the type — every executor branch in `agent.ts` calls `substituteVars` per param. Centralising the regex here is the only way to keep behaviour consistent.

## 2. Public contract

### Exports

| Symbol                | Kind      | Signature / shape                                                                                                                | Stability                                                                 |
| --------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `BlockKind`           | type      | `"navigate" \| "goal" \| "pause" \| "click" \| "fill" \| "extract" \| "verify" \| "questionnaire" \| "for_each"`                 | persisted — additions require frontend mirror; removals require migration |
| `ClickRole`           | type      | `"any" \| "button" \| "link" \| "tab" \| "menuitem" \| "checkbox" \| "radio" \| "switch" \| "combobox" \| "option" \| "textbox"` | stable                                                                    |
| `BaseBlock`           | interface | `{ id: string; kind: BlockKind; pauseAfter?: boolean }`                                                                          | stable                                                                    |
| `NavigateBlock`       | interface | `BaseBlock & { kind: "navigate"; url: string }`                                                                                  | persisted                                                                 |
| `GoalBlock`           | interface | `BaseBlock & { kind: "goal"; description: string; max_steps?: number }`                                                          | persisted (`max_steps` default 12 lives in `agent.ts`, not here)          |
| `PauseBlock`          | interface | `BaseBlock & { kind: "pause"; message?: string }`                                                                                | persisted                                                                 |
| `ClickBlock`          | interface | `BaseBlock & { kind: "click"; target: string; role?: ClickRole }`                                                                | persisted                                                                 |
| `FillBlock`           | interface | `BaseBlock & { kind: "fill"; target: string; value: string }` (`value` may contain `$var`)                                       | persisted                                                                 |
| `ExtractBlock`        | interface | `BaseBlock & { kind: "extract"; target: string; var_name: string }`                                                              | persisted                                                                 |
| `VerifyBlock`         | interface | `BaseBlock & { kind: "verify"; condition: string; on_fail?: "halt" \| "pause" }`                                                 | persisted                                                                 |
| `QuestionnaireBlock`  | interface | `BaseBlock & { kind: "questionnaire"; context?: string; unanswered_var?: string }`                                               | persisted                                                                 |
| `ForEachBlock`        | interface | `BaseBlock & { kind: "for_each"; items: string; item_var?: string; body: Block[] }`                                              | persisted                                                                 |
| `Block`               | type      | discriminated union of all of the above on `kind`                                                                                | persisted                                                                 |
| `newBlock`            | function  | `(kind: BlockKind) => Block` — fresh `id` (UUID v4), kind-specific defaults                                                      | stable                                                                    |
| `instructionToBlocks` | function  | `(instruction: string) => Block[]` — wraps trimmed instruction in a single `goal` block with a fresh UUID                        | stable (legacy migration)                                                 |
| `parseBlocks`         | function  | `(json: string \| null \| undefined, fallbackInstruction?: string) => Block[]`                                                   | stable                                                                    |
| `substituteVars`      | function  | `(input: string, vars: Map<string, unknown>) => string`                                                                          | stable                                                                    |
| `countBlocks`         | function  | `(blocks: Block[]) => number` — recurses into `for_each.body`                                                                    | stable                                                                    |
| `walkBlocks`          | function  | `(blocks: Block[], visit: (b: Block) => void) => void` — depth-first, pre-order, recurses into `for_each.body`                   | stable                                                                    |

### `parseBlocks` semantics

- `json` null/undefined/empty → `[]` if `fallbackInstruction` is empty/whitespace, else `instructionToBlocks(fallbackInstruction)`.
- `json` parses to an array → returned as `Block[]` (no validation; trusts the SQLite-stored shape).
- `json` parses to a non-array → `[]` (silently; **no fallback applied** even if `fallbackInstruction` is set — see §6).
- `json` fails to parse → fallback path same as null/undefined.

### `substituteVars` semantics

- Fast path: input without any `$` is returned unchanged (no allocation).
- Pattern: `\$([a-zA-Z_][a-zA-Z0-9_]*)` — leading letter or underscore, then alnum/underscore. `$1foo`, `$.foo`, `$-foo` do not match.
- `vars.has(name) === false` → the literal `$name` substring is preserved (NOT replaced with empty string, NOT thrown).
- `vars.get(name)` is `string` → inserted as-is.
- Any other type (number, boolean, object, array, null) → `JSON.stringify(value)` is inserted.
- An explicitly-undefined value (`vars.set("x", undefined)`) substitutes to the empty string. (Key absent → `$name` is preserved as a literal.)
- Multiple `$var` occurrences in one string are all substituted in a single `replace` pass.
- `$var` matches are case-sensitive; `vars` lookup is case-sensitive.

### Errors

This module never throws. All edge cases (missing variable, non-array JSON, bad JSON) are encoded as silent fallbacks per the rules above.

## 3. Invariants

- **`Block.id` is a string.** `newBlock` returns `crypto.randomUUID()`; `instructionToBlocks` does the same. The agent uses `id` as the `block_id` on every SSE event and as the parent in `blockPath` for nested execution; collisions would corrupt the event tree.
- **`BlockKind` is closed.** Every kind in the union has (a) a `newBlock` case, (b) an `executeBlock` case in `agent.ts`, (c) a `blockSummary` case in `agent.ts`, and (d) a frontend mirror in `web/src/blocks.ts` with `KIND_META`. Adding a kind requires touching all four.
- **`pauseAfter` applies to every block kind.** It is on `BaseBlock`, honoured by `executeBlocks` after every successful (or rescued) block, and is _not_ checked on `failed` / `cancelled` outcomes. The `pause` block kind is orthogonal — it pauses _during_ execution; `pauseAfter` pauses _after_.
- **Block lifecycle states (`pending → running → done | failed | skipped`) live in `agent.ts`, not here.** This module declares no state field on `Block`; status is computed at runtime by the executor and emitted via SSE `block_start` / `block_end`. (Frontend mirrors a `BlockStatus` type for rendering.)
- **`for_each.items` is the one string param NOT subject to `substituteVars`.** It is parsed structurally by `agent.ts`: `$name` → variable lookup; `[…]` → JSON literal; bare `name` → variable lookup as a kindness. `substituteVars` would mangle the `$` prefix into the resolved value before the executor could distinguish modes.
- **`walkBlocks` is depth-first, pre-order.** `visit` runs on the parent before its `for_each.body` children. `countBlocks` counts the parent `for_each` plus every nested block.
- **JSON shape is the wire format.** Any field added to a block interface lands in `tasks.steps` JSON for every newly-saved task; loading an old task that lacks the field yields `undefined` at runtime. New fields MUST be optional or have a default applied at read time.
- **Persisted schema invariant — no field renames in place.** Renaming `var_name` → `varName` would silently strand every existing task. Renames require a read-side migration in `routes/tasks.ts` analogous to `ensureSteps`.

## 4. How (briefly)

- **No state.** Every export is a pure function over its arguments. `Map<string, unknown>` for vars is owned by the caller (`ExecCtx.vars` in `agent.ts`).
- **`newBlock` defaults are deliberate.** `click.role` defaults to `"any"`, `for_each.item_var` to `"item"`, `questionnaire.unanswered_var` to `"unanswered"`, `verify.on_fail` to `"halt"`. These are the values the executor reads when the field is present; the executor itself also `||`-defaults `item_var` and `unanswered_var` so editing JSON to clear them still works.
- **Migration policy:** `parseBlocks` is the single entry point used by `routes/tasks.ts` (`ensureSteps`) and `agent.ts` (`runAgent`). A task with `steps IS NULL` in SQLite hits the fallback branch with the legacy `instruction` column, producing a single `goal` block.
- **Recursion is limited to `for_each.body`.** No other block kind contains nested blocks. Walkers and the agent's `executeBlocks` both rely on this.
- **Concurrency:** none. All exports are synchronous, allocation-light, safe to call from any context.

## 5. How tested

There are no tests for this module yet.

| Spec section / claim                                               | Test file | Test name                                                           | Status     |
| ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------- | ---------- |
| §2 `parseBlocks` returns `[]` on null + empty fallback             | —         | `parseBlocks: null+empty fallback returns []`                       | TODO(test) |
| §2 `parseBlocks` migrates legacy instruction when json is null     | —         | `parseBlocks: null json + non-empty fallback yields one goal block` | TODO(test) |
| §2 `parseBlocks` returns array unchanged when json is a JSON array | —         | `parseBlocks: passes through JSON array`                            | TODO(test) |
| §2 `parseBlocks` returns `[]` on non-array JSON (no fallback)      | —         | `parseBlocks: non-array JSON drops fallback`                        | TODO(test) |
| §2 `parseBlocks` falls back on malformed JSON                      | —         | `parseBlocks: malformed JSON falls back to instruction`             | TODO(test) |
| §2 `substituteVars` no-`$` fast path                               | —         | `substituteVars: input without $ is returned identity`              | TODO(test) |
| §2 `substituteVars` missing var preserves literal                  | —         | `substituteVars: unknown $name is left intact`                      | TODO(test) |
| §2 `substituteVars` string value inserted as-is                    | —         | `substituteVars: string value substitutes verbatim`                 | TODO(test) |
| §2 `substituteVars` non-string value JSON-encoded                  | —         | `substituteVars: array/object/number is JSON.stringified`           | TODO(test) |
| §2 `substituteVars` multiple occurrences in one input              | —         | `substituteVars: replaces every match`                              | TODO(test) |
| §2 `substituteVars` regex boundary (`$1`, `$.`, `$-` don't match)  | —         | `substituteVars: rejects illegal identifier starts`                 | TODO(test) |
| §3 `Block.id` is a fresh UUID per `newBlock` call                  | —         | `newBlock: ids are unique across calls`                             | TODO(test) |
| §3 every `BlockKind` value is constructable via `newBlock`         | —         | `newBlock: handles every BlockKind exhaustively`                    | TODO(test) |
| §3 `walkBlocks` is pre-order and recurses into `for_each.body`     | —         | `walkBlocks: parent visited before nested body`                     | TODO(test) |
| §3 `countBlocks` counts parent + nested                            | —         | `countBlocks: matches walkBlocks visit count`                       | TODO(test) |
| §2 `substituteVars(undefined)` substitutes to ""                   | `__tests__/blocks.test.ts` | undefined-value cases                                  | done       |

### Deliberately not tested (here)

- `pauseAfter` honour, block lifecycle transitions, and `for_each.items` resolution live in `agent.ts` and are tested under `server/agent.md` (TBD).
- Frontend mirror drift between `server/src/blocks.ts` and `web/src/blocks.ts` is structural; covered by a future cross-package type test or by the post-refactor shared `domain/` module.

## 6. Drift / open questions

- ⚠️ **Drift — CLAUDE.md kind list is incomplete.** `CLAUDE.md` lists "navigate, pause, goal, click, fill, extract, for_each" under "Block-based execution." The actual union also includes **`verify`** and **`questionnaire`**. The handbook should be updated to match the code; this spec is canonical.
- ⚠️ **Drift — frontend duplication.** `web/src/blocks.ts` redeclares the entire union plus `KIND_META`, `BLOCK_KINDS`, `CLICK_ROLES`, `newBlock`, `summaryOf`. Any change here requires a coordinated change there. `_LAYERS.md` calls for a shared `domain/` module — that is the post-refactor target. Until then, keep the two in lockstep.
- ⚠️ **Drift — `parseBlocks` non-array branch silently drops the fallback.** When `json` parses to a non-array (e.g. `"null"`, `"42"`, `"{}"`), `parseBlocks` returns `[]` even when `fallbackInstruction` is non-empty. The malformed-JSON branch DOES use the fallback. This asymmetry is probably a bug; the safer behaviour is "any non-array result triggers fallback." A test should pin the current behaviour and a follow-up should align the two paths.
- **Resolved — `substituteVars(undefined)`.** An explicitly-undefined value substitutes to the empty string instead of the literal `"undefined"`. (Key absent still leaves `$name` intact.) Regression: `__tests__/blocks.test.ts`.
- ⚠️ **Drift — `parseBlocks` does not validate.** It casts the parsed JSON to `Block[]` without checking `kind` values, required fields, or `id` presence. A corrupted `tasks.steps` row would propagate garbage to `executeBlock`'s switch (which has no `default` case → silent fallthrough returning `undefined`). A `parseBlock` validator belongs in `domain/` and should be wired through `parseBlocks`.
- ❓ **Question — should `BlockKind` be versioned?** Today the persisted schema is implicit. A `schema_version` on the row (or on each block) would make migrations explicit instead of "lazy + hope."
- ❓ **Question — should `pauseAfter` be ignored on `pause` blocks?** A `pause` block already pauses; `pauseAfter: true` on it produces a second pause after the user resumes. Probably a no-op edge case but worth deciding.
- ❓ **Question — should `for_each.items` accept a substituted form?** Today it is parsed structurally; a user who writes `"$prefix$suffix"` cannot compose a variable name. Likely YAGNI; document the constraint.
