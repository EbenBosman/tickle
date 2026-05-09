# Spec — `agent` (run orchestration, block execution, sub-agent loops, rescue)

> Path: `server/src/agent.ts` (1534 lines, multi-concern god-file) · Layer: today flat, post-refactor decomposes across `domain/`, `application/`, and `infrastructure/llm/` (see §4) · Spec owner: `routes/runs.ts` (only caller of `runAgent`), `routes/export.ts` (consumes `messages_export` rows this file writes), `bus.ts` + `web/src/components/RunView.tsx` (consumers of the `AgentEvent` union), `db.ts` (writer of `steps`, `lessons`).

## 1. Why

A tickle task is a typed program of blocks (see `blocks.md`). This module is the runtime: it walks the program, owns the per-run state, drives a real Chromium tab via the `Session`/`Tools` layer, talks to a local LLM (with optional Claude rescue), and produces the SSE event stream the UI consumes. Everything that makes the user-facing experience possible — "hit Run, watch it work, intervene when needed, get the result" — flows through here. The shape is dictated by four hard constraints:

1. **Cooperative pause/cancel at every safe boundary.** The user must be able to take over the browser, or stop the run, between any two model decisions. That requires checkable state (a flag), not exceptions, plus a way to abort an in-flight LLM HTTP call (an `AbortController` registered with `cancel.ts`).
2. **Two LLM topologies, not one.** Multi-turn `runAiSubGoal` (goal/click/fill blocks: snapshot → think → act → re-snapshot, up to N turns) and stateless `runStatelessStep` (extract / verify / per-question answer / vision-enrichment: one prompt, one response, no follow-up). Atomic steps disable Qwen3.x thinking-mode for latency; multi-turn loops keep it on.
3. **Observability is the product.** Every model thought, tool call, tool result, page transition, variable write, and stat point is fanned out as both an SSE event (live UI) and a `steps` row (replay on reconnect). The persistence and the bus must agree on event vocabulary.
4. **Recovery without losing the run.** When the local model gives up or stalls, an opt-in Claude rescue can retry the same block while persisting both transcripts as a DPO training pair. Rescue is hijacked into the cancel button so the user can trigger it explicitly from the UI.

> **Non-obvious why — page content is hostile.** Snapshot text, `read_text` output, DOM-derived form questions, and screenshot data all enter the prompt. The system prompts here remind the model that page content is data, not instructions, and the upstream tools (`snapshot`, `read_text`) strip invisible elements. This module trusts the tools to have done their job; it does not re-filter.
>
> **Non-obvious why — sub-agent step budget is per-block, not per-run.** `MAX_STEPS_PER_GOAL` (default 25) caps a _single_ `runAiSubGoal` invocation. Click/fill blocks override to 12/8. The cap exists because a stuck local model would otherwise spend tokens flailing forever on one block; the user can always re-issue the task or split it.
>
> **Non-obvious why — image pruning is in-module.** Screenshots are 50–200 KB base64 each. `KEEP_RECENT_IMAGES` (default 3) bounds the image bytes per chat call by replacing older `images` arrays with a "screenshot omitted" text marker, leaving older text intact. Belongs to `agent.ts` today; should move to `infrastructure/llm/pruneImages.ts` (see §6).

## 2. Public contract

### Exports

| Symbol          | Kind     | Signature / shape                                                                                                                                                                                          | Stability                                                                                                                                |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `runAgent`      | function | `(runId: number, taskId: number, instruction: string, stepsJson: string \| null, emit: (e: AgentEvent) => void) => Promise<{ status: "done" \| "error" \| "cancelled"; result?: string; error?: string }>` | stable — sole entry point invoked by `routes/runs.ts` IIFE. **Must not throw**; all errors are returned as `{ status: "error", error }`. |
| `AgentEvent`    | type     | discriminated union on `kind` — see "SSE event vocabulary" below                                                                                                                                           | stable (consumed by `bus.ts`, `routes/runs.ts`, `web/src/api.ts`)                                                                        |
| `BlockStatus`   | type     | `"pending" \| "running" \| "done" \| "failed" \| "skipped"`                                                                                                                                                | stable                                                                                                                                   |
| `RunHandle`     | type     | `{ run: Run }` — declared, not used at runtime today                                                                                                                                                       | evolving — candidate for removal                                                                                                         |
| `chatWithRetry` | function | `(client, request, isCancelled, setActiveController, onRetry) => Promise<ChatResponse>` — module-internal but exercised by both `runAiSubGoal` and `runStatelessStep`                                      | **misplaced** — must move to `infrastructure/llm/chatWithRetry.ts` per `_LAYERS.md` (see §6). Not exported today.                        |

All other names in this file (`ExecCtx`, `BlockOutcome`, `AiSubOutcome`, `StatelessOutcome`, `executeBlocks`, `executeBlock`, `runAiSubGoal`, `runStatelessStep`, `runVerifyBlock`, `runQuestionnaireBlock`, `enrichQuestionsWithVision`, `runClaudeRescue`, `generateLesson`, `buildLessonContext`, `buildStatelessUserPrompt`, `pruneOldImages`, `toolsForAiBlock`, `blockSummary`, `emitPageState`, `isTransientLLMError`, the system-prompt constants) are intentionally not exported.

### `runAgent` runtime contract

