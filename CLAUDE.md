# CLAUDE.md

Local AI browser-agent. Talks to any OpenAI-compatible LLM server (LM Studio, Ollama via /v1, vLLM, SGLang, llama.cpp). Default config is `qwen3.6-27b-uncensored-hauhaucs-balanced` against LM Studio at `http://127.0.0.1:1234/v1`. Drives a real headed Chromium via Playwright to complete user tasks defined as ordered "blocks." React + Tailwind UI; Node + Fastify + SQLite (`node:sqlite`) backend. Persists tasks, runs, and per-step traces.

**Single-user, local-only.** No auth, persistent profile holds real cookies, LLM is on the same box. Don't expose this to the network.

**OS-agnostic.** Developed on Windows (RTX 4080, 16 GB VRAM); primary deployment target is a Mac mini (Apple Silicon); Linux is also supported. Anything OS-specific is called out where it appears. Use repo-relative paths everywhere — never bake `D:\…` or `/Users/…` into specs, scripts, or commits.

## How we work here (spec-driven + TDD)

Read this section before changing code. Full workflow lives in [`.claude/skills/spec-driven/SKILL.md`](.claude/skills/spec-driven/SKILL.md) and [`.claude/skills/tdd/SKILL.md`](.claude/skills/tdd/SKILL.md).

1. **Spec first.** Every module has a contract at `docs/specs/<module>.md`. Read it before editing. If it doesn't exist, run `/spec <module>` to author one against current behaviour. If it exists but is stale, update it. The spec is the source of truth — code follows it.
2. **Test second.** Run `/tdd <module>` to drive change red→green→refactor. No production code without a failing test first; no test without a spec claim it maps to.
3. **Layer discipline.** Code lives in [`docs/specs/_LAYERS.md`](docs/specs/_LAYERS.md) layers: server is `domain → application → infrastructure → interface`; web is `domain → state → ui → features`. Dependencies point inward. A `domain/` file importing Playwright is a violation, full stop.
4. **God files are bugs.** If a file passes ~300 lines or mixes concerns, it gets broken up via `/refactor-module <path>`. Refactors preserve behaviour and run against existing tests.
5. **Helper subagents.** `spec-writer`, `test-writer`, and `refactor-reviewer` are defined in [`.claude/agents/`](.claude/agents/). Hand off context-heavy work to them rather than doing it inline.

Until Phase 2 lands the per-module specs, treat the module-by-module section below as the working contract. As specs are authored, they supersede this file for their module.

## Commands

```bash
npm run install:all         # first-run: root + server + web
npx playwright install chromium   # once
npm run dev                 # both, with [server] / [web] prefixes; Ctrl+C kills both
npm run dev:server          # only Fastify (http://127.0.0.1:8787)
npm run dev:web             # only Vite (http://localhost:5173)
```

Env vars (`server/.env.example`):

- `LLM_BASE_URL` (default `http://127.0.0.1:1234/v1` — LM Studio). Point at Ollama with `http://127.0.0.1:11434/v1`, or any other OpenAI-compatible `/v1` endpoint.
- `LLM_MODEL` (default `qwen3.6-27b-uncensored-hauhaucs-balanced`). Whatever name the LLM server reports for the loaded model. The default is an abliterated qwen3.6-27b — uncensored variants follow page-content instructions (forms, refusals, banners) without an extra policy layer on top of the locally running model.
- `LLM_API_KEY` (default `not-needed`) — most local servers ignore this but the OpenAI client requires _something_.
- `HEADED` (default `true`), `MAX_AGENT_STEPS`, `KEEP_RECENT_IMAGES` round out the agent config.
- `TICKLE_PROFILE_DIR`, `TICKLE_SHOTS_DIR`, `TICKLE_DB_PATH` — override on-disk locations of the persistent Chromium profile, screenshot files, and SQLite database. Absolute pass through; relative paths resolve against `server/`.
- `LOG_REDACT` — comma-separated extra keys to add to the trace-log redaction denylist (default already covers `apikey`, `authorization`, `cookie`, `password`, `token`).

