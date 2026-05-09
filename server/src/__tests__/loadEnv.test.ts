import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// docs/specs/server/load-env.md
//
// loadEnv.ts is a side-effecting top-level module: at import time it walks
// a fixed list of candidate paths anchored to its own module location
// (server/.env first, then repo-root /.env) and populates process.env from
// the first candidate that exists. Tests use vi.mock("node:fs") so the
// real .env is never touched, and vi.resetModules() + dynamic import to
// trigger a fresh evaluation per test.

const fsState = vi.hoisted(() => {
  return {
    files: new Map<string, string>(),
    existsErrors: new Map<string, NodeJS.ErrnoException>(),
    readErrors: new Map<string, NodeJS.ErrnoException>(),
  };
});

vi.mock("node:fs", () => {
  return {
    existsSync: vi.fn((path: string) => {
      const err = fsState.existsErrors.get(path);
      if (err) throw err;
      return fsState.files.has(path);
    }),
    readFileSync: vi.fn((path: string) => {
      const err = fsState.readErrors.get(path);
      if (err) throw err;
      const data = fsState.files.get(path);
      if (data === undefined) {
        const e: NodeJS.ErrnoException = Object.assign(new Error(`ENOENT: ${path}`), {
          code: "ENOENT",
        });
        throw e;
      }
      return data;
    }),
  };
});

// Mirror the path resolution that loadEnv.ts itself does, so tests seed
// the same absolute paths the loader will probe at runtime.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// server/src/__tests__/loadEnv.test.ts -> ../.. is server/
const SERVER_DIR = resolve(TEST_DIR, "..", "..");
const REPO_ROOT = resolve(SERVER_DIR, "..");
const SERVER_ENV = resolve(SERVER_DIR, ".env");
const ROOT_ENV = resolve(REPO_ROOT, ".env");

const ENV_KEYS_TO_RESET = [
  "TEST_K1",
  "TEST_K2",
  "TEST_K3",
  "TEST_QUOTED",
  "TEST_EMBEDDED_EQ",
  "TEST_EMPTY",
  "TEST_HASH_VALUE",
];

beforeEach(() => {
  fsState.files.clear();
  fsState.existsErrors.clear();
  fsState.readErrors.clear();
  for (const k of ENV_KEYS_TO_RESET) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS_TO_RESET) delete process.env[k];
  vi.restoreAllMocks();
});

async function loadFresh() {
  await import("../loadEnv.ts");
}

