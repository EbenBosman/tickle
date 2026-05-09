import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// docs/specs/server/http-runs.md
//
// Most endpoints are JSON-shaped and testable with app.inject(). The
// agent IIFE is fire-and-forget — when the test cares about the
// terminal state of the runs row, it subscribes to the bus's `end`
// event before injecting and awaits that. SSE itself is exercised only
// at smoke level here.

const agentState = vi.hoisted(() => {
  type Outcome = {
    status: "done" | "error" | "cancelled";
    result?: string;
    error?: string;
  };
  const outcome: Outcome = { status: "done" };
  return {
    /** What runAgent should resolve to (or throw, when set on `throwErr`). */
    nextOutcome: outcome,
    /** When set, runAgent throws this instead of resolving. */
    throwErr: null as Error | null,
    /** Most recent (runId, taskId) the route invoked us with. */
    lastCall: null as { runId: number; taskId: number } | null,
    /** Hooks that simulate cancel/pause registration mid-run for the cancel/pause tests. */
    onStart: null as ((runId: number) => Promise<void> | void) | null,
  };
});

vi.mock("../../agent.ts", () => {
  return {
    runAgent: vi.fn(
      async (runId: number, taskId: number, _instruction: string, _stepsJson: string | null) => {
        agentState.lastCall = { runId, taskId };
        if (agentState.onStart) await agentState.onStart(runId);
        if (agentState.throwErr) throw agentState.throwErr;
        return agentState.nextOutcome;
      },
    ),
  };
});

const originalDbPath = process.env.TICKLE_DB_PATH;
let app: FastifyInstance;
let bus: typeof import("../../bus.ts");
let pauseMod: typeof import("../../pause.ts");
type DbModule = typeof import("../../db.ts");
let db: DbModule["db"];

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  agentState.nextOutcome = { status: "done", result: "ok" };
  agentState.throwErr = null;
  agentState.lastCall = null;
  agentState.onStart = null;

  vi.resetModules();
  bus = await import("../../bus.ts");
  pauseMod = await import("../../pause.ts");
  // Side-effect import: ensure the cancel registry shares the same
  // module graph as routes/runs.ts (otherwise requestCancel keys would
  // diverge across the test seam).
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

async function makeTask(): Promise<number> {
  const info = db
    .prepare("INSERT INTO tasks (name, instruction) VALUES (?, ?)")
    .run("test-task", "do something");
  return Number(info.lastInsertRowid);
}

/** Subscribe to bus, return a promise that resolves on the `end` event for `runId`. */
function awaitEnd(runId: number): Promise<{ status: string; error?: string; result?: string }> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe(runId, (ev) => {
      if (ev.kind === "end") {
        unsub();
        resolve(ev);
      }
    });
  });
}

/**
 * Block runAgent until the caller releases the gate. Lets the test
 * subscribe to the bus (knowing the run_id from the inject response)
 * before the IIFE publishes `end`. Without this, `end` can fire before
 * the test's `bus.subscribe` runs, and `awaitEnd` hangs.
 */
function gatedRun() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  agentState.onStart = () => gate;
  return release;
}

describe("POST /api/tasks/:id/run", () => {
  it("creates a runs row and returns the run_id", async () => {
    const taskId = await makeTask();
    const release = gatedRun();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { run_id } = res.json();
    expect(typeof run_id).toBe("number");
    const ended = awaitEnd(run_id);
    release();
    await ended;
    expect(agentState.lastCall).toEqual({ runId: run_id, taskId });
  });

  it("returns 404 for an unknown task", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/9999/run",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("on success: row ends at status='done' with the result", async () => {
    const taskId = await makeTask();
    agentState.nextOutcome = { status: "done", result: "the answer" };
    const release = gatedRun();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      payload: {},
    });
    const { run_id } = res.json();
    const ended = awaitEnd(run_id);
    release();
    await ended;
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(run_id) as {
      status: string;
      result: string | null;
      finished_at: string | null;
    };
    expect(row.status).toBe("done");
    expect(row.result).toBe("the answer");
    expect(row.finished_at).not.toBeNull();
  });

  it("on agent throw: row ends at status='error' with the message", async () => {
    const taskId = await makeTask();
    agentState.throwErr = new Error("playwright crashed");
    const release = gatedRun();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      payload: {},
    });
    const { run_id } = res.json();
    const ended = awaitEnd(run_id);
    release();
    await ended;
    const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(run_id) as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe("error");
    expect(row.error).toContain("playwright crashed");
  });

  it("on agent return cancelled: row ends at status='cancelled'", async () => {
    const taskId = await makeTask();
    agentState.nextOutcome = { status: "cancelled", error: "user stop" };
    const release = gatedRun();
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      payload: {},
    });
    const { run_id } = res.json();
    const ended = awaitEnd(run_id);
    release();
    await ended;
    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(run_id) as {
      status: string;
    };
    expect(row.status).toBe("cancelled");
  });
});

describe("GET /api/runs/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/runs/9999" });
    expect(res.statusCode).toBe(404);
  });

  it("returns the run row for a known id", async () => {
    const taskId = await makeTask();
    const release = gatedRun();
    const start = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/run`,
      payload: {},
    });
    const { run_id } = start.json();
    const ended = awaitEnd(run_id);
    release();
    await ended;
    const res = await app.inject({ method: "GET", url: `/api/runs/${run_id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toBe(run_id);
  });
});

describe("POST /api/runs/:id/cancel", () => {
  it("force-cancels a zombie running row that has no live handler", async () => {
    const taskId = await makeTask();
    const info = db
      .prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)")
      .run(taskId, "running");
    const runId = Number(info.lastInsertRowid);
    const res = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: "force" });
    const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as {
      status: string;
    };
    expect(row.status).toBe("cancelled");
  });

  it("returns 404 when the run id is unknown", async () => {
    const res = await app.inject({ method: "POST", url: "/api/runs/9999/cancel" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the run is already terminal", async () => {
    const taskId = await makeTask();
    const info = db.prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)").run(taskId, "done");
    const runId = Number(info.lastInsertRowid);
    const res = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel` });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /api/runs/:id/pause and /resume", () => {
  it("returns 409 for pause when no run is registered", async () => {
    const res = await app.inject({ method: "POST", url: "/api/runs/9999/pause" });
    expect(res.statusCode).toBe(409);
  });

  it("pauses and resumes a registered run", async () => {
    const runId = 12345;
    pauseMod.registerRun(runId);
    const pauseRes = await app.inject({ method: "POST", url: `/api/runs/${runId}/pause` });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseMod.isPaused(runId)).toBe(true);

    const resumeRes = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume` });
    expect(resumeRes.statusCode).toBe(200);
    expect(pauseMod.isPaused(runId)).toBe(false);

    pauseMod.clear(runId);
  });

  it("returns 409 for resume when the run is not paused", async () => {
    const runId = 23456;
    pauseMod.registerRun(runId);
    const res = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume` });
    expect(res.statusCode).toBe(409);
    pauseMod.clear(runId);
  });
});

describe("DELETE /api/runs/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/runs/9999" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 409 when the run is still active", async () => {
    const taskId = await makeTask();
    const info = db
      .prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)")
      .run(taskId, "running");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/runs/${info.lastInsertRowid}`,
    });
    expect(res.statusCode).toBe(409);
  });

  it("deletes a terminal run row", async () => {
    const taskId = await makeTask();
    const info = db.prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)").run(taskId, "done");
    const runId = Number(info.lastInsertRowid);
    const res = await app.inject({ method: "DELETE", url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    const row = db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
    expect(row).toBeUndefined();
  });
});
