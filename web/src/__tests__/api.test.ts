import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api.ts";

// docs/specs/web/api-client.md
//
// `api` is a thin wrapper over `fetch`. Tests stub global fetch and
// assert (a) the URL/method/body shape, (b) the j<T>() error path on
// non-2xx, and (c) the special clearTaskRuns 409 decoration.

type FetchArgs = { url: string; init?: RequestInit };

// Body of a Response is a single-use stream — `fetch` is expected to
// produce a fresh Response per call. The mock therefore stores a
// FACTORY that constructs a Response on demand, not a Response.
type Factory = () => Response;

function json(body: unknown, init: ResponseInit = { status: 200 }): Factory {
  return () =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
}

function text(body: string, init: ResponseInit): Factory {
  return () => new Response(body, init);
}

function blob(body: string, init: ResponseInit = { status: 200 }): Factory {
  return () => new Response(body, init);
}

let fetchCalls: FetchArgs[] = [];
let nextResponse: Factory = json({});
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  nextResponse = json({});
  globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: urlStr, init });
    return Promise.resolve(nextResponse());
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("api — happy paths and URL shapes", () => {
  it("listTasks → GET /api/tasks", async () => {
    nextResponse = json([{ id: 1, name: "t" }]);
    await api.listTasks();
    expect(fetchCalls[0].url).toBe("/api/tasks");
    expect(fetchCalls[0].init?.method).toBeUndefined(); // default GET
  });

  it("getTask → GET /api/tasks/:id", async () => {
    nextResponse = json({ id: 7 });
    await api.getTask(7);
    expect(fetchCalls[0].url).toBe("/api/tasks/7");
  });

  it("createTask → POST /api/tasks with JSON body", async () => {
    nextResponse = json({ id: 1 });
    await api.createTask("Buy milk", "go to the store");
    expect(fetchCalls[0].url).toBe("/api/tasks");
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(fetchCalls[0].init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      name: "Buy milk",
      instruction: "go to the store",
    });
  });

  it("updateTask → PUT /api/tasks/:id with patch body", async () => {
    nextResponse = json({ id: 1 });
    await api.updateTask(1, { name: "renamed" });
    expect(fetchCalls[0].url).toBe("/api/tasks/1");
    expect(fetchCalls[0].init?.method).toBe("PUT");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({ name: "renamed" });
  });

  it("deleteTask → DELETE /api/tasks/:id", async () => {
    await api.deleteTask(5);
    expect(fetchCalls[0].url).toBe("/api/tasks/5");
    expect(fetchCalls[0].init?.method).toBe("DELETE");
  });

  it("startRun → POST /api/tasks/:id/run", async () => {
    nextResponse = json({ run_id: 42 });
    const r = await api.startRun(7);
    expect(fetchCalls[0].url).toBe("/api/tasks/7/run");
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(r.run_id).toBe(42);
  });

  it("cancelRun / pauseRun / resumeRun / deleteRun all hit /api/runs/:id/<verb>", async () => {
    await api.cancelRun(1);
    await api.pauseRun(2);
    await api.resumeRun(3);
    await api.deleteRun(4);
    expect(fetchCalls[0]).toMatchObject({ url: "/api/runs/1/cancel" });
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(fetchCalls[1]).toMatchObject({ url: "/api/runs/2/pause" });
    expect(fetchCalls[2]).toMatchObject({ url: "/api/runs/3/resume" });
    expect(fetchCalls[3]).toMatchObject({ url: "/api/runs/4" });
    expect(fetchCalls[3].init?.method).toBe("DELETE");
  });

  it("listRuns → GET /api/tasks/:taskId/runs", async () => {
    nextResponse = json([]);
    await api.listRuns(11);
    expect(fetchCalls[0].url).toBe("/api/tasks/11/runs");
  });

  it("getRun → GET /api/runs/:id", async () => {
    nextResponse = json({ run: { id: 1 }, steps: [], pause_info: null });
    await api.getRun(1);
    expect(fetchCalls[0].url).toBe("/api/runs/1");
  });

  it("compileBlocks → POST /api/blocks/compile with prompt body", async () => {
    nextResponse = json({ blocks: [] });
    await api.compileBlocks("do the thing");
    expect(fetchCalls[0].url).toBe("/api/blocks/compile");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({ prompt: "do the thing" });
  });
});

describe("api — settings + lessons", () => {
  it("getSettings / updateSettings → /api/settings GET and PUT", async () => {
    nextResponse = json({});
    await api.getSettings();
    expect(fetchCalls[0]).toMatchObject({ url: "/api/settings" });
    await api.updateSettings({ rescue_enabled: true });
    expect(fetchCalls[1].url).toBe("/api/settings");
    expect(fetchCalls[1].init?.method).toBe("PUT");
    expect(JSON.parse(fetchCalls[1].init?.body as string)).toEqual({ rescue_enabled: true });
  });

  it("listLessons builds the offset/limit query string", async () => {
    nextResponse = json({ lessons: [], total: 0 });
    await api.listLessons(20, 100);
    expect(fetchCalls[0].url).toBe("/api/lessons?offset=20&limit=100");
  });

  it("listLessons defaults to offset=0&limit=50", async () => {
    nextResponse = json({ lessons: [], total: 0 });
    await api.listLessons();
    expect(fetchCalls[0].url).toBe("/api/lessons?offset=0&limit=50");
  });

  it("deleteLesson → DELETE /api/lessons/:id", async () => {
    await api.deleteLesson(7);
    expect(fetchCalls[0].url).toBe("/api/lessons/7");
    expect(fetchCalls[0].init?.method).toBe("DELETE");
  });
});

describe("api — exportTrainingData", () => {
  it("hits /api/export and returns a Blob", async () => {
    nextResponse = blob("line\n");
    const result = await api.exportTrainingData();
    expect(fetchCalls[0].url).toBe("/api/export");
    expect(result).toBeInstanceOf(Blob);
  });

  it("appends ?status=rescued when onlyRescued=true", async () => {
    nextResponse = blob("");
    await api.exportTrainingData(true);
    expect(fetchCalls[0].url).toBe("/api/export?status=rescued");
  });
});

describe("api — error path", () => {
  it("j<T> throws with `${status} ${body}` shape on non-2xx", async () => {
    nextResponse = text("not found", { status: 404 });
    await expect(api.getTask(99)).rejects.toThrow(/^404 not found$/);
  });

  it("clearTaskRuns decorates the 409 error with status + active fields", async () => {
    nextResponse = json({ error: "still running", active: 2 }, { status: 409 });
    try {
      await api.clearTaskRuns(7);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as Error & { status?: number; active?: number };
      expect(err.message).toBe("still running");
      expect(err.status).toBe(409);
      expect(err.active).toBe(2);
    }
  });

  it("clearTaskRuns appends force/resetIds query toggles", async () => {
    nextResponse = json({ ok: true, deleted: 3, forced: 1 });
    await api.clearTaskRuns(5, { force: true, resetIds: true });
    expect(fetchCalls[0].url).toBe("/api/tasks/5/runs?force=true&reset_ids=true");
    expect(fetchCalls[0].init?.method).toBe("DELETE");
  });
});
