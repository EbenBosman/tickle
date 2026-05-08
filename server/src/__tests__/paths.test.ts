import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { safeResolveScreenshot, SCREENSHOTS_DIR } from "../paths.ts";

// docs/specs/cross-cutting/security.md — "/screenshots/* has no path-traversal guard"
//
// The route used to do `const path = \`screenshots/${rest}\`` and serve
// it after a literal `.png` suffix check. Anything containing `..` (or
// an absolute Windows-style path) escaped the screenshots dir.
//
// safeResolveScreenshot(rest) returns the absolute path if and only if
// the resolved path stays inside SCREENSHOTS_DIR AND ends with .png.
// Returns null otherwise. The route maps null to 404.

describe("safeResolveScreenshot — happy paths", () => {
  it("resolves a simple screenshot filename", () => {
    const out = safeResolveScreenshot("run-1-001.png");
    expect(out).not.toBeNull();
    expect(out).toBe(resolve(SCREENSHOTS_DIR, "run-1-001.png"));
  });

  it("resolves a screenshot inside a per-run subdirectory", () => {
    const out = safeResolveScreenshot("run-42/step-7.png");
    expect(out).not.toBeNull();
    // The resolved path must start with the base, with a separator boundary
    // so /screenshotsX/ doesn't pass.
    expect(out?.startsWith(resolve(SCREENSHOTS_DIR) + sep)).toBe(true);
  });
});

describe("safeResolveScreenshot — traversal attempts", () => {
  it("rejects a parent-directory escape via ..", () => {
    expect(safeResolveScreenshot("../secret.png")).toBeNull();
  });

  it("rejects deep traversal", () => {
    expect(safeResolveScreenshot("../../../etc/passwd.png")).toBeNull();
  });

  it("rejects URL-encoded traversal segments (we do not decode)", () => {
    // The Fastify wildcard delivers the raw string; we never URL-decode
    // it before resolving. A %2E%2E payload is treated as literal text,
    // which means it does NOT contain `..` but ALSO never matches a real
    // file. Either way, no escape.
    const out = safeResolveScreenshot("%2E%2E/secret.png");
    expect(out === null || out?.startsWith(resolve(SCREENSHOTS_DIR) + sep)).toBe(true);
  });

  it("rejects an absolute POSIX path", () => {
    expect(safeResolveScreenshot("/etc/passwd.png")).toBeNull();
  });

  it("rejects an absolute Windows path", () => {
    expect(safeResolveScreenshot("C:/Windows/System32/config.png")).toBeNull();
  });

  it("rejects a Windows backslash absolute path", () => {
    expect(safeResolveScreenshot("C:\\Windows\\config.png")).toBeNull();
  });

  it("rejects a sibling-directory bypass (screenshots vs screenshotsX)", () => {
    // Confirms the separator-boundary check: e.g. on Windows where
    // resolve('screenshots', '../screenshotsX/foo.png') would land in
    // a sibling directory whose absolute path shares the screenshots
    // prefix as a substring.
    expect(safeResolveScreenshot("../screenshotsX/foo.png")).toBeNull();
  });
});

describe("safeResolveScreenshot — extension filter", () => {
  it("rejects non-.png extensions", () => {
    expect(safeResolveScreenshot("run-1-001.jpg")).toBeNull();
    expect(safeResolveScreenshot("run-1-001.txt")).toBeNull();
    expect(safeResolveScreenshot("run-1-001")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(safeResolveScreenshot("")).toBeNull();
  });

  it("is case-sensitive on the .png suffix to match disk on case-sensitive FS", () => {
    // macOS default is case-INsensitive but Linux (and Windows-ish via
    // ReFS) is case-sensitive. Pinning case-sensitive matching here keeps
    // behaviour identical across hosts.
    expect(safeResolveScreenshot("run-1-001.PNG")).toBeNull();
  });
});
