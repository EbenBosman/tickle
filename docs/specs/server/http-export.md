# Spec — `http-export`

> Path: `server/src/routes/export.ts` · Layer: `interface/http/routes/` (post-refactor target). Today the route reads `db` directly, skipping `application/`. · Spec owner: external training-data pipeline (consumes the JSONL stream); `agent.ts::runClaudeRescue` is the sole producer of the rows this route emits.

## 1. Why

The agent's local-vs-rescue path (see `agent.ts::runClaudeRescue`) records, for every block where the local model failed and a Claude rescue ran, both transcripts side-by-side. That data is the substrate for DPO/SFT fine-tuning of the local model. This route exists to drain those transcripts out of SQLite as a single newline-delimited JSON file in a shape downstream training tooling can consume directly — no joins, no post-processing, one HTTP GET.

> **Non-obvious why — JSONL, not JSON.** Training pipelines stream line-by-line; a top-level array would force them to load the whole file. The route emits `application/x-ndjson`.
>
> **Non-obvious why — DPO pair shape.** When a rescue ran, the local attempt is emitted as `role: "rejected"` and the Claude rescue as `role: "chosen"` (preference-pair training). When the local model succeeded (no rescue), only one line is emitted with `role: "chosen"` for SFT use. This wire shape is the contract — see §3 I2.
>
> **Non-obvious why — local-only, no auth.** Tickle binds Fastify to `127.0.0.1` and is single-user by design. The export contains user-typed values from `fill` actions and page text the agent read; if the bind ever changes, this route needs auth before that change ships. Flagged in §6.

## 2. Public contract

### Exports

| Symbol         | Kind     | Signature / shape                                  | Stability |
|----------------|----------|----------------------------------------------------|-----------|
| `exportRoutes` | function | `(app: FastifyInstance) => Promise<void>` plugin   | stable    |

### HTTP surface

| Method · Path                  | Query                                  | Response                                                                                       |
|--------------------------------|----------------------------------------|------------------------------------------------------------------------------------------------|
| `GET /api/export`              | `status?: "rescued"` (optional filter) | `200 application/x-ndjson` body; `Content-Disposition: attachment; filename="tickle-training-<epoch_ms>.jsonl"` |

- `status=rescued` restricts output to rows where a Claude rescue actually ran (i.e. `payload.rescue_messages.length > 0`). Any other value, or absence, returns the full set (rescued *and* local-success rows).
- No other selection parameters exist. **There is no `run_id`, no `task_id`, no date range, no pagination.** Default scope is *all `messages_export` rows across all `done` runs* — runs with `status` other than `done` are excluded by the SQL join.
- Filename's epoch milliseconds is `Date.now()` at request time; not a stable identifier.

### Body schema (one JSON object per line)

```jsonc
{
  "role": "rejected" | "chosen",
  "messages": [...],   // raw OpenAI chat-completion message array (verbatim from the sub-agent loop)
  "meta": {
    "run_id":            number,
    "block_id":          string,
    "block_kind":        string,   // e.g. "goal" | "click" | "fill" | "extract"
    "rescue_model":      string,   // e.g. "claude-sonnet-4-6" or local model id when no claude provider
    "local_step_count":  number,   // count of assistant messages in local transcript
    "rescue_step_count": number    // count of assistant messages in rescue transcript (0 when no rescue ran)
  }
}
```

- **Pairing rule.** When `payload.rescue_messages.length > 0`, exactly **two** consecutive lines are emitted for that source row: `rejected` (local) immediately followed by `chosen` (rescue), sharing the same `meta`. When `rescue_messages` is empty, exactly **one** line is emitted with `role: "chosen"` carrying the local transcript.
- **Ordering.** Source rows are ordered by `(s.run_id ASC, s.id ASC)` — chronological within a run, runs in insertion order.
- **Trailing newline.** Present iff at least one line was emitted; an empty result is the empty string, not `"\n"`.

### Errors

| Error              | Returned when                          | Caller should…                                       |
|--------------------|----------------------------------------|------------------------------------------------------|
| (none)             | A `steps.payload` row fails `JSON.parse` | Row is skipped silently; export continues.         |
| (none)             | No matching rows                       | Receive `200` with empty body.                       |
| (synchronous throw)| DB unavailable                         | Fastify default 500.                                 |

There is no 4xx path; unknown query values are ignored, not rejected.

## 3. Invariants

- **I1 — Source kind is `messages_export`, source status is `done`.** The route reads only `steps.kind = 'messages_export'` rows joined to `runs.status = 'done'`. Rows from `running`, `error`, or `cancelled` runs are never exported, even if a rescue produced an export payload before cancellation. Falsifiable: insert a `messages_export` step under a `running` run; GET; assert it does not appear.
- **I2 — DPO pair contract.** For a source row with non-empty `rescue_messages`: emitted lines are exactly `[rejected(local), chosen(rescue)]` in that order, with identical `meta`. For a source row with empty/missing `rescue_messages`: exactly one `chosen(local)` line. Falsifiable by counting line pairs against payloads.
- **I3 — `meta` is a strict subset of payload fields.** `meta` carries `run_id, block_id, block_kind, rescue_model, local_step_count, rescue_step_count` — and nothing else. Notably absent: `instruction`, `local_status`, `local_error`. Consumers depending on those will need a contract change.
- **I4 — Buffered, not streamed.** The handler accumulates all lines in memory and returns the joined string from the handler. Response is *not* chunked-streamed. Memory cost is O(total payload bytes) per request. Falsifiable: a request body never starts arriving before the SQL `all()` completes.
- **I5 — Filter is binary on the literal `"rescued"`.** Only `status=rescued` activates filtering; any other value (`status=all`, `status=done`, missing) yields the unfiltered set.
- **I6 — Content negotiation is fixed.** `Content-Type: application/x-ndjson` regardless of `Accept` header. There is no JSON-array variant, no CSV, no per-run sub-route.

