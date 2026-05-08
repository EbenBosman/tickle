# Spec — `loginDetect` (login guard)

> Path: `server/src/loginDetect.ts` · Layer: `application/` (target: `application/loginGuard.ts`) · Spec owner: `agent.ts` block executor (calls after every successful tool result; consumes `LoginDetection` to trigger auto-pause)

## 1. Why

The agent must never attempt to type passwords, complete MFA challenges, solve CAPTCHAs, or use the human's passkeys. When the live page is a login surface, control belongs to the human. The login guard is a cheap, run-time heuristic that inspects the current page and, if it concludes "this is a login," signals the executor to pause the run. The pause is **one-shot per run** because once the human resumes, the page is by definition no longer a login from the agent's perspective — re-firing on the same surface would deadlock.

> **Non-obvious why:**
> - Protects the **user** (no autonomous bot trying to log in as them, no leaked secrets in tool calls / traces / screenshots).
> - Protects the **run** (LLM tool-call budget is not burned flailing at unsolvable challenges like webauthn).
> - Heuristics over an allowlist + DOM probes are necessary because login surfaces are not standardised; this is intentionally fuzzy.
> - One-shot enforcement lives **upstream** in `agent.ts` (`ctx.loginAutoPaused`), not here. This module is stateless and re-entrant.

## 2. Public contract

### Exports

| Symbol               | Kind     | Signature / shape                                                                 | Stability |
|----------------------|----------|-----------------------------------------------------------------------------------|-----------|
| `detectLoginPrompt`  | function | `(page: Page) => Promise<LoginDetection>`                                         | stable    |
| `LoginDetection`     | type     | `{ detected: false } \| { detected: true; reason: string }`                       | stable    |

`Page` is a Playwright `Page`. The function:
- MUST NOT navigate, click, type, or otherwise mutate the page.
- MUST NOT throw under normal conditions (malformed URL, detached page, evaluate failure → returns `{ detected: false }` rather than throwing). *(see §6 — current code throws on `page.evaluate` failure.)*
- MUST be safe to call repeatedly within a single tick (idempotent, side-effect free).
- The `reason` string is human-readable; it is surfaced in the SSE `paused` event and is part of the user-visible UI. Format is **not** part of the stable contract — callers must not parse it.

### Errors

| Error             | Returned when                              | Caller should…                              |
|-------------------|--------------------------------------------|---------------------------------------------|
| (none)            | function returns `{detected:false}` instead | proceed normally                            |

### HTTP / SSE / IPC surface

None directly. Triggers a `paused` SSE event upstream in `agent.ts` when `detected: true`.

## 3. Invariants

Each is independently falsifiable.

1. **SSO host allowlist matches.** Navigation to any of the following hostnames (incl. subdomains) returns `detected: true`:
   - `accounts.google.com`
   - `login.live.com`, `login.microsoftonline.com`, `login.microsoft.com`
   - `okta.com`
   - `auth0.com`
   - `id.atlassian.com`
   - `appleid.apple.com`
   - `login.yahoo.com`
2. **SSO path allowlist matches.** On the following hosts, `detected: true` iff the URL path matches:
   - `github.com` → `/login`, `/sessions`, `/sign_in`
   - `linkedin.com` → `/login`, `/uas/login`, `/checkpoint`
   - `x.com` and `twitter.com` → `/i/flow/login`, `/login`
   - `facebook.com` → `/login`, `/checkpoint`
3. **Visible password field.** Any `<input type="password">` that is visible (non-zero bounding box, `display !== none`, `visibility !== hidden`, `opacity !== 0`) returns `detected: true` with reason "Password field detected".
4. **Visibility means visibility.** Hidden password inputs (`display:none`, `visibility:hidden`, `opacity:0`, zero-area bounding box, or off-DOM) MUST NOT trigger detection. False positives on hidden inputs would misfire on every site that has a stowed login modal.
5. **WebAuthn / OTP fields.** A visible `<input>` whose `autocomplete` attribute contains `webauthn` or `one-time-code` returns `detected: true`.
6. **Passkey text cues.** If `document.body.innerText` (truncated to ~4000 chars, lowercased) contains any of: `use your passkey`, `continue with passkey`, `sign in with passkey`, returns `detected: true`.
7. **Malformed URL is non-fatal.** If `new URL(page.url())` throws (e.g. `about:blank`, `chrome-error://`), the function returns `{ detected: false }` rather than throwing.
8. **No mutation of page state.** Calling the function does not click, focus, scroll, type, or trigger network requests.
9. **Stateless.** Two consecutive calls on the same page return the same answer. No caching, no per-run memo. (One-shot semantics live in `agent.ts`.)

## 4. How (briefly)

Three-stage cascade, cheapest first, returns on first hit:

1. **URL host check** — parse `page.url()`, test hostname against `KNOWN_LOGIN_HOSTS` regex list (suffix-anchored, case-insensitive).
2. **URL host + path check** — for sites where the bare host isn't dispositive (the user's ordinary GitHub browsing isn't a login), pair host with a path regex.
3. **DOM probe** — single `page.evaluate` round trip:
   - Find a visible `input[type=password]` (visibility computed in-page from `getBoundingClientRect` + `getComputedStyle`).
   - Else find a visible `input[autocomplete*="webauthn"]` or `input[autocomplete*="one-time-code"]`.
   - Else search the first ~4000 chars of `body.innerText` (lowercased) for fixed passkey phrases.

