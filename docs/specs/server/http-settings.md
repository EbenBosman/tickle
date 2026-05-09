# Spec — `http-settings`

> Path: `server/src/routes/settings.ts` · Layer: `interface/http/routes/` · Spec owner: `web/src/components/SettingsPage.tsx` (sole consumer), `server/src/agent.ts` (reads same keys at run-start).

## 1. Why

The Claude Rescue feature (a fallback agent that takes over when a local-LLM block fails) needs three knobs the user can flip without restarting the server: on/off, which Anthropic model to use, and whether to also rescue on user-cancel. SQLite is already there for tasks/runs, so a `settings` key/value table is the cheapest persistence; a tiny REST surface fronts it for the React Settings page. The route also exposes `lessons` listing/delete because the Settings page is the only screen showing them — colocating endpoints by screen, not by domain, keeps the frontend bundle small.

> **Non-obvious why — fixed shape, not generic CRUD.** Despite the underlying table being key/value, the HTTP surface is hand-shaped: one GET / one PUT, both returning the same exact object. There is no `GET /api/settings/:key` and no `DELETE`. The reason is that the consumer (`SettingsPage`) saves all three values atomically, and a generic surface would invite drift between the React state shape and the DB rows.
>
> **Non-obvious why — `api_key_configured` is a boolean, not the key.** `ANTHROPIC_API_KEY` is read from `process.env`, never from the DB; the response leaks only its presence. Required because the UI needs to disable the rescue toggle when no key is set, but the key itself must never cross the wire.

## 2. Public contract

### Exports

| Symbol           | Kind     | Signature / shape                         | Stability |
| ---------------- | -------- | ----------------------------------------- | --------- |
| `settingsRoutes` | function | `(app: FastifyInstance) => Promise<void>` | stable    |

### HTTP surface

