# Spec — `loadEnv`

> Path: `server/src/loadEnv.ts` · Layer: `interface/` (bootstrap) · Spec owner: `server/src/index.ts` (must import this first); transitively, every module that captures `process.env.*` into a top-level `const`.

## 1. Why

`server/src/index.ts` and its dependency graph snapshot environment variables into module-level constants at evaluation time (`llm.ts` line 21–25 captures `LLM_BASE_URL`, `MODEL`, `CONTEXT_WINDOW`; `index.ts` line 11 captures `PORT`). ES module evaluation order is dependency order, so unless something runs _before_ those modules are imported, their fallbacks lock in and an existing `server/.env` file is silently ignored. `loadEnv.ts` exists as the very first import in `index.ts` to populate `process.env` from `server/.env` before any other module is evaluated. Doing it as a side-effecting import (rather than a function the entry point must remember to call) makes the load-order guarantee a property of the module graph itself.

> **Non-obvious why:** anyone adding a new top-level `const X = process.env.FOO ?? "fallback"` in a freshly-imported module has, by extension, made `loadEnv` part of their contract. If the new module is imported before `loadEnv` (e.g. transitively from a config file pulled in earlier), the fallback wins and `.env` is invisible. The fix is always "import `./loadEnv.ts` first," not "rewrite the loader."
> **Non-obvious why:** `.env` is gitignored (`/.gitignore` lines 19–25). The committed defaults in `.env.example` and the in-source fallbacks must independently produce a working dev setup, because a fresh clone has no `.env`.

## 2. Public contract

### Exports

| Symbol                           | Kind | Signature / shape                                                                           | Stability |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------- | --------- |
| _(none — side-effecting module)_ | —    | `import "./loadEnv.ts";` populates `process.env` as a side effect at module-evaluation time | stable    |

The module has no named exports. Importers depend exclusively on its evaluation-order side effect.

### Environment variables read from `.env`

