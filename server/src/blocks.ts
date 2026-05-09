import { randomUUID } from "node:crypto";
import type { Block, BlockKind } from "../../shared/blocks.ts";

// Re-export the shared types and pure helpers so existing imports
// (`from "./blocks.ts"`) keep working without churn.
export type {
  Block,
  BlockKind,
  ClickRole,
  BaseBlock,
  NavigateBlock,
  GoalBlock,
  PauseBlock,
  ClickBlock,
  FillBlock,
  ExtractBlock,
  VerifyBlock,
  QuestionnaireBlock,
  ForEachBlock,
} from "../../shared/blocks.ts";
export { substituteVars, countBlocks, walkBlocks, parseBlocksJson } from "../../shared/blocks.ts";

/** Build a fresh block of the given kind with sensible defaults.
 *  Server-side `randomUUID` from node:crypto. */
export function newBlock(kind: BlockKind): Block {
  const id = randomUUID();
  switch (kind) {
    case "navigate":
      return { id, kind, url: "" };
    case "goal":
      return { id, kind, description: "" };
    case "pause":
      return { id, kind, message: "" };
    case "click":
      return { id, kind, target: "", role: "any" };
    case "fill":
      return { id, kind, target: "", value: "" };
    case "extract":
      return { id, kind, target: "", var_name: "" };
    case "verify":
      return { id, kind, condition: "", on_fail: "halt" };
    case "questionnaire":
      return { id, kind, context: "", unanswered_var: "unanswered" };
    case "for_each":
      return { id, kind, items: "", item_var: "item", body: [] };
  }
}

/** Migrate a legacy free-text instruction into a single goal block. */
export function instructionToBlocks(instruction: string): Block[] {
  return [{ id: randomUUID(), kind: "goal", description: instruction.trim() }];
}

/**
 * Parse `tasks.steps` JSON.
 *
 * Three distinct cases (preserved from pre-shared-types behaviour):
 *   - null / empty input  → fallback to `instructionToBlocks` (or `[]`)
 *   - JSON parse error    → fallback to `instructionToBlocks` (or `[]`)
 *   - Parses to non-array → `[]`, even if fallback was provided. This
 *     last case treats well-formed-but-shape-wrong JSON as "the user
 *     emptied the steps" rather than "drop back to the legacy instruction".
 */
export function parseBlocks(json: string | null | undefined, fallbackInstruction = ""): Block[] {
  if (!json) {
    return fallbackInstruction.trim() ? instructionToBlocks(fallbackInstruction) : [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Block[]) : [];
  } catch {
    return fallbackInstruction.trim() ? instructionToBlocks(fallbackInstruction) : [];
  }
}
