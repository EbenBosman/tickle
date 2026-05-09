---
description: Drive a change red→green→refactor against an existing spec. Refuses to write production code without a failing test.
argument-hint: <module-or-feature> [— short description of the change]
---

# /tdd — test-driven change

You are making a change to **$ARGUMENTS**. Follow the cycle strictly.

## Preconditions

1. **A spec must exist** at `docs/specs/<module>.md`. If it does not, stop and run `/spec <module>` first. We do not write code without a contract.
2. **Read the spec.** The change you make must satisfy a claim in the spec. If the spec doesn't cover what you're doing, update the spec first — that is itself a TDD step (the spec is the meta-test).

## The cycle

### 🔴 Red — write a failing test

- Add the test under `<module-dir>/__tests__/<module>.test.ts` (or `.spec.ts`).
- The test must fail for the _right reason_: assertion failure, not import error or missing fixture. Run it (`npm run test -- <pattern>`) and confirm.
- Keep the test small and behavioural. One assertion concept per test. Use `describe`/`it` to name the contract claim from the spec.

### 🟢 Green — minimum code to pass

- Make the test pass with the smallest possible change. Resist the urge to also fix the next thing you noticed.
- Run all tests, not just the new one. If anything else broke, that's a regression — fix it before moving on.

### 🧹 Refactor — clean up with the safety net

- With tests green, improve the code: extract helpers, rename for clarity, eliminate duplication. Re-run tests after every meaningful change.
- This is when DRY happens. Not before — premature DRY locks in the wrong abstraction.

## Rules

- **No production code without a failing test first.** If you find yourself editing `src/` before adding to `__tests__/`, stop and back up.
- **No test without a spec claim it maps to.** If you can't point at a line in the spec the test enforces, the spec is incomplete — update it.
- **Keep commits small.** One red→green→refactor cycle = one commit. The diff should be small enough to review in two minutes.
- **Report back** at the end of each cycle:
  - Which spec claim was enforced
  - Test name(s) added
  - Files changed
  - Test results before/after
