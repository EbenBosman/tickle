# Spec — `<module-name>`

> Path: `<server/src/... | web/src/...>` · Layer: `<domain | application | infrastructure | interface | state | ui | features>` · Spec owner: `<who/what depends on this being correct>`

## 1. Why

One paragraph. The problem this module exists to solve, and the constraint that made _this_ the chosen shape rather than something simpler. If you can't answer this in plain language, the module is mis-scoped.

> **Non-obvious why:** any external constraint a future reader would otherwise miss (Windows-without-MSVC, prompt-injection defence, vendor quirk, deadline-driven trade-off). One line each.

## 2. Public contract

What the rest of the system depends on. Anyone integrating with this module reads only this section and nothing more.

### Exports

| Symbol          | Kind     | Signature / shape                     | Stability |
| --------------- | -------- | ------------------------------------- | --------- |
| `foo`           | function | `(x: number) => Promise<Result<Bar>>` | stable    |
| `BarKind`       | type     | `"a" \| "b" \| "c"`                   | stable    |
| `internalThing` | —        | (intentionally not exported)          | —         |

### HTTP / SSE / IPC surface (if applicable)

- `GET /api/foo/:id` → `200 Foo \| 404 { error }`
- SSE event `bar` → `{ block_id: string, ... }`

### Errors

| Error                    | Returned when           | Caller should…                         |
| ------------------------ | ----------------------- | -------------------------------------- |
| `FooNotFoundError`       | `id` doesn't exist      | render 404                             |
| `transient fetch failed` | upstream LLM call fails | already retried, surface and abort run |

## 3. Invariants

Things that must always be true. Each one should be enforceable as a test.

- _Example:_ Block IDs are unique within a task.
- _Example:_ `data-tickle-id` is set on every interactive element returned by `snapshot()`.
- _Example:_ `cancelRun(id)` is idempotent and safe to call from any thread.

## 4. How (briefly)

A few paragraphs describing the implementation strategy and any tricky bits. Not a code walk-through. What an experienced reader would otherwise have to reverse-engineer.

- **Algorithm / data flow:** …
- **Key dependencies:** …
- **Persistence / mutable state:** …
- **Concurrency model:** …

## 5. How tested

| Spec section / claim | Test file               | Test name                  | Status     |
| -------------------- | ----------------------- | -------------------------- | ---------- |
| §3 invariant 1       | `__tests__/foo.test.ts` | `id is unique within task` | ✅         |
| §2 errors row 1      | `__tests__/foo.test.ts` | `404 when id missing`      | ✅         |
| §2 errors row 2      | —                       | —                          | TODO(test) |

### Deliberately not tested

- Anything that requires real LLM / real browser. Covered by the integration-test runner separately, or by manual smoke.

## 6. Drift / open questions

Use this section to flag where current code disagrees with the spec, or design questions that haven't been resolved.

- ⚠️ Drift: …
- ❓ Question: …
