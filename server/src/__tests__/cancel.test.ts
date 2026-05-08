import { afterEach, describe, expect, it, vi } from "vitest";
import { clearCancel, registerCancel, requestCancel } from "../cancel.ts";

// docs/specs/server/run-control-cancel.md
//
// cancel.ts is a module-level Map<runId, fn>. Tests use unique ids and
// clearCancel() in afterEach for hygiene.

let nextId = 1;
const used: number[] = [];
function freshId(): number {
  const id = 2_000_000 + nextId++;
  used.push(id);
  return id;
}
afterEach(() => {
  while (used.length) clearCancel(used.pop()!);
});

describe("cancel registry — registration", () => {
  it("requestCancel returns false for an unknown run id", () => {
    expect(requestCancel(freshId())).toBe(false);
  });

  it("requestCancel returns true and invokes the registered callback", () => {
    const id = freshId();
    const fn = vi.fn();
    registerCancel(id, fn);
    expect(requestCancel(id)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("requestCancel returns false after clearCancel", () => {
    const id = freshId();
    const fn = vi.fn();
    registerCancel(id, fn);
    clearCancel(id);
    expect(requestCancel(id)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("cancel registry — dispatch semantics", () => {
  it("clearCancel does NOT invoke the callback", () => {
    const id = freshId();
    const fn = vi.fn();
    registerCancel(id, fn);
    clearCancel(id);
    expect(fn).not.toHaveBeenCalled();
  });

  it("clearCancel is a safe no-op for an unknown run id", () => {
    expect(() => clearCancel(freshId())).not.toThrow();
  });

  it("requestCancel invokes the callback synchronously", () => {
    const id = freshId();
    let order = "";
    registerCancel(id, () => {
      order += "B";
    });
    order += "A";
    requestCancel(id);
    order += "C";
    expect(order).toBe("ABC");
  });

  it("requestCancel twice fires the callback twice (no internal dedup)", () => {
    // Important contract: the registry doesn't decide what cancellation
    // means — that's the caller's job. The callback is allowed to be
    // idempotent if it wants; the registry doesn't enforce it.
    const id = freshId();
    const fn = vi.fn();
    registerCancel(id, fn);
    requestCancel(id);
    requestCancel(id);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("cancel registry — replacement", () => {
  it("registerCancel replaces a prior registration without invoking it", () => {
    const id = freshId();
    const first = vi.fn();
    const second = vi.fn();
    registerCancel(id, first);
    registerCancel(id, second); // should not call first
    expect(first).not.toHaveBeenCalled();
    requestCancel(id);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("cancel registry — per-run-id isolation", () => {
  it("requesting cancel for one run does not invoke another's callback", () => {
    const a = freshId();
    const b = freshId();
    const fnA = vi.fn();
    const fnB = vi.fn();
    registerCancel(a, fnA);
    registerCancel(b, fnB);
    requestCancel(a);
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();
  });

  it("clearing one run does not affect another", () => {
    const a = freshId();
    const b = freshId();
    const fnA = vi.fn();
    const fnB = vi.fn();
    registerCancel(a, fnA);
    registerCancel(b, fnB);
    clearCancel(a);
    expect(requestCancel(a)).toBe(false);
    expect(requestCancel(b)).toBe(true);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
