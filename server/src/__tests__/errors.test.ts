import { describe, expect, it } from "vitest";
import { errorMessageFromThrow } from "../errors.ts";

// docs/specs/cross-cutting/error-handling.md — "Top-level rejection escape"
//
// errorMessageFromThrow normalises any thrown value into a string we
// can persist in the runs.error column and surface in the SSE error
// event. JS lets you throw anything — Error, string, plain object,
// undefined — so the helper has to handle all of it without itself
// throwing.

describe("errorMessageFromThrow", () => {
  it("uses .message for an Error", () => {
    expect(errorMessageFromThrow(new Error("boom"))).toBe("boom");
  });

  it("uses .message for a subclass of Error", () => {
    class MyError extends Error {
      constructor() {
        super("custom");
        this.name = "MyError";
      }
    }
    expect(errorMessageFromThrow(new MyError())).toBe("custom");
  });

  it("returns the string when a string is thrown", () => {
    expect(errorMessageFromThrow("plain string")).toBe("plain string");
  });

  it("returns a non-empty marker for null", () => {
    const out = errorMessageFromThrow(null);
    expect(out.length).toBeGreaterThan(0);
    expect(typeof out).toBe("string");
  });

  it("returns a non-empty marker for undefined", () => {
    const out = errorMessageFromThrow(undefined);
    expect(out.length).toBeGreaterThan(0);
    expect(typeof out).toBe("string");
  });

  it("JSON-stringifies a plain object", () => {
    expect(errorMessageFromThrow({ code: 502, reason: "upstream" })).toBe(
      '{"code":502,"reason":"upstream"}',
    );
  });

  it("falls back to String() when JSON.stringify would throw (e.g. circular)", () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    const out = errorMessageFromThrow(a);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns String(n) for a primitive number", () => {
    expect(errorMessageFromThrow(42)).toBe("42");
  });

  it("never throws on any input", () => {
    // Property-style spot check: a handful of weird inputs.
    const inputs: unknown[] = [
      Symbol("s"),
      () => "fn",
      new Map([["k", "v"]]),
      new Set([1, 2, 3]),
      false,
      0,
    ];
    for (const x of inputs) {
      expect(() => errorMessageFromThrow(x)).not.toThrow();
    }
  });
});
