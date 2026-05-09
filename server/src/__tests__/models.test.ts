import { describe, expect, it } from "vitest";
import { VALID_MODELS, isValidModel } from "../domain/models.ts";

describe("VALID_MODELS — server-side allowlist", () => {
  it("contains the three currently-supported model ids", () => {
    expect([...VALID_MODELS]).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
    ]);
  });
});

describe("isValidModel", () => {
  it.each([...VALID_MODELS])("accepts %s", (m) => {
    expect(isValidModel(m)).toBe(true);
  });

  it("rejects an unknown model id", () => {
    expect(isValidModel("claude-7")).toBe(false);
    expect(isValidModel("")).toBe(false);
    expect(isValidModel("claude-sonnet-4-5")).toBe(false);
  });

  it("narrows the type when true (compile-time, smoke-tested at runtime)", () => {
    const candidate = "claude-sonnet-4-6" as string;
    if (isValidModel(candidate)) {
      // ValidModel is the narrowed type — usable as such here.
      expect(candidate).toBe("claude-sonnet-4-6");
    } else {
      throw new Error("isValidModel should have returned true");
    }
  });
});