The loader does not validate or know about specific keys — it copies every `KEY=VALUE` line into `process.env`. The keys actually consumed downstream (so the loader's job is to make these visible) are:

| Name                 | Default (when unset)                       | Consumed in            | Notes                                                              |
| -------------------- | ------------------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| `PORT`               | `8787`                                     | `server/src/index.ts`  | Fastify listen port.                                               |
| `LLM_BASE_URL`       | `http://127.0.0.1:1234/v1`                 | `server/src/llm.ts`    | LM Studio default; Ollama uses `:11434/v1`.                        |
| `LLM_MODEL`          | `qwen3.6-27b-uncensored-hauhaucs-balanced` | `server/src/llm.ts`    | Falls through to legacy `OLLAMA_MODEL` before the literal default. |
| `LLM_API_KEY`        | `not-needed`                               | `server/src/llm.ts`    | OpenAI client requires _something_; most local servers ignore it.  |
| `LLM_CONTEXT_WINDOW` | `32768`                                    | `server/src/llm.ts`    | UI gauge only.                                                     |
| `HEADED`             | `true`                                     | agent / browser config | Headed Chromium by default.                                        |
| `MAX_AGENT_STEPS`    | (per agent config)                         | agent                  | Per-block step ceiling.                                            |
| `KEEP_RECENT_IMAGES` | `3`                                        | LLM client             | Image-pruning window.                                              |
| `ANTHROPIC_API_KEY`  | _(empty / disabled)_                       | `server/src/llm.ts`    | Required for Claude rescue feature; blank disables it.             |

### Errors

| Error    | Returned when                                                   | Caller should… |
| -------- | --------------------------------------------------------------- | -------------- |
| _(none)_ | Missing `.env` is not an error — defaults apply silently.       | —              |
| _(none)_ | Malformed lines (no `=`, comments, blank) are skipped silently. | —              |

The loader never throws. ENOENT silently skips to the next candidate path. Other IO errors (EACCES, EISDIR, etc.) are logged via `console.error` and skipped — startup proceeds with downstream defaults.

## 3. Invariants

- **I1 — Load-order:** `loadEnv` finishes evaluating before any other module in the dependency graph reads `process.env` at top level. Enforced by `server/src/index.ts` importing `./loadEnv.ts` as its first statement; any module that ends up in the graph before `loadEnv` (e.g. transitively imported by a future config file evaluated earlier) breaks this invariant.
- **I2 — Existing values win:** if `process.env[key]` is already defined (anything other than `undefined`) when `loadEnv` runs, the value from `.env` is **discarded**. This is the inverse of `dotenv`'s default and intentional — it lets callers override via shell (`LLM_MODEL=foo npm run dev:server`) without editing `.env`. An empty string in `process.env` is _defined_ and therefore preserved, not overwritten.
- **I3 — Missing file is graceful:** if `.env` does not exist (`existsSync(".env") === false`), the loader is a no-op. Defaults from downstream `??` fallbacks apply.
- **I4 — Resolution is module-anchored:** the loader resolves candidate paths via `import.meta.url`, walking `server/.env` then the repo-root `.env`. CWD-independent — the server can be launched from anywhere. The first candidate that exists wins.
- **I5 — Single-pass, no expansion:** the loader does not perform variable expansion (`${VAR}`), multi-line values, comment-on-same-line stripping, or escape sequences. Only outer matching single or double quotes around the entire trimmed value are stripped.
- **I6 — Idempotent re-import:** ES module caching means the side effect runs exactly once per process. Re-importing the module does not re-read `.env`.

## 4. How (briefly)

- **Algorithm:** walks candidate paths anchored at `import.meta.url` (`server/.env` then repo-root `.env`). For the first existing file, read it as UTF-8, split on `\n`, and for each line: trim; skip blank or `#`-prefixed; split on the first `=`; trim key and value; strip outer matching quotes (`"…"` or `'…'`); assign to `process.env[key]` **only if currently `undefined`**.
- **No dependency:** does not use `dotenv` or any other package — pure `node:fs` (`existsSync`, `readFileSync`). This avoids dragging a transitive dependency tree into the bootstrap path and keeps the load-order guarantee simple to reason about.
- **Path handling:** module-anchored via `import.meta.url`, so `cd` location and Windows / macOS / Linux all behave the same.
- **No mutable state of its own:** the only side effect is on `process.env`. No exports, no internal cache, no logging.

## 5. How tested

| Spec section / claim                                                                            | Test file | Test name | Status     |
| ----------------------------------------------------------------------------------------------- | --------- | --------- | ---------- |
| §3 I1 — load-order: `loadEnv` runs before `llm.ts` captures constants                           | —         | —         | TODO(test) |
| §3 I2 — existing `process.env[key]` is not overwritten by `.env`                                | —         | —         | TODO(test) |
| §3 I3 — missing `.env` is a graceful no-op (no throw)                                           | —         | —         | TODO(test) |
| §3 I4 — `.env` is resolved via `import.meta.url`, walking `server/.env` then repo-root `.env`    | `__tests__/loadEnv.test.ts` | candidate-walk cases | done       |
| §3 I5 — outer matching quotes stripped; comments and blanks skipped; `=` inside value preserved | —         | —         | TODO(test) |
| §6 — non-ENOENT IO errors logged and skipped (no crash)                                         | `__tests__/loadEnv.test.ts` | EACCES / EISDIR cases | done       |

### Deliberately not tested

- The full env-var schema in §2 — those defaults are exercised by `llm.ts` / `index.ts` specs, not here. `loadEnv` itself is key-agnostic.

## 6. Drift / open questions

- **Resolved — cwd dependency removed.** Path resolution is anchored at `import.meta.url` and walks `server/.env` then the repo-root `.env`. Regression: `__tests__/loadEnv.test.ts`.
- **Resolved — non-ENOENT IO errors no longer crash.** ENOENT silently skips to the next candidate; EACCES / EISDIR / other IO errors are logged via `console.error` and skipped. Regression: `__tests__/loadEnv.test.ts`.
- ❓ **Question — should override semantics be inverted?** I2 is "shell wins, .env loses," matching the project's "set `LLM_MODEL=foo` ad-hoc" workflow. `dotenv`'s default is the opposite. If this module is ever swapped for `dotenv`, the override flag must be set explicitly to preserve I2.
