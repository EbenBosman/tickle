# Spec — `formScan` (deterministic form-input walk)

> Path: `server/src/formScan.ts` · Layer: `application/` (target: `application/formScan.ts`) · Spec owner: `runQuestionnaireBlock` in `agent.ts` (calls `scanForm` once at block entry; calls `checkQuestionAnswered` after every per-question `act`)

## 1. Why

Form-handling is the slow, error-prone seam of any browser agent. The model can read a screenshot and decide _what_ to type, but asking it "have I now answered this question?" after every action is a 30–60s round-trip on a 26–30B local model and hallucinates badly on busy pages. `formScan` splits the concern: a deterministic DOM walk produces the exhaustive list of fields the agent must answer, and a deterministic post-action probe (`checkQuestionAnswered`) confirms each was filled. The LLM is left with the one job it does well — choosing a value. Selection still flows through `snapshot()` for AI loops; `formScan` is the **verification** half. The two coexist because the snapshot heuristic is tuned for "what's clickable on this viewport," whereas a questionnaire requires "every input in the form, including ones below the fold," with deterministic grouping.

> **Non-obvious why:**
>
> - **`data-tickle-id` is shared with `snapshot()`.** Both modules tag with the same attribute and both reset numbering from `0` on every pass. Whichever pass ran most recently owns the ids; mixing ids across pre- and post-scan calls is a bug. The questionnaire flow is built around this — it scans once at block entry and never re-snapshots until the block ends.
> - **Nav/header/anchor exclusion is a safety guarantee, not cosmetics.** Inputs nested in nav chrome are search boxes, language pickers, "open menu" buttons. Inputs nested inside `<a href>` navigate the page when clicked. Either ruins a questionnaire mid-flow.
> - **Two-tier real-vs-role fallback.** Custom React forms with `<div role="radio">` exist; native `<input>` is preferred when both are present because role-only elements often have surprising click handlers.

## 2. Public contract

### Exports

| Symbol                  | Kind     | Signature / shape                                                                                      | Stability |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------ | --------- |
| `scanForm`              | function | `(session: Session) => Promise<FormScan>`                                                              | stable    |
| `checkQuestionAnswered` | function | `(session: Session, ids: number[]) => Promise<{ answered: boolean; hits: Hit[]; reason: string }>`     | stable    |
| `FormQuestionInput`     | type     | `{ tickle_id, type, option?, group?, value?, checked?, current_value? }`                               | stable    |
| `FormQuestion`          | type     | `{ question, kind, inputs }` where `kind ∈ "radio"\|"checkbox"\|"text"\|"textarea"\|"select"\|"mixed"` | stable    |
| `FormScan`              | type     | `{ questions: FormQuestion[]; input_count: number }`                                                   | stable    |

`Session` is the wrapper around a Playwright `Page` from `browser.ts`.

`scanForm`:

- MUTATES the page: every matched input receives a `data-tickle-id="N"` attribute (numbering resets to 0 on each call). This is a deliberate side-effect — the executor and `act()` consume those ids.
- Picks **one root**: the `<form>` element with the most matching descendants, falling back to `document` if no `<form>` exists.
- Returns questions grouped by radio `name` / checkbox `name` / shared question container; text inputs are always solo.
- Truncates `question` text to 400 chars and stored option labels are not length-bounded by the scanner (caller responsibility).

`checkQuestionAnswered`:

- READ-ONLY: does not mutate the DOM.
- Resolves elements by `[data-tickle-id="<id>"]` selectors; returns `{ id, type: "missing", state: "absent" }` for ids no longer in the DOM.
- Returns `answered: true` if **any one** of the supplied ids has a non-default state. The questionnaire flow treats one filled input per question as "this question is answered" — appropriate because radio groups have one selection, checkboxes accept any selection.

### Errors

| Error                                                         | Returned when                      | Caller should…                                   |
| ------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| (rejection from `page.evaluate`)                              | page detached / navigated mid-call | catch and treat as failed/empty (see drift)      |
| `{ answered: false, hits: [], reason: "no inputs to check" }` | called with empty `ids`            | treat as unanswered without burning a round-trip |

### HTTP / SSE / IPC surface

None. The questionnaire block emits `remember` and `tool_call` events around it, but `formScan` itself is silent.

## 3. Invariants

Each independently falsifiable.