| Method | Path               | Request body                                                                      | Success response                              | Errors                                                                                                                |
| ------ | ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/settings`    | —                                                                                 | `200 SettingsResponse`                        | —                                                                                                                     |
| PUT    | `/api/settings`    | `{ rescue_enabled?: boolean; rescue_model?: string; rescue_on_cancel?: boolean }` | `200 SettingsResponse` (post-write read-back) | `400 { error: "empty body" }` if body missing; `400 { error: "unknown model: …" }` if `rescue_model` not in allowlist |
| GET    | `/api/lessons`     | query: `?offset=0&limit=50` (limit clamped to 200)                                | `200 { lessons: Lesson[]; total: number }`    | —                                                                                                                     |
| DELETE | `/api/lessons/:id` | —                                                                                 | `200 { ok: true }`                            | None — silently no-ops on unknown id                                                                                  |

`SettingsResponse` shape:

```
{
  rescue_enabled: boolean,        // getSetting("rescue_enabled") === "true"
  rescue_model: string,           // getSetting("rescue_model") ?? "claude-sonnet-4-6"
  rescue_on_cancel: boolean,      // getSetting("rescue_on_cancel") === "true"
  api_key_configured: boolean,    // Boolean(process.env.ANTHROPIC_API_KEY) — env, not DB
  lesson_count: number            // SELECT COUNT(*) FROM lessons
}
```

### Settings keys

| Key                | Default               | Acceptable values                                                                                                     | Storage form | Consumer                                                                        |
| ------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `rescue_enabled`   | `"false"`             | `"true"` or `"false"` (string-encoded boolean)                                                                        | TEXT         | `agent.ts:185` — read once at `runAgent` start.                                 |
| `rescue_model`     | `"claude-sonnet-4-6"` | One of: `"claude-haiku-4-5-20251001"`, `"claude-sonnet-4-6"`, `"claude-opus-4-7"` (PUT-time allowlist `VALID_MODELS`) | TEXT         | `agent.ts:186` (run-start), `agent.ts:1409` (re-read inside `runClaudeRescue`). |
| `rescue_on_cancel` | `"false"`             | `"true"` or `"false"`                                                                                                 | TEXT         | `agent.ts:187` — read once at run start.                                        |

Defaults are seeded once at DB open (`db.ts:125`, `INSERT OR IGNORE`) — they are real DB rows, not response-side fallbacks. The `?? "claude-sonnet-4-6"` in both routes and `agent.ts` is belt-and-braces against a future where the row is deleted manually.

### Errors

| Error                               | Returned when                            | Caller should…                                          |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `400 { error: "empty body" }`       | PUT `/api/settings` with no body         | Surface to user; SettingsPage never sends empty bodies. |
| `400 { error: "unknown model: X" }` | PUT `rescue_model` not in `VALID_MODELS` | Surface; UI's radio group prevents this.                |

## 3. Invariants

- **I1 — Boolean keys round-trip via `String(b)` / `=== "true"`.** Producer writes `String(body.rescue_enabled)` (`"true"`/`"false"`); consumer compares `=== "true"`. Falsifiable: PUT `rescue_enabled: true`; assert `getSetting("rescue_enabled") === "true"` and GET returns `true`.
- **I2 — Model is allowlisted at PUT, not at GET.** A `rescue_model` row containing an arbitrary string (set by direct DB edit) is returned verbatim by GET. Falsifiable: `setSetting("rescue_model", "made-up")`; GET returns `rescue_model: "made-up"` (no validation on read path).
- **I3 — PUT is partial.** Omitting a field leaves its row untouched. Type-checked per-field (`typeof === "boolean"` / `=== "string"`); a present-but-wrong-type field is silently ignored, not 400. Falsifiable: PUT `{ rescue_enabled: "yes" }`; row unchanged, response 200.
- **I4 — Response is read-after-write.** PUT runs `setSetting` for each field, then re-reads via `getSetting` for the response. The response reflects DB state, not the request body. Falsifiable: in a transaction, intercept `setSetting` to no-op; PUT returns prior values, not requested ones.
- **I5 — `api_key_configured` reflects `process.env.ANTHROPIC_API_KEY` only.** Never read or written by these routes. Falsifiable: unset env, GET → `false`; set env, restart, GET → `true`. Setting via PUT has no field for it.
- **I6 — `/api/lessons` limit is clamped to 200.** `Math.min(Number(limit), 200)`. Falsifiable: GET `?limit=10000` returns ≤ 200 rows.
- **I7 — `DELETE /api/lessons/:id` is idempotent.** No 404; both `lessons` and `lessons_fts` are deleted by rowid. Falsifiable: DELETE same id twice → both 200.

## 4. How (briefly)

- **Routes-as-thin-shim.** Six lines of logic per endpoint; all real persistence is in `db.ts`. The route layer's only jobs are: HTTP shape, allowlist enforcement on `rescue_model`, env-var probe for `api_key_configured`, and lesson-count side query.
- **Settings keys are open at the DB layer, allowlisted at the HTTP layer.** `getSetting`/`setSetting` accept any string key; this route only exposes three. New keys require both seeding in `db.ts:SETTING_DEFAULTS` _and_ explicit handling here. There is no enumeration endpoint listing all keys.
- **Side-effect timing for runs.** `agent.ts` reads all three settings _once_ at `runAgent` entry (lines 185–187) and captures them into `ctx`. A PUT during a live run does **not** affect the running agent — except `rescue_model`, which is re-read inside `runClaudeRescue` (line 1409) on each rescue invocation. Practical effect: toggling `rescue_enabled` mid-run is ignored; switching `rescue_model` mid-run takes effect on the next failed block. See §6 drift.
- **Lesson endpoints colocated by UI screen.** `/api/lessons` GET/DELETE live here, not in a dedicated `routes/lessons.ts`, because the Settings page is the only consumer (export uses a separate route).

## 5. How tested

| Spec section / claim                                        | Test file | Test name | Status                   |
| ----------------------------------------------------------- | --------- | --------- | ------------------------ |
| §2 GET shape                                                | —         | —         | TODO(test)               |
| §2 PUT 400 on empty body                                    | —         | —         | TODO(test)               |
| §2 PUT 400 on unknown `rescue_model`                        | —         | —         | TODO(test)               |
| §3 I1 boolean round-trip                                    | —         | —         | TODO(test)               |
| §3 I2 model not validated on read path (drift candidate)    | —         | —         | TODO(test)               |
| §3 I3 partial PUT leaves omitted fields untouched           | —         | —         | TODO(test)               |
| §3 I3 wrong-type field silently ignored                     | —         | —         | TODO(test)               |
| §3 I5 `api_key_configured` from env, not DB                 | —         | —         | TODO(test)               |
| §3 I6 `/api/lessons` limit clamp at 200                     | —         | —         | TODO(test)               |
| §3 I7 DELETE lessons idempotency                            | —         | —         | TODO(test)               |
| §4 mid-run setting changes do not affect already-active run | —         | —         | TODO(test) — integration |

### Deliberately not tested

- The underlying `getSetting`/`setSetting` (covered by `persistence` spec).
- The Anthropic API key actually working — that's `agent.ts`'s rescue path.

## 6. Drift / open questions

- **Secrets.** No setting in this route holds a secret. `ANTHROPIC_API_KEY` is **only** in `process.env`, never in the `settings` table or any response payload. Risk surface remains zero on this route. Local-only context, but the contract should stay this way: do not migrate the API key into the DB to make it user-editable from the Settings page without first adding a redaction layer to GET responses.
- **⚠️ Drift — `VALID_MODELS` is duplicated.** The allowlist exists in `routes/settings.ts:4` and again in `web/src/components/SettingsPage.tsx:4` (`MODELS`). Adding a model requires editing both. Lift to `domain/settings.ts` (per `_LAYERS.md` recommendation in `persistence` spec §6) and import on both sides.
- **⚠️ Drift — write-path validates, read-path doesn't.** I2 means a future migration path that injects a setting via SQL (or a typo in `SETTING_DEFAULTS`) silently leaks through GET to the UI, where the radio group will simply have nothing checked. Either (a) validate on read with a fallback to default, or (b) add a `CHECK (key NOT IN ('rescue_model') OR value IN (…))` constraint at the DB.
- **⚠️ Drift — mid-run setting changes have inconsistent effect.** `rescue_enabled` and `rescue_on_cancel` are captured at run-start into `ctx`; `rescue_model` is re-read on each rescue. Either pin all three at run-start (predictable, current behaviour for two of them) or re-read all three per block (responsive, current behaviour for one). The mixed model is an accident, not a design.
- **⚠️ Drift — `Math.min(Number(limit), 200)` accepts negative / NaN.** `Number("abc") → NaN`, `Math.min(NaN, 200) → NaN`, SQLite `LIMIT NaN` errors at runtime. Clamp with `Math.max(0, …)` and a NaN check.
- **❓ Open — generic settings surface vs hand-rolled.** A second feature-area wanting persistent toggles will tempt a copy-paste of this file. Decide before that happens whether to (a) keep the hand-rolled per-screen pattern, or (b) introduce a typed `SettingsSchema` registry and a single generic GET/PUT.
- **❓ Open — endpoint ownership.** `/api/lessons` GET and DELETE live here for UI-locality, but `/api/lessons/export` (in `routes/export.ts`) and `addLesson` writes (in `agent.ts`) are elsewhere. Consider a `routes/lessons.ts` once a third lesson endpoint appears.
