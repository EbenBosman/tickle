# Spec — `tools`

> Path: `server/src/tools.ts` · Layer: `application/tools.ts` (post-refactor target; see §6 for the proposed `domain/` split of definitions vs. `application/`/`infrastructure/` execution) · Spec owner: `agent.ts` (sole caller of `executeTool`; consumes `toolDefs` to send to the LLM).

## 1. Why

The LLM cannot drive a browser directly — it can only emit OpenAI-style tool calls. This module is the bridge: it declares the _exact_ surface the model is allowed to use (`toolDefs`) and dispatches each named call against a `Session` (`executeTool`). Adding a new model capability means adding a tool here and nowhere else; the system prompt and the agent loop both follow from this surface.

The shape is constrained by three things: (a) the OpenAI tool-call wire format expected by `llm.ts` and re-emitted by Ollama / LM Studio / vLLM / SGLang; (b) the snapshot-and-act paradigm — the model never writes selectors, it picks numeric ids out of the most recent `snapshot()` and calls `act(id, action, value?)`; (c) page content is hostile and must be filtered before re-entering the prompt.

> **Non-obvious why:** `finish_step` is a _virtual_ tool. It is appended to the model's tool list by `agent.ts::toolsForAiBlock` and intercepted by `runAiSubGoal` before dispatch — it never reaches `executeTool`. `toolDefs` deliberately does not declare it (and no longer declares an alias `finish`).
>
> **Non-obvious why:** `read_text` filters injection-risk DOM (hidden / zero-size / colour-camouflaged elements, `<script>` / `<style>` / `<template>`) because `read_text` output is concatenated into the next assistant prompt. That makes the page a prompt-injection vector unless invisible text is stripped before re-entry.

## 2. Public contract

### Exports

| Symbol        | Kind     | Signature / shape                                                                                                | Stability |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| `toolDefs`    | const    | `readonly [{ type: "function"; function: { name; description; parameters } }, …]` (OpenAI tool-spec, `as const`) | stable    |
| `ToolResult`  | type     | `{ ok: true; text?: string; image_base64?: string; data?: unknown } \| { ok: false; error: string }`             | stable    |
| `executeTool` | function | `(session: Session, name: string, args: Record<string, unknown>) => Promise<ToolResult>`                         | stable    |

### Tool surface (shipped to the LLM)

| Tool name    | Required args                | Optional args                                               | Returns on success                                                                                         | Auto-snapshot after?                    |
| ------------ | ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `navigate`   | `url: string` (http/https)   | —                                                           | `{ ok: true, text: "Navigated to <final-url>" }`                                                           | **yes** (in agent.ts)                   |
| `snapshot`   | —                            | `query?: string`, `all?: boolean=false`, `max?: number=150` | `{ ok: true, text, image_base64, data: { elements, hidden_below_fold, url, title } }`                      | n/a (this **is** the snapshot)          |
| `act`        | `id: number`, `action: enum` | `value?: string`                                            | `{ ok: true, text: "<verb-phrase> [id]" }`                                                                 | **yes** (in agent.ts)                   |
| `read_text`  | —                            | `selector?: string` (CSS)                                   | `{ ok: true, text: <≤6000 chars or "(empty)"> }`                                                           | no                                      |
| `scroll`     | `pixels: number`             | —                                                           | `{ ok: true, text: "Scrolled Npx" }`                                                                       | no                                      |
| `wait_for`   | `selector: string`           | `state?: "visible"\|"attached"\|"hidden"\|"detached"=visible`, `timeout_ms?: number=8000`                                  | `{ ok: true, text: "Element <sel> present" }`                                                              | no                                      |
| `press_key`  | `key: string`                | —                                                           | `{ ok: true, text: "Pressed <key>" }`                                                                      | no                                      |
| `screenshot` | —                            | —                                                           | `{ ok: true, image_base64, text: "(screenshot attached)" }`                                                | no (it returns one)                     |
| `fetch_url`  | `url: string` (http/https)   | —                                                           | `{ ok: true, text: "Fetched <final-url> (<n> chars, returning first <m>):\n\n<body>" }` (≤6000 chars body) | no (uses temp tab; main page untouched) |

`finish_step(success, output?, note?)` is appended to the LLM's tool list inside `agent.ts::toolsForAiBlock` and intercepted by `runAiSubGoal` before dispatch — it does not appear in `toolDefs` and never reaches `executeTool`.

