# Spec — `observability-log`

> Path: `server/src/log.ts` · Layer: `infrastructure/observability/` (post-refactor target — `infrastructure/observability/jsonlLogger.ts`) · Spec owner: `agent.ts` (primary publisher), `routes/runs.ts` and `routes/compile.ts` (secondary publishers); operators tailing `server/data/tickle.log`

## 1. Why

Runs are long, multi-step, partly LLM-driven, and reproducibility is poor — when something goes wrong (a tool returns garbage, the model loops, a click misses, a login screen appears mid-flow) the operator needs an after-the-fact record of _what the agent saw, what it asked the model, and what the model replied_, structured enough to grep and slice. The persisted `steps` SQLite rows are the user-facing replay surface; this trace log is the lower-level operator surface — finer-grained (LLM retries, login-detect errors, snapshot failures) and append-only across server restarts. JSONL was chosen over a structured log library because it's **dependency-free**, **line-grep-able with stock OS tools** (`tail -f`, `Get-Content -Wait`, `jq`), and **tail-friendly during dev** without needing a sink process. Single-file rotation at 5 MB keeps `tail`/`Get-Content -Wait` snappy and bounds disk footprint to ~10 MB total.

> **Non-obvious why — small rotation threshold.** 5 MB is deliberately small. The dev workflow is "tail the file in another terminal while a run executes"; large logs make tools sluggish and `Get-Content -Wait` more sensitive to truncation races. A single `.log.1` backup keeps disk usage bounded (~10 MB worst-case) without trying to be a long-term archive — operators export interesting runs by copying lines out, not by retaining history in this file.
>
> **Non-obvious why — stdout mirror is compact, not JSON.** The dev terminal is for humans; the file is for `jq`. Two formats, one writer.

## 2. Public contract

### Exports

| Symbol           | Kind     | Signature / shape                                             | Stability |
| ---------------- | -------- | ------------------------------------------------------------- | --------- |
| `trace`          | function | `(event: string, ctx?: LogContext) => void` — fire-and-forget | stable    |
| `LogContext`     | type     | `{ runId?: number; [key: string]: unknown }`                  | stable    |
| `LOG_FILE`       | const    | `string` — absolute-or-relative path to the active log file   | stable    |
| `rotateIfNeeded` | —        | (intentionally not exported; internal)                        | —         |

### Output format

Every successful `trace(event, ctx)` call appends one line to `LOG_FILE`:

```
{"t":"2026-05-08T12:34:56.789Z","event":"<event>","runId":<n?>,...ctx}\n
```

- `t` is ISO-8601 UTC, always present, always first by construction.
- `event` is the second key, always a non-empty string.
- The remaining keys are spread from `ctx` after a redaction pass (default denylist: `apikey`, `authorization`, `cookie`, `password`, `token`, case-insensitive). Matched values become the literal string `[redacted]`. Recursion handles nested objects and arrays; cycles are broken with `[circular]`. The `LOG_REDACT` env var extends the denylist with comma-separated additional keys.
- Each line ends with exactly one `\n` and is itself valid JSON.

### Event vocabulary

The set of `event` strings is defined by call sites, not by this module. As of today, agent-driven runs emit (non-exhaustive — the authoritative list is `grep -n 'trace(' server/src/`):

- **Run lifecycle:** `run.start`, `run.cancel_requested`, `run.cancelled`, `run.error`, `run.done`, `run.end`, `run.force_cancelled`, `run.paused`, `run.resumed`, `run.breakpoint_pause`, `run.auto_paused_login`, `run.auto_paused_stall`, `run.rescue_requested`.
- **Block lifecycle:** `block.start`, `block.end`, `block.pause`.
- **LLM I/O (multi-turn):** `llm.request`, `llm.response`, `llm.retry`.
- **LLM I/O (stateless):** `stateless.request`, `stateless.response`, `stateless.snapshot_error`, `stateless.screenshot_error`.
- **Tool I/O:** `tool.call`, `tool.result`.
- **Subsystems:** `auto_snapshot.error`, `login_detect.error`, `questionnaire.scan`, `questionnaire.question`, `questionnaire.verify_dom`, `questionnaire.invalid_act_id`, `rescue.start`, `rescue.end`, `rescue.user_triggered`, `rescue.lesson_saved`, `rescue.lesson_failed`, `rescue.lesson_error`, `compile.ok`, `compile.error`, `compile.parse_error`.