Thinking mode is already wired: `chat_template_kwargs.enable_thinking: false` is passed on stateless atomic steps (extract, verify, per-question answer in questionnaire) where chain-of-thought is wasted latency. `runAiSubGoal` (multi-turn goal/click/fill blocks) leaves thinking on because planning benefits from it. The flag is recognised by Qwen3.x running under LM Studio or Ollama's /v1 endpoint; ignored by other backends.

### Hardware

Tested:

- Windows / RTX 4080 (16 GB VRAM) — 27B at Q3_K_M / Q4_K_S fits cleanly; Q4_K_M needs partial CPU offload, especially with a long context.
- Mac mini (Apple Silicon) — primary deployment target. Unified-memory budget governs quant size; aim to leave 4–8 GB for the OS + Chromium.
- Linux — same VRAM rules as Windows; vLLM is the speed option once configured.

If the agent feels sluggish, check whether the model is partially on CPU. If it's swapping to disk, drop a quant. The agent is screenshot-heavy, so vision throughput matters as much as text speed.

## Architecture

### Block-based execution

Tasks are an ordered array of typed **blocks** (not free text). Each block has a `kind`, `params`, and an optional `pauseAfter` breakpoint flag. The executor walks them sequentially; each block reports `pending → running → done | failed | skipped`.

Block kinds (see `server/src/blocks.ts`):

- **`navigate`** — direct Playwright `page.goto`. No LLM.
- **`pause`** — explicit human-in-loop checkpoint.
- **`goal`** / **`click`** / **`fill`** / **`extract`** / **`verify`** — AI sub-tasks. Each invokes a focused sub-agent loop with a tightly scoped system prompt and the `finish_step` tool. `extract` writes to a variable the executor stores in a per-run `Map<string, unknown>`. `verify` evaluates a natural-language condition; on failure it either halts the run or auto-pauses (per `on_fail`).
- **`questionnaire`** — deterministic form-walk variant. Scans inputs via `formScan.ts`, asks the model one stateless answer per question (thinking off), writes unanswered questions to a variable.
- **`for_each`** — iterates over a `$varname` array, sets `$item`, recurses into nested `body` blocks.

`$varname` substitution happens via `substituteVars()` on string params before each block executes. `for_each.items` is special-cased (not substituted; either `$name` or literal JSON array).

### Sub-agent loop (per AI block)

`runAiSubGoal` in `server/src/agent.ts`. The model gets:

- `snapshot()` — labelled list of visible interactive elements (each tagged `data-tickle-id="N"`) + screenshot. See `server/src/snapshot.ts`. Defaults to viewport-only on dense pages (>50 elements).
- `act(id, action, value?)` — click/fill/press/check/uncheck/hover/select_option on an element from the most recent snapshot.
- `navigate`, `read_text`, `scroll`, `wait_for`, `screenshot`, `press_key`.
- **`finish_step(success, output?, note?)`** — virtual tool the executor handles directly; ends the sub-loop.

After every `navigate`/`act` the executor auto-takes a fresh snapshot and attaches it to the tool result, so the model always sees post-action state without asking. Image pruning keeps only the last `KEEP_RECENT_IMAGES` (default 3) screenshots' image data on each chat call; older messages keep their text.

### Persistent browser

One shared Chromium profile at `server/data/profile/` via `chromium.launchPersistentContext`. Cookies, localStorage, IndexedDB, passkey credentials all survive across runs and server restarts. Each run gets a fresh tab, never closes the context. Headed by default with `--start-maximized`; `viewport: null` so the page reflows when the user resizes the window.

A small `addInitScript` polyfills `__name` / `__publicField` in the page world — without it, `page.evaluate` callbacks compiled by tsx/esbuild throw `ReferenceError: __name`.

