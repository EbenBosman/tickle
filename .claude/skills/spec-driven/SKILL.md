---
name: spec-driven
description: Use whenever a change is being made to a server or web module that has a spec at docs/specs/. Reminds you to read the spec first, ensure the change is covered by a spec claim (or update the spec), and link the change back to the claim it satisfies. Trigger on edits under server/src/ or web/src/.
---

# Spec-driven development for tickle

This project uses spec-driven + test-driven development. The spec is the contract; the tests enforce it; the code implements it. In that order.

## Before you change code

1. Find the spec. For a file at `server/src/agent.ts`, the spec is `docs/specs/server/agent.md`. For `web/src/components/RunView.tsx`, it is `docs/specs/web/RunView.md`.
2. **Spec missing?** Stop. Run `/spec <module>` to author one against current behaviour. Then come back.
3. **Spec exists?** Read it. Identify the exact claim your change satisfies, modifies, or adds.
4. **Claim not in the spec?** Update the spec first — that is itself a step in the cycle. The spec must be true after your change, not before.

## During the change

- For every behavioural change, there must be a test that fails before and passes after. Use `/tdd <module>` to drive this.
- For every file you touch, check the layer it lives in (see `docs/specs/_LAYERS.md`). If you would be introducing a layer violation (e.g. a `domain/` file importing from `infrastructure/`), stop and refactor the dependency direction instead.

## After the change

- The spec, tests, and code are all consistent.
- Your commit message references the spec section it touches: `agent: enforce stall-detection invariant (docs/specs/server/agent.md §guardrails)`.
- If you noticed something out of scope, file it as a follow-up — do not fold it into this change.

## When to skip the spec dance

- Pure formatting / lint fixes that don't change behaviour.
- Comments-only edits.
- Dependency bumps with no API change (still note in CHANGELOG).

That's it. Everything else needs a spec entry first.
