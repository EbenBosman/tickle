import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/specs/server/load-env.md
//
// loadEnv.ts is a side-effecting top-level module: it reads .env from
// process.cwd() at import time and populates process.env in place.
// Tests use vi.mock("node:fs") so the real .env is never touched, and
// vi.resetModules() + dynamic import to trigger a fresh evaluation per
// test.

const fsState = vi.hoisted(() => {
  return {
    files: new Map<string, string>(),
  };
});

vi.mock("node:fs", () => {
  return {
    existsSync: vi.fn((path: string) => fsState.files.has(path)),
    readFileSync: vi.fn((path: string) => {
      const data = fsState.files.get(path);
      if (data === undefined) throw new Error(`ENOENT: ${path}`);
      return data;
    }),
  };
});

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
  for (const k of ENV_KEYS_TO_RESET) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS_TO_RESET) delete process.env[k];
});

async function loadFresh() {
  await import("../loadEnv.ts");
}

describe("loadEnv — happy path", () => {
  it("populates process.env from a simple .env", async () => {
    fsState.files.set(".env", "TEST_K1=v1\nTEST_K2=v2\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("v1");
    expect(process.env.TEST_K2).toBe("v2");
  });

  it("is a no-op when .env does not exist", async () => {
    // No file seeded.
    await loadFresh();
    expect(process.env.TEST_K1).toBeUndefined();
  });
});

describe("loadEnv — parser rules", () => {
  it("skips empty lines and # comments", async () => {
    fsState.files.set(".env", "\n# a comment\nTEST_K1=v1\n\n# another\nTEST_K2=v2\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("v1");
    expect(process.env.TEST_K2).toBe("v2");
  });

  it("skips lines without `=`", async () => {
    fsState.files.set(".env", "JUST_A_KEY\nTEST_K1=ok\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("ok");
    expect(process.env.JUST_A_KEY).toBeUndefined();
  });

  it("strips matching surrounding double quotes", async () => {
    fsState.files.set(".env", 'TEST_QUOTED="hello world"\n');
    await loadFresh();
    expect(process.env.TEST_QUOTED).toBe("hello world");
  });

  it("strips matching surrounding single quotes", async () => {
    fsState.files.set(".env", "TEST_QUOTED='hello world'\n");
    await loadFresh();
    expect(process.env.TEST_QUOTED).toBe("hello world");
  });

  it("preserves `=` characters in the value (only the first `=` splits)", async () => {
    fsState.files.set(".env", "TEST_EMBEDDED_EQ=a=b=c\n");
    await loadFresh();
    expect(process.env.TEST_EMBEDDED_EQ).toBe("a=b=c");
  });

  it("trims whitespace around keys and values", async () => {
    fsState.files.set(".env", "  TEST_K1  =  spaced  \n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("spaced");
  });

  it("treats an empty value as the empty string", async () => {
    fsState.files.set(".env", "TEST_EMPTY=\n");
    await loadFresh();
    expect(process.env.TEST_EMPTY).toBe("");
  });

  it("does not parse a `#` mid-value as a comment", async () => {
    // Once the line passes the `startsWith("#")` check, the rest is
    // value-as-written; #-comments are line-level only.
    fsState.files.set(".env", "TEST_HASH_VALUE=abc#def\n");
    await loadFresh();
    expect(process.env.TEST_HASH_VALUE).toBe("abc#def");
  });
});

describe("loadEnv — shell wins", () => {
  it("does not overwrite a key that already exists in process.env", async () => {
    process.env.TEST_K1 = "from-shell";
    fsState.files.set(".env", "TEST_K1=from-file\n");
    await loadFresh();
    expect(process.env.TEST_K1).toBe("from-shell");
  });

  it("populates a key that is undefined in process.env", async () => {
    delete process.env.TEST_K2;
    fsState.files.set(".env", "TEST_K2=from-file\n");
    await loadFresh();
    expect(process.env.TEST_K2).toBe("from-file");
  });
});