### Claude rescue

When a local-model run fails or the user requests rescue, the executor can re-attempt the failing block under a more capable Claude model (`claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`, configured via the settings page). Gated by `rescue_enabled` and `rescue_on_cancel` in the `settings` table; requires `ANTHROPIC_API_KEY` in env. The rescue outcome is merged with the local outcome via a single `block_end` emission (see `server/src/blockOutcome.ts::mergeRescuedOutcome`). When a rescue produces a different outcome than the local attempt, the messages exchanged are persisted as a `messages_export` step row for later DPO export.

### Lessons

`lessons` table + FTS5 index (`lessons_fts`). Populated by `addLesson(runId, blockId, lesson, situation)` calls from the rescue path or from explicit "remember this" tool invocations. Surfaces in the settings page lesson list; consulted by future runs as additional system-prompt context. `searchLessons(query)` does FTS5 match with recency fallback.

### Training-data export

`GET /api/export` streams JSONL of `messages_export` step payloads. Optional `?status=rescued` filters to runs the rescue actually changed. Used to bootstrap DPO datasets from the rescue corpus.

### Guardrails

- **Login auto-pause** (`server/src/loginDetect.ts`) — known SSO hosts (Google, Microsoft, Okta, Auth0, Apple, Atlassian, Yahoo, GitHub `/login`, LinkedIn, X / twitter.com, Facebook), visible password fields, webauthn/one-time-code inputs, "Use your passkey" text. One-shot per run.
- **Stall auto-pause** — three identical-shape tool calls in a row. One-shot per run.
- **LLM retry with backoff** — `chatWithRetry` (in `server/src/infrastructure/llm/`) retries transient errors (`fetch failed`, `ECONN*`, `ETIMEDOUT`, `socket hang up`) at 1.5s and 4s; cancellation is honoured between attempts.
- **Pause / Resume / Cancel** are first-class: `server/src/pause.ts` and `cancel.ts`. Cancel calls `client.abort()` to interrupt the in-flight LLM request (LM Studio / Ollama / whatever is wired via `LLM_BASE_URL`) and resumes any pause-waiter so the loop can observe the cancellation.

### Storage

SQLite at `server/data/tickle.db` via `node:sqlite` (built into Node ≥22.5; stable in 24+). No native compile.

- `tasks(id, name, instruction, steps, created_at)` — `steps` is JSON array of blocks. Lazy migration: tasks with `steps IS NULL` are populated from `instruction` on first GET (`ensureSteps` in `server/src/routes/tasks.ts`).
- `runs(id, task_id, status, result, error, started_at, finished_at)` — `status` ∈ `running | done | error | cancelled`.
- `steps(id, run_id, idx, kind, payload, screenshot_path, created_at)` — persisted event log. `kind` ∈ `thought | tool_call | tool_result | block_start | block_end | var_set | remember | error | final | page_state | stats | messages_export`. Used for live SSE replay. Note: `paused`, `resumed`, `end` are emitted live to the bus only and not persisted — they're reconstructable from the run row + the in-process pause registry, so a reconnecting client doesn't lose state.
- `settings(key, value)` — small KV table for the rescue toggles and model choice; seeded with defaults on first run.
- `lessons(id, run_id, block_id, lesson, situation, created_at)` + `lessons_fts` virtual table — see Lessons section above.

SQLite stores `datetime('now')` as UTC space-separated; the frontend's `parseSqliteUtc` normalises it before computing elapsed times.

### SSE event stream

`GET /api/runs/:id/stream` replays existing steps then subscribes via `server/src/bus.ts`. Event kinds: `thought`, `tool_call`, `tool_result`, `block_start`, `block_end`, `var_set`, `remember`, `page_state`, `stats`, `paused`, `resumed`, `error`, `final`, `end`. Each carries a `block_id` where applicable. The `domain/run.ts::StepKind` and `LIVE_ONLY_KINDS` unions are the single source of truth — `bus.ts`, `db.ts`, and `agent.ts` all consume them.