## 4. How (briefly)

- **Single SELECT, in-memory transform.** One prepared statement reads every `messages_export` step under `done` runs ordered by `(run_id, id)`. The handler iterates rows, parses each `payload`, applies the optional `rescued` filter, and pushes one or two lines to an array.
- **Errors are swallowed.** A row whose `payload` is not valid JSON is `continue`d — no log, no error. Rare in practice (the producer is `agent.ts` writing `JSON.stringify(exportPayload)`), but worth noting.
- **No streaming.** `db.prepare(...).all()` materialises everything; `lines.join("\n")` materialises the response. Acceptable for current data volumes (single-user, manual training runs); will not scale to large rescue corpora.
- **Buffered filename.** `Date.now()` is sampled once per request; the filename is informational only.

## 5. How tested

| Spec section / claim                                | Test file | Test name | Status     |
|-----------------------------------------------------|-----------|-----------|------------|
| §3 I1 only `done` runs surface                      | —         | —         | TODO(test) |
| §3 I1 only `kind='messages_export'` rows surface    | —         | —         | TODO(test) |
| §3 I2 DPO pair ordering & shape (rescue case)       | —         | —         | TODO(test) |
| §3 I2 single `chosen` line on local-success case    | —         | —         | TODO(test) |
| §3 I3 `meta` field allow-list (no `instruction`/`local_error` leak) | — | — | TODO(test) |
| §3 I4 buffered behaviour (correctness, not perf)    | —         | —         | TODO(test) |
| §3 I5 `status=rescued` filter; arbitrary value treated as no-filter | — | — | TODO(test) |
| §3 I6 `Content-Type` and `Content-Disposition` headers | —      | —         | TODO(test) |
| §2 errors row 1 — malformed payload row is skipped, others still emit | — | — | TODO(test) |
| §2 empty-result body is `""` (no leading/trailing newline) | —   | —         | TODO(test) |
| Ordering by `(run_id, id)`                          | —         | —         | TODO(test) |

### Deliberately not tested

- Filename uniqueness — `Date.now()` is informational, not a contract.
- Performance / memory ceiling — single-user tool; size is bounded by the user's own rescue history.

## 6. Drift / open questions

- **⚠️ Drift — privacy / redaction.** Exported payloads embed full `local_messages` and `rescue_messages` arrays. Those messages contain user-typed values from `fill` actions and arbitrary page text the agent read via `read_text` / `extract` (which `CLAUDE.md` flags as untrusted but does *not* flag as private). They may include credentials typed before login-detection paused the run, OTP codes, names, addresses, anything the user dictated. The same redaction concern that applies to `tickle.log` applies here, and is not addressed today. Recommendation: redact `tool_call.function.arguments` for `fill` actions and `tool_result` content for `read_text` before serialising, or document the export as PII-bearing and gate it behind an explicit confirmation in the UI.
- **⚠️ Drift — local-only is implicit.** The route has no auth, no origin check, no CORS guard specific to it. Tickle's bind to `127.0.0.1` is what makes this safe; nothing in `export.ts` enforces or documents that assumption. If `index.ts`'s host ever changes, this endpoint leaks training data. Recommendation: an explicit allow-localhost-only guard at the route level, even if redundant today.
- **⚠️ Drift — layer violation.** This file is `interface/http/routes/` but reaches directly into `infrastructure` via `import { db }` and writes prepared SQL inline. Per `_LAYERS.md`, route handlers should depend on a store interface (`infrastructure/persistence/sqliteRunStore.ts`). The query — "list `messages_export` payloads under `done` runs" — belongs as a method on that store.
- **⚠️ Drift — no `run_id` / `task_id` / date selection.** A user with months of rescue data has no way to request "just last week" or "just this task". Either add query params (`run_id`, `since`, `task_id`), or commit to "always full corpus" as the design and document it here. Today the absence is unstated.
- **⚠️ Drift — silent skip on bad JSON.** Malformed payloads vanish without a log line. Add a `trace("export.skip_malformed", { run_id, step_id })` so corrupted training rows are at least observable.
- **⚠️ Drift — buffered response.** §3 I4 documents current behaviour, but the right shape is `reply.raw.write(line + "\n")` per row with `reply.hijack()`. Trivial change; deferred until corpus size justifies it.
- **❓ Open question — `rescue_step_count` semantics.** Counted as "assistant messages in the rescue transcript", which conflates planning turns with tool-calling turns. If consumers use this as a difficulty signal, document it; if not, drop it from `meta`.
- **❓ Open question — schema versioning.** The JSONL line shape is unversioned. A future change (adding `instruction` to `meta`, switching `role` literals) breaks downstream silently. Add a `"v": 1` field to each line, or a `?v=` query parameter the route validates.
