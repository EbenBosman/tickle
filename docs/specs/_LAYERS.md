# Layered architecture

This is the target architecture for tickle. Phase-2+ refactors move existing code into these layers; new code is written into the right layer from day one.

The rule that matters: **dependencies point inward.** A file in an outer layer may import from an inner layer. Never the reverse.

## Server (`server/src/`)

```
server/src/
├── domain/          ← pure types, errors, value objects, invariants
├── application/     ← use-cases that orchestrate domain + infrastructure
├── infrastructure/  ← Playwright, LLM client, SQLite, filesystem, network
└── interface/       ← Fastify routes, SSE handlers, CLI bootstrap
```

| Layer             | May import from                        | What goes here                                                                 |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `domain/`         | (nothing)                              | Block types, error classes, the SSE event type union, value objects.           |
| `application/`    | `domain/`                              | Block executors, run lifecycle, pause/cancel orchestration, snapshot pipeline. |
| `infrastructure/` | `domain/`, `application/` (interfaces) | `BrowserContext` adapter, `LLMClient`, `RunStore`, `EventBus`, file logger.    |
| `interface/`      | all of the above                       | `routes/tasks.ts`, `routes/runs.ts`, SSE wiring, Fastify bootstrap.            |

### Concrete examples (post-refactor target)

- `domain/block.ts` — block type union, `parseBlock`, `BlockId`.
- `domain/run.ts` — `RunStatus`, `RunResult`, `SseEvent` union.
- `domain/errors.ts` — `RunCancelledError`, `LoginRequiredError`, `StallDetectedError`.
- `application/runAgent.ts` — top-level orchestration (today: `agent.ts`).
- `application/blocks/runNavigate.ts`, `runGoal.ts`, `runClick.ts`, `runFill.ts`, `runExtract.ts`, `runForEach.ts`, `runQuestionnaire.ts`.
- `application/loginGuard.ts`, `application/stallGuard.ts`.
- `infrastructure/browser/context.ts`, `infrastructure/browser/snapshot.ts`, `infrastructure/browser/act.ts`.
- `infrastructure/llm/openaiCompatClient.ts`, `infrastructure/llm/chatWithRetry.ts`.
- `infrastructure/persistence/sqliteRunStore.ts`, `infrastructure/persistence/sqliteTaskStore.ts`.
- `infrastructure/observability/jsonlLogger.ts`, `infrastructure/observability/eventBus.ts`.
- `interface/http/server.ts`, `interface/http/routes/runs.ts`, `interface/sse/runStream.ts`.

### Enforcement

A test under `server/src/__tests__/architecture.test.ts` walks the import graph and fails on layer violations. The `eslint-plugin-boundaries` config (or equivalent) enforces it at lint time.

## Web (`web/src/`)

```
web/src/
├── domain/          ← types shared with server (or duplicated and reconciled)
├── state/           ← stores, hooks, selectors, SSE subscription
├── ui/              ← pure presentational components
└── features/        ← feature folders combining state + ui (one folder = one screen-shaped chunk)
```

| Layer       | May import from  | What goes here                                                        |
| ----------- | ---------------- | --------------------------------------------------------------------- |
| `domain/`   | (nothing)        | Block, Task, Run, Step types. Mirrors `server/src/domain/` shapes.    |
| `state/`    | `domain/`        | `useRunStream`, `useTasks`, derived selectors, store factories.       |
| `ui/`       | `domain/`        | `<StatusPill/>`, `<BlockBadge/>`, generic primitives. No fetch calls. |
| `features/` | all of the above | `features/run-view/`, `features/task-editor/`, etc.                   |

### Concrete examples (post-refactor target)

- `features/run-view/RunView.tsx` (orchestration), `features/run-view/EntryStream.tsx`, `features/run-view/PageStateBanner.tsx`, `features/run-view/Timer.tsx`, `features/run-view/PauseBanner.tsx`.
- `features/task-editor/TaskEditor.tsx`, `features/task-editor/BlockList.tsx`, `features/task-editor/BlockEditor/<kind>.tsx` (one file per block kind).
- `state/useRunStream.ts`, `state/useTaskStore.ts`, `state/parseSqliteUtc.ts`.

## Anti-patterns

- A `domain/` file importing `fetch`, `playwright`, `node:sqlite` — that's infrastructure leaking inward.
- A route file calling `chromium.launchPersistentContext` directly — that's `interface/` reaching past `application/` into `infrastructure/`.
- A `ui/` component calling `fetch('/api/...')` — UI must not know about the network. The component takes data as props.
- One `agent.ts` containing 1500 lines of mixed concerns — the thing this whole structure exists to prevent.
