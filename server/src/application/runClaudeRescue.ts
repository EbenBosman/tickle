/**
 * Claude rescue path.
 *
 * When a block fails on the local model, the run can attempt the same
 * sub-goal once more against a more capable backend (typically Claude
 * via Anthropic). We persist a side-by-side trace of both attempts for
 * later training-data export and ask Claude to extract a one-sentence
 * generalizable lesson, stored in the lessons table for future runs.
 *
 * `buildLessonContext` is the read side of that loop — it lives here
 * because the rescue path is the only writer of lessons; the per-block
 * goal loop (`runAiSubGoal`, still in `agent.ts`) is the only reader.
 */

import type { Block } from "../blocks.ts";
import type { Message } from "../llm.ts";
import { chatOnce, MODEL } from "../llm.ts";
import { addLesson, searchLessons, getSetting } from "../db.ts";
import { trace } from "../log.ts";
import type { BlockOutcome } from "../blockOutcome.ts";
import type { ExecCtx } from "./execCtx.ts";
// Lazy import: agent.ts re-exports `runAiSubGoal` and `blockSummary` and
// also imports from this module, so we deliberately resolve those two
// inside the function bodies below to keep the cycle harmless.
import { runAiSubGoal, blockSummary } from "../agent.ts";

const MAX_STEPS_PER_GOAL = Number(process.env.MAX_AGENT_STEPS ?? 25);

export function buildLessonContext(instruction: string): string {
  try {
    const lessons = searchLessons(instruction, 5);
    if (lessons.length === 0) return "";
    return (
      "LESSONS FROM PAST RUNS (general patterns that helped in similar situations):\n" +
      lessons.map((l) => `• ${l.lesson}`).join("\n")
    );
  } catch {
    return "";
  }
}

export async function runClaudeRescue(
  ctx: ExecCtx,
  block: Block,
  priorError: string,
  localMessages: Message[],
): Promise<BlockOutcome> {
  if (!ctx.claudeClient) return { status: "failed", error: "no claude client" };
  const rescueModel =
    (ctx.claudeClient as { provider: string }).provider === "anthropic"
      ? (getSetting("rescue_model") ?? "claude-sonnet-4-6")
      : MODEL;

  trace("rescue.start", { runId: ctx.runId, blockId: block.id, model: rescueModel, priorError });

  const instruction = blockSummary(block, ctx.vars);
  const systemSuffix = `A previous agent already attempted this sub-task but failed: "${priorError.slice(0, 300)}". Try a different approach. The browser is at the state shown below.`;

  const rescueCtx: ExecCtx = { ...ctx, client: ctx.claudeClient };
  const maxSteps =
    (block.kind === "goal" ? (block as { max_steps?: number }).max_steps : undefined) ??
    MAX_STEPS_PER_GOAL;
  const localStepCount = localMessages.filter((m) => m.role === "assistant").length;
  const localStatus = "failed";

  const rescueOutcome = await runAiSubGoal(rescueCtx, block.id, instruction, {
    maxSteps,
    expectOutput: block.kind === "extract",
    systemSuffix,
  });

  const rescueMessages = rescueOutcome.messages ?? [];
  const rescueStepCount = rescueMessages.filter((m) => m.role === "assistant").length;

  // Persist combined trace for training data export
  const exportPayload = {
    block_id: block.id,
    block_kind: block.kind,
    instruction,
    rescue_model: rescueModel,
    local_status: localStatus,
    local_error: priorError,
    local_step_count: localStepCount,
    rescue_status: rescueOutcome.status,
    rescue_step_count: rescueStepCount,
    local_messages: localMessages,
    rescue_messages: rescueMessages,
  };

  // Use the shared in-memory step counter via ctx.persist so we don't race
  // with the main run loop's incrementing stepIdx. The previous direct
  // INSERT computed `MAX(idx)+1` from SQLite, which could collide if the
  // main loop emitted between SELECT and INSERT.
  ctx.persist("messages_export", exportPayload);

  trace("rescue.end", { runId: ctx.runId, blockId: block.id, status: rescueOutcome.status });

  // Generate lesson asynchronously (don't block the run on it)
  generateLesson(ctx, block.id, instruction, priorError, rescueMessages, rescueModel).catch((err) =>
    trace("rescue.lesson_error", { runId: ctx.runId, error: (err as Error).message }),
  );

  return rescueOutcome;
}

async function generateLesson(
  ctx: ExecCtx,
  blockId: string,
  instruction: string,
  priorError: string,
  rescueMessages: Message[],
  rescueModel: string,
): Promise<void> {
  if (!ctx.claudeClient) return;

  // Summarise last 3 tool calls from rescue for Claude to reason about
  const rescueTools = rescueMessages
    .filter((m) => m.role === "assistant" && m.tool_calls?.length)
    .slice(-3)
    .flatMap((m) =>
      (m.tool_calls ?? []).map(
        (tc) =>
          `${tc.function?.name}(${JSON.stringify(tc.function?.arguments ?? {}).slice(0, 80)})`,
      ),
    )
    .join(", ");

  const userPrompt = `Task the agent was trying to do: "${instruction.slice(0, 200)}"
Local agent failed with: "${priorError.slice(0, 200)}"
Claude recovered by calling: ${rescueTools || "(no tool calls recorded)"}

Write ONE short sentence (under 20 words) describing a GENERAL pattern that future agents should know. No page-specific URLs, element IDs, or site names. Format: "When [situation], [solution]."`;

  try {
    const response = await chatOnce(ctx.claudeClient, {
      model: rescueModel,
      messages: [
        {
          role: "system",
          content: "You extract generalizable browser automation lessons. Be concise and general.",
        },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    });

    const lesson = response.message.content.trim();
    if (lesson) {
      const situation = priorError.slice(0, 100);
      addLesson(ctx.runId, blockId, lesson, situation);
      trace("rescue.lesson_saved", { runId: ctx.runId, lesson });
    }
  } catch (err) {
    trace("rescue.lesson_failed", { runId: ctx.runId, error: (err as Error).message });
  }
}
