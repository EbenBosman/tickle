# Cross-cutting — error handling

> Status: 📝 drafted from Phase 2 findings. No tests yet.

## Principles

1. **Tools return `{ ok: false, error }`, they don't throw.** Per CLAUDE.md "Conventions" and confirmed in `server/src/tools.ts`. The block executor's outer `try/catch` is a backstop, not the primary path.
2. **The block executor catches throws and converts to `{ status: "failed", error }`.** No unhandled rejection should escape `executeBlock`.
3. **A run completes with exactly one of `done | error | cancelled` status.** Enforced in `runAgent` invariants (see [`server/agent.md`](../server/agent.md) §3 invariants).
4. **The HTTP layer translates server errors into status codes; routes never let exceptions escape Fastify handlers.**

## Current state — gaps

These come straight out of Phase 2 specs. Each is something the principles above demand and the current code doesn't deliver.

### Top-level rejection escape (resolved)

`server/src/routes/runs.ts` previously ran `runAgent` inside a fire-and-forget IIFE with no top-level catch. A throw out of `runAgent` (Playwright crash, SQLite write failure, LLM-client throw, etc.) propagated as an unhandled rejection and the `runs` row stayed at `running` forever.

The IIFE now wraps `runAgent` in `try/catch`, converts a throw into a synthetic `{ status: "error", error }` outcome via `errorMessageFromThrow` (`server/src/errors.ts`), traces a `run.unhandled_throw` event, and routes the outcome through the same finalisation path as a graceful return. An outer `.catch()` on the IIFE itself is the last-resort guard against a throw inside finalisation (e.g. DB unavailable) so process-level crashes are still impossible. Regression: `server/src/__tests__/errors.test.ts` covers the error-message normalisation; the IIFE shape is short enough to confirm by inspection.

### `tools.ts` `try/catch` swallows distinct error kinds

`executeTool` has a single outer `try/catch` that funnels every throw into `{ ok: false, error: String(e) }`. A network error from `fetch_url`, a Playwright timeout from `act`, and a bad `data-tickle-id` lookup all end up as the same string-shaped result. The agent can't tell whether a retry would help.

**Target:** structured error variants — `ToolError = { code: "timeout" | "selector_missing" | "network" | "blocked_by_navigation" | "unknown", message, retriable: boolean }`. The agent uses `retriable` to decide whether a retry tool call is worth offering.

### LLM retry classifier is too broad

`chatWithRetry` (now at `infrastructure/llm/chatWithRetry.ts`) matches `aborted by` in the transient-error regex — overlaps cancellation. Today defended by the `isCancelled()` ordering check, but it's a footgun. See [`server/llm-client.md`](../server/llm-client.md) drift notes.

**Target:** an explicit `TransientError` class thrown by `chatOnce` for known transient kinds; classifier checks `instanceof`, not stringly.

### Cancellation is a state, not an exception

`server/src/cancel.ts` (per its [spec](../server/run-control-cancel.md)) flips a flag and aborts the active controller. Callers check the flag at safe boundaries; if they don't, cancellation is observed only by the next `chatOnce` failing on the abort signal — which then surfaces as a transient error. Mixing "cancellation" and "error" on this path is the source of subtle bugs.

**Target:** every safe boundary throws a `RunCancelledError` once `isCancelled()` is true. The outer `runAgent` catches `RunCancelledError` specifically and finalises as `cancelled`. Anything else → `error`.

### Frontend `alert()` / `confirm()` (resolved)

`<UiPromptsProvider>` exposes `useUiPrompts()` with `toast.error/info/success` (auto-dismissing toasts) and `confirm({ destructive })` (styled modal, Promise-based, ESC = cancel, Enter / autofocus = confirm). All 16 alert / confirm call sites in `App.tsx`, `RunView.tsx`, `TaskList.tsx`, and `CompileFromText.tsx` migrated. Provider mounted in `main.tsx` above `<App>`.

### Lazy migration produces volatile UUIDs under concurrent GETs

`routes/tasks.ts::ensureSteps` regenerates and writes UUID-laden `Block` objects on every GET that finds `steps IS NULL` — concurrent first-GETs race and the persisted IDs depend on which write wins. Per [`server/http-tasks.md`](../server/http-tasks.md). The block-list editor relies on stable IDs for drag-drop.

**Target:** wrap migration in `BEGIN IMMEDIATE` so only one writer wins, others read the result.

### `addLesson` transactional (resolved)

The `lessons` + `lessons_fts` writes now run inside `BEGIN/COMMIT` with `ROLLBACK` on throw. Regression: `server/src/__tests__/db.lessons.test.ts`.

## Error class hierarchy (target)

```
domain/errors.ts
├── RunError            // base, abstract
│   ├── RunCancelledError
│   ├── RunPausedError  // (signal — not actually thrown today, candidate for unifying pause flow)
│   ├── LoginRequiredError
│   ├── StallDetectedError
│   ├── StepLimitExceededError
│   └── BlockExecutionError    // wraps a per-block failure
├── ToolError           // base, structured (code + retriable)
│   ├── SelectorMissingError
│   ├── NavigationBlockedError
│   ├── PlaywrightTimeoutError
│   └── FetchError
└── LlmError
    ├── TransientError  // retried by chatWithRetry
    ├── PermanentError  // 4xx from upstream, malformed responses
    └── ContextWindowError
```

`infrastructure/` constructs concrete errors; `application/` catches base classes; `interface/` translates to HTTP status / SSE `error` event.

## How tested (target)

- Unit: every error class has a smoke test that round-trips through `JSON.stringify` (logs/SSE) and back.
- Integration with mocked LLM: `chatWithRetry` retries on `TransientError`, surfaces `PermanentError`.
- Integration with mocked Page: each `ToolError` variant fires from a known scenario.
- E2E: a synthetic "run that throws" produces a terminal `error` row with the throw captured in trace.
