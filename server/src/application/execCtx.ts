/**
 * Shared execution context type passed through every block-level handler.
 *
 * Lives in `application/` because it is the contract between the run
 * orchestrator (`agent.ts`) and the per-block routines extracted into
 * sibling modules (`runStatelessStep`, `runQuestionnaireBlock`,
 * `runClaudeRescue`). Domain types stay pure; this layer wires them to
 * infrastructure (`Session`, `LlmClient`, persistence callbacks).
 */

import type { Session } from "../browser.ts";
import type { LlmClient } from "../llm.ts";
import type { StepKind } from "../domain/run.ts";
import type { SseEvent } from "../../../shared/run.ts";

/**
 * Events the AGENT emits. Subset of the wire-shape `SseEvent` — the
 * agent never emits `end`; that's published by `routes/runs.ts` when
 * the runs row reaches a terminal state.
 */
export type AgentEvent = Exclude<SseEvent, { kind: "end" }>;

export type ExecCtx = {
  runId: number;
  session: Session;
  client: LlmClient;
  claudeClient: LlmClient | null;
  /** When true, the cancel button should trigger Claude rescue instead of a real cancel. */
  isRescueRequested: () => boolean;
  /** Reset after rescue has been triggered. */
  clearRescueRequest: () => void;
  /** Currently in-flight LLM AbortController, set per-call by chatWithRetry. Cancellation aborts it. */
  setActiveController: (c: AbortController | null) => void;
  getActiveController: () => AbortController | null;
  vars: Map<string, unknown>;
  /** Append-only short notes that persist across blocks for the whole run. */
  memory: string[];
  emit: (event: AgentEvent) => void;
  persist: (kind: StepKind, payload: unknown, screenshotPath?: string) => void;
  isCancelled: () => boolean;
  loginAutoPaused: { value: boolean };
  blockPath: string[]; // for nested blocks: parent ids
};