**Trade-off:** the text-cue stage is a deliberately fuzzy heuristic. False positives are tolerable (the human can resume); silent false negatives are worse (the agent flails at a passkey prompt and may type into a password field). Stages 1 and 2 are high-precision; stage 3 is a safety net.

**Key dependencies:** Playwright `Page` only. No DB, no LLM, no network.

**Persistence / mutable state:** none.

**Concurrency:** safe for concurrent calls per `Page`; the executor today calls it serially, after each tool result.

## 5. How tested

| Spec section / claim                            | Test file | Test name | Status |
|-------------------------------------------------|-----------|-----------|--------|
| §3.1 each SSO host triggers detection           | —         | —         | TODO(test) |
| §3.2 each path-gated host triggers only on login paths | — | —         | TODO(test) |
| §3.2 path-gated host on non-login path returns `{detected:false}` | — | — | TODO(test) |
| §3.3 visible `<input type=password>` triggers   | —         | —         | TODO(test) |
| §3.4 hidden password input does NOT trigger (display:none, visibility:hidden, opacity:0, zero-rect, offscreen-non-rendered) | — | — | TODO(test) |
| §3.5 webauthn / one-time-code autocomplete triggers when visible, not when hidden | — | — | TODO(test) |
| §3.6 each passkey phrase triggers; benign text doesn't | — | —     | TODO(test) |
| §3.7 `about:blank` and unparseable URL → `{detected:false}` | — | — | TODO(test) |
| §3.8 calling does not mutate page (snapshot before/after equal) | — | — | TODO(test) |
| §3.9 calling twice is stable                    | —         | —         | TODO(test) |

**Recommended test setup:** Playwright fixtures with locally-served HTML (`page.setContent(...)`) cover §3.3–§3.9 without network. §3.1–§3.2 can be unit-tested by extracting the regex check into a pure helper, or by stubbing `page.url()` with a mock object that satisfies the narrow surface used here (`url()` + `evaluate()`).

### Deliberately not tested

- Real interaction with Google / Microsoft / etc. login flows — out of scope for unit tests. Manual smoke covers this when the SSO list changes.

## 6. Drift / open questions

- ⚠️ **Drift — CLAUDE.md vs. code:** CLAUDE.md lists the SSO providers in prose. Cross-checked against `KNOWN_LOGIN_HOSTS` + `KNOWN_LOGIN_PATHS`: Google, Microsoft (live + microsoftonline + microsoft), Okta, Auth0, Atlassian, Apple, Yahoo, GitHub, LinkedIn, X, Facebook are all present. CLAUDE.md does **not** mention `twitter.com`, but the code includes it as an alias of `x.com`. Recommend updating CLAUDE.md to mention `twitter.com` for completeness, or document it here as a deliberate alias.
- ⚠️ **Drift — error handling:** §2 contract says `detectLoginPrompt` MUST NOT throw. Current code wraps `new URL(...)` in try/catch but does **not** wrap `page.evaluate(...)`. If the page is detached or navigates mid-call, `evaluate` rejects and the rejection propagates. Caller in `agent.ts` does have a `try/catch` around it (line ~846), so this is currently absorbed — but the contract should be tightened: wrap the `evaluate` in try/catch and return `{ detected: false }` on failure. **Recommended fix.**
- ⚠️ **Drift — visibility check:** §3.4 requires real visibility. The code checks `getBoundingClientRect` width/height, `display`, `visibility`, `opacity`. It does **not** check `offsetParent` (catches inputs whose ancestor has `display:none` even if the input itself doesn't), nor does it check whether the element is occluded or scrolled out of viewport. `display:none` on the element is caught; `display:none` on the parent is also caught indirectly because the bounding rect collapses to 0×0. Adequate in practice. The `opacity !== "0"` check is exact-string comparison and would miss `opacity:0.0` or computed-cascaded fractional zeros — minor, but worth a `parseFloat(s.opacity) > 0` upgrade.
- ❓ **SSO host list governance.** The list is opinionated, English-speaking-internet biased, and will rot. Open question: who maintains it, and how? Proposal — additions/removals require a PR with at least one regression test (HTML fixture or URL fixture) for the new entry, and a one-line rationale in the commit message. A `// last reviewed: YYYY-MM` comment at the top of the file would help.
- ❓ **Localisation.** The passkey-text cues are English-only (`use your passkey`, etc.). Users on `accounts.google.com/?hl=de` or other localised SSOs are still caught by §3.1 host match; users on a localised in-page passkey prompt outside those hosts would not be caught by §3.6. Open question: is English-only acceptable as a stated limitation, or do we maintain a localisation table? Pragmatic answer: rely on host/path/password-field/webauthn-input checks (which are language-agnostic), and treat §3.6 as a best-effort bonus. Document this limitation here rather than expanding the phrase list ad-hoc.
- ❓ **Iframe-hosted login forms.** `page.evaluate` runs in the top frame only. A login form inside a cross-origin iframe (some embedded SSO flows, Stripe Checkout, etc.) would be missed by §3.3–§3.6. The host/path checks still catch the common cases. Open question: is iframe traversal worth the complexity, or do we accept that as a known gap?
- ❓ **Same-origin iframes.** Even within same-origin frames, the current code does not iterate `page.frames()`. Low-cost upgrade if §3.3 false negatives ever become a real-world problem.
