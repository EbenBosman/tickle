# tickle specs

This directory is the **source of truth** for what tickle's modules do, why, and how we know they're right. Code follows specs; tests enforce them. If you find a contradiction, the spec is the place to resolve it before touching code.

## Reading order for a newcomer

1. **[`_LAYERS.md`](./_LAYERS.md)** — the architecture rules (server N-tier, web feature layout). Read this first; everything else assumes it.
2. **[`../../README.md`](../../README.md)** — what tickle is and how to run it.
3. **[`../../CLAUDE.md`](../../CLAUDE.md)** — guardrails the agent (and you) work under.
4. The module specs below, in roughly the order data flows through the system.

## Module specs (Phase 2 — to be authored)

> Status legend: 📝 drafted · 🔄 stale (drift noted) · ⛔ missing

### Server

| Module | Spec | Status |
|--------|------|--------|
| Run lifecycle (top-level orchestration, today: `agent.ts`) | [`server/agent.md`](./server/agent.md) | 📝 |
| Block model (`blocks.ts`, `$var` substitution, walkers) | [`server/blocks.md`](./server/blocks.md) | 📝 |
| Snapshot pipeline (`snapshot.ts`) | [`server/snapshot.md`](./server/snapshot.md) | 📝 |
| Form scan (`formScan.ts`) | [`server/form-scan.md`](./server/form-scan.md) | 📝 |
| Tools (`tools.ts`, the model-facing tool surface) | [`server/tools.md`](./server/tools.md) | 📝 |
| Browser adapter (`browser.ts`, persistent profile, `__name` polyfill) | [`server/browser.md`](./server/browser.md) | 📝 |
| LLM client (`llm.ts`, OpenAI-compatible, retry, thinking-mode toggle) | [`server/llm-client.md`](./server/llm-client.md) | 📝 |
| Persistence (`db.ts`, schema, lazy migrations) | [`server/persistence.md`](./server/persistence.md) | 📝 |
| Login auto-pause (`loginDetect.ts`) | [`server/login-guard.md`](./server/login-guard.md) | 📝 |
| Stall auto-pause (lives in `agent.ts::runAiSubGoal`) | covered in [`server/agent.md`](./server/agent.md) §3 invariants | 📝 |
| Pause registry (`pause.ts`) | [`server/run-control-pause.md`](./server/run-control-pause.md) | 📝 |
| Cancel registry (`cancel.ts`) | [`server/run-control-cancel.md`](./server/run-control-cancel.md) | 📝 |
| Event bus (`bus.ts`) | [`server/event-bus.md`](./server/event-bus.md) | 📝 |
| Env bootstrap (`loadEnv.ts`) | [`server/load-env.md`](./server/load-env.md) | 📝 |
| JSONL trace logger (`log.ts`) | [`server/observability-log.md`](./server/observability-log.md) | 📝 |
| HTTP routes — runs (`routes/runs.ts`) | [`server/http-runs.md`](./server/http-runs.md) | 📝 |
| HTTP routes — tasks (`routes/tasks.ts`) | [`server/http-tasks.md`](./server/http-tasks.md) | 📝 |
| HTTP routes — compile (`routes/compile.ts`) | [`server/http-compile.md`](./server/http-compile.md) | 📝 |
| HTTP routes — export (`routes/export.ts`) | [`server/http-export.md`](./server/http-export.md) | 📝 |
| HTTP routes — settings (`routes/settings.ts`) | [`server/http-settings.md`](./server/http-settings.md) | 📝 |

### Web

