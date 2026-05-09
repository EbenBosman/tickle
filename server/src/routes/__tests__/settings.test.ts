import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildAppWithRoute } from "../../__tests__/helpers/routeFixture.ts";

// docs/specs/server/http-settings.md

const originalDbPath = process.env.TICKLE_DB_PATH;
const originalAnthropic = process.env.ANTHROPIC_API_KEY;
let app: FastifyInstance;

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  vi.resetModules();
  app = await buildAppWithRoute("../../routes/settings.ts");
});

afterEach(async () => {
  await app.close();
  if (originalDbPath === undefined) delete process.env.TICKLE_DB_PATH;
  else process.env.TICKLE_DB_PATH = originalDbPath;
  if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropic;
});

describe("GET /api/settings", () => {
  it("returns the seeded defaults", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rescue_enabled: false,
      rescue_model: "claude-sonnet-4-6",
      rescue_on_cancel: false,
      lesson_count: 0,
    });
  });

  it("api_key_configured reflects ANTHROPIC_API_KEY env presence", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r1 = await app.inject({ method: "GET", url: "/api/settings" });
    expect(r1.json().api_key_configured).toBe(false);

    process.env.ANTHROPIC_API_KEY = "sk-test";
    const r2 = await app.inject({ method: "GET", url: "/api/settings" });
    expect(r2.json().api_key_configured).toBe(true);
  });

  it("does NOT leak the API key value", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-supersecret-12345";
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.payload).not.toContain("sk-supersecret-12345");
  });
});

describe("PUT /api/settings", () => {
  it("returns 400 on missing body", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/settings" });
    expect(res.statusCode).toBe(400);
  });

  it("updates rescue_enabled boolean", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { rescue_enabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rescue_enabled).toBe(true);
  });

  it("rejects an unknown rescue_model with 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { rescue_model: "claude-7" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("unknown model");
  });

  it("accepts each known rescue_model", async () => {
    for (const model of [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { rescue_model: model },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().rescue_model).toBe(model);
    }
  });

  it("partial updates leave omitted fields unchanged", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { rescue_enabled: true, rescue_on_cancel: true },
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { rescue_enabled: false },
    });
    const settings = res.json();
    expect(settings.rescue_enabled).toBe(false);
    expect(settings.rescue_on_cancel).toBe(true); // not touched
  });

  it("ignores wrong-type fields silently", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { rescue_enabled: "yes" }, // not a boolean — should be ignored
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rescue_enabled).toBe(false);
  });
});

describe("GET /api/lessons", () => {
  it("returns an empty list when no lessons exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/lessons" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.lessons)).toBe(true);
    expect(body.lessons).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("DELETE /api/lessons/:id", () => {
  it("returns ok:true even for an unknown id (idempotent)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/lessons/9999" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
