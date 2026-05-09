/**
 * Canonical run-event shapes.
 *
 * The same event flows through four layers today:
 *   1. `agent.ts` emits it (`AgentEvent`)
 *   2. `bus.ts` fans it out (`Subscriber`)
 *   3. `db.ts` persists it (`Step["kind"]`)
 *   4. `routes/runs.ts` forwards it over SSE
 *
 * Before this module they all defined the union independently and the
 * four lists drifted. Now this module is the single source of truth for:
 *   - the terminal `end` event shape (`EndEvent`)
 *   - the set of `kind` values the agent persists to `steps` (`STEP_KINDS`)
 *   - the live-only kinds excluded from persistence (`LIVE_ONLY_KINDS`)
 *
 * The full live `AgentEvent` union still lives in `agent.ts` because its
 * payloads reference `ToolResult` (an infrastructure concern). Lifting
 * that to domain is deferred until tools.ts decomposes.
 */

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
 * persisted, because they're reconstructable from runtime state on
 * reconnect:
 *   - `paused` / `resumed`: from the in-process pause registry
 *   - `end`: from the run row's terminal status
 */
export const LIVE_ONLY_KINDS = ["paused", "resumed", "end"] as const;

export type LiveOnlyKind = (typeof LIVE_ONLY_KINDS)[number];

/** Runtime guard: is this kind one the agent persists to the steps table? */
export function isStepKind(kind: string): kind is StepKind {
  return (STEP_KINDS as readonly string[]).includes(kind);
}
