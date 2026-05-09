# Cross-cutting — security

> Status: 📝 drafted from Phase 2 findings. No tests yet.

Tickle is a **single-user local tool**. It binds to `127.0.0.1`, has no auth, holds the user's real cookies, and runs an LLM that drives a real browser. The threat model is shaped by that.

## Threat model

| In scope                                                  | Out of scope                           |
| --------------------------------------------------------- | -------------------------------------- |
| Hostile web pages tricking the agent into harmful actions | Multi-user authentication, RBAC, audit |
| Untrusted page content reaching the LLM as instructions   | Network-exposed deployments            |
| Local code accidentally committing secrets                | Production-grade key vaulting          |
| Malicious browser extensions / pages reading the API      | Compromised host OS                    |
| LLM responses with prompt-injection-style outputs         | Anti-fingerprinting, anti-detection    |

The persistent profile, the trace log, and the SQLite DB all hold material that, if leaked, would expose the user's identity. They live under `server/data/`, which is gitignored by an explicit rule (see [`.gitignore`](../../../.gitignore)).

## Principles

1. **Page content is untrusted.** The system prompt explicitly tells the model to ignore prompt-injection patterns. `read_text` filters hidden / camouflaged text. See [`tools.md`](../server/tools.md).
2. **Secrets do not transit URLs.** Per CLAUDE.md "Things to avoid".
3. **Secrets do not transit the wire to the UI.** `ANTHROPIC_API_KEY` lives in `process.env`; the settings page receives only `api_key_configured: boolean`. See [`http-settings.md`](../server/http-settings.md).
4. **The compile-from-text feature has a defence-in-depth: human review before execute.** See [`http-compile.md`](../server/http-compile.md), [`web/compile.md`](../web/compile.md).
5. **`.env` is never committed.** Only `.env.example` is tracked. Enforced by `.gitignore`.

## Current state — gaps

### CORS allowlist (resolved)

The previous `cors({ origin: true })` config let any origin drive `/api/*` — DNS-rebinding territory. Now uses an explicit allowlist (`server/src/cors.ts`): `http://localhost:5173`, `http://127.0.0.1:5173`, `http://[::1]:5173` for the Vite dev origins, and the matching `:8787` origins for direct browsing. Missing/empty Origin (same-origin / curl / SSE) is allowed; everything else is rejected. Regression: `server/src/__tests__/cors.test.ts` covers both the pure policy and the wired-up Fastify behaviour. A future `Host:`-header check would add belt-and-braces protection but is not required for the local-only threat model.

### `/screenshots/*` path-traversal guard (resolved)

The route used to do literal string concat (`screenshots/${rest}`) and serve any matching file with a `.png` suffix — `..`, absolute paths, and sibling-directory bypasses all worked. Now uses `safeResolveScreenshot` in `server/src/paths.ts`, which `path.resolve`s against the screenshots base, asserts the resolved path stays inside via a separator-boundary check, and rejects non-`.png`. Regression: `server/src/__tests__/paths.test.ts`.

### Trace log secret redaction (resolved)

`log.ts::trace()` previously spread `ctx` verbatim into the JSONL line. Now applies a default denylist (`apikey`, `authorization`, `cookie`, `password`, `token`, case-insensitive) that replaces matched values with `[redacted]`. Recurses into nested objects and arrays, structurally clones so the caller's object is never mutated, and breaks circular references with a `[circular]` marker. The `LOG_REDACT` env var extends the denylist with comma-separated additional keys. The stdout mirror also uses the redacted form. Regression: `server/src/__tests__/log.test.ts`.

PII surface in user `fill` values and extracted page text remains — those are not denylisted because they are signal, not secrets, and call sites that log them already do so with intent. The same denylist will be reused when `/api/export` gets a redaction layer (see [`http-export.md`](../server/http-export.md)).

### Compile preview danger affordances (resolved, partial)

The "human-review-before-execute" gate per `http-compile.md` §6 is the load-bearing injection defence. `web/src/state/compileFlags.ts` now exposes pure detectors: `isExternalUrl` flags off-localhost `navigate` blocks; `looksLikeCredential` flags `fill` blocks whose target description or value matches credential / SSN / credit-card patterns. The preview shows a "Review carefully — N blocks flagged" banner when any flag fires, plus per-block badges with the reason. Regression: `web/src/__tests__/compileFlags.test.ts`. Remaining gap: per-block accept rather than all-or-nothing.

