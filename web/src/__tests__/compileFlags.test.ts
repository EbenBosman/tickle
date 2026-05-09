import { describe, expect, it } from "vitest";
import {
  externalHost,
  flagBlock,
  flagBlocks,
  isExternalUrl,
  looksLikeCredential,
} from "../state/compileFlags.ts";
import type { Block } from "../blocks.ts";

describe("isExternalUrl / externalHost", () => {
  it.each([
    "http://localhost:8080/x",
    "https://localhost/page",
    "http://127.0.0.1:1234",
    "http://[::1]/",
    "http://0.0.0.0/",
  ])("treats %s as local", (url) => {
    expect(isExternalUrl(url)).toBe(false);
    expect(externalHost(url)).toBeNull();
  });

  it.each([
    ["https://example.com", "example.com"],
    ["https://accounts.google.com/signin", "accounts.google.com"],
    ["http://10.0.0.5/admin", "10.0.0.5"],
  ])("treats %s as external (%s)", (url, host) => {
    expect(isExternalUrl(url)).toBe(true);
    expect(externalHost(url)).toBe(host);
  });

  it("returns false / null for unparseable input", () => {
    expect(isExternalUrl("not a url")).toBe(false);
    expect(externalHost("not a url")).toBeNull();
  });
});

describe("looksLikeCredential", () => {
  it.each([
    "password",
    "Password",
    "pw",
    "the secret API key",
    "api_key",
    "api-key",
    "auth token",
    "SSN",
    "social security number",
    "credit card",
    "card number",
    "CVV",
    "cvc",
    "PIN",
    "OTP code",
    "2FA",
    "MFA",
  ])("flags %s by keyword", (s) => {
    expect(looksLikeCredential(s)).not.toBeNull();
  });

  it.each(["1234567890123456", "4111-1111-1111-1111", "4111 1111 1111 1111"])(
    "flags credit-card-shaped %s",
    (s) => {
      expect(looksLikeCredential(s)).toMatch(/credit-card/);
    },
  );

  it("flags SSN-shaped 123-45-6789", () => {
    expect(looksLikeCredential("123-45-6789")).toMatch(/SSN/);
  });

  it.each(["", "  ", "the user's full name", "search query for shoes"])(
    "does NOT flag harmless %s",
    (s) => {
      expect(looksLikeCredential(s)).toBeNull();
    },
  );
});

describe("flagBlock", () => {
  it("flags a navigate to an external host", () => {
    const b: Block = { id: "x", kind: "navigate", url: "https://example.com/login" };
    const f = flagBlock(b);
    expect(f).not.toBeNull();
    expect(f?.severity).toBe("warn");
    expect(f?.reason).toContain("example.com");
  });

  it("does NOT flag a navigate to localhost", () => {
    const b: Block = { id: "x", kind: "navigate", url: "http://localhost:5173" };
    expect(flagBlock(b)).toBeNull();
  });

  it("flags a fill whose target looks like a credential field", () => {
    const b: Block = { id: "x", kind: "fill", target: "Password", value: "$pw" };
    const f = flagBlock(b);
    expect(f?.reason).toContain("field");
  });

  it("flags a fill whose value looks like a credit card", () => {
    const b: Block = { id: "x", kind: "fill", target: "Card", value: "4111-1111-1111-1111" };
    const f = flagBlock(b);
    expect(f?.reason).toContain("value");
    expect(f?.reason).toContain("credit-card");
  });

  it("does NOT flag a benign fill", () => {
    const b: Block = { id: "x", kind: "fill", target: "Search", value: "shoes" };
    expect(flagBlock(b)).toBeNull();
  });

  it("does NOT flag a click / extract / goal etc.", () => {
    const click: Block = { id: "x", kind: "click", target: "Submit", role: "button" };
    expect(flagBlock(click)).toBeNull();
  });
});

describe("flagBlocks — list summary", () => {
  it("returns the indices and flags of every flagged block", () => {
    const blocks: Block[] = [
      { id: "1", kind: "navigate", url: "https://example.com" }, // flagged
      { id: "2", kind: "click", target: "Submit", role: "button" }, // not
      { id: "3", kind: "fill", target: "Password", value: "x" }, // flagged
    ];
    const flags = flagBlocks(blocks);
    expect(flags).toHaveLength(2);
    expect(flags.map((f) => f.idx)).toEqual([0, 2]);
  });

  it("returns an empty array when no block is flagged", () => {
    const blocks: Block[] = [
      { id: "1", kind: "click", target: "Submit", role: "button" },
      { id: "2", kind: "extract", target: "title", var_name: "t" },
    ];
    expect(flagBlocks(blocks)).toEqual([]);
  });
});