1. **Tagging is exhaustive within scope.** Every visible input/textarea/select/contenteditable inside the chosen root, not inside an excluded region, receives a `data-tickle-id`. `input_count` equals the number of taggings.
2. **Numbering starts at 0 and is contiguous.** `tickle_id` values returned in `FormScan` are `0..input_count-1` with no gaps and no duplicates.
3. **Form-scope rule.** If the page contains one or more `<form>` elements, the chosen root is the `<form>` with the largest count of `SELECTOR` matches; ties resolve to the first encountered. Inputs outside this root are not scanned.
4. **Excluded ancestors.** An input is excluded iff any ancestor (up to `<body>`) is one of: `<nav>`, `<header>`, `<aside>`, `<footer>`, an element with `role` ∈ {`navigation`, `banner`, `complementary`, `contentinfo`}, or an `<a href="...">` whose href is non-empty, not `#`, and not `javascript:...`.
5. **Visibility rule.** An input is excluded if its bounding rect is zero-area, or if it or any ancestor has `display:none` / `visibility:hidden`, or its own `opacity` parses to `0`.
6. **Real-input preference.** If the visible candidate set contains at least one `<input>`/`<select>`/`<textarea>`/contenteditable, role-only candidates (`role="radio"` etc. on non-form tags) are dropped. Only when there are zero real inputs does the role-only set survive.
7. **Type classification.** `type` is derived in this precedence: tag (`textarea`/`select`) → explicit `role` (`checkbox`, `radio`, `switch→checkbox`) → input `type` attribute (`checkbox`, `radio`, text-family list) → `role="textbox"` / contenteditable → `button` (for `submit`/`button`/`reset`) → `other`. Text-family inputs include `text`, `email`, `url`, `search`, `number`, `tel`, `password`, and missing-type.
8. **Grouping rule.**
   - Radios with the same non-empty `name` attribute group together.
   - Checkboxes with the same non-empty `name` attribute group together.
   - Radios/checkboxes without a `name` group by `findQuestionContainer` element-path identity.
   - All other inputs (text, textarea, select, button, contenteditable, other) are solo (`groupKey = solo:<tickle_id>`).
9. **`question.kind` resolution.** `kind` equals the single member of `{inputs[].type}` if all inputs share a type; otherwise `"mixed"`.
10. **Label resolution precedence.** For each input's `option`: `<label for="<id>">` → wrapping `<label>` ancestor → `aria-label` → `aria-labelledby` referent's text → empty string. Empty becomes `undefined` in the output.
11. **Question-text resolution precedence.** For each question container: in-container `<legend>` → in-container heading (`h1..h6`) not inside a `<label>` → walk up to 4 ancestor levels and inspect up to 6 preceding siblings per level for an `h1..h6`/`legend` (3–399 chars) or `p`/`label`/`div`/`span` (9–399 chars, not matching `^(yes|no|true|false)\W?$`) → fallback to container's own `innerText` truncated to 240 chars (low confidence).
12. **`checkQuestionAnswered` per-type rules.** A given `id` is reported `answered`-contributing iff:
    - **Checkable** (`role` ∈ {`checkbox`,`radio`,`switch`}, or `type` ∈ {`checkbox`,`radio`}): native `.checked === true` OR `aria-checked="true"` OR `aria-selected="true"`.
    - **Text** (`<textarea>`, or `<input>` with `type` ∈ {`text`,`email`,`url`,`search`,`number`,`tel`,missing}): `.value.trim()` is non-empty.
    - **Select**: not at default. Default = `selectedIndex <= 0` AND (`value` is empty/falsy OR the selected `<option>` is `disabled` OR its text matches `/please|choose|select/i`).
    - **Contenteditable**: `innerText.trim()` is non-empty.
    - Anything else: `state: "unknown"`, not answered.
13. **`answered` aggregate.** Returns `true` iff at least one supplied id contributes per (12); `false` otherwise. Empty `ids` array short-circuits to `false`.
14. **Idempotence of `checkQuestionAnswered`.** Repeated calls with the same ids and a stationary page return identical `answered` / `state` values.
15. **Re-scan invalidates ids.** A second call to `scanForm` re-numbers from 0; previously returned `tickle_id` values are not stable across scans. (Same constraint as `snapshot()`.)
16. **Password fields are tagged.** `type="password"` is in the text-family classification; the form scanner is intentionally not a login guard. Login surfaces should be intercepted by `loginDetect.ts` before `scanForm` runs.

