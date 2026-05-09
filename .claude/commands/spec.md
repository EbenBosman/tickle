---
description: Author or update a module spec under docs/specs/ for the named module. Spec lives next to no code; it is the contract.
argument-hint: <module-path-or-name>
---

# /spec — author a module specification

You are writing a spec for **$ARGUMENTS**.

A spec is a short, durable document that answers four questions for one module:

1. **Why does this exist?** The user-facing or system-facing problem it solves. If you cannot articulate the why, the module is probably mis-scoped — flag it.
2. **What is its public contract?** Exported types, functions, routes, events, file artefacts. Anyone integrating with this module reads only this section.
3. **How is it implemented (briefly)?** Key invariants and design choices. Not a line-by-line walk-through — just the things a reader would otherwise have to reverse-engineer.
4. **How is it tested?** What unit / integration / contract tests cover it, and what is deliberately _not_ tested (and why).

## Process

1. **Locate the module.** If `$ARGUMENTS` is a path, read the file(s) directly. If it's a name, find the relevant code under `server/src/` or `web/src/`.
2. **Read the existing spec** at `docs/specs/<module>.md` if one exists. If it does, you are _updating_ — preserve the structure, change only what's drifted.
3. **Read the code** carefully enough to answer the four questions. Don't paraphrase code line-by-line — abstract.
4. **Draft the spec** using `docs/specs/_TEMPLATE.md` as the starting structure.
5. **Cross-check the index** at `docs/specs/README.md` and add/update the entry.

## Rules

- **Specs describe contracts, not code.** If you find yourself copying function bodies, stop and abstract.
- **Specs must be falsifiable.** A claim like "handles errors gracefully" is not a spec; "on `fetch failed`, retries at 1.5s and 4s, then returns `{ ok: false, error }`" is.
- **Capture invariants.** Things that must always be true (e.g. "block IDs are unique within a task", "snapshot tags every interactive element with `data-tickle-id`").
- **Note non-obvious why.** When a design choice exists for an external reason (Windows native-build constraint, prompt-injection defence), spell it out — those are the easiest things to accidentally undo later.
- **Link to tests.** Every spec section that makes a behavioural claim should reference the test that enforces it. If no test exists yet, mark it `TODO(test)` so it appears in the test backlog.

## When the spec disagrees with the code

If the code does X but the right answer is Y, write the spec for **Y** and open a follow-up to fix the code. Don't enshrine bad behaviour just because it's current behaviour. Note the discrepancy explicitly: `> ⚠️ Drift: code currently does X. Tracked in [issue/branch].`
