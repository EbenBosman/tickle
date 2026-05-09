# Spec — `llm-client`

> Path: `server/src/llm.ts` (+ `chatWithRetry` at `server/src/infrastructure/llm/chatWithRetry.ts`) · Layer: `infrastructure/llm/` (post-refactor target — `infrastructure/llm/openaiCompatClient.ts`, `infrastructure/llm/anthropicClient.ts`) · Spec owner: `agent.ts` (multi-turn sub-agent loops + rescue), `routes/compile.ts` (stateless one-shot)

## 1. Why

The agent talks to whatever model the user has running locally — LM Studio, Ollama, vLLM, SGLang, llama.cpp — or, when the local model can't make progress, falls back to the Anthropic API directly. Each provider speaks a slightly different protocol (OpenAI-compat tool-call shape, Anthropic content-block shape, message ordering rules), each emits different usage telemetry, and each has its own quirks around thinking-mode, image attachments, and cancellation. This module is the **single seam** that hides those differences from `agent.ts`: callers exchange a normalized `Message[]` / `ChatResponse` and never see provider-specific shapes.

> **Non-obvious why — provider neutrality is load-bearing.** CLAUDE.md, "Things to avoid": _"Do not re-introduce a runtime-specific LLM client. `llm.ts` is OpenAI-compatible on purpose — it lets users swap between Ollama, LM Studio, vLLM, SGLang, etc. by env var. If you find yourself adding `import { Ollama }` or similar, stop and figure out how to do it through the `chatOnce` wrapper instead."_ Adding an Ollama-specific client (e.g. for richer stats) would lock the project to one backend and break the user's ability to point at any OpenAI-compatible server. Anthropic is the _only_ permitted second client because the API is fundamentally non-compatible (different content-block model, no `/v1/chat/completions` endpoint).
>
> **Non-obvious why — thinking-mode toggle.** Qwen3.x emits `<think>...</think>` chain-of-thought by default, which is pure latency for _stateless atomic_ steps (extract a value, verify a DOM state, answer a single questionnaire question). For _multi-turn_ planning loops (`runAiSubGoal`: goal/click/fill blocks) the thinking actually improves the next-action choice, so it stays on. The flag is conveyed via `chat_template_kwargs.enable_thinking: false` — recognised by Qwen3.x running under LM Studio or Ollama's `/v1` endpoint, silently ignored by every other backend. The toggle is therefore _opportunistic_, not a correctness requirement.
>
> **Non-obvious why — image pruning is a context-budget tactic, lives in agent.ts.** Screenshots are 50–200 KB base64 each; keeping all of them blows out the prompt cache long before the 32k window. `pruneOldImages` (in `agent.ts`, not here) keeps the last `KEEP_RECENT_IMAGES` (default 3) screenshots' image bytes and replaces older ones with a text marker. This module is unaware of the policy — it just serializes whatever `images` array each `Message` carries.

## 2. Public contract

### Exports

| Symbol               | Kind     | Signature / shape                                                                                                                      | Stability                                                                   |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `LLM_BASE_URL`       | const    | `string` — defaults to `"http://127.0.0.1:1234/v1"` (LM Studio)                                                                        | stable                                                                      |
| `MODEL`              | const    | `string` — defaults to `"qwen3.6-27b-uncensored-hauhaucs-balanced"`; honours `LLM_MODEL` then `OLLAMA_MODEL`                           | stable                                                                      |
| `CONTEXT_WINDOW`     | const    | `number` — UI-only gauge value; defaults to `32768`                                                                                    | stable                                                                      |
| `LlmClient`          | type     | `{ provider: "openai"; client: OpenAI } \| { provider: "anthropic"; client: Anthropic }`                                               | stable                                                                      |
| `Message`            | type     | `{ role: "system"\|"user"\|"assistant"\|"tool"; content: string; images?: string[]; tool_calls?: ToolCall[] }`                         | stable                                                                      |
| `ToolCall`           | type     | `{ function?: { name?: string; arguments?: Record<string, unknown> } }`                                                                | stable                                                                      |
| `ChatOptions`        | type     | `{ model; messages; tools?; temperature?; think?; signal? }`                                                                           | stable                                                                      |
| `ChatResponse`       | type     | `{ message: { content; tool_calls }; usage: { prompt_tokens; completion_tokens }; duration_ms }`                                       | stable                                                                      |
| `newLlmClient`       | function | `() => LlmClient` — chooses provider from `LLM_PROVIDER` env (`"anthropic"` ⇒ Anthropic, else OpenAI-compat)                           | stable                                                                      |
| `newAnthropicClient` | function | `() => LlmClient` — always Anthropic; for the rescue path, independent of primary provider. Model is per-call via `ChatOptions.model`. | stable                                                                      |
| `chatOnce`           | function | `(client: LlmClient, opts: ChatOptions) => Promise<ChatResponse>` — one round-trip, cancellable                                        | stable                                                                      |
| `toAnthropic`        | function | `(messages: Message[]) => { system: string; messages: AnthropicMessage[] }` — exported for testability                                 | evolving                                                                    |
| `chatWithRetry`      | function | `(client, request, isCancelled, setActiveController, onRetry) => Promise<ChatResponse>` — at `infrastructure/llm/chatWithRetry.ts`     | stable                                                                      |

