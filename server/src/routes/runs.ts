import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, unlinkSync } from "node:fs";
import { db, type Run, type Step, type Task } from "../db.ts";
import { runAgent } from "../agent.ts";
import { subscribe, publish, endTopic } from "../bus.ts";
import { requestCancel } from "../cancel.ts";
import { pause, resume, isPaused, getPauseInfo } from "../pause.ts";
import { trace } from "../log.ts";

function deleteRunArtifacts(runId: number): number {
  const rows = db
    .prepare("SELECT screenshot_path FROM steps WHERE run_id = ? AND screenshot_path IS NOT NULL")
    .all(runId) as { screenshot_path: string }[];
  let removed = 0;
  for (const r of rows) {
    const p = `screenshots/${r.screenshot_path}`;
    if (existsSync(p)) {
      try {
        unlinkSync(p);
        removed++;
      } catch {
        // ignore individual delete failures
      }
    }
  }
  db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
  return removed;
}

export async function runsRoutes(app: FastifyInstance) {
  // Start a run for a task. Returns immediately with run id; the agent runs in the background.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/run", async (req, reply) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as
      | Task
      | undefined;
    if (!task) return reply.code(404).send({ error: "task not found" });

    const info = db
      .prepare("INSERT INTO runs (task_id, status) VALUES (?, 'running')")
      .run(task.id);
    const runId = Number(info.lastInsertRowid);

    // Kick off the agent loop without awaiting.
    (async () => {
      const outcome = await runAgent(
        runId,
        task.id,
        task.instruction,
        task.steps ?? null,
        (ev) => publish(runId, ev),
      );
      const finishedAt = new Date().toISOString();
      if (outcome.status === "done") {
        db.prepare(
          "UPDATE runs SET status='done', result=?, finished_at=? WHERE id=?",
        ).run(outcome.result ?? "", finishedAt, runId);
      } else if (outcome.status === "cancelled") {
        db.prepare(
          "UPDATE runs SET status='cancelled', error=?, finished_at=? WHERE id=?",
        ).run(outcome.error ?? "Cancelled by user", finishedAt, runId);
      } else {
        db.prepare(
          "UPDATE runs SET status='error', error=?, finished_at=? WHERE id=?",
        ).run(outcome.error ?? "", finishedAt, runId);
      }
      publish(runId, { kind: "end", status: outcome.status, result: outcome.result, error: outcome.error });
      // Give late subscribers a moment, then drop the topic.
      setTimeout(() => endTopic(runId), 5000);
    })();

    return { run_id: runId };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
    const runId = Number(req.params.id);

    // Live path: in-process handler exists, signal it.
    if (requestCancel(runId)) {
      return { ok: true, mode: "live" };
    }

    // Zombie path: DB says `running` but no live handler — typically because
    // the agent died between turns (tsx-watch reload, crash). Force the row
    // to a terminal state so the UI unblocks and run-list cleanup works.
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
      | { status: string }
      | undefined;
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (run.status !== "running") {
      return reply.code(409).send({ error: `run is already ${run.status}` });
    }

    const finishedAt = new Date().toISOString();
    db.prepare(
      "UPDATE runs SET status='cancelled', error=?, finished_at=? WHERE id=?",
    ).run("Force-stopped by user (no live handler — likely server restarted mid-run)", finishedAt, runId);
    // Notify any SSE listeners that may have reconnected after the crash.
    publish(runId, {
      kind: "end",
      status: "cancelled",
      error: "Force-stopped by user",
    });
    trace("run.force_cancelled", { runId });
    return { ok: true, mode: "force" };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/pause", async (req, reply) => {
    const runId = Number(req.params.id);
    const reason = "Paused by user";
    const ok = pause(runId, { reason, auto: false });
    if (!ok) return reply.code(409).send({ error: "run not active or already paused" });
    trace("run.paused", { runId });
    publish(runId, { kind: "paused", reason, auto: false });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => {
    const runId = Number(req.params.id);
    const ok = resume(runId);
    if (!ok) return reply.code(409).send({ error: "run not active or not paused" });
    trace("run.resumed", { runId });
    publish(runId, { kind: "resumed" });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const runId = Number(req.params.id);
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Run | undefined;
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (run.status === "running") {
      return reply
        .code(409)
        .send({ error: "run is still active — cancel it first, then delete" });
    }
    const screenshots = deleteRunArtifacts(runId);
    return { ok: true, screenshots_removed: screenshots };
  });

  app.delete<{
    Params: { taskId: string };
    Querystring: { force?: string; reset_ids?: string };
  }>("/api/tasks/:taskId/runs", async (req, reply) => {
    const taskId = Number(req.params.taskId);
    const force = req.query.force === "true" || req.query.force === "1";
    const resetIds = req.query.reset_ids === "true" || req.query.reset_ids === "1";

    const runs = db.prepare("SELECT id, status FROM runs WHERE task_id = ?").all(taskId) as Pick<
      Run,
      "id" | "status"
    >[];
    const active = runs.filter((r) => r.status === "running");

    if (active.length > 0 && !force) {
      return reply.code(409).send({
        error: `${active.length} run(s) still active`,
        active: active.length,
      });
    }

    // Try to gracefully cancel active runs first; doesn't matter if there's no
    // live in-process handler (server restarted, zombie row), we mark them
    // cancelled in the DB regardless.
    const finishedAt = new Date().toISOString();
    for (const r of active) {
      try {
        requestCancel(r.id);
      } catch {
        // ignore
      }
      db.prepare(
        "UPDATE runs SET status='cancelled', error=?, finished_at=? WHERE id=?",
      ).run("Force-cleared by user", finishedAt, r.id);
    }

    let totalShots = 0;
    for (const r of runs) totalShots += deleteRunArtifacts(r.id);

    if (resetIds || (force && runs.length > 0)) {
      // Only safe when no other tasks have remaining runs — otherwise the
      // shared sqlite_sequence reset would clash with their ids.
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
      if (remaining.n === 0) {
        try {
          db.exec("DELETE FROM sqlite_sequence WHERE name='runs'");
        } catch {
          // sqlite_sequence may not exist if no autoincrement has happened yet
        }
      }
    }

    return {
      ok: true,
      deleted: runs.length,
      forced: active.length,
      screenshots_removed: totalShots,
    };
  });

  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/runs", async (req) => {
    const runs = db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC")
      .all(req.params.taskId) as Run[];
    return runs.map((r) => ({ ...r, is_paused: isPaused(r.id) }));
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(req.params.id) as Run | undefined;
    if (!run) return reply.code(404).send({ error: "not found" });
    const steps = db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY idx ASC")
      .all(req.params.id) as Step[];
    const paused = isPaused(run.id);
    const pauseInfo = paused ? getPauseInfo(run.id) : null;
    return { run: { ...run, is_paused: paused }, steps, pause_info: pauseInfo };
  });

  // SSE stream of agent events for a live run.
  app.get<{ Params: { id: string } }>("/api/runs/:id/stream", async (req, reply) => {
    const runId = Number(req.params.id);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay any steps already persisted (so a late connection sees the full history).
    const existing = db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY idx ASC")
      .all(runId) as Step[];
    for (const s of existing) {
      send({ replay: true, step: s });
    }

    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Run | undefined;
    if (run && run.status !== "running") {
      send({ kind: "end", status: run.status, result: run.result, error: run.error });
      reply.raw.end();
      return;
    }

    // If the run is currently paused, replay a synthetic `paused` event so a
    // reconnecting UI knows to show the Resume button. Without this, a refresh
    // mid-pause leaves the UI thinking the run is still actively running.
    if (isPaused(runId)) {
      const info = getPauseInfo(runId);
      send({ kind: "paused", reason: info?.reason, auto: info?.auto });
    }

    const unsubscribe = subscribe(runId, (event) => send(event));

    req.raw.on("close", () => {
      unsubscribe();
    });

    // Keep the handler alive
    return reply;
  });

  // Serve persisted screenshots
  app.get<{ Params: { "*": string } }>("/screenshots/*", async (req, reply) => {
    const path = `screenshots/${req.params["*"]}`;
    if (!existsSync(path) || !path.endsWith(".png")) {
      return reply.code(404).send();
    }
    reply.type("image/png");
    return reply.send(createReadStream(path));
  });
}