### `act.action` enum

`click | fill | press | check | uncheck | hover | select_option`

| Action          | `value` required? | Behaviour                                                                                                                                                                                                                        |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`         | no                | `locator.click({ timeout: 8000 })`                                                                                                                                                                                               |
| `fill`          | **yes** (string)  | `locator.fill(value, { timeout: 8000 })` — replaces input contents                                                                                                                                                               |
| `press`         | **yes** (key)     | `locator.press(value, { timeout: 8000 })` — element-scoped key press                                                                                                                                                             |
| `check`         | no                | `locator.check({ timeout: 8000 })`                                                                                                                                                                                               |
| `uncheck`       | no                | `locator.uncheck({ timeout: 8000 })`                                                                                                                                                                                             |
| `hover`         | no                | `locator.hover({ timeout: 8000 })`                                                                                                                                                                                               |
| `select_option` | **yes**           | `locator.selectOption(value, { timeout: 8000 })` — Playwright matches by `value` attribute, label, or `<option>` text in that order. The schema description matches this priority. |

### Errors (return shape, never thrown)

| Error                                                                                                                    | Returned when                                       | Caller should…                            |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------- |
| `{ ok: false, error: "navigate.url must be http(s)://" }`                                                                | non-http(s) URL passed to `navigate` or `fetch_url` | re-emit a corrected call                  |
| `{ ok: false, error: "act.id must be a non-negative integer from the latest snapshot" }`                                 | `act.id` non-integer or negative                    | call `snapshot` again                     |
| ``{ ok: false, error: `No element with id ${id}. The page may have changed; call snapshot() again.` }``                  | id not present in current DOM                       | call `snapshot` again                     |
| `{ ok: false, error: "act.fill requires a `value` string" }`                                                             | `fill` / `select_option` missing `value`            | re-emit with `value`                      |
| `{ ok: false, error: "act.press requires a `value` (key name)" }`                                                        | `press` missing `value`                             | re-emit with `value`                      |
| ``{ ok: false, error: `Unknown action "${action}". Valid: click, fill, press, check, uncheck, hover, select_option.` }`` | `act.action` outside enum                           | re-emit with valid action                 |
| ``{ ok: false, error: `fetch_url failed: <message>` }``                                                                  | `fetch_url` goto/evaluate throws                    | continue, do not retry blindly            |
| ``{ ok: false, error: `Unknown tool: ${name}` }``                                                                        | dispatched name has no case branch                  | bug — surfaces missing tool in dispatcher |
| `{ ok: false, error: <native message> }`                                                                                 | any other thrown error in any branch                | top-level `try/catch` returns this shape  |

## 3. Invariants

- **I1 — Every `executeTool` return is the `ToolResult` discriminated union.** Never throws; the outer `try/catch` converts any thrown error to `{ ok: false, error }`. Falsifiable: pass a tool name that triggers an internal throw and assert the return shape.
- **I2 — `navigate` and `fetch_url` reject non-http(s) URLs before any browser work.** Falsifiable: call `executeTool(session, "navigate", { url: "javascript:alert(1)" })` — must return `ok: false` and not call `page.goto`.
- **I3 — `act` only resolves elements via the `[data-tickle-id="N"]` attribute.** It does not accept selectors and never receives selectors from the model. Falsifiable: confirm only one selector form in the `act` branch.
- **I4 — `read_text` output ≤ 6000 characters and never contains content from filtered-out elements.** Falsifiable: render a page with `<div style="display:none">SECRET</div>` and assert `SECRET` does not appear in the result.
- **I5 — `fetch_url` does not navigate the main page.** It opens a `context.newPage()` temp tab, reads, and closes it — even on error (`finally { tempPage.close() }`). Falsifiable: capture `session.page.url()` before and after; must be unchanged.
- **I6 — `finish_step` is virtual and never appears in `toolDefs`.** It is appended by `agent.ts::toolsForAiBlock` and intercepted by `runAiSubGoal` before dispatch. `executeTool` has no `finish` or `finish_step` branch; an unrecognised name falls through to `Unknown tool: <name>`. Falsifiable: `toolDefs` must contain neither `finish` nor `finish_step` (regression: `__tests__/tools.test.ts`).
- **I7 — `screenshot` and `snapshot` are the only tools that attach `image_base64`.** All others return text-only.
- **I8 — Auto-snapshot is the executor's responsibility, not this module's.** `agent.ts` is responsible for taking a fresh snapshot after every successful `navigate` and `act` call and attaching it to the tool result the model sees. `executeTool` itself does not auto-snapshot. Falsifiable: grep this module for `takeSnapshot` outside the `snapshot` branch — there must be exactly one call site.
- **I9 — `act` timeouts are 8000ms, fixed.** Not configurable from the tool args. Falsifiable by inspection.
- **I10 — `wait_for` defaults to `state: "visible"`.** An invisible element does NOT satisfy the wait by default. Optional `state` accepts `visible | attached | hidden | detached`, validated server-side. Falsifiable by Playwright behaviour.

## 4. How (briefly)

- **Two halves.** `toolDefs` is a frozen `as const` array of OpenAI-shaped tool schemas — pure data, no behaviour. `executeTool` is a single-level `switch (name)` over those tool names with a top-level `try/catch` that funnels any throw into `{ ok: false, error }`.
- **Element addressing.** `act` builds the locator as `page.locator(\`[data-tickle-id="${id}"]\`).first()`. The `data-tickle-id`attribute is set by`snapshot.ts`during the previous`snapshot()` call. If the page has reflowed (id no longer present) the count check returns the "page may have changed" error so the model knows to re-snapshot.
- **`read_text` filter (exact rules).** A DOM walker called via `page.evaluate`. An element is **excluded** (its subtree is skipped) if any of:
  1. `tagName ∈ {script, style, template, noscript, meta, link, head, title}` (case-insensitive)
  2. `aria-hidden="true"`
  3. `getComputedStyle(el).display === "none"`
  4. `getComputedStyle(el).visibility === "hidden"`
  5. `parseFloat(getComputedStyle(el).opacity || "1") === 0`
  6. `parseFloat(getComputedStyle(el).fontSize || "16") <= 0.5` (sub-pixel font)
  7. `getBoundingClientRect()` has `width === 0` or `height === 0`
  8. `getComputedStyle(el).color === getComputedStyle(el).backgroundColor` (camouflage)

  Block-level tags (`div, p, br, tr, li, section, article, h1–h6, header, footer, nav`) append a newline after their subtree. Output is post-processed: `[ \t]+\n → \n`, `\n{3,} → \n\n`, `.trim()`, then `.slice(0, 6000)`. Empty output renders as `"(empty)"`.

- **`fetch_url` filter.** Shares one walker with `read_text` (`__extractVisibleTextFnSource` in `tools.ts`, evaluated as a string + `new Function` so neither call site can drift). Same eight strip rules.
- **Image attachment shape.** `ToolResult.image_base64` is raw base-64 with no `data:image/...;base64,` prefix; `agent.ts` constructs the data URL when assembling the OpenAI vision message.
- **No state.** Module-level mutable state is zero. Every call is a function of `(session, name, args)`.

## 5. How tested

| Spec section / claim                                        | Test file                 | Test name                                                         | Status                        |
| ----------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------- | ----------------------------- |
| §3 I1 every result is `ToolResult`                          | —                         | —                                                                 | TODO(test)                    |
| §3 I2 `navigate` rejects non-http(s)                        | —                         | —                                                                 | TODO(test)                    |
| §3 I2 `fetch_url` rejects non-http(s)                       | —                         | —                                                                 | TODO(test)                    |
| §3 I3 `act` selector form is `[data-tickle-id]`             | —                         | —                                                                 | TODO(test) — static grep test |
| §3 I4 `read_text` strips hidden / camouflage                | —                         | —                                                                 | TODO(test)                    |
| §3 I4 `read_text` ≤ 6000 chars and trims                    | —                         | —                                                                 | TODO(test)                    |
| §3 I5 `fetch_url` does not navigate main page               | —                         | —                                                                 | TODO(test)                    |
| §3 I6 `toolDefs` exposes neither `finish` nor `finish_step` | `__tests__/tools.test.ts` | `does not include finish` / `does not include finish_step either` | done                          |
| §3 I8 auto-snapshot lives in `agent.ts`                     | —                         | —                                                                 | TODO(test) — static grep      |
| §2 errors row "Unknown action"                              | —                         | —                                                                 | TODO(test)                    |
| §2 errors row "No element with id N"                        | —                         | —                                                                 | TODO(test)                    |
| §4 `read_text` block-tag newline insertion                  | —                         | —                                                                 | TODO(test)                    |
| §6 `select_option` matching mode (value vs label)           | —                         | —                                                                 | TODO(test)                    |

### Deliberately not tested

- Real-network `navigate` / `fetch_url` — exercised by integration smoke against actual pages.
- Real-LLM round-trip (the schema strings are consumed by an external model; correctness is validated by manual smoke runs).
- The 8000ms Playwright timeouts.

## 6. Drift / open questions — guardrails and unresolved

### Hard guardrails (do not violate)

- **🚫 Do not add tools that filter site policy text.** Anti-AI banners, "do not use AI" disclaimers, robots.txt-style admonishments are _legitimate platform terms_ and must remain visible to the model. The `read_text` injection-defence filter exists for **invisible attack vectors only** — display:none, opacity:0, font-size:0, colour-camouflage, off-screen text — not for muting visible page text. Any new strip rule must justify itself against this distinction. (CLAUDE.md "Things to avoid".)
- **🚫 No jQuery `:contains()` selectors anywhere in tool args.** Playwright rejects them. The model uses ids; if `wait_for`'s `selector` arg ever needs text matching, route through `getByText` / `getByRole` in a new tool, do not paper over it. (CLAUDE.md "Things to avoid".)
- **🚫 Do not bypass the `Session` abstraction.** Tools must not import `chromium` or open their own contexts; they go through `session.page` / `session.page.context()` only. The persistent profile lives in `server/data/profile/` and is owned by `browser.ts`.
- **🚫 Do not move sensitive data through tool args that end up in URL parameters.** `navigate.url` and `fetch_url.url` are logged (steps table, JSONL trace); never construct URLs that embed secrets.
- **🚫 Cancellation is enforced _outside_ this module.** `executeTool` does not check `cancel.ts`; `agent.ts` checks before each tool dispatch and between LLM retries. Do not add ad-hoc cancellation polling inside tool branches — it would duplicate the seam and leak the cancel registry into infrastructure code. (CLAUDE.md "Conventions": "Cancellation is checked at every safe boundary".)

### Drift

- **Resolved — `finish` removed from `toolDefs`.** The model now only sees `finish_step` (appended by `agent.ts::toolsForAiBlock`). The duplicate `finish` exposed an un-intercepted exit path that ran the loop to step-limit. Regression: `__tests__/tools.test.ts`.
- **Resolved — unified text walker.** `read_text` and `fetch_url` share a single in-page walker (`__extractVisibleTextFnSource` in `tools.ts`), evaluated via a string + `new Function` so neither call site can drift. The 8 strip rules apply to both. Regression: `__tests__/tools.readText.test.ts`.
- **Resolved — `select_option` description.** Schema description aligned with Playwright's match priority (value → label → text).
- **⚠️ `read_text` slice-then-trim ordering.** Output is post-processed (`replace`, `replace`, `trim`) then `.slice(0, 6000)`. A page with 6001 chars of meaningful text followed by trailing whitespace would have its tail truncated mid-word silently. Acceptable for an LLM consumer but worth flagging.
- **⚠️ Layer placement.** Per `_LAYERS.md`, `tools.ts` belongs in `application/` post-refactor — it orchestrates `infrastructure/` (`browser.ts`, `snapshot.ts`) on behalf of the agent. The right split is:
  - `domain/tools.ts` — `toolDefs` (pure data) and the `ToolResult` type. Zero imports from infrastructure.
  - `application/executeTool.ts` — the dispatcher; imports the `Session` interface from `domain/`.
  - `infrastructure/browser/extractText.ts` — the shared text walker (resolves the second drift item above).
  - `read_text` and `fetch_url`'s `page.evaluate` callbacks would still execute in the page world, but the host-side wrapper lives in `application/`.

### Open questions

- **❓ Should `fetch_url` advertise its 6KB cap in the success text?** It currently says "first M chars" but doesn't tell the model the cap is fixed at 6000 — successive calls on the same long page won't paginate.
- **❓ Should `act.fill` clear the input first explicitly?** Playwright's `fill()` already replaces, but some React inputs ignore programmatic value-set without a `change` event. No reported issue yet.
