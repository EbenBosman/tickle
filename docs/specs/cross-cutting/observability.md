# Cross-cutting — observability

> Status: 📝 drafted from Phase 2 findings. No tests yet.

Tickle has three observability surfaces. Knowing which to use, and how they relate, is most of the cross-cutting story.

## The three surfaces

| Surface       | Lives in                                                         | Lifetime         | Audience                                     |
| ------------- | ---------------------------------------------------------------- | ---------------- | -------------------------------------------- |
| **Trace log** | `server/data/tickle.log` (JSONL)                                 | Forever, rotated | Operators after the fact; `tail -f` / `jq`   |
| **DB steps**  | `steps` table (per [`persistence.md`](../server/persistence.md)) | Forever          | UI replay on reconnect; long-term inspection |
| **SSE bus**   | `bus.ts` → `GET /api/runs/:id/stream`                            | Run lifetime     | UI live-updating while a run is active       |

All three are populated by `agent.ts` (per [`server/agent.md`](../server/agent.md) §2 contract). The same logical event often lands in multiple surfaces — **but not all events go everywhere.**

## Event vocabulary — single source of truth (target)

Today the event set is implicit and spread across:

- `bus.ts::AgentEvent` (publisher type)
- `db.ts::Step["kind"]` (persistence type)
- `RunView.tsx` event-switch (consumer)
- `log.ts` trace event names (string-untyped)
- CLAUDE.md "SSE event stream" section (docs)

These five lists disagree with each other. Specifically:

- `Step["kind"]` lists 5 kinds; agent persists 9 (`block_start`, `block_end`, `var_set`, `remember` missing). [`persistence.md`](../server/persistence.md), [`agent.md`](../server/agent.md).
- `AgentEvent` includes `resumed` but the agent never publishes it — `routes/runs.ts` does.
- `page_state` and `stats` are advertised in CLAUDE.md as persisted but they aren't — live-only. [`agent.md`](../server/agent.md).
- Web client `Step["kind"]` mirror is narrower again. [`api-client.md`](../web/api-client.md).
- Trace logger's event vocabulary is ~30 names, untyped — far broader than CLAUDE.md describes. [`observability-log.md`](../server/observability-log.md).

**Target:** `domain/run.ts` exports a single `SseEvent` discriminated union. `bus.ts` carries it; `agent.ts` emits it; `db.ts` types `Step["payload"]` against it; `RunView.tsx` switches on it. A single `TraceEventKind` union does the same for `log.ts`. Type drift becomes a compile error.

## Event matrix (current behaviour)

For each event, where it lands today. ✅ = lands; ⛔ = does not.

| Event         | SSE | DB `steps` | Trace log | Notes                                                 |
| ------------- | --- | ---------- | --------- | ----------------------------------------------------- |
| `block_start` | ✅  | ✅         | ✅        |                                                       |
| `block_end`   | ✅  | ✅         | ✅        | 🔴 emitted twice on rescue success                    |
| `thought`     | ✅  | ✅         | ⛔        |                                                       |
| `tool_call`   | ✅  | ✅         | ✅        |                                                       |
| `tool_result` | ✅  | ✅         | ✅        |                                                       |
| `var_set`     | ✅  | ✅         | ✅        | `Step["kind"]` type doesn't include this              |
| `remember`    | ✅  | ✅         | ✅        | `Step["kind"]` type doesn't include this              |
| `page_state`  | ✅  | ⛔         | ⛔        | 🟠 reconnects miss it (CLAUDE.md says it's persisted) |
| `stats`       | ✅  | ⛔         | ⛔        | 🟠 reconnects miss it                                 |
| `paused`      | ✅  | ✅         | ✅        |                                                       |
| `resumed`     | ✅  | ✅         | ✅        | Emitted by routes, not agent                          |
| `error`       | ✅  | ✅         | ✅        |                                                       |
| `final`       | ✅  | ✅         | ✅        |                                                       |
| `end`         | ✅  | ⛔         | ✅        | End marker — bus deletes topic 5s after               |

## Rotation, redaction, retention

### Trace log

- Rotation: 5 MB threshold, single backup `.log.1` (overwritten). [`observability-log.md`](../server/observability-log.md).
- Single backup is intentional — bounds disk to ~10 MB.
- **Redaction (resolved).** `trace()` applies a default denylist (`apikey`, `authorization`, `cookie`, `password`, `token`, case-insensitive) before serialising; matched values become `[redacted]`. Recurses into nested objects and arrays, structurally clones (caller's `ctx` not mutated), and breaks cycles with `[circular]`. The `LOG_REDACT` env var extends the denylist with comma-separated additional keys. Regression: `server/src/__tests__/log.test.ts`.

### DB `steps`

- Retention: forever. Cascades on task delete (per `persistence.md`).
- 🟠 PII surface: `tool_call`/`tool_result` payloads can include user-typed `fill` values and page extracts. Same redaction concern as logs.
- Export endpoint at `/api/export` ([`http-export.md`](../server/http-export.md)) drains these as JSONL training data — same PII flows downstream unless redacted.

### SSE bus

- Lifetime: until `endTopic` (called 5s after `end` per `routes/runs.ts`). Subscribers don't get a buffered backlog — they get future events plus replay from DB.
- 🟠 Replay-then-subscribe race in `bus.ts`. Window between SQLite read and `subscribe()` can drop events. [`event-bus.md`](../server/event-bus.md).

## Correlation across surfaces

Today there is **no shared correlation ID** beyond `runId`. Within a run:

- `step_id` is the DB primary key; trace log doesn't include it.
- `block_id` is on every event but not consistently echoed in trace.
- The trace `t` timestamp and the DB `created_at` should agree, but no test enforces that.

**Target:** every event carries `{ run_id, step_id, block_id?, t }` end-to-end. Trace and DB share the same `step_id` (allocate at emit time, not on insert). Frontend can deep-link `?run=N&step=M`.

## Operator workflows (today)

- **Tail live:** `tail -f server/data/tickle.log` (POSIX/Git Bash/WSL) or `Get-Content -Wait .\server\data\tickle.log` (PowerShell). README describes this.
- **Filter by event:** `tail -f server/data/tickle.log | jq 'select(.event=="tool.call")'`.
- **Re-attach to a run mid-flight:** open the run in the UI; SSE replays persisted steps then subscribes live. The reconnect synthetic-`paused` event comes from `routes/runs.ts`, not the bus. [`http-runs.md`](../server/http-runs.md).

## How tested (target)

- Unit: trace event has the same payload shape as the SSE event for the same kind.
- Unit: redaction denylist suppresses each banned key.
- Integration: a known synthetic run produces the expected event-matrix rows in DB / trace / SSE; cross-surface correlation IDs match.
- Property: every `SseEvent` variant round-trips through `JSON.stringify` and `JSON.parse` lossless.