| Module | Spec | Status |
|--------|------|--------|
| App shell (`App.tsx`, routing, top-level layout) | [`web/app-shell.md`](./web/app-shell.md) | 📝 |
| Run view (SSE consumer, timer, banners, entry stream) | [`web/run-view.md`](./web/run-view.md) | 📝 |
| Block list editor (drag-drop, per-kind UI) | [`web/block-list.md`](./web/block-list.md) | 📝 |
| Task editor wrapper | [`web/task-editor.md`](./web/task-editor.md) | 📝 |
| Settings page | [`web/settings.md`](./web/settings.md) | 📝 |
| Compile-from-text | [`web/compile.md`](./web/compile.md) | 📝 |
| API client (`api.ts`) | [`web/api-client.md`](./web/api-client.md) | 📝 |
| Block model + UI metadata (`blocks.ts`) | [`web/blocks.md`](./web/blocks.md) | 📝 |
| Status pill + small primitives + bootstrap | [`web/ui-primitives.md`](./web/ui-primitives.md) | 📝 |

## Authoring a spec

Run `/spec <module-name>` in Claude Code, or use the **spec-writer** subagent. Both follow the same template (`_TEMPLATE.md`) and the same four-question structure.

## Cross-cutting concerns

These don't belong to one module but apply across all of them. Each synthesises findings from the per-module specs above.

- [`cross-cutting/error-handling.md`](./cross-cutting/error-handling.md) — principles, current gaps (top-level rejection escape, structured `ToolError`, retry classifier breadth), target error class hierarchy.
- [`cross-cutting/observability.md`](./cross-cutting/observability.md) — the three surfaces (trace log / DB steps / SSE bus), event-matrix table for current behaviour, target single source of truth for `SseEvent`.
- [`cross-cutting/security.md`](./cross-cutting/security.md) — threat model, current gaps (CORS, path traversal, log redaction, compile-preview affordances), defences in depth.
- [`cross-cutting/testing-strategy.md`](./cross-cutting/testing-strategy.md) — Vitest, three tiers (unit / integration / smoke), determinism rules, mock-at-boundary table, Phase 3 starting order.

## Open findings from Phase 2 spec pass

Issues surfaced while specifying the modules. Each is captured in detail in the relevant module spec; tracked here so they don't get lost. Severity is rough (🔴 fix soon, 🟠 worth scheduling, 🟡 nit/cleanup).

### Behavioural drift (code disagrees with docs/specs)

- 🟠 **`finish` tool name drift.** Wire schema is `finish(answer: string)`; `CLAUDE.md` and the agent's prompts use `finish_step(success, output?, note?)`. Pick one — the wire surface is what models actually receive.
- 🟠 **`Step["kind"]` type incomplete.** Type lists 5 kinds; agent persists 9 (`block_start`, `block_end`, `var_set`, `remember` missing). DB rows for those kinds bypass the type guarantee.
- 🟠 **CLAUDE.md missing `verify` and `questionnaire` block kinds.** Code defines 9 block kinds; CLAUDE.md enumerates 7.
- 🟠 **CLAUDE.md silent on the Claude-rescue / lessons / messages_export features.** `agent.ts::runClaudeRescue`, the `lessons` table, and the training-data `/api/export` endpoint exist but aren't documented in the architecture overview.
- 🟡 **`loginDetect`: `twitter.com` alias** in code but not in `CLAUDE.md`'s SSO list.
- 🟡 **`VALID_MODELS` duplicated** between `routes/settings.ts` and `web/src/components/SettingsPage.tsx` — change one, drift the other.

### Likely bugs

