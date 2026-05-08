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
| Run lifecycle (top-level orchestration, today: `agent.ts`) | `server/agent.md` | ⛔ |
| Block model (`blocks.ts`, `$var` substitution, walkers) | `server/blocks.md` | ⛔ |
| AI sub-goal loop | `server/ai-subgoal-loop.md` | ⛔ |
| Snapshot pipeline (`snapshot.ts`) | `server/snapshot.md` | ⛔ |
| Form scan (`formScan.ts`) | `server/form-scan.md` | ⛔ |
| Tools (`tools.ts`, the model-facing tool surface) | `server/tools.md` | ⛔ |
| Browser adapter (`browser.ts`, persistent profile, `__name` polyfill) | `server/browser.md` | ⛔ |
| LLM client (`llm.ts`, OpenAI-compatible, retry, thinking-mode toggle) | `server/llm.md` | ⛔ |
| Persistence (`db.ts`, schema, lazy migrations) | `server/persistence.md` | ⛔ |
| Event bus + SSE stream | `server/events.md` | ⛔ |
| Login auto-pause (`loginDetect.ts`) | `server/login-guard.md` | ⛔ |
| Stall auto-pause | `server/stall-guard.md` | ⛔ |
| Pause / Resume / Cancel registries | `server/run-control.md` | ⛔ |
| JSONL trace logger (`log.ts`) | `server/observability.md` | ⛔ |
| HTTP routes (`routes/*.ts`) | `server/http-api.md` | ⛔ |

### Web

| Module | Spec | Status |
|--------|------|--------|
| App shell (`App.tsx`, routing, top-level layout) | `web/app-shell.md` | ⛔ |
| Run view (SSE consumer, timer, banners, entry stream) | `web/run-view.md` | ⛔ |
| Task editor + block list (drag-drop, kind metadata) | `web/task-editor.md` | ⛔ |
| Settings page | `web/settings.md` | ⛔ |
| Compile-from-text | `web/compile.md` | ⛔ |
| API client (`api.ts`) | `web/api-client.md` | ⛔ |
| Status pill, primitives | `web/ui-primitives.md` | ⛔ |

## Authoring a spec

Run `/spec <module-name>` in Claude Code, or use the **spec-writer** subagent. Both follow the same template (`_TEMPLATE.md`) and the same four-question structure.

## Cross-cutting concerns

These don't belong to one module but apply to all of them. Each gets its own short doc once we have something concrete to say.

- `cross-cutting/error-handling.md` — error class hierarchy, where errors are converted to user-facing strings, retry policy.
- `cross-cutting/observability.md` — what events get logged, what traces look like, how to correlate a run across logs / DB / SSE.
- `cross-cutting/security.md` — secrets handling, prompt-injection defence, page-content-as-untrusted-data, `.env` discipline.
- `cross-cutting/testing-strategy.md` — unit vs. integration vs. smoke; what is mocked at the boundary; the deterministic-tests rule.
