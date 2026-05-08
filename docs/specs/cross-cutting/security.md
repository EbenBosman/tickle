# Cross-cutting — security

> Status: 📝 drafted from Phase 2 findings. No tests yet.

Tickle is a **single-user local tool**. It binds to `127.0.0.1`, has no auth, holds the user's real cookies, and runs an LLM that drives a real browser. The threat model is shaped by that.

## Threat model

| In scope                                                       | Out of scope                                                  |
|----------------------------------------------------------------|----------------------------------------------------------------|
| Hostile web pages tricking the agent into harmful actions      | Multi-user authentication, RBAC, audit                         |
| Untrusted page content reaching the LLM as instructions        | Network-exposed deployments                                    |
| Local code accidentally committing secrets                     | Production-grade key vaulting                                  |
| Malicious browser extensions / pages reading the API           | Compromised host OS                                            |
| LLM responses with prompt-injection-style outputs              | Anti-fingerprinting, anti-detection                            |

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

### 🔴 `/screenshots/*` has no path-traversal guard

Literal string concat with only `.png` suffix filter. Local-only context, but trivial to fix and the kind of thing that gets re-read months later as "wait, really?". See [`http-runs.md`](../server/http-runs.md). **Target:** `path.resolve` against `SHOTS_DIR`, reject anything escaping.

### 🔴 Trace log has no secret redaction

`log.ts::trace()` spreads `ctx` verbatim. Today's call sites are clean, but the next caller could log an API key without warning. User `fill` values and extracted page text already on disk. See [`observability-log.md`](../server/observability-log.md). **Target:** denylist + `LOG_REDACT` env var, per [observability cross-cut](./observability.md).

### 🟠 Compile preview has no danger affordances

The "human-review-before-execute" gate per `http-compile.md` §6 is the load-bearing injection defence. But `CompileFromText.tsx` shows blocks as plain `kind` + summary — a `navigate evil.com` looks identical to a `navigate google.com`. Review becomes a rubber stamp. See [`web/compile.md`](../web/compile.md). **Target:** off-host-navigate banner, credential-pattern flag (looks-like-an-email-address-in-a-`fill`-value), per-block accept rather than all-or-nothing.

### 🟠 `/api/blocks/compile` has no input length cap

User free text interpolated directly into the user message. No injection-resistant framing in the system prompt. The shape sanitiser is the only server-side defence. See [`http-compile.md`](../server/http-compile.md). **Target:** length cap on `prompt`; system prompt prefix instructing the model to treat the input as data.

### 🟠 `/api/export` is buffered and full-corpus only

No date / run / task filter. Drains every `messages_export` row at once. PII (user `fill` values, extracted page content) flows verbatim into the JSONL. See [`http-export.md`](../server/http-export.md). **Target:** filter parameters; same redaction layer as the trace log.

### 🟠 Run API has no auth

This is the threat model — but it deserves an explicit decision when (if ever) tickle goes multi-host. **Target (when needed):** localhost-only Unix-socket transport, OR a per-install token in `~/.tickle/auth` that the UI reads and the server checks. Don't add HTTP basic auth — it's worse than no auth for the cross-site-scripting case.

### 🟡 `runs.status` has no CHECK constraint

A bug elsewhere could persist arbitrary strings. Not exploitable, but the schema should refuse. See [`persistence.md`](../server/persistence.md). **Target:** `CHECK (status IN ('running', 'done', 'error', 'cancelled'))`.

### 🟡 Visibility-check inconsistency between `loginDetect` and `formScan`

`loginDetect` does string `opacity !== "0"` (misses `"0.0"`); `formScan` does `parseFloat(opacity) === 0`. False negatives in `loginDetect` mean an actual login surface might not auto-pause. Low likelihood but security-flavoured. **Target:** consolidate visibility checks into one helper in `infrastructure/browser/visibility.ts`. See [`login-guard.md`](../server/login-guard.md), [`form-scan.md`](../server/form-scan.md).

### 🟡 Snapshot doesn't filter `aria-hidden="true"`

Could surface visually-decorative-but-DOM-active elements. Combined with the visibility-check inconsistency above. See [`snapshot.md`](../server/snapshot.md).

### 🟡 Stale `data-tickle-id` tags persist across snapshots

A buggy caller passing a stale id to `act` could match the wrong element. Today defended by the executor's re-snapshot discipline. Trust-but-verify. See [`snapshot.md`](../server/snapshot.md).

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