- 🔴 **`finish` vs `finish_step` is a correctness bug.** Both names appear in tool defs (`finish` from `toolDefs`, `finish_step` appended). Only `finish_step` is intercepted by `runAiSubGoal`. If the model picks `finish`, `executeTool` returns it as a normal tool result and the loop continues until stall/step-limit failure. **Fix:** drop `finish` from `toolDefs`, or stop appending `finish_step`. (Drift between agent and tool docs was noted earlier; the actual model-visible mismatch is the bug.)
- 🔴 **`block_end` emitted twice on successful Claude rescue.** Once with `failed` (local), then again with `done` (rescue). Two `steps` rows per block; UI relies on last-write-wins.
- 🔴 **`scanForm` bug:** `SELECTOR` includes `[role="combobox"]` but the classifier has no combobox branch — combobox elements get tagged `"other"` and would be unfillable.
- 🔴 **`newAnthropicClient(model)` ignores its `model` argument.** Anthropic provider always uses the wrong (or default) model.
- 🔴 **No top-level catch on the run-start IIFE.** A throw out of `runAgent` leaks as an unhandled rejection and leaves the `runs` row stuck in `running` forever.
- 🔴 **`/screenshots/*` has no path-traversal guard.** Literal string concat with only a `.png` suffix filter. Local-only context, but trivial to fix.
- 🔴 **CORS `origin: true`** — server binds 127.0.0.1 but CORS allows any origin. DNS-rebinding lets a malicious page in the user's browser drive the API.
- 🟠 **`page_state` and `stats` events not persisted.** CLAUDE.md "Storage" claims all events get a `steps` row; in fact `page_state` and `stats` are emitted live only. SSE clients reconnecting via replay miss them entirely.
- 🟠 **`runClaudeRescue` bypasses the in-memory step counter.** Re-prepares its own INSERT and computes `stepIdx` via `SELECT MAX(idx)+1`. Latent race with the main run if any concurrency emerges.
- 🟠 **`CompileFromText` preview lacks danger affordances.** The "human-review-before-execute" injection defence per `http-compile.md` §6 is load-bearing, but the preview is a plain `<ol>` of `kind` + summary — no off-host `navigate` banner, no credential-pattern flag. Makes review a rubber-stamp.
- 🟠 **Single-run invariant not enforced.** A second `POST /api/tasks/:id/run` while one is running succeeds and races on the shared Chromium context.
- 🟠 **`PUT /api/tasks/:id` `name: ""` overwrites.** `??` semantics vs intended `||`. Empty-string survives where it shouldn't.
- 🟠 **`DELETE /api/tasks/:id` returns 200 for unknown ids** — inconsistent with GET/PUT, which return 404.
- 🟠 **`Math.min(NaN, 200)` lets bad `?limit=`** through `/api/lessons` unclamped.
- 🟠 **`/api/blocks/compile` has no input length cap** and no injection-resistant framing — user free text is interpolated directly into the user message. The shape sanitiser + editor-review-before-execute is the only defence.
- 🟠 **`statusMap`/`runningBlockId` not propagated into `for_each.body`** — inner blocks never show running/done state during a run.
- 🟠 **`goal.max_steps`** in the schema but no UI input — silent server-only field.
- 🟠 **`BlockBody` switch has no `default`** — unknown `kind` renders empty and likely throws on `meta.color` lookup.
- 🟡 **No SSE auto-reconnect.** `EventSource.onerror` closes; no `Last-Event-ID`. Reconnect after network blip would either fail or duplicate entries (no idempotent identity).
- 🟡 **`alert()`/`confirm()`** for action errors throughout the UI.
- 🟡 **`web/src/blocks.ts::newBlock`** falls back to non-UUID IDs when `crypto.randomUUID` unavailable. Server validation tolerates it; equality checks across run boundaries don't.
- 🟡 **`RunView` entries unbounded** — at hundreds of events per run, no virtualisation. Memory grows linearly.
- 🟡 **Drag-drop cannot cross `for_each` boundaries** — separate `dragId` state per recursion level.
- 🟠 **`addLesson` non-transactional** — `lessons` + `lessons_fts` writes can desync on crash between them.
- 🟠 **Two diverging text-extraction walkers** — `read_text` applies 8 strip rules; `fetch_url` omits font-size, bounding-box, and colour-camouflage checks. Same hostile-content surface, different filter.
- 🟠 **`wait_for` resolves on `state: "attached"`, not visible** — model can get a "present" signal for an invisible element.
- 🟠 **`select_option` description lies** — schema says "option text or value"; Playwright matches value/label/text in priority order. Cross-language sites get inconsistent results.
- 🟠 **Visibility check inconsistency.** `formScan` does `parseFloat(opacity) === 0`; `loginDetect` does string `!== "0"` (misses `"0.0"`). Should consolidate in one helper.
- 🟡 **DOM mutation side effects.** `snapshot` and `scanForm` write `data-tickle-id` into the live page and never revert. SPAs that re-render could clobber tags before `act` runs; stale tags persist across snapshots.
- 🟡 **Snapshot doesn't filter `aria-hidden="true"`** — accessibility-equivalence gap; could surface visually-decorative-but-DOM-active elements.
- 🟡 **`substituteVars(undefined)`** produces literal string `"undefined"` (not an error, not empty).

