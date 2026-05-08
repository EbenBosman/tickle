/**
 * Block outcome shape and helpers shared between executeBlocks and the
 * Claude-rescue path.
 *
 * Lives in its own module so the rescue-merge logic can be unit-tested
 * without dragging `agent.ts` (and its 30+ transitive imports) into the
 * test surface. Phase 4 moves this into `domain/run.ts`.
 */

export type BlockOutcome =
  | { status: "done"; summary?: string; details?: unknown }
  | { status: "skipped" }
  | { status: "failed"; error: string; details?: unknown }
  | { status: "cancelled"; error?: string };

/**
 * Merge a local block outcome with a Claude-rescue outcome to produce
 * the single canonical outcome that drives the (single) `block_end`
 * emission.
 *
 * Contract:
 * - Rescue cancelled wins: a cancellation observed during rescue
 *   short-circuits the run regardless of what local did.
 * - Rescue done wins over local failed: that is the entire point of
 *   rescue; the run continues with the rescue's summary.
 * - Rescue failed yields the local outcome: surface the user-meaningful
 *   error from the local attempt, not the rescue's "I also gave up"
 *   error.
 * - If local was anything other than failed, rescue should not have
 *   been called; pass through local for type safety.
 */
export function mergeRescuedOutcome(
  local: BlockOutcome,
  rescue: BlockOutcome,
): BlockOutcome {
  if (rescue.status === "cancelled") return { status: "cancelled", error: rescue.error };
  if (rescue.status === "done") return { status: "done", summary: rescue.summary };
  // rescue.status is "failed" or "skipped" — keep the local outcome.
  return local;
}