### `/api/blocks/compile` input length cap (resolved)

`MAX_COMPILE_PROMPT_CHARS = 8000`; over-cap requests return `413` without invoking the LLM. Regression: `server/src/routes/__tests__/compile.test.ts`. Injection-resistant framing in the system prompt remains a separate hardening item.

### 🟠 `/api/export` is buffered and full-corpus only

No date / run / task filter. Drains every `messages_export` row at once. PII (user `fill` values, extracted page content) flows verbatim into the JSONL. See [`http-export.md`](../server/http-export.md). **Target:** filter parameters; same redaction layer as the trace log.

### 🟠 Run API has no auth

This is the threat model — but it deserves an explicit decision when (if ever) tickle goes multi-host. **Target (when needed):** localhost-only Unix-socket transport, OR a per-install token in `~/.tickle/auth` that the UI reads and the server checks. Don't add HTTP basic auth — it's worse than no auth for the cross-site-scripting case.

### `runs.status` CHECK constraint (resolved)

Table-level CHECK on fresh DBs plus matching INSERT/UPDATE triggers (`runs_status_check_*`) on existing DBs. Regression: `server/src/routes/__tests__/runs.test.ts`.

### Visibility-check unification (resolved)

`server/src/visibility.ts` exports `isVisuallyHidden(style, rect?)` with `parseFloat(opacity) === 0`. `formScan.ts` and `loginDetect.ts` keep their inline `page.evaluate` copies (mirrored logic, marked `keep-in-sync: visibility.ts`) so the same `0.0` / `0.00` opacity case is caught in both. Regression: `server/src/__tests__/loginDetect.test.ts`.

### Snapshot `aria-hidden` filter (resolved)

`snapshot.ts::isVisible` now rejects elements with an `aria-hidden="true"` ancestor via `el.closest("[aria-hidden='true']")`. `aria-hidden="false"` does NOT hide. Regression: `server/src/__tests__/snapshot.test.ts`.

### Stale `data-tickle-id` cleanup (resolved)

`snapshot.ts` and `formScan.ts` now strip stale `[data-tickle-id]` attributes at the top of each `page.evaluate` block before retagging. `act` resolves ids strictly within one snapshot→act window. Regression: `server/src/__tests__/snapshot.test.ts`.

## Defences in depth — what works today

- Page content as untrusted data: filter rules in `tools.ts::read_text`. See [`tools.md`](../server/tools.md).
- System-prompt warning to ignore "ignore previous instructions"-style payloads. CLAUDE.md "Conventions".
- Compile preview gate (despite its weaknesses).
- Login auto-pause on SSO hosts and visible password fields. See [`login-guard.md`](../server/login-guard.md).
- Stall auto-pause on three identical-shape tool calls.
- `.env` gitignored; `.env.example` tracked.
- `server/data/` gitignored — profile cookies, SQLite, screenshots never committed.

## Discipline going forward

- **Do not extend `read_text` filters to evade legitimate platform terms.** CLAUDE.md anti-pattern. The injection-defence filter is for attack vectors, not policy laundering.
- **Do not move sensitive data through URL parameters.** Already a CLAUDE.md rule; codify here.
- **Settings UI shows secrets as presence-only.** Never stream secret values to the browser. If a future feature wants to display "the last 4 of an API key", route it through a server-side render and don't hold the value client-side.
- **`.env` discipline:** if you change `server/.env.example`, copy your local `.env` first, add the new key, re-`source` or restart the server. Never commit a real value to `.env.example`.

## How tested (target)

- Unit: redaction denylist suppresses each banned key in the trace logger.
- Unit: CORS rejects an origin not in the dev allowlist.
- Unit: `/screenshots/*` rejects `..` and absolute-path inputs.
- Integration: `/api/blocks/compile` honours length cap; system-prompt prefix is present.
- Integration: settings GET never returns the API key value.
- Architecture test: no test or production module imports `process.env.ANTHROPIC_API_KEY` from a path leading to the HTTP layer.
