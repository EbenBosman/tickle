# Spec — `snapshot`

> Path: `server/src/snapshot.ts` · Layer: `infrastructure/browser/snapshot.ts` (post-refactor target) · Spec owner: `agent.ts` (sub-agent loop) and `tools.ts` (the `act` tool that consumes the labelled IDs)

## 1. Why

The agent picks targets to click, fill, hover, etc. using small integer IDs, not selectors. `takeSnapshot` is what produces those IDs: it walks the live DOM, filters to visible interactive elements, infers an ARIA-style role and accessible name for each, tags every survivor in-place with `data-tickle-id="N"`, and returns a labelled list plus a screenshot. The model's universe of clickable things is exactly what's in the most-recent snapshot. Without this seam, every action would require the model to author or guess a selector — slow, brittle, and (worse) easy to inject text from page content into.

> **Non-obvious why — visibility filtering is a prompt-injection control.** Hidden elements that present interactive affordances (offscreen "Click here", `display:none` forms with attacker-chosen labels, zero-opacity buttons) must not appear in the labelled list. The agent only sees what the user can see, which mirrors the page's untrusted-content threat model in `read_text` (CLAUDE.md "Page content is untrusted data").
>
> **Non-obvious why — the >50 viewport heuristic.** Dense pages (search results, tables, long forms) emit hundreds of interactive elements; piping them all into the model wastes context and increases stall risk. Defaulting to viewport-only above the threshold keeps the labelled list tractable while still telling the model how many elements were hidden.

## 2. Public contract

### Exports

| Symbol            | Kind     | Signature / shape                                                                                                      | Stability |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| `takeSnapshot`    | function | `(session, opts?: { query?: string; max?: number; all?: boolean }) => Promise<Snapshot>`                               | stable    |
| `Snapshot`        | type     | `{ elements: SnapshotElement[]; hidden_below_fold: number; text: string; base64: string; url: string; title: string }` | stable    |
| `SnapshotElement` | type     | `{ id: number; role: string; name: string; state?: string; href?: string; value?: string }`                            | stable    |

### Inputs

- `opts.query` — case-insensitive substring filter on accessible name. When set, viewport filtering is **disabled** (search is whole-page).
- `opts.max` — hard cap on returned elements. Clamped to `[1, 500]`, default `150`.
- `opts.all` — opt out of the viewport-only heuristic and return everything visible.

### Output

- `elements` — at most `opts.max` items, IDs assigned `0..N-1` in DOM order. Each carries `role`, accessible `name`, optional `state` flag-string (e.g. `"checked,focused"`), `href` for `<a>`, and `value` for textbox/combobox/searchbox.
- `hidden_below_fold` — count of visible interactive elements that the viewport filter dropped (always `0` when `opts.all=true` or `opts.query` is set).
- `text` — the rendered, model-facing form: a headline, one line per element (`[N] role "name" (state) = "value" → href`), and a footer note when off-screen elements exist.
- `base64` — PNG screenshot taken **after** the DOM is tagged. Capture is delegated to `session.screenshot()` in `browser.ts`; this module does not know how to talk to Playwright directly for screenshots.
- `url`, `title` — current page URL and document title (title swallowed if Playwright throws).

### Errors

| Error / failure mode             | Returned when                                                   | Caller should…                                                                                               |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `page.evaluate` rejection        | tab navigated/closed mid-snapshot, or Playwright dispatch error | propagates as a thrown error; caller (`agent.ts`) catches and emits a tool error                             |
| `session.screenshot()` rejection | browser context lost                                            | propagates                                                                                                   |
| `page.title()` rejection         | tab in a state where `title()` throws                           | swallowed; `title` is `""`                                                                                   |
| (no error)                       | zero elements match                                             | `elements: []`, headline says `(no visible interactive elements)` or `(no visible elements match "<query>")` |

## 3. Invariants

