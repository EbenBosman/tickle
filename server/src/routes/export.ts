import type { FastifyInstance } from "fastify";
import { db } from "../db.ts";

type MessagesExportPayload = {
  block_id: string;
  block_kind: string;
  instruction: string;
  rescue_model: string;
  local_status: string;
  local_error: string;
  local_step_count: number;
  rescue_status: string;
  rescue_step_count: number;
  local_messages: unknown[];
  rescue_messages: unknown[];
};

type StepRow = {
  run_id: number;
  payload: string;
};

export async function exportRoutes(app: FastifyInstance) {
  app.get("/api/export", async (req, reply) => {
    const { status: filterStatus } = req.query as { status?: string };
    const onlyRescued = filterStatus === "rescued";

    const rows = db
      .prepare(
        `SELECT s.run_id, s.payload
         FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE s.kind = 'messages_export'
           AND r.status = 'done'
         ORDER BY s.run_id, s.id`,
      )
      .all() as StepRow[];

    reply.header("content-type", "application/x-ndjson");
    reply.header(
      "content-disposition",
      `attachment; filename="tickle-training-${Date.now()}.jsonl"`,
    );

    const lines: string[] = [];
    for (const row of rows) {
      let payload: MessagesExportPayload;
      try {
        payload = JSON.parse(row.payload) as MessagesExportPayload;
      } catch {
        continue;
      }

      const hasRescue = payload.rescue_messages?.length > 0;
      if (onlyRescued && !hasRescue) continue;

      const meta = {
        run_id: row.run_id,
        block_id: payload.block_id,
        block_kind: payload.block_kind,
        rescue_model: payload.rescue_model,
        local_step_count: payload.local_step_count,
        rescue_step_count: payload.rescue_step_count,
      };

      if (hasRescue) {
        // DPO pair: rejected = local attempt, chosen = claude rescue
        lines.push(
          JSON.stringify({ role: "rejected", messages: payload.local_messages, meta }),
        );
        lines.push(
          JSON.stringify({ role: "chosen", messages: payload.rescue_messages, meta }),
        );
      } else {
        // Local model succeeded — still useful as positive SFT data
        lines.push(
          JSON.stringify({ role: "chosen", messages: payload.local_messages, meta }),
        );
      }
    }

    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  });
}