### Image attachment shape

- `Message.images` is `string[]` of **raw base64-encoded PNG bytes** (no `data:` prefix).
- OpenAI-compat path serializes each as `{ type: "image_url", image_url: { url: "data:image/png;base64,<b64>" } }` and only when role is `user` or `system`.
- Anthropic path serializes each as `{ type: "image", source: { type: "base64", media_type: "image/png", data: <b64> } }` on `user` messages only.
- URL-form (`http(s)://...` images) is **not supported** — if a future caller needs it, extend the `Message` shape rather than overloading the existing `images` field.

### Tool-call format (internal normalized)

- Assistant turn carries `tool_calls: ToolCall[]`, each `{ function: { name, arguments } }` where `arguments` is an **already-parsed object** (not a JSON string). The OpenAI converter re-serializes; `safeParseArgs` parses on the way back, falling back to `{}` on malformed JSON.
- Subsequent `role: "tool"` messages carry the result `content` as a string. There is no per-call ID in the internal shape — Anthropic correlation is reconstructed positionally (`toolu_<msgIdx>_<callIdx>`) inside `toAnthropic`.
- Consecutive `role: "tool"` messages are batched into one Anthropic `user` turn (Anthropic API requirement).

### AbortSignal seam

- `ChatOptions.signal?: AbortSignal` is forwarded to both providers' SDKs as the second-arg request option (`{ signal }`). Aborting the controller cancels the in-flight HTTP request.
- `chatWithRetry` (caller-side) creates a fresh `AbortController` per attempt and stores it via `setActiveController` so the run's `cancelRun()` can call `controller.abort()` from `cancel.ts`. See `docs/specs/server/run-control-cancel.md`.

### Errors

| Error                                  | Returned when                                      | Caller should…                                                                                                  |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Provider SDK error (network, 4xx, 5xx) | upstream LLM call fails                            | classified by `isTransientLLMError` regex; retried by `chatWithRetry` for transient kinds, otherwise propagated |
| `AbortError` / `aborted` (signal)      | `signal.abort()` was called                        | `chatWithRetry` checks `isCancelled()` first and converts to a final cancellation; never retried                |
| Malformed tool-call arguments JSON     | local model returned non-JSON `function.arguments` | swallowed by `safeParseArgs`; tool receives `{}` and likely fails its own validation                            |

## 3. Invariants

- **I1 — Provider abstraction is total at the boundary.** `chatOnce`'s return type is identical regardless of provider. `agent.ts` never branches on `client.provider`. Falsifiable: grep for `client.provider` in `agent.ts` — should be empty.
- **I2 — `images` only attach where the provider accepts them.** OpenAI-compat: `user`/`system` only. Anthropic: `user` only. Falsifiable: build a `Message[]` with images on an `assistant` role; assert the converted payload contains no image blocks.
- **I3 — Tool-call arguments survive the round-trip as objects, not strings.** Falsifiable: send a `Message` with `tool_calls: [{ function: { name: "x", arguments: { a: 1 } }}]`; converter emits a JSON-string `arguments`; response parser recovers the object.
- **I4 — `chat_template_kwargs.enable_thinking: false` is sent only when `opts.think === false`.** When `think` is `true` or unset, the field is absent. Anthropic ignores `think` entirely (no equivalent flag wired). Falsifiable: spy on the request body for both branches.
- **I5 — `duration_ms` is wall-clock, measured by us.** Set from `Date.now()` at call entry/exit, independent of any provider-reported timing. Falsifiable: stub the SDK to delay 50ms; assert `duration_ms ≥ 50`.
- **I6 — `chatOnce` is cancellable mid-flight.** When `opts.signal` aborts, the SDK call rejects and `chatOnce` propagates without further work. Falsifiable: kick off `chatOnce`, abort after 10ms, assert the promise rejects within a small bound.
- **I7 — Empty / missing usage fields default to `0`, never `undefined`.** OpenAI-compat path: `prompt_tokens ?? 0`, `completion_tokens ?? 0`. Falsifiable: stub a response with no `usage` field; assert numeric zeros.
- **I8 — System messages are extracted, not duplicated, on the Anthropic path.** All `system` content is concatenated into the top-level `system` parameter; no `system`-role message survives in `messages[]`. Falsifiable: convert a transcript with two system messages; assert the resulting `messages[]` has none and `system` contains both joined by `\n`.
- **I9 — `chatWithRetry` retries only `isTransientLLMError`-classified failures.** Non-transient errors propagate on the first attempt. Cancellation short-circuits before any retry. Falsifiable: throw a `400 Bad Request`; assert single attempt. Throw `fetch failed`; assert two attempts at 1.5s and 4s before giving up.