The `runId` field is conventionally present on every per-run event but is **not enforced** by the type — `LogContext.runId` is optional.

> **⚠️ Drift — vocabulary not typed.** Event names are stringly-typed at every call site. CLAUDE.md documents a partial list (`run.start`, `llm.request`, `llm.response`, `tool.call`, `tool.result`, `run.cancel_requested`, `run.cancelled`, `run.done`, `run.error`, `run.end`) — that subset is a strict undercount of what actually flows. Post-refactor, hoist a `TraceEventKind` union and a per-kind `LogContext` shape into `domain/observability.ts`, and have `trace` accept the union. Today, a typo in a call site (`run.startt`) would log silently.

### Errors

| Error         | Returned when                                      | Caller should…                                                                                |
| ------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| (none thrown) | log file is locked / disk full / permission denied | nothing — `trace` swallows the error so a logging failure can never crash the agent           |
| (none thrown) | rotation `statSync` / `renameSync` throws          | nothing — outer `try/catch` in `rotateIfNeeded` swallows; next call may try again             |
| (none thrown) | `ctx` contains a circular reference                | the eventual `JSON.stringify` would throw — currently uncaught in the file write path; see §6 |

## 3. Invariants

- **I1 — One line per `trace` call (success path).** A successful `trace()` writes exactly one `\n`-terminated line to `LOG_FILE`. Falsifiable: call `trace("x", { y: 1 })` against an empty file; assert file content is `<json>\n` and contains exactly one newline.
- **I2 — Each line is valid JSON.** `JSON.parse(line)` succeeds for every line ever written by `trace`. Falsifiable: write a corpus of representative `ctx` shapes (numbers, strings, nested objects, `undefined` values, `null`s) and round-trip each line.
- **I3 — `t` and `event` are always present.** Every line has a string `t` parseable as ISO-8601 and a non-empty string `event`. Falsifiable: `trace("x")` with no ctx still produces a line with both fields.
- **I4 — Logging never crashes the caller.** `trace()` returns normally even when the underlying file write fails (disk full, EACCES, file locked on Windows). Falsifiable: monkey-patch `appendFileSync` to throw; assert `trace()` does not throw and the process continues.
- **I5 — Rotation triggers at the threshold.** When `LOG_FILE` size is `>= 5 * 1024 * 1024` bytes at the start of a `trace` call, the file is renamed to `${LOG_FILE}.1` before the new line is written. Falsifiable: prepopulate `LOG_FILE` to ≥5 MB; call `trace(...)`; assert (a) `${LOG_FILE}.1` now exists, (b) `LOG_FILE` contains only the just-written line.
- **I6 — Rotation overwrites the prior backup.** When rotation triggers and `${LOG_FILE}.1` already exists, it is replaced (Node's `renameSync` overwrites on POSIX; on Windows, `renameSync` over an existing file is supported by recent Node and is the documented behaviour relied on here). Only one backup is retained. Falsifiable: rotate twice; assert `${LOG_FILE}.2` does **not** exist and `${LOG_FILE}.1` contains the _most recent_ pre-rotation contents.
- **I7 — Rotation does not split a single event.** Because rotation is checked at the _start_ of `trace` (before `appendFileSync`), no line is ever cut in half by a rotation. The line that triggered rotation lands wholly in the post-rotation `LOG_FILE`. Falsifiable: write up to (5 MB − 10 bytes), then write a line longer than 100 bytes; assert that line is entirely in the new `LOG_FILE` and not at the tail of `.log.1`.
- **I8 — Stdout mirror exists for every successful file write.** A compact one-liner is written to `console.log` in the same `trace` call. Falsifiable: capture `process.stdout`; assert exactly one write per `trace`. (Note: stdout mirror runs **even if the file write fails** — see §6.)

## 4. How (briefly)

- **Algorithm.** Synchronous: `rotateIfNeeded()` → build `entry` object (`t`, `event`, ...ctx) → `JSON.stringify` → `appendFileSync` (in `try/catch` that swallows) → build compact stdout summary → `console.log`. No async, no buffering, no batching.
- **Rotation strategy.** Size-based, single backup. On entry to each `trace` call, `statSync(LOG_PATH)` checks current size; if `>= 5 MB`, `renameSync(LOG_PATH, LOG_PATH+'.1')`. The `existsSync` check is currently a no-op — the comment says "overwrite the older rotated file", and `renameSync` does that implicitly on the platforms we support; the explicit branch is dead code. ⚠️ See §6.
- **Concurrency.** Single Node process by design (CLAUDE.md "Quirks" — only one run at a time). Within a process, `appendFileSync` is fully synchronous; there is no observable interleaving with other `trace` callers. There is no inter-process locking — running two `npm run dev:server` instances against the same `data/` directory would race on rotation. Out of scope.
- **Stdout mirror.** Compact human-readable form: `[run <id>] <event> key1=val1 key2=val2`, with each value JSON-stringified and truncated to 120 chars. Intended for the live dev terminal alongside Fastify's own logging. The file remains the canonical record.
- **Cross-platform tail.** `tail -f server/data/tickle.log` works on macOS / Linux / Git Bash / WSL; `Get-Content -Wait .\server\data\tickle.log` is the PowerShell equivalent. README §"Trace log" documents both. Both readers tolerate the rotation `rename` because they re-open by inode/path on next read; some tail implementations need `tail -F` (capital F) to follow truncation/rename — `tail -f` may stop following after rotation. Worth noting in operator docs.
- **Persistence / mutable state.** Two on-disk files (`data/tickle.log`, `data/tickle.log.1`) and the `data/` directory itself (created via `mkdirSync` at module load). No in-memory state.
- **Path resolution.** `LOG_PATH = "data/tickle.log"` is **relative to the process CWD**, not the source file. The server is conventionally launched from `server/`, which makes the effective path `server/data/tickle.log` as documented. Launching from a different CWD silently relocates the log. ⚠️ See §6.

## 5. How tested

| Spec section / claim                                       | Test file                                                                    | Test name                                                               | Status     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| §3 I1 one line per call, `\n` terminated                   | `__tests__/log.test.ts`                                                      | `writes one JSON line per call, terminated by \\n`                      | done       |
| §3 I2 every line is valid JSON                             | `__tests__/log.test.ts`                                                      | `each line parses to JSON with t (ISO) and event keys`                  | done       |
| §3 I3 `t` + `event` always present                         | `__tests__/log.test.ts`                                                      | `each line parses to JSON with t (ISO) and event keys`                  | done       |
| §3 I4 file-write failure doesn't throw                     | `__tests__/log.test.ts`                                                      | `does not throw when the underlying append fails`                       | done       |
| §3 I5 rotation triggers at ≥5 MB                           | `__tests__/log.test.ts`                                                      | `rotates to .log.1 when the file is >=5 MB at write time`               | done       |
| §3 I6 rotation overwrites prior `.log.1`                   | `__tests__/log.test.ts`                                                      | `overwrites a prior .log.1 on subsequent rotation`                      | done       |
| §3 I8 stdout mirror per call                               | `__tests__/log.test.ts`                                                      | `mirrors with [run N] prefix when runId is provided`                    | done       |
| §2.1 redaction default denylist                            | `__tests__/log.test.ts`                                                      | `redacts authorization, cookie, password, and token at the top level`   | done       |
| §2.1 redaction recurses into nested objects/arrays         | `__tests__/log.test.ts`                                                      | `recursively redacts banned keys from nested objects` / `inside arrays` | done       |
| §2.1 redaction case-insensitive                            | `__tests__/log.test.ts`                                                      | `matches denylisted keys case-insensitively`                            | done       |
| §2.1 caller's ctx not mutated                              | `__tests__/log.test.ts`                                                      | `does not mutate the caller's ctx object`                               | done       |
| §2.1 `LOG_REDACT` env var extends the denylist             | `__tests__/log.test.ts`                                                      | `honours LOG_REDACT env var to extend the denylist`                     | done       |
| §2.1 circular ctx does not throw                           | `__tests__/log.test.ts`                                                      | `survives a circular reference in ctx without throwing`                 | done       |
| §2 each documented event kind appears with the right shape | — (would need an integration harness collecting trace lines from a real run) | —                                                                       | TODO(test) |

### Deliberately not tested

- Real disk-full / permission-denied behaviour. Covered by I4's swallow contract; reproducing it portably in CI is more trouble than it's worth.
- Cross-platform rename semantics on Windows under file-lock (e.g. another process holding `tickle.log.1` open). Single-process by design; if a tail tool holds the file open during rotation the failure mode is "rotation skipped this call, retried next call" — already covered by I4.

## 6. Drift / open questions

- **Resolved — secret redaction.** `trace(event, ctx)` now applies a default denylist (`apikey`, `authorization`, `cookie`, `password`, `token`, case-insensitive) before serialising. Matched values are replaced with `[redacted]`; key names remain visible so debugging "did this code path receive an API key?" still works. The redactor recurses into nested objects and arrays, structurally clones (caller's `ctx` not mutated), and breaks cycles with `[circular]`. The `LOG_REDACT` env var extends the denylist with comma-separated additional keys. PII surface from `tool.call` / `tool.result` (user `fill` values, page extracts) is unchanged — those are signal, not secrets, and the call sites log them with intent.
- **Resolved — dead `existsSync` branch in `rotateIfNeeded` removed.** `renameSync` overwrites on POSIX and modern Windows Node, so the comment-only conditional was always a no-op.
- **⚠️ Drift — `LOG_PATH` is CWD-relative.** Documented effective path is `server/data/tickle.log` only because the server is launched from `server/`. If anyone ever runs the server from the repo root or from a different CWD, the log relocates silently and the README's tail commands stop working. Resolve to an absolute path anchored to the module location (e.g. `path.resolve(import.meta.dirname, "../data/tickle.log")`).
- **⚠️ Drift — vocabulary not typed.** See §2 — events are stringly-typed and the documented vocabulary in CLAUDE.md is a strict undercount of actual call sites. Hoist `TraceEventKind` into `domain/observability.ts` post-refactor and have `trace` accept the union.
- **Resolved — cyclic ctx handled.** The redactor structurally clones, replacing cycles with `[circular]` before `JSON.stringify` runs. Regression: `__tests__/log.test.ts`.
- **⚠️ Drift — stdout mirror runs even on file-write failure.** `console.log` runs unconditionally after the file-write `try/catch`. That's probably desirable (operator still sees the line live), but is undocumented and could surprise a caller assuming "silent on disk failure" means "silent everywhere."
- **❓ Question — should rotation be checked less often?** `statSync` runs on every `trace` call. Cost is sub-millisecond, but on a busy run with hundreds of trace calls per second it's measurable. Could amortize by checking every Nth call or by tracking `bytesWrittenSinceLastCheck` in module state. Probably not worth the complexity until profiling shows it.
- **❓ Question — should `LOG_FILE` export be the absolute resolved path?** Today it is the literal `"data/tickle.log"` constant — i.e. the same CWD-relative string the writer uses. If consumers want to read or tail the file programmatically they must resolve it themselves. Tied to the CWD-relative drift above.
