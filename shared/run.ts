/**
 * Canonical run-event shapes shared by server (emitter) and web (consumer).
 *
 * Today the same event flows through:
 *   1. `agent.ts` emits it
 *   2. `bus.ts` fans it out
 *   3. `db.ts` persists the persistable subset
 *   4. `routes/runs.ts` forwards it over SSE
 *   5. `useRunStream.ts` parses it on the web
 *
 * This module is the single source of truth for all five.
 */

import type { BlockKind } from "./blocks.ts";

/** Per-block lifecycle state, used in `block_end` and the web's local map. */
export type BlockStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** Structural shape returned by tool calls. Kept narrow so we don't drag
 *  the server's `tools.ts` into the shared module. */
export type ToolResultShape =
  | { ok: true; text?: string; image_base64?: string; data?: unknown }
  | { ok: false; error: string };

/** Aggregate statistics emitted after each LLM call. */
export type RunStatsSample = {
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  eval_duration_ms: number;
  tps: number;
};

/**
 * Event published when a run reaches a terminal state. Carried over the
 * SSE stream to clients; not persisted (the run row's status + result/
 * error reconstructs it on reconnect).
 */
export type EndEvent = {
  kind: "end";
  status: string;
  result?: string;
  error?: string;
};

/**
 * The full live event union — what the agent emits and what useRunStream
 * parses on the web. `end` is part of the SSE wire shape; `messages_export`
 * is NOT in this union because it's persist-only.
 */
export type SseEvent =
  | {
      kind: "block_start";
      block_id: string;
      block_kind: BlockKind;
      summary: string;
      path: string[];
    }
  | {
      kind: "block_end";
      block_id: string;
      block_kind: BlockKind;
      status: BlockStatus;
      result?: string;
      error?: string;
      details?: unknown;
      path: string[];
    }
  | { kind: "thought"; text: string; block_id?: string }
  | { kind: "tool_call"; name: string; args: unknown; block_id?: string }
  | {
      kind: "tool_result";
      name: string;
      result: ToolResultShape;
      screenshotPath?: string;
      block_id?: string;
    }
  | { kind: "page_state"; url: string; title: string }
  | RunStatsEvent
  | { kind: "var_set"; name: string; preview: string }
  | { kind: "remember"; note: string }
  | { kind: "paused"; reason?: string; auto?: boolean }
  | { kind: "resumed" }
  | { kind: "error"; error: string; block_id?: string }
  | { kind: "final"; answer: string }
  | EndEvent;

/** Sub-shape so the rest of the union stays readable. */
export type RunStatsEvent = { kind: "stats" } & RunStatsSample;

/**
 * Persistable event kinds. These get a row in the `steps` table; SSE
 * clients can rebuild the full timeline from them via replay.
 *
 * `messages_export` is a Step-only kind: written by the rescue path for
 * later DPO export, never emitted live to the bus.
 */
export const STEP_KINDS = [
  "thought",
  "tool_call",
  "tool_result",
  "block_start",
  "block_end",
  "var_set",
  "remember",
  "error",
  "final",
  "page_state",
  "stats",
  "messages_export",
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Live-only event kinds. These are emitted to the bus but never
 * persisted; reconstructable from runtime state on reconnect:
 *   - `paused` / `resumed`: from the in-process pause registry
 *   - `end`: from the run row's terminal status
 */
export const LIVE_ONLY_KINDS = ["paused", "resumed", "end"] as const;

export type LiveOnlyKind = (typeof LIVE_ONLY_KINDS)[number];

/** Runtime guard: is this kind one the agent persists to the steps table? */
export function isStepKind(kind: string): kind is StepKind {
  return (STEP_KINDS as readonly string[]).includes(kind);
}
