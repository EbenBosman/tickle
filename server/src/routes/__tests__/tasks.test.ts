import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildAppWithRoute } from "../../__tests__/helpers/routeFixture.ts";

// docs/specs/server/http-tasks.md
//
// Task CRUD plus lazy `instruction` → `steps` migration on read.
// Tests use TICKLE_DB_PATH=:memory: so each fresh import gets a clean
// SQLite + schema bootstrap from db.ts. vi.resetModules() in
// beforeEach ensures the route, db, and blocks modules all see the
// fresh in-memory connection.

const originalDbPath = process.env.TICKLE_DB_PATH;
let app: FastifyInstance;

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  vi.resetModules();
  app = await buildAppWithRoute("../../routes/tasks.ts");
});

afterEach(async () => {
  await app.close();
  if (originalDbPath === undefined) delete process.env.TICKLE_DB_PATH;
  else process.env.TICKLE_DB_PATH = originalDbPath;
});

async function createTask(body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return await app.inject({ method: "POST", url: "/api/tasks", payload: body });
}

describe("POST /api/tasks", () => {
  it("creates a task with name + instruction; auto-derives a single goal block", async () => {
    const res = await createTask({ name: "Buy milk", instruction: "go to the store" });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.name).toBe("Buy milk");
    expect(task.instruction).toBe("go to the store");
    const steps = JSON.parse(task.steps);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("goal");
    expect(steps[0].description).toBe("go to the store");
  });

  it("creates a task with an explicit `steps` array", async () => {
    const steps = [
      { id: "x", kind: "navigate", url: "https://example.com" },
      { id: "y", kind: "goal", description: "find the price" },
    ];
    const res = await createTask({ name: "Price check", steps });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(JSON.parse(task.steps)).toEqual(steps);
  });

  it("returns 400 when name is missing or whitespace", async () => {
    const r1 = await createTask({ instruction: "x" });
    expect(r1.statusCode).toBe(400);

    const r2 = await createTask({ name: "   ", instruction: "x" });
    expect(r2.statusCode).toBe(400);
  });

  it("trims whitespace from name and instruction", async () => {
    const res = await createTask({ name: "  trimmed  ", instruction: "  hi  " });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.name).toBe("trimmed");
    expect(task.instruction).toBe("hi");
  });
});

describe("GET /api/tasks", () => {
  it("returns an empty list when no tasks exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns tasks newest-first by id", async () => {
    await createTask({ name: "first" });
    await createTask({ name: "second" });
    const res = await app.inject({ method: "GET", url: "/api/tasks" });
    const list = res.json();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("second");
    expect(list[1].name).toBe("first");
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tasks/9999" });
    expect(res.statusCode).toBe(404);
  });

  it("returns the task for a known id", async () => {
    const create = await createTask({ name: "T1", instruction: "do it" });
    const id = create.json().id;
    const res = await app.inject({ method: "GET", url: `/api/tasks/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });
});

describe("PUT /api/tasks/:id", () => {
  it("updates name and instruction", async () => {
    const create = await createTask({ name: "before", instruction: "old" });
    const id = create.json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/tasks/${id}`,
      payload: { name: "after", instruction: "new" },
    });
    expect(res.statusCode).toBe(200);
    const task = res.json();
    expect(task.name).toBe("after");
    expect(task.instruction).toBe("new");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/tasks/9999",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("preserves omitted fields", async () => {
    const create = await createTask({ name: "keep-name", instruction: "keep-instruction" });
    const id = create.json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/tasks/${id}`,
      payload: { name: "renamed" },
    });
    const task = res.json();
    expect(task.name).toBe("renamed");
    expect(task.instruction).toBe("keep-instruction");
  });

  it("replaces steps when an explicit array is sent", async () => {
    const create = await createTask({ name: "T", instruction: "x" });
    const id = create.json().id;
    const newSteps = [{ id: "z", kind: "navigate", url: "https://example.com" }];
    const res = await app.inject({
      method: "PUT",
      url: `/api/tasks/${id}`,
      payload: { steps: newSteps },
    });
    expect(JSON.parse(res.json().steps)).toEqual(newSteps);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("deletes an existing task", async () => {
    const create = await createTask({ name: "T" });
    const id = create.json().id;
    const del = await app.inject({ method: "DELETE", url: `/api/tasks/${id}` });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: `/api/tasks/${id}` });
    expect(get.statusCode).toBe(404);
  });

  it("returns 404 for an unknown id (consistent with GET/PUT)", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/tasks/9999" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /api/tasks/:id — empty-string name guard", () => {
  it("preserves the existing name when body sends name: ''", async () => {
    const create = await createTask({ name: "real-name", instruction: "x" });
    const id = create.json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/tasks/${id}`,
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("real-name");
  });

  it("preserves the existing name when body sends whitespace-only name", async () => {
    const create = await createTask({ name: "real-name", instruction: "x" });
    const id = create.json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/tasks/${id}`,
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("real-name");
  });

  it("still allows an empty-string instruction to clear the field", async () => {
    const create = await createTask({ name: "T", instruction: "old" });
    const id = create.json().id;
    const res = await app.inject({
      method: "PUT",
      url: `/api/tasks/${id}`,
      payload: { instruction: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().instruction).toBe("");
  });
});

describe("ensureSteps lazy migration", () => {
  it("on GET /api/tasks/:id, fills in steps when null and persists", async () => {
    // Simulate a legacy row with no steps by writing directly via the
    // db module — same in-memory connection the route uses.
    const { db } = await import("../../db.ts");
    const info = db
      .prepare("INSERT INTO tasks (name, instruction, steps) VALUES (?, ?, NULL)")
      .run("legacy", "search the store");
    const id = Number(info.lastInsertRowid);

    const first = await app.inject({ method: "GET", url: `/api/tasks/${id}` });
    expect(first.statusCode).toBe(200);
    const steps = JSON.parse(first.json().steps);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("goal");

    // Should now be persisted: a second GET returns the same data
    // without re-deriving (verified by hitting the row directly).
    const row = db.prepare("SELECT steps FROM tasks WHERE id = ?").get(id) as { steps: string };
    expect(JSON.parse(row.steps)).toHaveLength(1);
  });
});
