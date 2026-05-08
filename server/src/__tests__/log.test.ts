import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/specs/server/observability-log.md
//
// log.ts opens `data/tickle.log` (cwd-relative) at import time via
// `mkdirSync` and writes via `appendFileSync`. Tests mock `node:fs`
// entirely so the real log file is never touched.
//
// vi.hoisted gives the mock state a stable reference that survives
// Vitest's mock hoisting; otherwise the module-level `mkdirSync` call
// fires before our `vi.mock` factory runs.

const fsState = vi.hoisted(() => {
  return {
    files: new Map<string, string>(),
    sizes: new Map<string, number>(),
    appendShouldThrow: false,
    rotateError: null as Error | null,
    consoleLines: [] as string[],
  };
});

vi.mock("node:fs", () => {
  return {
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn((path: string, data: string) => {
      if (fsState.appendShouldThrow) throw new Error("disk full");
      const prev = fsState.files.get(path) ?? "";
      fsState.files.set(path, prev + data);
      fsState.sizes.set(path, (prev + data).length);
    }),
    statSync: vi.fn((path: string) => {
      const size = fsState.sizes.get(path);
      if (size === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return { size } as unknown as ReturnType<typeof import("node:fs").statSync>;
    }),
    renameSync: vi.fn((from: string, to: string) => {
      if (fsState.rotateError) throw fsState.rotateError;
      const data = fsState.files.get(from);
      if (data !== undefined) {
        fsState.files.set(to, data);
        fsState.sizes.set(to, data.length);
        fsState.files.delete(from);
        fsState.sizes.delete(from);
      }
    }),
    existsSync: vi.fn((path: string) => fsState.files.has(path)),
  };
});

const LOG_PATH_REL = "data/tickle.log";

let trace: typeof import("../log.ts").trace;
let LOG_FILE: typeof import("../log.ts").LOG_FILE;

beforeEach(async () => {
  fsState.files.clear();
  fsState.sizes.clear();
  fsState.appendShouldThrow = false;
  fsState.rotateError = null;
  fsState.consoleLines.length = 0;
  vi.spyOn(console, "log").mockImplementation((s: string) => {
    fsState.consoleLines.push(s);
  });
  // Re-import to get a fresh module evaluation per test, ensuring the
  // `mkdirSync` happens against the cleared mock.
  vi.resetModules();
  const mod = await import("../log.ts");
  trace = mod.trace;
  LOG_FILE = mod.LOG_FILE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function readLines(): string[] {
  const data = fsState.files.get(LOG_PATH_REL) ?? "";
  if (!data) return [];
  return data.split("\n").filter(Boolean);
}

describe("log — line shape", () => {
  it("writes one JSON line per call, terminated by \\n", () => {
    trace("run.start", { runId: 1 });
    trace("run.end", { runId: 1 });
    const lines = readLines();
    expect(lines).toHaveLength(2);
    // Stored data ends with \n (split + filter Boolean above strips empties)
    expect(fsState.files.get(LOG_PATH_REL)?.endsWith("\n")).toBe(true);
  });

  it("each line parses to JSON with t (ISO) and event keys", () => {
    trace("run.start", { runId: 1, taskId: 7 });
    const [line] = readLines();
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("run.start");
    expect(parsed.runId).toBe(1);
    expect(parsed.taskId).toBe(7);
    expect(typeof parsed.t).toBe("string");
    // ISO 8601, e.g. 2026-05-08T10:11:12.345Z
    expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("does not throw when ctx is omitted entirely", () => {
    expect(() => trace("ping")).not.toThrow();
    const [line] = readLines();
    expect(JSON.parse(line)).toMatchObject({ event: "ping" });
  });

  it("LOG_FILE export points at the canonical path", () => {
    expect(LOG_FILE).toBe(LOG_PATH_REL);
  });
});

describe("log — rotation", () => {
  it("does not rotate when below the 5 MB threshold", () => {
    // Pre-seed the file at ~1 MB.
    fsState.files.set(LOG_PATH_REL, "x".repeat(1024 * 1024));
    fsState.sizes.set(LOG_PATH_REL, 1024 * 1024);
    trace("run.start");
    expect(fsState.files.has(`${LOG_PATH_REL}.1`)).toBe(false);
  });

  it("rotates to .log.1 when the file is >=5 MB at write time", () => {
    fsState.files.set(LOG_PATH_REL, "x".repeat(5 * 1024 * 1024));
    fsState.sizes.set(LOG_PATH_REL, 5 * 1024 * 1024);
    trace("run.start");
    expect(fsState.files.has(`${LOG_PATH_REL}.1`)).toBe(true);
    // After rotation, the new write goes to a fresh main file.
    const main = fsState.files.get(LOG_PATH_REL) ?? "";
    expect(main.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("overwrites a prior .log.1 on subsequent rotation (single backup)", () => {
    fsState.files.set(`${LOG_PATH_REL}.1`, "old backup");
    fsState.files.set(LOG_PATH_REL, "x".repeat(5 * 1024 * 1024));
    fsState.sizes.set(LOG_PATH_REL, 5 * 1024 * 1024);
    trace("run.start");
    expect(fsState.files.get(`${LOG_PATH_REL}.1`)).not.toBe("old backup");
  });
});

describe("log — failure tolerance", () => {
  it("does not throw when the underlying append fails", () => {
    fsState.appendShouldThrow = true;
    expect(() => trace("run.start")).not.toThrow();
  });

  it("still mirrors to stdout when the file write fails", () => {
    fsState.appendShouldThrow = true;
    trace("run.start", { runId: 1 });
    expect(fsState.consoleLines.some((l) => l.includes("run.start"))).toBe(true);
  });
});

describe("log — stdout mirror", () => {
  it("mirrors with [run N] prefix when runId is provided", () => {
    trace("tool.call", { runId: 42, name: "navigate" });
    const line = fsState.consoleLines.at(-1) ?? "";
    expect(line.startsWith("[run 42] tool.call")).toBe(true);
    expect(line).toContain("name=navigate");
  });

  it("omits runId prefix when runId is absent", () => {
    trace("server.start");
    const line = fsState.consoleLines.at(-1) ?? "";
    expect(line.startsWith("server.start")).toBe(true);
    expect(line.startsWith("[run")).toBe(false);
  });
});

describe("log — redaction (TARGET behaviour, currently red — see security.md)", () => {
  // 🔴 The trace logger does NOT redact secrets today. These tests pin
  // the desired behaviour and run as `it.todo` so they show in the
  // backlog without failing CI. When redaction is added, swap `.todo`
  // for `it` and they should immediately pass.
  it.todo("strips `apiKey` from ctx before writing");
  it.todo("strips `authorization` / `cookie` / `password` / `token` from ctx");
  it.todo("recursively strips banned keys from nested objects");
  it.todo("honours LOG_REDACT env var to extend the denylist");
});
