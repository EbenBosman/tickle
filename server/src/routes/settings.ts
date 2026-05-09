import type { FastifyInstance } from "fastify";
import { db, getSetting, setSetting, listLessons } from "../db.ts";
import { isValidModel } from "../domain/models.ts";

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () => {
    const lessonCount = (db.prepare("SELECT COUNT(*) as n FROM lessons").get() as { n: number }).n;
    return {
      rescue_enabled: getSetting("rescue_enabled") === "true",
      rescue_model: getSetting("rescue_model") ?? "claude-sonnet-4-6",
      rescue_on_cancel: getSetting("rescue_on_cancel") === "true",
      api_key_configured: Boolean(process.env.ANTHROPIC_API_KEY),
      lesson_count: lessonCount,
    };
  });

  app.put("/api/settings", async (req, reply) => {
    const body = req.body as
      | { rescue_enabled?: boolean; rescue_model?: string; rescue_on_cancel?: boolean }
      | undefined;
    if (!body) return reply.code(400).send({ error: "empty body" });

    if (typeof body.rescue_enabled === "boolean") {
      setSetting("rescue_enabled", String(body.rescue_enabled));
    }
    if (typeof body.rescue_model === "string") {
      if (!isValidModel(body.rescue_model)) {
        return reply.code(400).send({ error: `unknown model: ${body.rescue_model}` });
      }
      setSetting("rescue_model", body.rescue_model);
    }
    if (typeof body.rescue_on_cancel === "boolean") {
      setSetting("rescue_on_cancel", String(body.rescue_on_cancel));
    }

    const lessonCount = (db.prepare("SELECT COUNT(*) as n FROM lessons").get() as { n: number }).n;
    return {
      rescue_enabled: getSetting("rescue_enabled") === "true",
      rescue_model: getSetting("rescue_model") ?? "claude-sonnet-4-6",
      rescue_on_cancel: getSetting("rescue_on_cancel") === "true",
      api_key_configured: Boolean(process.env.ANTHROPIC_API_KEY),
      lesson_count: lessonCount,
    };
  });

  app.get("/api/lessons", async (req) => {
    const { offset, limit } = req.query as { offset?: string; limit?: string };
    const offsetN = (() => {
      const n = Number(offset);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    })();
    const limitN = (() => {
      const n = Number(limit);
      // NaN, negative, zero -> default 50; otherwise clamp to [1, 200].
      if (!Number.isFinite(n) || n <= 0) return 50;
      return Math.min(Math.floor(n), 200);
    })();
    return listLessons(offsetN, limitN);
  });

  app.delete("/api/lessons/:id", async (req, _reply) => {
    const { id } = req.params as { id: string };
    db.prepare("DELETE FROM lessons WHERE id = ?").run(Number(id));
    db.prepare("DELETE FROM lessons_fts WHERE rowid = ?").run(Number(id));
    return { ok: true };
  });
}
