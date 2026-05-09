import type { FastifyInstance } from "fastify";
import { db, type Task } from "../db.ts";
import { instructionToBlocks, type Block } from "../blocks.ts";

function ensureSteps(task: Task): Task {
  // Lazy migration: any task without steps gets its instruction wrapped as a goal block.
  if (task.steps) return task;
  const blocks = task.instruction.trim() ? instructionToBlocks(task.instruction) : [];
  const json = JSON.stringify(blocks);
  db.prepare("UPDATE tasks SET steps = ? WHERE id = ?").run(json, task.id);
  return { ...task, steps: json };
}

export async function tasksRoutes(app: FastifyInstance) {
  app.get("/api/tasks", async () => {
    const rows = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all() as Task[];
    return rows.map(ensureSteps);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as
      | Task
      | undefined;
    if (!task) return reply.code(404).send({ error: "not found" });
    return ensureSteps(task);
  });

  app.post<{ Body: { name: string; instruction?: string; steps?: Block[] } }>(
    "/api/tasks",
    async (req, reply) => {
      const { name, instruction = "", steps } = req.body ?? {};
      if (!name?.trim()) {
        return reply.code(400).send({ error: "name required" });
      }
      const blocks: Block[] = Array.isArray(steps)
        ? steps
        : instruction.trim()
          ? instructionToBlocks(instruction)
          : [];
      const info = db
        .prepare("INSERT INTO tasks (name, instruction, steps) VALUES (?, ?, ?)")
        .run(name.trim(), instruction.trim(), JSON.stringify(blocks));
      return db.prepare("SELECT * FROM tasks WHERE id = ?").get(info.lastInsertRowid);
    },
  );

  app.put<{
    Params: { id: string };
    Body: { name?: string; instruction?: string; steps?: Block[] };
  }>("/api/tasks/:id", async (req, reply) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as
      | Task
      | undefined;
    if (!existing) return reply.code(404).send({ error: "not found" });
    // Empty-string or whitespace-only name is treated as omitted (keep the
    // existing). Mirrors POST validation, which rejects empty names. `??`
    // wouldn't help here because it only catches null/undefined, not "".
    const candidateName = req.body.name?.trim();
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    const name = candidateName || existing.name;
    // Instruction has no such constraint; an empty string is a valid clear.
    const instruction = req.body.instruction?.trim() ?? existing.instruction;
    const stepsJson = Array.isArray(req.body.steps)
      ? JSON.stringify(req.body.steps)
      : existing.steps;
    db.prepare("UPDATE tasks SET name = ?, instruction = ?, steps = ? WHERE id = ?").run(
      name,
      instruction,
      stepsJson,
      req.params.id,
    );
    return db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    if (result.changes === 0) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
}
