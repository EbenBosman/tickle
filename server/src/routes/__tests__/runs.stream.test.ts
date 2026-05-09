import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Last-Event-ID auto-reconnect: when EventSource reconnects after a
// transient drop, it sends the last `id:` value as `Last-Event-ID`.
// The /stream handler uses that to skip already-replayed step rows.
//
// We mock runAgent so the route doesn't actually run anything; instead
// we seed the steps table directly and exercise the replay path.

vi.mock("../../agent.ts", () => {
  return {
    runAgent: vi.fn(async () => ({ status: "done", result: "ok" })),
  };
});

const originalDbPath = process.env.TICKLE_DB_PATH;
let app: FastifyInstance;
type DbModule = typeof import("../../db.ts");
let db: DbModule["db"];

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  vi.resetModules();
  await import("../../cancel.ts");
  db = (await import("../../db.ts")).db;
  const mod = await import("../../routes/runs.ts");
  const Fastify = (await import("fastify")).default;
  app = Fastify();
  await app.register(mod.runsRoutes);
});

afterEach(async () => {
  await app.close();
  if (originalDbPath === undefined) delete process.env.TICKLE_DB_PATH;
  else process.env.TICKLE_DB_PATH = originalDbPath;
});

function seedRun(): { runId: number } {
  const taskInfo = db
    .prepare("INSERT INTO tasks (name, instruction) VALUES (?, ?)")
    .run("t", "i");
  const taskId = Number(taskInfo.lastInsertRowid);
  // Seed a terminal run so the /stream handler returns synchronously
  // after replay (no live subscription needed).
  const runInfo = db
    .prepare("INSERT INTO runs (task_id, status, finished_at) VALUES (?, 'done', ?)")
    .run(taskId, new Date().toISOString());
  const runId = Number(runInfo.lastInsertRowid);
  const ins = db.prepare(
    "INSERT INTO steps (run_id, idx, kind, payload, screenshot_path) VALUES (?, ?, ?, ?, NULL)",
  );
  ins.run(runId, 0, "thought", JSON.stringify({ text: "first" }));
  ins.run(runId, 1, "thought", JSON.stringify({ text: "second" }));
  ins.run(runId, 2, "thought", JSON.stringify({ text: "third" }));
  return { runId };
}

/** Parse the SSE wire format into a list of `{ id, data }` records. */
function parseSse(payload: string): { id: string | null; data: unknown }[] {
  const out: { id: string | null; data: unknown }[] = [];
  let currentId: string | null = null;
  let currentData: string | null = null;
  for (const line of payload.split("\n")) {
    if (line.startsWith("id: ")) currentId = line.slice(4);
    else if (line.startsWith("data: ")) currentData = line.slice(6);
    else if (line === "" && currentData !== null) {
      out.push({ id: currentId, data: JSON.parse(currentData) });
      currentId = null;
      currentData = null;
    }
  }
  return out;
}

describe("/api/runs/:id/stream — Last-Event-ID reconnect", () => {
  it("annotates each replay event with `id: r-<idx>`", async () => {
    const { runId } = seedRun();
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/stream` });
    const events = parseSse(res.payload);
    // 3 replay rows + 1 terminal `end` event.
    const replays = events.filter((e) => e.id?.startsWith("r-"));
    expect(replays.map((e) => e.id)).toEqual(["r-0", "r-1", "r-2"]);
  });

  it("when Last-Event-ID=r-1 is sent, only idx > 1 is replayed", async () => {
    const { runId } = seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/stream`,
      headers: { "last-event-id": "r-1" },
    });
    const events = parseSse(res.payload);
    const replays = events.filter((e) => e.id?.startsWith("r-"));
    expect(replays.map((e) => e.id)).toEqual(["r-2"]);
  });

  it("when Last-Event-ID is malformed, falls back to full replay", async () => {
    const { runId } = seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/stream`,
      headers: { "last-event-id": "not-a-row-id" },
    });
    const events = parseSse(res.payload);
    const replays = events.filter((e) => e.id?.startsWith("r-"));
    expect(replays).toHaveLength(3);
  });

  it("when Last-Event-ID points past the last persisted idx, replay is empty", async () => {
    const { runId } = seedRun();
    const res = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/stream`,
      headers: { "last-event-id": "r-99" },
    });
    const events = parseSse(res.payload);
    const replays = events.filter((e) => e.id?.startsWith("r-"));
    expect(replays).toHaveLength(0);
  });

  it("live (non-replay) events get `id: live-<n>` annotations on every connection", async () => {
    const { runId } = seedRun();
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/stream` });
    const events = parseSse(res.payload);
    // The terminal `end` event is a live emission and must carry an id.
    const liveEnd = events.find(
      (e) => typeof e.data === "object" && e.data !== null && (e.data as { kind?: string }).kind === "end",
    );
    expect(liveEnd?.id).toMatch(/^live-\d+$/);
  });
});
