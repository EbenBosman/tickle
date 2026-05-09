import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// docs/specs/server/browser.md — storage paths must be anchored to the
// server module location so they survive launching the process from the
// repo root, from server/, or from anywhere else.
//
// We test against server/src/paths/storage.ts directly (not browser.ts)
// because importing browser.ts loads Playwright at module top-level and
// also runs mkdirSync, neither of which we want to do from a unit test.

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// server/src/__tests__/browser.paths.test.ts -> ../.. is server/
const SERVER_DIR = resolve(TEST_DIR, "..", "..");

const ENV_KEYS = ["TICKLE_PROFILE_DIR", "TICKLE_SHOTS_DIR"];

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

async function loadStorage(): Promise<{
  PROFILE_DIR: string;
  SHOTS_DIR: string;
}> {
  const mod = await import("../paths/storage.ts");
  return { PROFILE_DIR: mod.PROFILE_DIR, SHOTS_DIR: mod.SHOTS_DIR };
}

describe("storage paths — defaults", () => {
  it("anchors PROFILE_DIR to <server>/data/profile", async () => {
    const { PROFILE_DIR } = await loadStorage();
    expect(PROFILE_DIR).toBe(resolve(SERVER_DIR, "data", "profile"));
  });

  it("anchors SHOTS_DIR to <server>/screenshots", async () => {
    // Default kept as 'screenshots' (not 'data/screenshots') for now to
    // match the existing on-disk layout and other modules that still
    // reference it; alignment is a separate commit.
    const { SHOTS_DIR } = await loadStorage();
    expect(SHOTS_DIR).toBe(resolve(SERVER_DIR, "screenshots"));
  });

  it("ignores process.cwd() when resolving the defaults", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/some/other/cwd");
    try {
      const { PROFILE_DIR, SHOTS_DIR } = await loadStorage();
      expect(PROFILE_DIR.startsWith(SERVER_DIR)).toBe(true);
      expect(SHOTS_DIR.startsWith(SERVER_DIR)).toBe(true);
      expect(PROFILE_DIR.startsWith("/some/other/cwd")).toBe(false);
      expect(SHOTS_DIR.startsWith("/some/other/cwd")).toBe(false);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

describe("storage paths — TICKLE_PROFILE_DIR override", () => {
  it("returns an absolute env value unchanged", async () => {
    // Use a platform-appropriate absolute path so the test passes on
    // both POSIX and Windows.
    const abs = process.platform === "win32" ? "C:\\custom\\profile" : "/abs/path/profile";
    process.env.TICKLE_PROFILE_DIR = abs;
    const { PROFILE_DIR } = await loadStorage();
    expect(PROFILE_DIR).toBe(abs);
  });

  it("resolves a relative env value against <server>", async () => {
    process.env.TICKLE_PROFILE_DIR = "relative/sub";
    const { PROFILE_DIR } = await loadStorage();
    expect(PROFILE_DIR).toBe(resolve(SERVER_DIR, "relative", "sub"));
  });

  it("falls back to the default when the env var is empty", async () => {
    process.env.TICKLE_PROFILE_DIR = "";
    const { PROFILE_DIR } = await loadStorage();
    expect(PROFILE_DIR).toBe(resolve(SERVER_DIR, "data", "profile"));
  });
});

describe("storage paths — TICKLE_SHOTS_DIR override", () => {
  it("returns an absolute env value unchanged", async () => {
    const abs = process.platform === "win32" ? "C:\\custom\\shots" : "/abs/path/shots";
    process.env.TICKLE_SHOTS_DIR = abs;
    const { SHOTS_DIR } = await loadStorage();
    expect(SHOTS_DIR).toBe(abs);
  });

  it("resolves a relative env value against <server>", async () => {
    process.env.TICKLE_SHOTS_DIR = "relative/shots";
    const { SHOTS_DIR } = await loadStorage();
    expect(SHOTS_DIR).toBe(resolve(SERVER_DIR, "relative", "shots"));
  });

  it("falls back to the default when the env var is empty", async () => {
    process.env.TICKLE_SHOTS_DIR = "";
    const { SHOTS_DIR } = await loadStorage();
    expect(SHOTS_DIR).toBe(resolve(SERVER_DIR, "screenshots"));
  });
});
