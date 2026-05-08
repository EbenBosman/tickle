# Cross-cutting — testing strategy

> Status: 📝 drafted from Phase 2 findings. **No tests exist yet.** Phase 3 stands them up.

The codebase has zero tests today. Phase 3 changes that. This document is the contract for *how* tests get written, not which ones get written first (the per-module specs hold that, in their `TODO(test)` rows).

## Three tiers, one runner

We use **Vitest** for everything testable.

| Tier            | What it tests                                                  | Speed  | When it runs                |
|-----------------|----------------------------------------------------------------|--------|------------------------------|
| **Unit**        | Pure modules: types, value objects, classifiers, parsers.      | <50ms  | Every save · every commit    |
| **Integration** | Multiple modules together with mocked LLM / mocked Page.       | <2s    | Every push · pre-merge       |
| **Smoke**       | The whole stack against a real LLM and real Chromium.          | minutes | Manually before a release    |

Smoke is **not** a CI gate. It's a "did I break the world" sanity check.

## Determinism rules

> *Per `.claude/skills/tdd/SKILL.md`:* "Hits the real LLM / real browser / real network → integration test, not unit. Live behind a separate runner and don't gate the inner loop on it."

- **No real network in unit or integration tests.** All `fetch` calls and OpenAI / Anthropic SDK calls go through fakes.
- **No real Playwright browser in unit or integration tests.** The `Session` interface (per [`browser.md`](../server/browser.md)) is the seam; integration tests use a fake `Session` or Playwright's `setContent` against an in-memory `BrowserContext` (still Playwright, but no real navigation).
- **No real time.** `vi.useFakeTimers()` for anything testing retries, debounces, or the elapsed-time UI.
- **No real RNG.** Stub `crypto.randomUUID` when block IDs matter for assertion stability.
- **No real filesystem in unit tests.** Use `memfs` or `vi.mock("fs")`. Integration tests can use a `mkdtemp` workspace cleared in `afterEach`.

## What to mock at the boundary

| Module                  | Substitute in tests with                                       |
|-------------------------|----------------------------------------------------------------|
| `infrastructure/llm/`   | A `FakeLlmClient` returning scripted `ChatResponse[]`.         |
| `infrastructure/browser/` | A `FakeSession` exposing `screenshot()`, `evaluate()`, etc.  |
| `infrastructure/persistence/` | An in-memory SQLite (`:memory:`); schema initialised per test. |
| `infrastructure/observability/` | Spy collectors that record `trace()` calls and SSE publishes. |
| `interface/http/`       | Fastify `app.inject()` — no real HTTP listener.                |
| `bus.ts`                | Real implementation; trivially testable in-process.            |
| `pause.ts`, `cancel.ts` | Real implementation; pure registry over `Map`.                 |

## Spec ↔ test mapping

Every test header declares the spec claim it enforces:

```ts
// docs/specs/server/run-control-pause.md §3 invariant 1
it("calling pauseRun twice on the same id is a no-op", () => { ... });
```

The `TODO(test)` rows in each module spec are the test backlog. Phase 3 starts with the easiest: leaf modules with deterministic behaviour and no external dependencies.

## Test layout

```
server/src/
├── domain/
│   └── __tests__/
│       └── blocks.test.ts
├── application/
│   └── __tests__/
│       └── runAgent.test.ts
└── infrastructure/
    └── browser/
        └── __tests__/
            └── snapshot.test.ts

web/src/
├── domain/__tests__/
├── state/__tests__/
└── features/<feature>/__tests__/
```

Tests live next to the code under `__tests__/` (conventional Vitest layout). Integration tests that span layers go to `<workspace>/test/integration/`.

## Coverage policy

We track coverage but don't gate on a number. Coverage drops are PR-review questions ("you removed the only test for X — intentional?"), not CI failures. Hard gates breed cargo-cult tests.

The exceptions:
- Anything in `domain/` ought to be near 100% — it's pure types and value objects.
- Every `🔴 blocker` finding from Phase 2 (see [`README.md`](../README.md) "Open findings") gets a regression test as part of its fix. No silent re-introduction.

## Architecture tests

Beyond behaviour tests, we keep two **import-graph tests** (Vitest, but executed against the project's TypeScript AST):

1. **Layer boundaries.** Per [`_LAYERS.md`](../_LAYERS.md): `domain/` may not import from `application/`, `infrastructure/`, or `interface/`; `infrastructure/` may not import from `interface/`; etc. Each violation is a named test failure.
2. **No god files.** A test fails if any file under `server/src/` or `web/src/` exceeds 400 lines. (Generous; `agent.ts` blows it today, that's the point.) Cleared incrementally as Phase 4–5 lands.

## TDD discipline (recap from skill)

For every behavioural change:

1. **🔴 Red** — write a failing test that maps to a spec claim. Run it. Confirm assertion-failure, not import-error.
2. **🟢 Green** — minimum production change to pass. Run the *full* suite, not just the new test.
3. **🧹 Refactor** — improve the code with the safety net. Re-run after every meaningful edit.

One cycle = one commit. The diff should be small enough to review in two minutes.

The slash commands `/spec` and `/tdd` (see `.claude/commands/`) drive this loop. The subagents `spec-writer` and `test-writer` (in `.claude/agents/`) are the helpers.

## When tests don't help

- **UI feature correctness:** type-checking and tests verify code, not whether the feature *feels* right. Per CLAUDE.md "Tasks": for UI changes, start the dev server and use the feature in a browser before reporting it done. If the test can't be written, say so explicitly rather than claim success.
- **Cross-LLM behaviour:** a test that pins exact Claude or Qwen output is a flake waiting to happen. Test the *shape* of the contract (tool was called with these args; finish was triggered with these fields) — not the exact text.
- **Browser-vs-site brittleness:** if a test fails because a real website changed its DOM, it's a smoke test, not a unit test. Move it to the manual smoke list.

## Phase 3 starting order

When Phase 3 begins (test scaffolding), tackle in this order — easiest first, both for the pleasure of momentum and to validate the harness on simple cases before going hard:

1. **`pause.ts`, `cancel.ts`, `bus.ts`** — pure registries, all invariants from their specs.
2. **`blocks.ts`** — `substituteVars`, `parseBlocks`, `walkBlocks` — pure functions over data.
3. **`loadEnv.ts`, `log.ts`** — small surface, deterministic with `memfs`.
4. **`loginDetect.ts`, `tools.ts::read_text`** — Page-evaluate logic; integration test with `setContent` fixtures.
5. **`chatWithRetry`** (post-move to `infrastructure/llm/`) — fake-timer + scripted-response classic.
6. **HTTP routes** — `app.inject()` against in-memory SQLite.
7. **`agent.ts`** orchestration — only after the above are green, since it composes everything. This is also when refactoring per `agent.md` §4 starts.

That ordering is also roughly the order of [`_LAYERS.md`](../_LAYERS.md) inner-to-outer, which is not a coincidence — testable code respects dependencies, and respecting dependencies is what `_LAYERS.md` is enforcing.