## 4. How (briefly)

- **Algorithm.** `chatOnce` branches on `client.provider`, runs the appropriate converter (`toOpenAI` or `toAnthropic` + `toAnthropicTools`), calls the SDK with `{ signal }`, and remaps the response back to `ChatResponse`. No state, no I/O beyond the SDK call.
- **Retry policy (`infrastructure/llm/chatWithRetry.ts`).** Backoffs `[1500, 4000]` ms (i.e. up to 2 retries → max 3 attempts total). Classifier regex: `/fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted by/i`. Cancellation is checked at the top of each attempt loop and after each failure; a cancelled run never sleeps the backoff. ⚠️ See §6 for classifier-vs-CLAUDE.md drift.
- **Anthropic-only mechanics.** `toAnthropic` is a small state machine that (a) hoists `system` messages to a top-level string, (b) groups consecutive `tool` messages into one `user` turn with `tool_result` blocks, (c) assigns deterministic positional `toolu_<i>_<k>` IDs to assistant `tool_use` blocks so the next turn's `tool_result` can reference them. `max_tokens` is hard-coded to `8192`; `temperature` defaults to `0.2` (matching the OpenAI-compat default).
- **OpenAI-compat path** uses the official `openai` SDK pointed at an arbitrary `baseURL`. The `chat_template_kwargs` extension is non-standard but accepted as a passthrough by LM Studio and Ollama's `/v1` endpoint; vLLM/SGLang ignore unknown body keys. No special-casing required.
- **Per-backend stats.** This module reports only what the OpenAI/Anthropic SDK responses expose: `prompt_tokens`, `completion_tokens`, and our own `duration_ms`. **Ollama-specific** fields (`prompt_eval_count`, `eval_count`, `eval_duration` in nanoseconds) mentioned in CLAUDE.md "Quirks" do not flow through `chatOnce` — `agent.ts` derives `tps` from `(completion_tokens / duration_ms) * 1000` instead. LM Studio recent builds may surface similar fields in `usage` but we don't read them. ⚠️ See §6.
- **Persistence / mutable state.** None. Stateless function calls; clients are created on demand by `newLlmClient` / `newAnthropicClient` and held by `agent.ts` for the life of a run.
- **Concurrency model.** Single in-flight call per run (one `AbortController` registered at a time via `setActiveController`). Multiple runs would each have their own client and controller, but tickle today executes one run at a time (CLAUDE.md "Quirks").

## 5. How tested

| Spec section / claim                                                | Test file | Test name | Status                                        |
| ------------------------------------------------------------------- | --------- | --------- | --------------------------------------------- |
| §3 I1 no `client.provider` checks leak into `agent.ts`              | —         | —         | TODO(test) — static grep assertion            |
| §3 I2 image attachments only on permitted roles                     | —         | —         | TODO(test)                                    |
| §3 I3 tool-call arguments object round-trip                         | —         | —         | TODO(test)                                    |
| §3 I4 `enable_thinking` only present when `think === false`         | —         | —         | TODO(test)                                    |
| §3 I5 `duration_ms` is wall-clock                                   | —         | —         | TODO(test)                                    |
| §3 I6 abort mid-flight rejects promptly                             | —         | —         | TODO(test)                                    |
| §3 I7 missing `usage` defaults to zeros                             | —         | —         | TODO(test)                                    |
| §3 I8 `toAnthropic` extracts system + groups tool turns             | —         | —         | TODO(test) — pure function, easy unit test    |
| §3 I9 `chatWithRetry` classifier + backoff schedule                 | —         | —         | TODO(test) — fake-timers + stubbed `chatOnce` |
| §2 OpenAI-compat tool-call shape (id format, JSON-stringified args) | —         | —         | TODO(test)                                    |
| §2 Anthropic positional `toolu_<i>_<k>` correlation                 | —         | —         | TODO(test)                                    |