### Trace log

`server/data/tickle.log` is JSONL, rotated to `.log.1` at 5MB. Mirrored to stdout in compact form. Tail with `Get-Content -Wait`.

## Layout

```
server/
  src/
    index.ts            Fastify bootstrap, CORS, /api/health
    db.ts               SQLite open + zombie-running sweep + typed row helpers (schema lives in migrations/)
    blocks.ts           Block types, factory, $var substitution, walkers
    agent.ts            runAgent → executeBlocks → executeBlock → runAiSubGoal / runStatelessStep / runQuestionnaireBlock
    blockOutcome.ts     mergeRescuedOutcome: single-emit block_end semantics across local + Claude rescue
    snapshot.ts         takeSnapshot: DOM walk, role inference, accessible name, viewport-only default
    formScan.ts         Deterministic form-input walk (form-scoped, exclusion of nav/header/<a>); checkQuestionAnswered
    visibility.ts       isVisuallyHidden — shared helper, with mirrored copies inside formScan/loginDetect page.evaluate blocks
    tools.ts            toolDefs + executeTool (snapshot, act, navigate, read_text, scroll, wait_for, press_key, screenshot, fetch_url). The agent loop appends finish_step at runtime.
    browser.ts          Persistent Chromium context, __name polyfill, screenshot helper
    llm.ts              OpenAI-compatible client + chatOnce wrapper (handles tool-call format, image attachments, thinking-mode toggle, AbortSignal cancellation)
    cancel.ts           per-run cancellation registry
    pause.ts            per-run pause registry with awaitable resume
    loginDetect.ts      auto-pause heuristics
    log.ts              JSONL trace + rotation + redaction (apikey/authorization/cookie/password/token; LOG_REDACT extends)
    bus.ts              SSE pub-sub per run
    cors.ts             Fastify CORS allowlist (localhost dev origins only)
    errors.ts           errorMessageFromThrow — normalises Error / string / unknown / circular shapes
    paths.ts            safeResolveScreenshot path-traversal guard
    coerce.ts           query-param helpers (positive-finite numbers, etc.)
    domain/             Pure types: run.ts (StepKind / EndEvent / LIVE_ONLY_KINDS), models.ts (rescue model allowlist + isValidModel guard)
    infrastructure/
      llm/
        chatWithRetry.ts   chatWithRetry + RETRY_BACKOFFS_MS + isTransientLLMError + ChatRequest type
    migrations/         Versioned, idempotent schema migrations recorded in schema_versions
    paths/
      storage.ts        PROFILE_DIR / SHOTS_DIR — module-anchored via import.meta.url; TICKLE_PROFILE_DIR / TICKLE_SHOTS_DIR override (TICKLE_DB_PATH lives next to the DB open in db.ts)
    routes/
      tasks.ts          CRUD + lazy steps migration
      runs.ts           start (with single-run 409), cancel, pause, resume, delete, clear, /stream (SSE), /screenshots/*
      compile.ts        POST /api/blocks/compile — prose to typed Block[] via the LLM (8000-char input cap → 413)
      settings.ts       GET/PUT /api/settings; GET/DELETE /api/lessons (limit / offset clamped)
      export.ts         GET /api/export — JSONL training-data dump from messages_export rows

web/
  src/
    main.tsx, App.tsx, index.css
    api.ts              fetch helpers + Task/Run/Step types (Step.kind tracks server StepKind)
    blocks.ts           Block types matching server, kind metadata (icon, color), v4-shaped UUID fallback
    state/
      useRunStream.ts   EventSource lifecycle + entry/page-state/memory/paused/started/finished state
      parseSqliteUtc.ts parseSqliteUtc + formatDuration + runDuration
      compileFlags.ts   isExternalUrl + looksLikeCredential — drives the compile-preview review banner
    components/
      TaskList.tsx      left column
      TaskEditor.tsx    middle column — name + BlockList
      BlockList.tsx     drag-drop reorderable typed-block editor (recurses for for_each); cross-for_each drag via DragCtx + moveBlockInTree
      RunView.tsx       right column — consumes useRunStream; renders entry stream, page state, timer, pause banner
      StatusPill.tsx    status colour mapping (running/paused/done/error/cancelled)
      UiPrompts.tsx     toast + confirm provider; replaces window.alert / window.confirm
```