describe("loadEnv — happy path", () => {
  it("populates process.env from a simple .env at server/.env", async () => {
    fsState.files.set(SERVER_ENV, "TEST_K1=v1\nTEST_K2=v2\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("v1");
    expect(process.env.TEST_K2).toBe("v2");
  });

  it("is a no-op when no .env candidate exists", async () => {
    // No file seeded — both candidates return false from existsSync.
    await loadFresh();
    expect(process.env.TEST_K1).toBeUndefined();
  });
});

describe("loadEnv — candidate lookup", () => {
  it("falls through to repo-root .env when server/.env is absent", async () => {
    fsState.files.set(ROOT_ENV, "TEST_K1=root\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("root");
  });

  it("prefers server/.env over repo-root .env when both exist", async () => {
    fsState.files.set(SERVER_ENV, "TEST_K1=server\n");
    fsState.files.set(ROOT_ENV, "TEST_K1=root\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("server");
  });
});

describe("loadEnv — parser rules", () => {
  it("skips empty lines and # comments", async () => {
    fsState.files.set(SERVER_ENV, "\n# a comment\nTEST_K1=v1\n\n# another\nTEST_K2=v2\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("v1");
    expect(process.env.TEST_K2).toBe("v2");
  });

  it("skips lines without `=`", async () => {
    fsState.files.set(SERVER_ENV, "JUST_A_KEY\nTEST_K1=ok\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("ok");
    expect(process.env.JUST_A_KEY).toBeUndefined();
  });

  it("strips matching surrounding double quotes", async () => {
    fsState.files.set(SERVER_ENV, 'TEST_QUOTED="hello world"\n');
    await loadFresh();
    expect(process.env.TEST_QUOTED).toBe("hello world");
  });

  it("strips matching surrounding single quotes", async () => {
    fsState.files.set(SERVER_ENV, "TEST_QUOTED='hello world'\n");
    await loadFresh();
    expect(process.env.TEST_QUOTED).toBe("hello world");
  });

  it("preserves `=` characters in the value (only the first `=` splits)", async () => {
    fsState.files.set(SERVER_ENV, "TEST_EMBEDDED_EQ=a=b=c\n");
    await loadFresh();
    expect(process.env.TEST_EMBEDDED_EQ).toBe("a=b=c");
  });

  it("trims whitespace around keys and values", async () => {
    fsState.files.set(SERVER_ENV, "  TEST_K1  =  spaced  \n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("spaced");
  });

  it("treats an empty value as the empty string", async () => {
    fsState.files.set(SERVER_ENV, "TEST_EMPTY=\n");
    await loadFresh();
    expect(process.env.TEST_EMPTY).toBe("");
  });

  it("does not parse a `#` mid-value as a comment", async () => {
    // Once the line passes the `startsWith("#")` check, the rest is
    // value-as-written; #-comments are line-level only.
    fsState.files.set(SERVER_ENV, "TEST_HASH_VALUE=abc#def\n");
    await loadFresh();
    expect(process.env.TEST_HASH_VALUE).toBe("abc#def");
  });
});

describe("loadEnv — shell wins", () => {
  it("does not overwrite a key that already exists in process.env", async () => {
    process.env.TEST_K1 = "from-shell";
    fsState.files.set(SERVER_ENV, "TEST_K1=from-file\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("from-shell");
  });

  it("populates a key that is undefined in process.env", async () => {
    delete process.env.TEST_K2;
    fsState.files.set(SERVER_ENV, "TEST_K2=from-file\n");
    await loadFresh();
    expect(process.env.TEST_K2).toBe("from-file");
  });
});

describe("loadEnv — error handling", () => {
  it("logs and continues when readFileSync throws EACCES", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // swallow during test
    });
    // The candidate exists, but reading it is denied.
    fsState.files.set(SERVER_ENV, "TEST_K1=should-not-load\n");
    const eacces: NodeJS.ErrnoException = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    fsState.readErrors.set(SERVER_ENV, eacces);

    await expect(loadFresh()).resolves.not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("[loadEnv]");
    expect(message).toContain(SERVER_ENV);
    expect(message).toContain("permission denied");
    // Env must not be mutated when the file could not be read.
    expect(process.env.TEST_K1).toBeUndefined();
  });

  it("logs and continues when readFileSync throws EISDIR", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // swallow during test
    });
    fsState.files.set(SERVER_ENV, "TEST_K1=should-not-load\n");
    const eisdir: NodeJS.ErrnoException = Object.assign(
      new Error("illegal operation on a directory"),
      { code: "EISDIR" },
    );
    fsState.readErrors.set(SERVER_ENV, eisdir);

    await expect(loadFresh()).resolves.not.toThrow();

    expect(errSpy).toHaveBeenCalledTimes(1);
    const message = String(errSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("[loadEnv]");
    expect(message).toContain(SERVER_ENV);
    expect(process.env.TEST_K1).toBeUndefined();
  });

  it("falls back to the next candidate after a read error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      // swallow during test
    });
    // server/.env is unreadable; repo-root /.env is fine.
    fsState.files.set(SERVER_ENV, "TEST_K1=server\n");
    fsState.files.set(ROOT_ENV, "TEST_K1=root\n");
    const eacces: NodeJS.ErrnoException = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    fsState.readErrors.set(SERVER_ENV, eacces);

    await loadFresh();

    expect(process.env.TEST_K1).toBe("root");
  });

  it("treats ENOENT as a silent miss, not a logged error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // swallow during test
    });
    // No files seeded; both candidates report not-found.
    await loadFresh();
    expect(errSpy).not.toHaveBeenCalled();
    expect(process.env.TEST_K1).toBeUndefined();
  });
});
