import { describe, expect, it } from "vitest";
import { toolDefs } from "../tools.ts";

// docs/specs/server/tools.md — "Likely bugs: finish vs finish_step"
//
// toolDefs is what the LLM is told it can call. finish_step is appended
// later by agent.ts::toolsForAiBlock and intercepted by runAiSubGoal
// before reaching executeTool. Exposing a duplicate `finish` here let
// the model pick the unintercepted name and run past the step limit.

describe("toolDefs — exposed tool names", () => {
  it("does not include `finish` (use finish_step from the agent loop instead)", () => {
    const names = toolDefs.map((t) => t.function.name);
    expect(names).not.toContain("finish");
  });

  it("does not include `finish_step` either — that is appended by the agent loop", () => {
    const names = toolDefs.map((t) => t.function.name);
    expect(names).not.toContain("finish_step");
  });

  it("includes the canonical browser-control tools", () => {
    const names = toolDefs.map((t) => t.function.name);
    for (const expected of ["snapshot", "act", "navigate", "read_text", "scroll", "wait_for"]) {
      expect(names).toContain(expected);
    }
  });

  it("every tool name is unique", () => {
    const names = toolDefs.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