### Deliberately not tested

- Real upstream LLM calls. Covered by the manual smoke runner (point at a live LM Studio / Ollama / Anthropic key and execute a canned task).
- Per-backend body-shape compatibility for vLLM / SGLang / llama.cpp. We rely on those servers' OpenAI-compat claims; verifying each is out of scope for unit tests.
- `KEEP_RECENT_IMAGES` pruning — lives in `agent.ts`, will move to its own `infrastructure/llm/pruneImages.ts` spec post-refactor.

## 6. Drift / open questions

- **⚠️ Drift — CLAUDE.md defaults are stale.** CLAUDE.md states _"Default config is `qwen3.6:27b` against Ollama at `http://127.0.0.1:11434/v1`"_ and the env-var section repeats those defaults. The actual fallbacks in `llm.ts:21-25` and `server/.env.example` are now **LM Studio**: `http://127.0.0.1:1234/v1` and `qwen3.6-27b-uncensored-hauhaucs-balanced`. The README/CLAUDE.md needs to follow.
- **⚠️ Drift — `LLM_PROVIDER` is undocumented in CLAUDE.md.** The "Env vars" subsection lists `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` but not `LLM_PROVIDER` (which selects Anthropic vs OpenAI-compat). Add it.
- **Resolved — `chatWithRetry` relocated.** Now at `server/src/infrastructure/llm/chatWithRetry.ts` along with `RETRY_BACKOFFS_MS`, `isTransientLLMError`, and `ChatRequest`. Regression: `__tests__/chatWithRetry.test.ts`.
- **⚠️ Drift — transient-error classifier is broader than CLAUDE.md claims.** CLAUDE.md "Guardrails" lists `fetch failed`, `ECONN*`, `ETIMEDOUT`, `socket hang up`. The actual regex also matches `EAI_AGAIN`, `network`, and — load-bearingly — `aborted by`. The `aborted by` clause is dangerous: a user-cancellation that surfaces as `"aborted by user"` could be classified transient and retried _if_ `isCancelled()` returns false at the moment of the check. The order-of-operations in `chatWithRetry` (`isCancelled()` checked first) defends against this in practice, but the classifier itself shouldn't include cancellation patterns.
- **Resolved drift** — `newAnthropicClient(model)` previously accepted a `model` argument that was silently dropped; the model has always been per-call via `ChatOptions.model`. The parameter has been removed. Regression: `server/src/__tests__/llm.test.ts`.
- **⚠️ Drift — `KEEP_RECENT_IMAGES` location.** The image-prune policy is described in CLAUDE.md as part of the "Sub-agent loop" but the implementation lives in `agent.ts` (`pruneOldImages`). This module knows nothing about the budget; a future `infrastructure/llm/pruneImages.ts` should own it so that _every_ call site (compile route, rescue path, future utilities) gets the same policy automatically.
- **❓ Question — should `chatOnce` surface backend-native stats when present?** Today we discard Ollama's `prompt_eval_count` / `eval_duration`. Adding optional `ChatResponse.backendStats?: { prompt_eval_count?, eval_count?, eval_duration_ns? }` would let the UI show authoritative tok/s on Ollama without re-introducing an Ollama-specific client (the OpenAI SDK exposes `extra` fields if we ask). Trade-off: adds a barely-typed surface that varies by backend.
- **❓ Question — should `temperature` default differ per provider?** Hard-coded to `0.2` for both. Anthropic's models behave fine at this; some local backends benefit from `0.0` for tool-use determinism. Worth measuring.
- **❓ Question — is `max_tokens: 8192` the right Anthropic cap?** Today's Sonnet/Opus accept much more. 8192 was chosen to cap cost during rescue; revisit when the rescue UX has settled.
- **🔒 SECURITY — `LLM_API_KEY` and `ANTHROPIC_API_KEY` are read directly from `process.env`.** No redaction in error paths; if a provider error message ever echoed the key (rare but possible), it would flow to the trace log via `agent.ts`'s `trace("llm.response"/"llm.retry"/...)` calls. See `observability-log.md` §6 for the broader logging-redaction gap.
