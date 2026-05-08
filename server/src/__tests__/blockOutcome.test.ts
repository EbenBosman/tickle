import { describe, expect, it } from "vitest";
import { type BlockOutcome, mergeRescuedOutcome } from "../blockOutcome.ts";

// docs/specs/server/agent.md — "Likely bugs: doubled block_end on Claude rescue"
//
// Pre-fix: executeBlocks emitted block_end with status="failed" first,
// then a second block_end with status="done" if rescue succeeded.
// Two SSE emissions, two `steps` rows. UI's last-write-wins rule was
// not part of any contract.
//
// Fix: compute the final outcome via mergeRescuedOutcome and emit
// block_end exactly once. These tests pin the merge rules.

const localFailed: BlockOutcome = { status: "failed", error: "local boom" };
const localDone: BlockOutcome = { status: "done", summary: "local result" };

describe("mergeRescuedOutcome — rescue done wins over local failed", () => {
  it("returns the rescue's outcome when rescue succeeds", () => {
    const rescue: BlockOutcome = { status: "done", summary: "rescue saved it" };
    expect(mergeRescuedOutcome(localFailed, rescue)).toEqual({
      status: "done",
      summary: "rescue saved it",
    });
  });

  it("preserves the rescue summary even when local had its own", () => {
    const local: BlockOutcome = { status: "failed", error: "x" };
    const rescue: BlockOutcome = { status: "done", summary: "claude did it" };
    const merged = mergeRescuedOutcome(local, rescue);
    expect(merged.status).toBe("done");
    if (merged.status === "done") expect(merged.summary).toBe("claude did it");
  });
});

describe("mergeRescuedOutcome — rescue cancelled short-circuits", () => {
  it("returns cancelled regardless of local outcome", () => {
    const rescue: BlockOutcome = { status: "cancelled", error: "user stopped" };
    expect(mergeRescuedOutcome(localFailed, rescue)).toEqual({
      status: "cancelled",
      error: "user stopped",
    });
  });
});

describe("mergeRescuedOutcome — rescue failed surfaces local error", () => {
  it("keeps the local failed outcome (user wants the original error, not 'rescue gave up')", () => {
    const rescue: BlockOutcome = { status: "failed", error: "rescue also failed" };
    const merged = mergeRescuedOutcome(localFailed, rescue);
    expect(merged.status).toBe("failed");
    if (merged.status === "failed") expect(merged.error).toBe("local boom");
  });
});

describe("mergeRescuedOutcome — defensive fallthrough", () => {
  it("returns local when rescue is skipped (rescue should not have run)", () => {
    const rescue: BlockOutcome = { status: "skipped" };
    expect(mergeRescuedOutcome(localFailed, rescue)).toBe(localFailed);
  });

  it("returns local when local was already done (rescue should not have been invoked)", () => {
    const rescue: BlockOutcome = { status: "failed", error: "x" };
    expect(mergeRescuedOutcome(localDone, rescue)).toBe(localDone);
  });
});
