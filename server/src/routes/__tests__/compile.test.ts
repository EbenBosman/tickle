import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// docs/specs/server/http-compile.md
//
// /api/blocks/compile takes prose and returns a sanitised Block[].
// Tests mock ../llm.ts so we don't actually call an LLM. The shared
// LLM mock state is set per-test to script the response (or a thrown
// error) for the single chatOnce call the route makes.

type FakeChatResponse = {
  message: { content: string; tool_calls: unknown[] };
  usage: { prompt_tokens: number; completion_tokens: number };
  duration_ms: number;
};

type CompileChatOpts = {
  model?: string;
  messages?: unknown[];
  temperature?: number;
  think?: boolean;
};

const llmState = vi.hoisted(() => {
  const state: {
    response: FakeChatResponse | null;
    throwErr: Error | null;
    lastCallOpts: CompileChatOpts | null;
  } = { response: null, throwErr: null, lastCallOpts: null };
  return state;
});

vi.mock("../../llm.ts", () => {
  return {
    newLlmClient: () => ({ provider: "openai" as const, client: {} }),
    chatOnce: vi.fn(async (_client: unknown, opts: CompileChatOpts) => {
      llmState.lastCallOpts = opts;
      if (llmState.throwErr) throw llmState.throwErr;
      return (
        llmState.response ?? {
          message: { content: '{"blocks": []}', tool_calls: [] },
          usage: { prompt_tokens: 0, completion_tokens: 0 },
          duration_ms: 0,
        }
      );
    }),
    MODEL: "test-model",
    LLM_BASE_URL: "http://test",
    CONTEXT_WINDOW: 32768,
  };
});

const originalDbPath = process.env.TICKLE_DB_PATH;
let app: FastifyInstance;

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  llmState.response = null;
  llmState.throwErr = null;
  llmState.lastCallOpts = null;
  vi.resetModules();
  const mod = await import("../../routes/compile.ts");
  const Fastify = (await import("fastify")).default;
  app = Fastify();
  await app.register(mod.compileRoutes);
});

afterEach(async () => {
  await app.close();
  if (originalDbPath === undefined) delete process.env.TICKLE_DB_PATH;
  else process.env.TICKLE_DB_PATH = originalDbPath;
});

function setLlmContent(content: string) {
  llmState.response = {
    message: { content, tool_calls: [] },
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    duration_ms: 0,
  };
}

async function compile(prompt: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/blocks/compile",
    payload: { prompt },
  });
}

describe("POST /api/blocks/compile — short-circuit", () => {
  it("returns { blocks: [] } and does NOT call the LLM when prompt is empty", async () => {
    const res = await compile("");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocks: [] });
    expect(llmState.lastCallOpts).toBeNull();
  });

  it("returns { blocks: [] } when prompt is whitespace only", async () => {
    const res = await compile("   ");
    expect(res.json()).toEqual({ blocks: [] });
    expect(llmState.lastCallOpts).toBeNull();
  });
});

describe("POST /api/blocks/compile — happy path", () => {
  it("returns the parsed blocks from a valid LLM response", async () => {
    setLlmContent(
      JSON.stringify({
        blocks: [
          { kind: "navigate", url: "https://example.com" },
          { kind: "goal", description: "find the price" },
        ],
      }),
    );
    const res = await compile("go look at example.com and find the price");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[0].kind).toBe("navigate");
    expect(body.blocks[0].url).toBe("https://example.com");
    expect(body.blocks[1].kind).toBe("goal");
    expect(body.blocks[1].description).toBe("find the price");
  });

  it("assigns fresh ids to each block (sanitiser strips/replaces caller ids)", async () => {
    setLlmContent(
      JSON.stringify({ blocks: [{ kind: "navigate", url: "https://a.com", id: "ignored" }] }),
    );
    const res = await compile("go");
    const block = res.json().blocks[0];
    expect(block.id).toBeDefined();
    expect(block.id).not.toBe("ignored");
  });

  it("drops blocks with unknown kinds", async () => {
    setLlmContent(
      JSON.stringify({
        blocks: [
          { kind: "navigate", url: "https://a.com" },
          { kind: "rocket-launch", payload: "lol" },
          { kind: "goal", description: "x" },
        ],
      }),
    );
    const res = await compile("x");
    const blocks = res.json().blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b: { kind: string }) => b.kind !== "rocket-launch")).toBe(true);
  });

  it("accepts a bare array (no `blocks` wrapper) as a fallback", async () => {
    setLlmContent(JSON.stringify([{ kind: "goal", description: "x" }]));
    const res = await compile("x");
    expect(res.json().blocks).toHaveLength(1);
  });
});

describe("POST /api/blocks/compile — error responses", () => {
  it("returns 502 when the LLM call throws", async () => {
    llmState.throwErr = new Error("upstream timeout");
    const res = await compile("anything");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("upstream timeout");
  });

  it("returns 502 when the model output is not valid JSON", async () => {
    setLlmContent("this is not JSON at all");
    const res = await compile("x");
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("not valid JSON");
  });

  it("returns 502 when the JSON does not contain a blocks array", async () => {
    setLlmContent(JSON.stringify({ unrelated: "shape" }));
    const res = await compile("x");
    expect(res.statusCode).toBe(502);
  });
});

describe("POST /api/blocks/compile — chatOnce options", () => {
  it("passes temperature 0.1 and think: false (single-turn JSON, no thinking)", async () => {
    setLlmContent('{"blocks":[]}');
    await compile("anything");
    const opts = llmState.lastCallOpts;
    expect(opts).not.toBeNull();
    expect(opts?.temperature).toBeCloseTo(0.1);
    expect(opts?.think).toBe(false);
  });
});