### Misplaced code (resolves with refactor)

- 🟠 **`chatWithRetry` lives in `agent.ts:31-74`** — pure infrastructure trapped in the orchestration layer. `_LAYERS.md` already targets `infrastructure/llm/chatWithRetry.ts`.
- 🟠 **`EndEvent` shape duplicated** between `bus.ts` and `routes/runs.ts` — hoist to `domain/run.ts`.
- 🟠 **Frontend domain duplication** — `web/src/blocks.ts` mirrors `server/src/blocks.ts` (types, `newBlock`, defaults). Post-refactor: shared `domain/`.
- 🟠 **`SseEvent` union duplicated four ways** — emitted by `agent.ts`, carried by `bus.ts`, persisted by `db.ts` (`Step["kind"]`), consumed by `RunView.tsx`. All four lists differ from each other.
- 🟠 **`parseSqliteUtc` duplicated** — `RunView.tsx:570` and `App.tsx::runDuration`. The CLAUDE.md "canonical normaliser" doesn't actually have a canonical location.
- 🟠 **`VALID_MODELS` duplicated** — `routes/settings.ts` and `web/src/components/SettingsPage.tsx`.
- 🟠 **Two diverging text walkers** in `tools.ts` (already listed under bugs) — same root cause as the duplications above.
- 🟠 **EventSource lives in `RunView.tsx`, not in a hook.** `_LAYERS.md` calls for `state/useRunStream.ts`.
- 🟡 **`api.deleteTask`** typed `Promise<unknown>` while sibling deletes are typed `Promise<{ ok: true }>`.

### Cross-platform / correctness

- 🟠 **`PROFILE_DIR = "data/profile"` and `SHOTS_DIR = "screenshots"` are CWD-relative.** Only resolve correctly when launched from `server/`. Anchor with `import.meta.url` or env var.
- 🟠 **`loadEnv` cwd-relative** — silently no-ops if launched from anywhere other than `server/`.
- 🟠 **`loadEnv` non-ENOENT errors crash startup** with no friendly message.

### Security

- 🔴 **`log.ts` — no secret redaction.** `trace()` spreads `ctx` verbatim; user `fill` values and extracted page text already on disk. Future caller could log API keys/cookies/auth headers without warning. Add a denylist (`apiKey`, `authorization`, `cookie`, `password`, `token`) + `LOG_REDACT` env var.
- 🟠 **`runs.status` has no CHECK constraint** — any string accepted, type guarantee is at the application layer only.

### Concurrency / consistency

- 🟠 **`bus.ts` replay/subscribe race.** Window between SQLite replay read and live subscriber registration can drop events. Capture a cursor before replay or buffer during replay.
- 🟡 **`bus.ts` empty `Set` leak** when all subscribers unsubscribe before `endTopic`.

### Process / migration

- 🟠 **One-shot ALTER migration won't scale.** `db.ts` uses `PRAGMA table_info` then `ALTER` — no migration framework, no version table. The next schema change needs a real story.

### Bookkeeping

- ✅ **`pause.ts` / `cancel.ts` — index naming.** Resolved: split into `-pause` and `-cancel` specs.