- **I1 — IDs are dense, zero-based, and unique within one snapshot.** `elements[i].id === i` for all `i`, and every returned element carries `data-tickle-id="<id>"` after the call returns.
- **I2 — IDs are not stable across snapshots.** A subsequent `takeSnapshot` reassigns from zero. The system prompt instructs the model to always use the latest list (CLAUDE.md "Sub-agent loop"). The executor in `agent.ts` enforces this by re-snapshotting after every `navigate`/`act` and attaching the fresh result to the tool reply.
- **I3 — Visibility is a hard gate.** An element is included only if (a) `getBoundingClientRect()` has non-zero width and height, (b) computed `display !== "none"`, `visibility !== "hidden"`, and `opacity > 0`, and (c) no ancestor has `display:none` or `visibility:hidden`. Falsifiable: render a `display:none` button — it must not appear.
- **I4 — Role inference is deterministic and bounded.** The role is either an explicit `role=""` attribute or one of: `link` (a[href]), `button` (`<button>`, `<input type=submit|button|reset|file>`, `[onclick]`), `combobox` (`<select>`), `textbox` (`<textarea>`, `<input type=text|email|...>`, `contenteditable=true`), `checkbox`, `radio`, `slider` (range). Elements with no inferable role are skipped.
- **I5 — Nameless elements are skipped except for input-likes.** Elements whose accessible name resolves to `""` are dropped, **unless** the role is `textbox`, `combobox`, or `searchbox` (where an empty name is legitimate — the model still needs to fill them).
- **I6 — Accessible name precedence.** `aria-label` > `aria-labelledby` (joined `textContent` of referenced ids) > `<label for="">` > wrapping `<label>` > inner `<img alt="">` > visible text (`innerText`/`textContent`, whitespace-collapsed) > `(placeholder: …)` > `(value: …)` (truncated to 60 chars) > `title`. Final name is truncated to 240 chars.
- **I7 — Viewport heuristic.** When `!opts.all && !opts.query` and the count of qualifying elements exceeds `VIEWPORT_FILTER_THRESHOLD = 50`, only elements intersecting the viewport rectangle are returned; the rest are counted in `hidden_below_fold` and surfaced in the `text` footer with a hint to scroll or pass `query`. At or below 50, all qualifying elements are returned.
- **I8 — `max` is a hard cap, applied after viewport filtering.** If more than `max` candidates remain, the trailing ones are silently dropped (they are _not_ counted in `hidden_below_fold`).
- **I9 — Single-pass tagging is destructive but idempotent.** Each call sets `data-tickle-id` on returned elements; it does **not** clear stale `data-tickle-id` attributes from previous snapshots on elements that are no longer returned. Stale attributes from earlier snapshots persist until the page navigates or the element is removed. The `act` tool in `tools.ts` looks elements up via `[data-tickle-id="<id>"]` and trusts that the most recent snapshot's IDs are the live ones.

## 4. How (briefly)

- **One round-trip.** All DOM work runs inside a single `page.evaluate` so element collection, visibility checks, role inference, name resolution, viewport filter, and tagging are atomic with respect to page mutation.
- **Two-pass inside the page.** First pass collects every `SELECTOR` match that passes visibility + role + name gates into an array of `{ el, item, inViewport }`. Second pass picks `viewportOnly ? all.filter(inViewport) : all`, assigns sequential IDs, sets `data-tickle-id`, and emits the result.
- **Selector roster** — the union of `a[href]`, `button`, `input:not([type=hidden])`, `select`, `textarea`, `[contenteditable=true]`, the common ARIA roles (`button`, `link`, `tab`, `menuitem`, `checkbox`, `radio`, `switch`, `combobox`, `option`, `treeitem`, `searchbox`, `textbox`), and `[onclick]`.
- **Screenshot is taken last**, after tagging, via `session.screenshot()`. The base64 PNG is what the model sees alongside the labelled text.
- **Text rendering** lives in this module (post-evaluate). The `text` field is the canonical form the agent prompt receives; structured `elements` are kept for callers that want to introspect (none today).
- **Relationship to `formScan.ts`.** `formScan` is a parallel deterministic walker for **form inputs only**, used by the questionnaire block. It also stamps `data-tickle-id` (in its own number space, scoped to a form). Both modules write the same attribute; this is fine because each consumer (snapshot/act vs. formScan/questionnaire) operates within one walk and re-tags before reading. They must not interleave with each other expecting compatible IDs.