## Conventions

- **TypeScript everywhere**, run via `tsx watch` server-side; no build step in dev.
- Tailwind v4 — utilities only, no CSS-in-JS.
- Server-side strict TypeScript (`server/tsconfig.json`); frontend less strict for ergonomics.
- Errors: tools return `{ ok: false, error }` rather than throwing where possible. The block executor catches throws and converts to `{ status: "failed", error }`.
- Cancellation is checked at every safe boundary: top of step loop, before each tool, between LLM retries.
- **Page content is untrusted data.** The system prompt explicitly tells the model to ignore prompt-injection patterns ("ignore previous instructions", etc.). `read_text` strips `<script>/<style>/<template>` and elements with hidden styling (display:none, visibility:hidden, opacity 0, font-size 0, zero bounding box, color matching background).

## Things to avoid

- **Do not add tools that filter site policy text** (e.g. "Do not use AI" banners). The injection-defense filtering covers attack vectors; do not extend it to evade legitimate platform terms.
- **Do not move sensitive data through URL parameters** — they leak in referer headers / server logs.
- **Do not change `node:sqlite` to `better-sqlite3`** without checking — Windows users without Visual Studio cannot compile the native binding under Node 25.
- **Do not re-introduce a runtime-specific LLM client.** `llm.ts` is OpenAI-compatible on purpose — it lets users swap between Ollama, LM Studio, vLLM, SGLang, etc. by env var. If you find yourself adding `import { Ollama }` or similar, stop and figure out how to do it through the `chatOnce` wrapper instead.
- **Do not write `:contains()` in selectors** — it's jQuery, not CSS, and Playwright will reject it. Use `getByText` / `getByRole` (already wrapped by `act`).
- **Do not add raw bare-chrome launch options that disable the persistent profile** without preserving user's saved login state. Profile lives at `server/data/profile/`.

## Tasks lifecycle

1. User creates a task in the editor, adds blocks, hits **Run**.
2. `POST /api/tasks/:id/run` inserts a `runs` row, returns `run_id`, kicks off `runAgent` async.
3. Frontend opens an `EventSource` to `/api/runs/:run_id/stream`. Server replays any persisted steps, then forwards live events from the in-process `bus.ts`.
4. Each block emits `block_start`, then the per-block subloop streams `thought`/`tool_call`/`tool_result`/`page_state`/`stats`, then `block_end`.
5. On `pauseAfter`, login detection, stall detection, or explicit `pause` block: the executor calls `pauseRun(runId)`, emits `paused`, and awaits via `awaitIfPaused`. The user resumes via `POST /api/runs/:id/resume`.
6. On finish: `final` then `end` event; runs row updated to `done | error | cancelled` with `finished_at`. Frontend timer freezes to the total.

## Quirks

- Vite 8 binds IPv6-only by default. Use `localhost`, not `127.0.0.1`, in the browser.
- Some OpenAI-compatible backends (Ollama, recent LM Studio builds) include extra fields like `prompt_eval_count`, `eval_count`, `eval_duration` (nanoseconds) on each chat response — surfaced as a `stats` SSE event for the footer's tok/s display. Backends that don't emit them just leave the footer blank.
- `node:sqlite` still emits `ExperimentalWarning` even though stable in Node 24+; harmless.
- The persistent context is shared across runs but only one run executes at a time. Multiple concurrent runs would compete for tabs and would need a per-run context.