- **Single-call lifecycle.** Caller (the `routes/runs.ts` IIFE) calls `runAgent` exactly once per `runId`. `runAgent` itself calls `registerPause(runId)`, `registerCancel(runId, callback)`, and is responsible for `clearPause(runId)` + `clearCancel(runId)` in its `finally` block.
- **Browser ownership.** Constructs a `new Session(runId)` and calls `session.start()` at entry, `session.close()` in `finally`. The persistent Chromium _context_ survives; only the per-run tab is opened/closed.
- **Returns one of three terminal shapes:** `{ status: "done", result }`, `{ status: "error", error }`, or `{ status: "cancelled", error: "Cancelled by user" }`. Never throws under contract.
- **Emits one terminal `final` event** on `done` (with the last block's summary or `"All blocks completed"`); does NOT emit `final` on `error` or `cancelled`. The route's IIFE owns the SSE `end` frame.

### SSE event vocabulary (the `AgentEvent` union)

The bus and the `RunView` UI depend on this surface. Every event carries `kind`; `block_id` is attached for events that originate inside a block.

| `kind`        | Payload shape (beyond `kind`)                                                                                       | Emitted from                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `block_start` | `{ block_id: string; block_kind: BlockKind; summary: string; path: string[] }`                                      | `executeBlocks` before each block (incl. nested inside `for_each`)                                                                   |
| `block_end`   | `{ block_id; block_kind; status: BlockStatus; result?: string; error?: string; details?: unknown; path: string[] }` | `executeBlocks` after each block, **and** a second time after a successful rescue (see I7)                                           |
| `thought`     | `{ text: string; block_id?: string }`                                                                               | both `runAiSubGoal` and `runStatelessStep` when assistant content non-empty                                                          |
| `tool_call`   | `{ name: string; args: unknown; block_id?: string }`                                                                | once per tool call before dispatch                                                                                                   |
| `tool_result` | `{ name: string; result: ToolResult; screenshotPath?: string; block_id?: string }`                                  | once per tool call after dispatch (incl. virtual `finish_step`/`done` interceptions and refused `act` whitelist hits)                |
| `page_state`  | `{ url: string; title: string }`                                                                                    | after `navigate`, after auto-snapshot, on initial sub-goal snapshot, after `snapshot()` tool call                                    |
| `stats`       | `{ model: string; prompt_tokens: number; output_tokens: number; eval_duration_ms: number; tps: number }`            | once per LLM response in both loop kinds                                                                                             |
| `var_set`     | `{ name: string; preview: string }`                                                                                 | `extract` block on success, questionnaire block at end                                                                               |
| `remember`    | `{ note: string }`                                                                                                  | `remember` tool from stateless steps; questionnaire block at start (synthetic)                                                       |
| `paused`      | `{ reason?: string; auto?: boolean }`                                                                               | login auto-pause, stall auto-pause, `pause` block, `pauseAfter` flag, `verify` `on_fail: "pause"`                                    |
| `resumed`     | `{}`                                                                                                                | **Not emitted by this module today.** The `resumed` SSE event is published by `routes/runs.ts` on `POST /resume`. ⚠️ Drift — see §6. |
| `error`       | `{ error: string; block_id?: string }`                                                                              | top-level run failure, "task has no steps"                                                                                           |
| `final`       | `{ answer: string }`                                                                                                | exactly once on `status: "done"` exit                                                                                                |

`tps` is computed as `(completion_tokens / duration_ms) * 1000`; **not** Ollama-native eval timings (those don't flow through `chatOnce` — see `llm-client.md` §4).

### DB writes (the `steps` and `lessons` and `messages_export` surface)

- **`steps` rows** persisted via prepared `INSERT INTO steps (run_id, idx, kind, payload, screenshot_path)`. `idx` is monotonic per run, assigned by an in-memory counter (`stepIdx++`). Every persisted kind:

  | `steps.kind`      | Payload JSON shape                                                                                                                                                                                          | Mirrors SSE event?           |
  | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
  | `block_start`     | `{ id, kind, summary, path }`                                                                                                                                                                               | yes (`block_start`)          |
  | `block_end`       | `{ id, kind, status, result?, error?, details?, path }`                                                                                                                                                     | yes (`block_end`)            |
  | `thought`         | `{ text, block_id }`                                                                                                                                                                                        | yes                          |
  | `tool_call`       | `{ name, args, block_id }`                                                                                                                                                                                  | yes                          |
  | `tool_result`     | `{ name, ok, text, data?, block_id }` + optional `screenshot_path` column                                                                                                                                   | yes                          |
  | `var_set`         | `{ name, preview }` (extract) or `{ name, preview, unanswered }` (questionnaire)                                                                                                                            | yes                          |
  | `remember`        | `{ note }`                                                                                                                                                                                                  | yes                          |
  | `error`           | `{ error }`                                                                                                                                                                                                 | yes                          |
  | `final`           | `{ answer }`                                                                                                                                                                                                | yes                          |
  | `messages_export` | `{ block_id, block_kind, instruction, rescue_model, local_status, local_error, local_step_count, rescue_status, rescue_step_count, local_messages, rescue_messages }` — written _only_ by `runClaudeRescue` | no (training-data sink only) |

  ⚠️ The `Step.kind` literal union in `db.ts` lists only five kinds (`thought | tool_call | tool_result | error | final`). This module persists ten. See `persistence.md` §6 and §6 below.

- **`lessons` rows** via `addLesson(runId, blockId, lesson, situation)` from `generateLesson`. Written asynchronously after a Claude rescue completes; failures are traced and swallowed (`rescue.lesson_error` / `rescue.lesson_failed`).

### Filesystem writes

- Screenshots: `agent.ts` does not write PNG files directly; the `Session` (`browser.ts`) writes them. The agent's responsibility is recording the relative path `run-<runId>-<NNN>.png` (computed from `session.shotIdx - 1`) into the `steps.screenshot_path` column when a tool returned an image, OR after auto-snapshot.

### Trace writes (`log.ts::trace`)

This module emits the following named events. Documented in `observability-log.md`; reproduced for completeness so the contract is explicit:

- `run.start`, `run.cancel_requested`, `run.rescue_requested`, `run.cancelled`, `run.error`, `run.done`, `run.end`, `run.breakpoint_pause`, `run.auto_paused_stall`, `run.auto_paused_login`
- `block.start`, `block.end`, `block.pause`
- `llm.request`, `llm.response`, `llm.retry`
- `stateless.request`, `stateless.response`, `stateless.snapshot_error`, `stateless.screenshot_error`
- `tool.call`, `tool.result`
- `auto_snapshot.error`, `login_detect.error`
- `questionnaire.scan`, `questionnaire.question`, `questionnaire.verify_dom`, `questionnaire.invalid_act_id`
- `rescue.start`, `rescue.end`, `rescue.user_triggered`, `rescue.lesson_saved`, `rescue.lesson_failed`, `rescue.lesson_error`

### Errors

| Error / failure mode                                  | Returned when                                                                                      | Caller should…                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `{ status: "error", error: "Task has no steps" }`     | `parseBlocks` returned an empty array                                                              | finalize row as `error`; emit `end`  |
| `{ status: "error", error: <Error.message> }`         | unhandled throw inside `runAgent`'s `try` (defensive only — block executor catches its own throws) | finalize row as `error`              |
| `{ status: "cancelled", error: "Cancelled by user" }` | `cancelled` flag observed at any safe boundary OR thrown abort during cancel                       | finalize row as `cancelled`          |
| `{ status: "done", result }`                          | every block reached `done` / `skipped` (or `done`-via-rescue)                                      | finalize row as `done` with `result` |

## 3. Invariants

Each is independently falsifiable.

- **I1 — Cooperative pause/cancel at every safe boundary.** `isCancelled()` and `awaitIfPaused(runId)` are checked: at the top of `executeBlocks` per block, at the top of every iteration of `runAiSubGoal`'s step loop, before each tool dispatch in both loops, between each questionnaire question, before/after rescue triggers, and inside `for_each` per iteration. Falsifiable: instrument `isCancelled` to return true at each boundary in turn; assert the run exits cleanly with `status: "cancelled"`.
- **I2 — A run completes with exactly one of `done | error | cancelled`.** No other status escapes `runAgent`. Falsifiable: enumerate every `return` from `runAgent` and confirm.
- **I3 — Exactly one `final` SSE event per `done` run.** Emitted in the `try` block of `runAgent` only. Not emitted on `error`/`cancelled`. Falsifiable: count `final` events across paths.
- **I4 — `block_start`/`block_end` are paired per block, in order, and nest correctly under `for_each`.** Each block emits exactly one `block_start` before any inner work and at least one `block_end` after, with the same `block_id`. `path` carries parent ids for nested execution (set by `for_each`'s `childCtx`). Falsifiable: walk an emitted event log and assert pairing + `path` correctness.
- **I5 — Login auto-pause is one-shot per run.** Guarded by `ctx.loginAutoPaused.value`. Once true, no further `detectLoginPrompt` calls run. Reset never happens within a run. Falsifiable: simulate a page that always reports login; assert exactly one `paused` event of that kind.
- **I6 — Stall auto-pause is one-shot per _sub-goal_.** Guarded by `stallPaused` local in `runAiSubGoal`. Resets between blocks (each `runAiSubGoal` invocation starts fresh). Triggers when the last `STALL_REPEAT_THRESHOLD = 3` tool calls have identical `(name, JSON.stringify(args))`. Falsifiable: stub a model that emits the same `act` 3× — exactly one stall pause is published; a 4th identical call does not re-trigger.
- **I7 — Auto-snapshot is attached to `navigate` and `act` results by the agent, not the tool.** After a successful `navigate` or `act` whose result has no `image_base64`, `runAiSubGoal` calls `takeSnapshot` and appends `\n\n--- post-action snapshot (<url>) ---\n<text>` plus the screenshot to the tool message and `tool_result` event. Falsifiable: confirm `executeTool` does not call `takeSnapshot` itself (cross-spec with `tools.md` I8); confirm only `runAiSubGoal` does and only on the two trigger names.
- **I8 — Image pruning keeps the last `KEEP_RECENT_IMAGES` (default 3) image arrays per chat call.** `pruneOldImages` is called on every `messages` array immediately before `chatWithRetry` in `runAiSubGoal`. Older messages keep their text content with a marker appended; only the `images` field is dropped. Falsifiable: feed a 10-image history with `KEEP_RECENT_IMAGES=3`; assert exactly 3 retained image arrays in the prepared payload.
- **I9 — `extract` writes to a per-run variable map; `for_each` reads `$varname` array, sets `$item` and `$item_index`.** Variable map is `ctx.vars: Map<string, unknown>`. `for_each.items` resolves via `$name` (variable lookup), `[…]` (literal JSON), or bare `name` (variable lookup as a kindness). Falsifiable: §3 of `blocks.md` plus a test that confirms `vars.delete(itemVar)` runs after the loop body.
- **I10 — `$varname` substitution happens via `substituteVars()` per block param, before each block executes.** Delegated to `blocks.ts`. The agent never substitutes `for_each.items` (parsed structurally). Falsifiable: cross-grep call sites of `substituteVars` in this file and confirm coverage matches `blocks.md` §3.
- **I11 — Cancellation is honoured between LLM retry attempts.** `chatWithRetry` checks `isCancelled()` at the top of each attempt and after each failure, and short-circuits without sleeping the backoff if cancelled. Falsifiable: stub `chatOnce` to throw `fetch failed` once, set `cancelled` true mid-backoff; assert the function rejects with the original error and never retries.
- **I12 — Variable map is per-run, not global.** `ctx.vars = new Map()` is constructed once in `runAgent` per call. Nested `for_each` invocations clone `ctx` with `{ ...ctx, blockPath: childPath }` but share the same `vars` `Map` reference (intentional — the inner loop's writes are visible to outer scope). Falsifiable: two parallel `runAgent` invocations on different `runId` must have independent `vars` instances.
- **I13 — Stall detection sees only post-finish_step tool calls.** `recentCalls` is appended **before** the `name === "finish_step"` short-circuit, but the loop returns immediately on `finish_step` so the array never observes a finish call as "stalled". Falsifiable: assert `finish_step` never appears as the matching name in a stall.
- **I14 — Cancel callback is registered before the first cancellation-checkable boundary.** `runAgent` calls `registerCancel(runId, callback)` synchronously before `executeBlocks(ctx, blocks)`. This guarantees `requestCancel(runId)` from the route can never miss the registration window. Falsifiable: synchronous code-order inspection.
- **I15 — Rescue is gated by a DB setting + an env key.** `claudeClient !== null` requires `getSetting("rescue_enabled") === "true"` AND `process.env.ANTHROPIC_API_KEY` set at `runAgent` start. Disabling rescue mid-run does not affect an already-started run. Falsifiable: unset both conditions; assert `claudeClient === null` and rescue branches are unreachable.
- **I16 — Rescue produces exactly one `messages_export` row per rescued block.** Even if rescue itself fails. Even if lesson generation fails. Falsifiable: count `steps.kind = 'messages_export'` rows for a run with N rescued blocks; expect N.
- **I17 — `runAgent` never throws under contract.** All thrown exceptions inside `executeBlocks`/`executeBlock` are caught and converted to `{ status: "failed", error }` outcomes; the top-level `try/catch` in `runAgent` is defensive. Falsifiable: hostile fault injection at each `await` site.
- **I18 — Rescue can only be triggered when a Claude client exists.** `runClaudeRescue` is only called when `outcome.status === "failed"` AND `ctx.claudeClient !== null`. The `isRescueRequested()` flag is _checked_ throughout the sub-loop but only set if `rescueOnCancel && claudeClient !== null` at registration time. Falsifiable: with rescue disabled, `rescueRequested` is never set and the user-rescue branches are dead.
- **I19 — Questionnaire ids are stable for the duration of one questionnaire block.** `formScan` runs once at block entry; per-question `runStatelessStep` calls pass `includeSnapshot: false` so `takeSnapshot` does not re-tag and clobber `data-tickle-id` numbering. The `allowedActIds` whitelist refuses any `act` with an out-of-set id. Cross-spec with `form-scan.md` §3.15.
- **I20 — Anchor-URL guard halts a questionnaire that navigated.** If `ctx.session.page.url() !== anchorUrl` after a question, the remaining questions are marked unanswered and the loop breaks. Falsifiable: stub a question whose `act` triggers `goto`; assert the loop stops and remaining questions appear in `unanswered`.

## 4. How — concerns mixed in this file (the decomposition map)

This section is the refactor plan. Every concern in `agent.ts` is listed with: current line range, target post-refactor file, and what moves with it.

### 4.1 `runAgent` orchestration — `application/runAgent.ts`

- **Current:** lines `176–286`.
- **Moves:** the function itself, the construction of `Session`, the LLM client wiring (`newLlmClient`, optional `newAnthropicClient` from settings), the `registerCancel`/`registerPause`/`clearCancel`/`clearPause` lifecycle, the `insertStep` prepared statement and `persist` closure, the `emit`/`persist` plumbing wired into `ExecCtx`, the top-level try/catch/finally that finalizes the run.
- **Stays infrastructure:** `Session.start/close` (still in `infrastructure/browser/`), `db.prepare` use (move behind a `RunStore.appendStep` interface — see `persistence.md` §6).
- **`ExecCtx` type** moves with this file but should be an exported type so per-block executors can reference it without re-import cycles.

### 4.2 `executeBlocks` walker — `application/executeBlocks.ts`

- **Current:** lines `288–396`.
- **Moves:** the for-loop, the `block_start`/`block_end` SSE+persist boilerplate (extract a `withBlockSpan(ctx, block, fn)` helper to reduce duplication), the `pauseAfter` handling, and the post-failure rescue dispatch (the rescue dispatch is the most subtle part — it emits a _second_ `block_end` with `status: "done"` if rescue succeeds — see I7 + §6).
- **`blockSummary`** can move to `domain/blocks.ts` (it has no I/O); it is a pure presentation helper over `Block + vars`.

### 4.3 `executeBlock` dispatcher — `application/executeBlock.ts`

- **Current:** lines `423–572`.
- **Moves:** the `switch (block.kind)` and the per-kind try/catch wrapper.
- **Each `case` body extracts to its own per-block executor** (4.4 below). The dispatcher itself shrinks to a tagged dispatch table.

### 4.4 Per-block executors

- **`navigate`** — `application/blocks/runNavigate.ts`. Lines `426–434`. Owns: URL substitution, http(s) guard, `page.goto` with `domcontentloaded` waitUntil, `emitPageState`. No LLM.
- **`pause`** — `application/blocks/runPause.ts`. Lines `436–445`. Owns: `pauseRun` + `awaitIfPaused`, paired SSE events. No LLM.
- **`goal`** — `application/blocks/runGoal.ts`. Lines `447–450`. Thin wrapper over `runAiSubGoal`.
- **`click`** — `application/blocks/runClick.ts`. Lines `452–463`. Owns the role-hint prompt construction; calls `runAiSubGoal` with `maxSteps: 12`.
- **`fill`** — `application/blocks/runFill.ts`. Lines `465–471`. Calls `runAiSubGoal` with `maxSteps: 8`.
- **`extract`** — `application/blocks/runExtract.ts`. Lines `473–500`. Owns the `runStatelessStep` call, JSON-parse-best-effort of model output, `vars.set` + `var_set` event.
- **`verify`** — `application/blocks/runVerify.ts`. Lines `502–518` (block) + `1153–1170` (`runVerifyBlock` helper). Owns `on_fail: "pause"` branch.
- **`questionnaire`** — `application/blocks/runQuestionnaire.ts`. Lines `520–527` (block) + `1172–1340` (`runQuestionnaireBlock`) + `1342–1382` (`enrichQuestionsWithVision`). Owns: scan-once anchor URL, vision enrichment of question text, per-question stateless answer with `allowedActIds` whitelist, deterministic DOM verification with visual fallback, anchor-URL drift guard, `unanswered` var write.
- **`for_each`** — `application/blocks/runForEach.ts`. Lines `529–566`. Owns: `items` resolution (`$name` / JSON literal / bare name), recursion into `executeBlocks` with `childPath`, `item_var` + `item_var_index` set/delete.

### 4.5 `runAiSubGoal` (multi-turn AI loop) — `application/runAiSubGoal.ts`

- **Current:** lines `607–867`.
- **Moves:** the entire multi-turn loop, the per-loop initial snapshot, the message-list management, the assistant/tool message round-tripping, the `finish_step` interception, the auto-snapshot hook (4.13), the stall detector (4.10), the login auto-pause hook (4.11), the image pruning call site (4.12), the per-iteration cancel/pause/rescue checks.
- **`SYSTEM_PROMPT_AI_BLOCK`** stays with this module (the prompt is a contract with the local model; tying it to its consumer is right). Constant lives in this file post-refactor.
- **`toolsForAiBlock`** moves with it (lines `1513–1534`) — defines the `finish_step` virtual tool schema appended to `toolDefs`.

### 4.6 `runStatelessStep` (one-shot AI call) — `application/runStatelessStep.ts`

- **Current:** lines `869–1151`.
- **Moves:** the prompt builder (`buildStatelessUserPrompt`, lines `883–908`), the `STATELESS_SYSTEM` constant, the `done` and `remember` virtual tools, the `allowedActIds` whitelist guard, the `think: false` flag for stateless atomicity.
- **`StatelessOutcome` type** moves with it.

### 4.7 `runQuestionnaireBlock` — see 4.4 (the per-block executor file).

Note the scan→enrich→loop→verify pipeline is one cohesive unit; do not over-decompose into "scan layer / enrich layer / verify layer." The unit of meaning is "the questionnaire block."

### 4.8 `runClaudeRescue` (Claude fallback) — `application/runClaudeRescue.ts`

- **Current:** lines `1399–1462` (rescue) + `1464–1511` (lesson generation) + `1384–1397` (`buildLessonContext`).
- **Moves:** the rescue dispatcher (constructs a rescue `ExecCtx` cloned with `client: ctx.claudeClient`, calls `runAiSubGoal` with a "previous attempt failed" `systemSuffix`), the `messages_export` row write (must move behind a `RunStore.appendMessagesExport(runId, payload)` interface — see `persistence.md` §6), the fire-and-forget `generateLesson` (writes to `lessons` table via `addLesson`), the `buildLessonContext` (used by `runAiSubGoal` to inject lessons from past runs into the system prompt — read-only via `searchLessons`).
- **Cross-cuts:** rescue depends on `runAiSubGoal` (4.5), so rescue lives one level down in the dependency graph.

### 4.9 `chatWithRetry` (LLM retry, misplaced) — `infrastructure/llm/chatWithRetry.ts`

- **Current:** lines `31–74` plus the `isTransientLLMError` regex (line 33).
- **Moves wholesale.** Knows `chatOnce`, retry timing, transient classification — knows nothing about blocks or runs. Belongs next to `chatOnce`. The `setActiveController` callback parameter is the only seam back to caller state; it stays in the signature.
- **The `RETRY_BACKOFFS_MS` constant** moves with it. `STALL_REPEAT_THRESHOLD` stays with `runAiSubGoal` (4.5).
- **See `llm-client.md` §6 drift** — the classifier regex includes `aborted by`, which is dangerous; tighten on relocation.

### 4.10 Stall detection — fold into `application/runAiSubGoal.ts`

- **Current:** lines `637`, `739–751` (in-loop state + check).
- **Stays inline.** The stall machine is tiny (a 3-element FIFO + an equality check) and only `runAiSubGoal` cares. A separate file would over-fragment. Document the algorithm in §3 I6 and leave the code where its only consumer lives.

### 4.11 Login auto-pause invocation — fold into `application/runAiSubGoal.ts`

- **Current:** lines `843–857` (post-`tool_result` block).
- **Stays inline at this call site.** The detector itself lives in `application/loginGuard.ts` per `_LAYERS.md` (already speced as `loginDetect.ts`). The one-shot guard (`ctx.loginAutoPaused.value`) lives on `ExecCtx`; the boolean wrapper-object pattern is preserved so child contexts (`for_each`'s `{ ...ctx }` spread) share the same one-shot flag. Falsifiable: a `for_each` whose body triggers a login surface still pauses only once.

### 4.12 Image-pruning logic — `infrastructure/llm/pruneImages.ts`

- **Current:** lines `76–92` (`pruneOldImages`).
- **Moves.** Pure function over `Message[]` and a `keep` count. Belongs next to `chatWithRetry` so every LLM-calling site (this module's two loops, the future `routes/compile.ts` rewrite, any future utility) gets the same policy.
- **`KEEP_RECENT_IMAGES` constant** moves with it.

### 4.13 Tool-call dispatch + auto-snapshot attach — fold into `application/runAiSubGoal.ts`

- **Current:** lines `728–841` (tool-call inner loop) including the auto-snapshot block at `805–821`.
- **Stays inline.** The auto-snapshot policy is a property of the multi-turn loop, not of `executeTool`. Spec it in §3 I7 and keep the call site here. An `application/autoSnapshot.ts` would expose three lines of helper for one caller — not worth the dependency hop.

### 4.14 Variable store management — `domain/run.ts` (type), inline elsewhere

- **`Map<string, unknown>` itself** stays inline on `ExecCtx`. There is no abstraction worth introducing; the consumers (`extract`, `for_each`, `substituteVars` callers) all use the `Map` interface directly.
- **`buildStatelessUserPrompt`'s `VARIABLES:` section rendering** moves with `runStatelessStep` (4.6).

### 4.15 Step persistence — `infrastructure/persistence/sqliteRunStore.ts`

- **Current:** the `persist` closure in `runAgent` (lines `219–225`) and the duplicated `db.prepare` in `runClaudeRescue` for `messages_export` (lines `1446–1452`).
- **Moves behind a store interface.** `RunStore.appendStep(runId, idx, kind, payload, screenshotPath?)` and `RunStore.appendMessagesExport(runId, payload)` defined in `domain/run.ts` (or `domain/persistence.ts`); SQLite implementation in `infrastructure/persistence/sqliteRunStore.ts`. The `stepIdx` counter stays in `runAgent` (no good reason to expose it).
- **Drift fix:** today the rescue path re-prepares its own `INSERT` and re-computes `stepIdx` via a `SELECT MAX(idx)` rather than the in-memory counter — a race in principle (two `messages_export` rows could collide on idx if rescue ran twice in parallel for the same run, which currently can't). The store method should hide this by owning the idx.

### 4.16 SSE event emission — `domain/run.ts` (type), inline emission

- **`AgentEvent` union type** moves to `domain/run.ts` per `_LAYERS.md` (where the bus's `EndEvent` should also live, forming the full `SseEvent = AgentEvent | EndEvent`).
- **`emit` callback** stays as-is — passed in from `routes/runs.ts`. The wiring into the bus is the route's responsibility.

### 4.17 System prompt construction — `application/prompts/`

- **`SYSTEM_PROMPT_AI_BLOCK`** (lines `584–603`) — stays with `runAiSubGoal`.
- **`STATELESS_SYSTEM`** (lines `871–875`) — stays with `runStatelessStep`.
- **Per-block prompt fragments** (the role hint in `click`, the questionnaire-question prompt) live with the per-block executor (4.4).
- **Optional consolidation:** `application/prompts/index.ts` could export them all if test-time isolation is desired. Not necessary for the refactor; defer.

### 4.18 Trace logging — already extracted

- `log.ts::trace` is the seam. This module just calls it. No work to do here; the broader observability refactor (typed `TraceEventKind`, redaction allow-list) is described in `observability-log.md` §6 and is out of scope for the agent split.

### 4.19 Cancel/pause boundary checks — fold into each per-block executor

- **Current:** boundary checks are sprinkled at every safe site (counted: 14 sites in `runAgent` + `executeBlocks` + `runAiSubGoal` + `runStatelessStep` + `runQuestionnaireBlock`).
- **Stays inline.** Each per-block executor and each loop body owns its own boundary checks. Extracting a `withCancellable(ctx, fn)` higher-order would obscure the safe-boundary discipline that I1 requires; the explicit pattern is documentation.
- **Recommended hardening (post-refactor):** add a tiny `assertNotCancelled(ctx)` helper that throws a typed `RunCancelledError` (see `_LAYERS.md::domain/errors.ts`), and have the per-block executors catch it once at the top. That removes the `if (ctx.isCancelled()) return { status: "cancelled" }` repetition while keeping the discipline visible.

## 5. How tested

Nothing is tested today. Every `§3` invariant is `TODO(test)`. Recommended test taxonomy:

- **Unit (pure)** — `pruneOldImages`, `isTransientLLMError`, `blockSummary`, `buildLessonContext`, `buildStatelessUserPrompt` (deterministic given a fake `ExecCtx`), `toolsForAiBlock`. Stall detector state machine after extraction.
- **Integration with mocked LLM/browser** — per-block executors using a `LlmClient` fake (injectable via `ExecCtx.client`) and a `Session` fake (`page` mock or in-process page via `playwright/test`). This is where I1, I2, I4–I20 are validated.
- **Integration with real LLM/browser** — only manual smoke today; not gating CI per CLAUDE.md.

| Spec section / claim                                                            | Test file                 | Test name                                                         | Status                                                       |
| ------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| §3 I1 cancellation observed at every safe boundary                              | —                         | —                                                                 | TODO(test)                                                   |
| §3 I1 pause observed at every safe boundary                                     | —                         | —                                                                 | TODO(test)                                                   |
| §3 I2 terminal status is one of three                                           | —                         | —                                                                 | TODO(test)                                                   |
| §3 I3 exactly one `final` event on `done`                                       | —                         | —                                                                 | TODO(test)                                                   |
| §3 I3 no `final` event on `error` or `cancelled`                                | —                         | —                                                                 | TODO(test)                                                   |
| §3 I4 `block_start`/`block_end` pairing and `path` nesting under `for_each`     | —                         | —                                                                 | TODO(test)                                                   |
| §3 I5 login auto-pause is one-shot per run                                      | —                         | —                                                                 | TODO(test)                                                   |
| §3 I6 stall pause triggers at exactly the 3rd identical call, not the 4th       | —                         | —                                                                 | TODO(test)                                                   |
| §3 I6 stall state resets between blocks                                         | —                         | —                                                                 | TODO(test)                                                   |
| §3 I7 auto-snapshot only on `navigate`/`act`, only when no native image         | —                         | —                                                                 | TODO(test)                                                   |
| §3 I7 auto-snapshot is from the agent, not `executeTool`                        | —                         | —                                                                 | TODO(test, static-grep)                                      |
| §3 I8 image pruning keeps last `KEEP_RECENT_IMAGES` arrays                      | —                         | —                                                                 | TODO(test)                                                   |
| §3 I8 pruning preserves text content of older messages                          | —                         | —                                                                 | TODO(test)                                                   |
| §3 I9 `extract` writes to `vars`; emits `var_set`                               | —                         | —                                                                 | TODO(test)                                                   |
| §3 I9 `for_each` resolves `$name`, JSON literal, and bare name forms            | —                         | —                                                                 | TODO(test)                                                   |
| §3 I10 `substituteVars` is invoked on every string param                        | —                         | —                                                                 | TODO(test, table-driven)                                     |
| §3 I11 cancellation between LLM retry attempts                                  | —                         | —                                                                 | TODO(test)                                                   |
| §3 I12 `vars` is per-run, not module-global                                     | —                         | —                                                                 | TODO(test)                                                   |
| §3 I13 `finish_step` never appears as a stalled call                            | —                         | —                                                                 | TODO(test)                                                   |
| §3 I14 cancel callback registered before first cancel-checkable boundary        | —                         | —                                                                 | TODO(test)                                                   |
| §3 I15 rescue gated on setting AND env key at run start                         | —                         | —                                                                 | TODO(test)                                                   |
| §3 I16 exactly one `messages_export` row per rescued block                      | —                         | —                                                                 | TODO(test)                                                   |
| §3 I17 `runAgent` does not throw                                                | —                         | —                                                                 | TODO(test, fault injection)                                  |
| §3 I18 user-rescue branches dead when rescue disabled                           | —                         | —                                                                 | TODO(test)                                                   |
| §3 I19 questionnaire ids stable; whitelist refuses out-of-set ids               | —                         | —                                                                 | TODO(test)                                                   |
| §3 I20 anchor-URL drift halts questionnaire                                     | —                         | —                                                                 | TODO(test)                                                   |
| §2 SSE vocabulary completeness (every `kind` produced by at least one path)     | —                         | —                                                                 | TODO(test)                                                   |
| §2 every persisted `steps.kind` matches the documented payload shape            | —                         | —                                                                 | TODO(test)                                                   |
| §2 trace event vocabulary completeness                                          | —                         | —                                                                 | TODO(test, static-grep cross-checked with observability-log) |
| §6 `toolDefs` exposes neither `finish` nor `finish_step` (interception correct) | `__tests__/tools.test.ts` | `does not include finish` / `does not include finish_step either` | done                                                         |
| §6 ⚠️ `block_end` is emitted twice on a successful rescue                       | —                         | —                                                                 | TODO(test)                                                   |
| §6 ⚠️ `resumed` event is published by route, not by agent                       | —                         | —                                                                 | TODO(test)                                                   |
| §6 ⚠️ `ctx.memory` cap (`MAX_MEMORY_ENTRIES = 200`)                             | —                         | —                                                                 | TODO(test)                                                   |

### Deliberately not tested

- Real LLM round-trips. Manual smoke against a live Ollama / LM Studio / Anthropic key.
- Real browser navigation across third-party sites. Manual smoke; covered by integration runner.
- The OS-level Chromium persistent profile lifecycle. Owned by `browser.ts`.

## 6. Drift / open questions

### Drift — must address during the Phase 4 refactor

- ⚠️ **`chatWithRetry` is in the wrong layer.** Lives at lines `31–74`; per `_LAYERS.md` belongs at `infrastructure/llm/chatWithRetry.ts`. Owns nothing run-specific. (Cross-spec with `llm-client.md` §6.)
- ⚠️ **`Step.kind` type union understates reality.** `db.ts` declares five (`thought | tool_call | tool_result | error | final`); this module persists ten (`block_start, block_end, var_set, remember, messages_export` extra). Anyone reading typed `Step` rows will mis-narrow. Fix: hoist `StepKind` into `domain/run.ts` as a single source of truth and widen `db.ts`'s `Step` type. Cross-spec with `persistence.md` §6.
- **Resolved — `finish` vs `finish_step` interception drift.** `tools.ts::toolDefs` no longer declares `finish`; the model sees only `finish_step` (appended by `toolsForAiBlock`). `runAiSubGoal` intercepts it before dispatch. Regression: `__tests__/tools.test.ts`.
- **Resolved — single `block_end` per block.** `executeBlocks` now invokes the rescue path before emitting `block_end` and merges the outcome via `mergeRescuedOutcome` (`server/src/blockOutcome.ts`). One emission, one `steps` row, regardless of whether rescue happened. Regression: `__tests__/blockOutcome.test.ts`.
- ⚠️ **`resumed` SSE event documented in `AgentEvent` union but never emitted by this module.** The `kind: "resumed"` event is published by `routes/runs.ts` on `POST /resume`. The `AgentEvent` union here advertises it. Either move the type to a shared `SseEvent` union in `domain/run.ts` (the right answer per `_LAYERS.md`), or remove `resumed` from `AgentEvent`. The current state misleads readers into thinking the agent emits it.
- ⚠️ **CLAUDE.md "Block kinds" list is incomplete** (no `verify`, no `questionnaire`). Cross-spec with `blocks.md` §6 — already flagged there.
- ⚠️ **CLAUDE.md "Storage" lists kinds for `steps` payloads** (`thoughts, tool_calls, tool_results, block_start, block_end, var_set, remember, page_state, stats, errors, finals`) including `page_state` and `stats` — but those events are NOT persisted by this module's `persist` closure (which only handles `thought, tool_call, tool_result, error, final, block_start, block_end, var_set, remember`). The DB does not retain page_state/stats history; reconnecting clients see them in the live phase only. Either add them to `persist` (with throttling so a 50-stat run doesn't bloat the DB) or update CLAUDE.md.
- ⚠️ **Rescue and lessons are absent from CLAUDE.md.** The rescue feature, the `lessons` / `lessons_fts` tables, the `messages_export` row writes, the `rescue_enabled` / `rescue_model` / `rescue_on_cancel` settings, and the `ANTHROPIC_API_KEY` env var are all real, all production, and entirely undocumented in `CLAUDE.md`. The "Tasks lifecycle" and "Architecture" sections need a "rescue path" subsection. This is the biggest documentation gap surfaced by writing this spec.
- ⚠️ **`runClaudeRescue` re-prepares an `INSERT` statement.** Lines `1446–1452` re-prepare `INSERT INTO steps ...` instead of using `runAgent`'s `insertStep` closure or the `ctx.persist` callback. The result is a parallel write path that bypasses `stepIdx`. Fix during 4.15 by routing through `RunStore.appendMessagesExport`.
- ⚠️ **`buildLessonContext` failures are silently swallowed.** A `searchLessons` throw (e.g. malformed FTS5 query — see `persistence.md` §6) returns `""`; the run continues without lesson context. Acceptable, but a `trace("lessons.search_error")` would help diagnose. Same goes for `generateLesson` — failures only surface as `rescue.lesson_failed` / `rescue.lesson_error` traces.
- ⚠️ **`RunHandle` is unused.** Declared at line `134–136`, exported, never instantiated anywhere. Dead code; remove.

### Open questions

- ❓ **Should `ctx.memory` (the `remember` tool's append-only log) persist across a run via the `steps` table replay, or in a dedicated column?** Today it lives in-memory on `ExecCtx` and is reconstructed from `remember`-kind `steps` rows only via the SSE replay. A page refresh during a run reads `remember` events but does NOT rebuild the model-facing `GLOBAL CONTEXT` in subsequent stateless calls. Falsifiable bug. Fix: persist `ctx.memory` shape on each `remember`, or rebuild from `steps WHERE kind='remember'` at run resume (no resume mechanism exists today, so this is latent).
- ❓ **`MAX_MEMORY_ENTRIES = 200` and `MAX_MEMORY_ENTRY_CHARS = 500`.** These are picked by feel. No cap on total `memory` payload size shipped to the model per stateless call (200 × 500 = 100KB). For a long run, this dominates the prompt budget. Either trim to a sliding window when constructing `memorySection`, or rank by recency.
- ❓ **Stall detector applies only to multi-turn loops.** Stateless steps cannot stall (one shot), but a _block_ of "extract" calls in a loop _could_ (model returns `done(success=false)` 3× in a row). No per-block stall guard exists. Probably YAGNI.
- ❓ **`for_each` shares `vars` with parent scope by spread reference (I12).** Inner loop writes are visible to outer scope. This is intentional (an `extract` inside a `for_each` body should be readable after the loop) but the only signal is variable name conventions. Consider explicit scoping rules: top-level vars vs loop-local vars (e.g. `local:` prefix).
- ❓ **Rescue runs on the SAME block id.** The rescue's transcript is persisted under the original block id, so the SSE event `block_end` carries the rescue's outcome under the same id — but the `messages_export` row is also under that block id. If the same block is rescued twice (somehow — currently not possible since `runClaudeRescue` is only called once per block), the export rows would not disambiguate. Latent.
- ❓ **The `verify` block's `on_fail: "pause"` resumes silently as `done`.** Lines `508–515`: a paused-then-resumed verify produces `{ status: "done", summary: "Verify failed (resumed): <reason>" }`. The block's `block_end` SSE event therefore says `status: "done"` with the failure reason in `result`. Consumers parsing block status alone miss the failure. Either introduce a `status: "warned"` or pass the original-failed status alongside.
- ❓ **The agent's `claudeClient` is constructed once per run.** If the user changes `rescue_enabled` mid-run (via a settings UI), it does not take effect until the next run. Document or fix. (I15 enshrines this.)
- ❓ **`buildLessonContext` searches `lessons` for top-5 by FTS rank against the current block's instruction.** False positives (lessons from unrelated tasks ranked highly because of a shared word like "click") could mislead the model. Tracking which lessons actually helped — and downweighting unhelpful ones — is a longer-term concern.
- ❓ **Two LLM clients are constructed even when rescue is disabled.** Wait — re-read: `claudeClient = rescueEnabled && ANTHROPIC_API_KEY ? newAnthropicClient(...) : null`. So rescue-disabled means `claudeClient === null` and no Anthropic client is created. Good. But `newLlmClient()` (the local one) is _always_ created at run start, even for tasks that contain only `navigate` / `pause` blocks (no LLM calls). Trivial cost; flag for completeness.