## 4. How (briefly)

A single `page.evaluate` does the entire walk in-page so the round-trip cost is one IPC. Steps in order: `pickRoot` (largest `<form>` by SELECTOR count, else `document`) → DOM query for `SELECTOR` (`input:not([type=hidden]), textarea, select, [contenteditable=true], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox]`) → filter by visibility → filter out excluded ancestors → tier down to real form inputs if any exist → for each survivor, classify `type`, set `data-tickle-id`, compute `option` label and `groupKey`, push raw entry → fold into questions by `groupKey`, derive `question` text from the first member's container, derive `kind` by type-set size.

`findQuestionContainer` walks up looking for `fieldset` / `role=group|radiogroup` / `.form-group|.field|.question`. Heuristic fallback: ancestor with 2–14 checkable descendants becomes the container — captures tightly-laid-out radio sets without needing semantic markup.

`questionTextFor` deliberately prefers context **above** the container (heading/paragraph) over the container's own `innerText`, because the latter usually concatenates the radio labels themselves and would yield "Yes No Maybe" as a question. The fallback to in-container text is last-resort, low-confidence, and capped at 240 chars.

`checkQuestionAnswered` is also a single `page.evaluate`; it re-resolves elements by attribute selector each call so it survives DOM mutations between scan and check (as long as the tagged element is still present).

**Key dependencies:** Playwright `Page` only. No DB, no LLM, no network.

**Persistence / mutable state:** `data-tickle-id` attributes on the live DOM. Cleared only by re-tagging or page navigation.

**Concurrency:** safe for serial use per `Session`. Two concurrent `scanForm` calls on the same page would race on `nextId` numbering — never done in practice because runs are single-tab single-flight.

## 5. How tested

| Spec section / claim                                                                                                                                                                  | Test file | Test name | Status     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------- | ---------- |
| §3.1 every visible input gets a `data-tickle-id`                                                                                                                                      | —         | —         | TODO(test) |
| §3.2 ids are 0-based contiguous                                                                                                                                                       | —         | —         | TODO(test) |
| §3.3 multi-form page picks the form with most inputs                                                                                                                                  | —         | —         | TODO(test) |
| §3.3 no-form page falls back to `document`                                                                                                                                            | —         | —         | TODO(test) |
| §3.4 `<nav>` / `<header>` / `<aside>` / `<footer>` ancestors exclude                                                                                                                  | —         | —         | TODO(test) |
| §3.4 `role=navigation/banner/complementary/contentinfo` excludes                                                                                                                      | —         | —         | TODO(test) |
| §3.4 `<a href="https://...">` ancestor excludes; `href="#"` and `javascript:` do not                                                                                                  | —         | —         | TODO(test) |
| §3.5 `display:none` / `visibility:hidden` / `opacity:0` / zero-rect excluded (self and ancestors)                                                                                     | —         | —         | TODO(test) |
| §3.6 mixed real+role-only page returns only real inputs                                                                                                                               | —         | —         | TODO(test) |
| §3.6 role-only-only page returns role inputs                                                                                                                                          | —         | —         | TODO(test) |
| §3.7 each type-classification branch                                                                                                                                                  | —         | —         | TODO(test) |
| §3.8 radios with shared `name` group                                                                                                                                                  | —         | —         | TODO(test) |
| §3.8 nameless radios in a shared container group                                                                                                                                      | —         | —         | TODO(test) |
| §3.8 text inputs are always solo                                                                                                                                                      | —         | —         | TODO(test) |
| §3.9 `kind` is `"mixed"` for heterogeneous groups                                                                                                                                     | —         | —         | TODO(test) |
| §3.10 label precedence: `<label for>` beats `aria-label` beats placeholder                                                                                                            | —         | —         | TODO(test) |
| §3.11 `<legend>` wins over preceding `<h2>`                                                                                                                                           | —         | —         | TODO(test) |
| §3.11 preceding `<h2>` wins over container `innerText` fallback                                                                                                                       | —         | —         | TODO(test) |
| §3.11 "Yes"/"No" preceding-sibling text is rejected                                                                                                                                   | —         | —         | TODO(test) |
| §3.12 each per-type answered rule (text empty/non-empty, radio checked/unchecked, select default/non-default, select with `please choose` placeholder, contenteditable, aria-checked) | —         | —         | TODO(test) |
| §3.13 `answered=true` if any id contributes; empty ids → `false`                                                                                                                      | —         | —         | TODO(test) |
| §3.14 idempotent on stationary page                                                                                                                                                   | —         | —         | TODO(test) |
| §3.15 re-scan re-numbers from 0                                                                                                                                                       | —         | —         | TODO(test) |
| §3.16 password input is tagged (login guard is upstream)                                                                                                                              | —         | —         | TODO(test) |

