---
name: tdd
description: Use whenever production code is about to be added or modified in server/src or web/src. Enforces red→green→refactor — no production change without a failing test, and no test without a spec claim. Trigger on edits under server/src/, web/src/, or when a new feature is requested.
---

# Test-driven development for tickle

The cycle is **red → green → refactor**. Each cycle = one commit. If you find yourself editing production code without a failing test on the screen, stop and back up.

## 🔴 Red

- The test goes in `<module-dir>/__tests__/<module>.test.ts`.
- It must fail because the assertion fails — not because the import errored or the fixture is missing. Confirm by running `npm run test -- <pattern>`.
- The test name should match a spec claim word-for-word where possible: `it("retries fetch failed at 1.5s and 4s, then returns { ok: false, error }")`.

## 🟢 Green

- Smallest possible change to make the test pass. Resist drive-by improvements.
- Run the **full** test suite, not just the new test. If any other test went red, that is a regression you caused — fix it before continuing.

## 🧹 Refactor

- With the suite green, improve naming, extract helpers, eliminate real duplication. After every meaningful edit, re-run tests.
- DRY happens here, not before. Three similar lines aren't a duplication problem yet — they're three lines.

## Things that disqualify a "test"

- Hits the real LLM / real browser / real network → integration test, not unit. Live behind a separate runner and don't gate the inner loop on it.
- Asserts implementation detail (a private helper was called) → rewrite to assert on the public contract.
- Takes longer than ~50ms for a unit test → mock something or move it to integration.

## Reporting back

When a cycle finishes, summarise:

- Spec claim enforced
- Test names added
- Files changed
- Test results (count green / count red, before and after)
