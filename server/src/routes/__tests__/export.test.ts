import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildAppWithRoute } from "../../__tests__/helpers/routeFixture.ts";

// docs/specs/server/http-export.md
//
// /api/export drains messages_export steps from done runs as JSONL
// training data — DPO pairs (rejected/chosen) when rescue ran, single
// chosen line when local succeeded.

const originalDbPath = process.env.TICKLE_DB_PATH;
let app: FastifyInstance;

type DbModule = typeof import("../../db.ts");
let db: DbModule["db"];

async function seed(payload: Record<string, unknown>, runStatus = "done") {
  // Insert a run, then a step row of kind messages_export.
  const taskInfo = db
    .prepare("INSERT INTO tasks (name, instruction) VALUES (?, ?)")
    .run("test-task", "x");
  const runInfo = db
    .prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)")
    .run(taskInfo.lastInsertRowid, runStatus);
  db.prepare(
    "INSERT INTO steps (run_id, idx, kind, payload, screenshot_path) VALUES (?, ?, ?, ?, NULL)",
  ).run(runInfo.lastInsertRowid, 0, "messages_export", JSON.stringify(payload));
  return Number(runInfo.lastInsertRowid);
}

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  vi.resetModules();
  app = await buildAppWithRoute("../../routes/export.ts");
  db = (await import("../../db.ts")).db;
});

afterEach(async () => {
  await app.close();
  if (originalDbPath === undefined) delete process.env.TICKLE_DB_PATH;
  else process.env.TICKLE_DB_PATH = originalDbPath;
});

describe("GET /api/export — empty", () => {
  it("returns an empty body when there are no rows", async () => {
    const res = await app.inject({ method: "GET", url: "/api/export" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toBe("");
  });

  it("sets the JSONL content-type and a filename attachment header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/export" });
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.headers["content-disposition"]).toMatch(
      /attachment; filename="tickle-training-\d+\.jsonl"/,
    );
  });
});

describe("GET /api/export — DPO pairs vs single SFT lines", () => {
  it("emits rejected+chosen pair when rescue_messages is non-empty", async () => {
    await seed({
      block_id: "b1",
      block_kind: "goal",
      instruction: "x",
      rescue_model: "claude-sonnet-4-6",
      local_status: "failed",
      local_error: "boom",
      local_step_count: 5,
      rescue_status: "done",
      rescue_step_count: 3,
      local_messages: [{ role: "user", content: "local" }],
      rescue_messages: [{ role: "user", content: "rescue" }],
    });
    const res = await app.inject({ method: "GET", url: "/api/export" });
    const lines = res.payload.trim().split("\n");
    expect(lines).toHaveLength(2);
    const rejected = JSON.parse(lines[0]);
    const chosen = JSON.parse(lines[1]);
    expect(rejected.role).toBe("rejected");
    expect(chosen.role).toBe("chosen");
    expect(rejected.messages).toEqual([{ role: "user", content: "local" }]);
    expect(chosen.messages).toEqual([{ role: "user", content: "rescue" }]);
  });

  it("emits a single chosen line when rescue_messages is empty", async () => {
    await seed({
      block_id: "b1",
      block_kind: "goal",
      instruction: "x",
      rescue_model: "claude-sonnet-4-6",
      local_status: "done",
      local_error: "",
      local_step_count: 3,
      rescue_status: "skipped",
      rescue_step_count: 0,
      local_messages: [{ role: "user", content: "local" }],
      rescue_messages: [],
    });
    const res = await app.inject({ method: "GET", url: "/api/export" });
    const lines = res.payload.trim().split("\n");
    expect(lines).toHaveLength(1);
    const single = JSON.parse(lines[0]);
    expect(single.role).toBe("chosen");
  });
});

describe("GET /api/export — meta-only allowlist", () => {
  it("does NOT leak instruction or local_error into the meta", async () => {
    await seed({
      block_id: "b1",
      block_kind: "goal",
      instruction: "SHOULD-NOT-LEAK-instruction",
      rescue_model: "claude-sonnet-4-6",
      local_status: "failed",
      local_error: "SHOULD-NOT-LEAK-error",
      local_step_count: 1,
      rescue_status: "done",
      rescue_step_count: 1,
      local_messages: [],
      rescue_messages: [{ role: "user", content: "ok" }],
    });
    const res = await app.inject({ method: "GET", url: "/api/export" });
    expect(res.payload).not.toContain("SHOULD-NOT-LEAK-instruction");
    expect(res.payload).not.toContain("SHOULD-NOT-LEAK-error");
    const lines = res.payload.trim().split("\n");
    const parsed = JSON.parse(lines[0]);
    expect(parsed.meta.block_id).toBe("b1");
    expect(parsed.meta.rescue_model).toBe("claude-sonnet-4-6");
  });
});

describe("GET /api/export — filtering", () => {
  it("filters out runs whose status is not 'done'", async () => {
    await seed({ rescue_messages: [{}], local_messages: [] }, "running");
    const res = await app.inject({ method: "GET", url: "/api/export" });
    expect(res.payload).toBe("");
  });

  it("status=rescued only returns rows that have a rescue_messages payload", async () => {
    await seed({ rescue_messages: [{ role: "user" }], local_messages: [{ role: "user" }] });
    await seed({ rescue_messages: [], local_messages: [{ role: "user" }] });
    const all = await app.inject({ method: "GET", url: "/api/export" });
    expect(all.payload.trim().split("\n")).toHaveLength(3); // 2 (DPO pair) + 1 (chosen)

    const rescuedOnly = await app.inject({ method: "GET", url: "/api/export?status=rescued" });
    expect(rescuedOnly.payload.trim().split("\n")).toHaveLength(2); // only the DPO pair
  });

  it("skips a row whose payload is malformed JSON without aborting the whole stream", async () => {
    // First row: malformed payload.
    const taskInfo = db
      .prepare("INSERT INTO tasks (name, instruction) VALUES (?, ?)")
      .run("t", "x");
    const r1 = db
      .prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)")
      .run(taskInfo.lastInsertRowid, "done");
    db.prepare(
      "INSERT INTO steps (run_id, idx, kind, payload, screenshot_path) VALUES (?, ?, ?, ?, NULL)",
    ).run(Number(r1.lastInsertRowid), 0, "messages_export", "{not-json");

    // Second row: valid.
    await seed({ rescue_messages: [], local_messages: [{ role: "user" }] });

    const res = await app.inject({ method: "GET", url: "/api/export" });
    expect(res.payload.trim().split("\n")).toHaveLength(1);
  });
});