## 5. How tested

| Spec section / claim                                                           | Test file | Test name | Status     |
| ------------------------------------------------------------------------------ | --------- | --------- | ---------- |
| §3 I1 IDs dense, zero-based                                                    | —         | —         | TODO(test) |
| §3 I3 visibility filter (display/visibility/opacity/zero-rect/ancestor-hidden) | —         | —         | TODO(test) |
| §3 I4 role inference table                                                     | —         | —         | TODO(test) |
| §3 I5 nameless skip except input-likes                                         | —         | —         | TODO(test) |
| §3 I6 accessible-name precedence ladder                                        | —         | —         | TODO(test) |
| §3 I7 viewport heuristic at threshold boundary (50, 51)                        | —         | —         | TODO(test) |
| §3 I8 `max` cap behaviour                                                      | —         | —         | TODO(test) |
| §3 I9 stale `data-tickle-id` not cleared between snapshots                     | —         | —         | TODO(test) |
| §2 `query` substring + disables viewport filter                                | —         | —         | TODO(test) |
| §2 `text` rendering format and footer hint                                     | —         | —         | TODO(test) |

### Deliberately not tested

- The screenshot bytes themselves — covered by `browser.ts` and integration smoke.
- Real-site behaviour against the sites the agent drives. That's manual / e2e scope.

## 6. Drift / open questions

- **⚠️ Concern — DOM mutation as a side effect.** `data-tickle-id` is written into the live page. Sites that observe attribute mutations (MutationObservers, framework reconcilers, integrity checks) can detect or react to this. React/Vue/Angular generally tolerate unknown `data-*` attributes, but a SPA could in principle clobber them on next render — in which case `act` would fail to find the element via the attribute. No revert/cleanup happens after the snapshot. Document as a known trade-off; fixes would be (a) use a WeakMap from element to id with custom selectors, or (b) revert attributes after returning, accepting the race window.
- **⚠️ Concern — `data-tickle-id` collision.** If the page's own code already uses `data-tickle-id` for an unrelated purpose, snapshot will overwrite it. Negligible in practice (the attribute name is bespoke), but not enforced.
- **⚠️ Drift — stale tags persist (I9).** Old tags from the previous snapshot remain on elements that no longer pass the filter. `act` looks up by attribute and will happily find a stale tag for an element that is no longer in the labelled list. The executor mitigates this by always re-snapshotting and only feeding the fresh list to the model, but a buggy caller could still call `act(staleId, …)` and have it succeed against the wrong element. Either clear all `[data-tickle-id]` attributes at the start of each snapshot, or have `act` cross-check that the id is in the current snapshot's id range.
- **⚠️ Drift — visibility check misses `aria-hidden="true"`.** An element that is rendered but `aria-hidden` is not filtered. Real assistive tech ignores it; the agent should too. Add to `isVisible`.
- **⚠️ Drift — ancestor opacity not walked.** `isVisible` walks ancestors for `display`/`visibility` but not `opacity`. A parent with `opacity: 0` leaves its descendants visible to the snapshot. Probably should walk opacity too.
- **❓ Question — should `query` honour role prefixes?** The system prompt warns the model not to pass role names as `query` (substring matches names, not roles). A typed `query: { name?: string; role?: string }` would be safer than the current overload, at the cost of API surface.
- **❓ Question — should `hidden_below_fold` include the cap-dropped count from I8?** Today it does not, so the footer can understate how much the model is missing. Trivial fix.
