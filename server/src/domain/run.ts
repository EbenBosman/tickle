/**
 * Server-side re-export of run-event types from the shared workspace.
 *
 * Before this module the union was defined independently in `agent.ts`,
 * `bus.ts`, `db.ts`, and `routes/runs.ts`. The shared `../../../shared/run.ts`
 * is now the single source of truth for both server and web; this file
 * exists for backwards-compatible import paths inside the server tree.
 */
export type {
  BlockStatus,
  EndEvent,
  RunStatsEvent,
  RunStatsSample,
  SseEvent,
  StepKind,
  LiveOnlyKind,
  ToolResultShape,
} from "../../../shared/run.ts";
export { STEP_KINDS, LIVE_ONLY_KINDS, isStepKind } from "../../../shared/run.ts";
