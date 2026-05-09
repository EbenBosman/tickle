---
description: Refactor a god-file module into layered N-tier files with tests, against an existing spec. Aborts if no spec or no tests.
argument-hint: <path/to/godfile.ts>
---

# /refactor-module — break up a god file safely

You are refactoring **$ARGUMENTS**.

## Preconditions (hard stops)

1. A spec exists at `docs/specs/<module>.md` and is up-to-date with current behaviour.
2. Tests exist that exercise the public contract from the spec. They must be **green** before you start. If they aren't, fix that first or write them.
3. The repo is clean (`git status` shows no unrelated changes).

If any of these fail, **stop and report**. Do not proceed.

## Layered N-tier targets (server)

When breaking a server module, sort code into these layers (top depends on bottom; never the reverse):

| Layer             | What lives here                               | Example folder               |
| ----------------- | --------------------------------------------- | ---------------------------- |
| `domain/`         | Pure types, value objects, errors, invariants | `server/src/domain/`         |
| `application/`    | Use-cases (orchestrate domain + infra)        | `server/src/application/`    |
| `infrastructure/` | Browser, LLM client, DB, filesystem, network  | `server/src/infrastructure/` |
| `interface/`      | HTTP routes, SSE handlers, CLI                | `server/src/interface/`      |

A file in `domain/` must not import from any other layer. A file in `infrastructure/` must not import from `interface/`. Enforce with directory-aware tests (`no-restricted-imports`).

## Frontend targets (web)

| Layer       | What lives here                                                                     | Example folder      |
| ----------- | ----------------------------------------------------------------------------------- | ------------------- |
| `domain/`   | Pure types shared with server (or duplicated intentionally and reconciled in tests) | `web/src/domain/`   |
| `state/`    | Stores, hooks, derived selectors                                                    | `web/src/state/`    |
| `ui/`       | Pure presentational components                                                      | `web/src/ui/`       |
| `features/` | Feature-folders combining state + ui                                                | `web/src/features/` |

## Process

1. **Survey the file.** List every exported symbol and roughly which layer it belongs to. Output the table before editing anything.
2. **Plan the splits.** Propose a target file tree as a comment in the chat. Wait for confirmation before moving files.
3. **Move one symbol at a time.** Each move is its own commit:
   - Move the code.
   - Update imports.
   - Run tests — must stay green.
   - Commit.
4. **No behaviour changes during refactor.** If you spot a bug, write it down for a follow-up; don't fix it inline. The whole point is the safety net of unchanged behaviour.
5. **DRY pass at the end.** With everything in its layer, look for duplication that crosses files and lift shared helpers to `shared/` within the appropriate layer. Re-run tests after each lift.
6. **Update the spec.** If module boundaries changed, the spec must reflect the new public surface and file map.

## Stop conditions

Abort and report if:

- A test goes red and you can't make it green within one move (the move was wrong — revert).
- The plan needs to grow beyond what was approved (re-propose, don't sneak it in).
- You discover the spec was wrong (stop, fix the spec, re-confirm).