**Recommended test setup:** Playwright fixtures with `page.setContent(...)` HTML strings cover almost every claim without network or LLM. `Session` can be a thin shim exposing `{ page }`. Hidden-input tests need stylesheets to verify the cascaded-display traversal.

### Deliberately not tested

- Real questionnaire flows on third-party sites — covered by manual smoke. The scanner's correctness is independent of any specific site.
- Interaction with `act()` and the LLM — covered by integration tests of `runQuestionnaireBlock`, not this module.

## 6. Drift / open questions

- ⚠️ **Drift — `tickle_id` namespace shared with `snapshot()`.** Both modules tag with the same attribute and both reset numbering from 0. The questionnaire flow only works because it scans once and never snapshots within the block. This is an undocumented coupling — either give the form scan a separate attribute (`data-tickle-form-id`) or document the rule in `snapshot.ts` too. **Recommended fix:** add a comment in both files; the cost of the rename is the bigger fix.
- ⚠️ **Drift — `scanForm` mutates the live DOM.** §2 makes this explicit; the function name does not. A future reader expects "scan" to be read-only. Either rename to `tagAndScanForm` or document the side-effect in the JSDoc.
- ⚠️ **Drift — error contract.** §2 says the function "rejects" on `page.evaluate` failure; today the rejection just propagates from Playwright. Caller in `agent.ts` (line 1184) wraps in try/catch and surfaces as a block failure. `checkQuestionAnswered` has no such wrapping; the caller (line 1287) catches it and synthesises `{ answered: false, hits: [], reason: "dom check threw: …" }`. Consider doing that synthesis inside the module so both surfaces have a uniform contract.
- ⚠️ **Drift — radio name without form scope.** §3.8 groups radios by `name` attribute. If two unrelated questions on the same page reused the same `name` (broken HTML, but seen in the wild), they would collapse into one logical question with `mixed` kind and an option list mixing both. Open question: do we add a same-container guard to the name-grouping path? Pragmatic answer for now: rare enough to defer; if it surfaces, swap the `groupKey` for radios from `radio:${name}` to `radio:${name}@${containerKey}`.
- ⚠️ **Drift — visibility check vs `loginDetect`.** §3.5's visibility predicate uses `parseFloat(s.opacity || "1") === 0`, which correctly handles `"0.0"`. `loginDetect.ts`'s same-purpose check uses `s.opacity !== "0"` which does **not**. The two should be consolidated into one helper.
- **Resolved — combobox classifier.** `SELECTOR` includes `[role="combobox"]`; the inline classifier now maps `combobox → select`, ordered before the text-input branch so `<input role="combobox" type="text">` (react-select / Headless UI) wins. The pure exported `classifyFormInput` mirrors the inline rules and is the unit-test surface; both copies must stay in sync until Phase 4 splits the page-evaluate into "DOM extraction" + "classification". Regression: `server/src/__tests__/formScan.test.ts`.
- ❓ **`findQuestionContainer` heuristic upper bound (14).** Why 14? More than that and it's "probably the whole form, not a question." The constant is unjustified; document or relax.
- ❓ **`questionTextFor` fallback at level 0.** The "walk up" loop's first iteration uses `cur.previousElementSibling` of the **container** itself; for legend/heading-inside-container we already returned. Confirm the level-0 sibling sweep is intentional and not double-coverage.
- ❓ **`elementPath` collision.** Path-of-indices is unique on a static DOM but not stable across a single mutation (insert one row above, every path shifts). Re-scan invalidates ids anyway (§3.15), so this is fine in the current usage; flag if anyone tries to memoize question identity across scans.
- ❓ **Iframe-hosted forms.** `page.evaluate` runs in the top frame only. Forms inside same-origin or cross-origin iframes are invisible to the scanner. Same gap as `snapshot()` and `loginDetect`. Open question: is iframe traversal worth the complexity for the questionnaire flow?
