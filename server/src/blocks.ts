import { randomUUID } from "node:crypto";

export type BlockKind =
  | "navigate"
  | "goal"
  | "pause"
  | "click"
  | "fill"
  | "extract"
  | "verify"
  | "questionnaire"
  | "for_each";

/** ARIA roles offered as an optional filter on click/fill targets. */
export type ClickRole =
  | "any"
  | "button"
  | "link"
  | "tab"
  | "menuitem"
  | "checkbox"
  | "radio"
  | "switch"
  | "combobox"
  | "option"
  | "textbox";

export interface BaseBlock {
  id: string;
  kind: BlockKind;
  /** Set true to halt the run after this block completes successfully. */
  pauseAfter?: boolean;
}

export interface NavigateBlock extends BaseBlock {
  kind: "navigate";
  url: string;
}

export interface GoalBlock extends BaseBlock {
  kind: "goal";
  description: string;
  /** Maximum LLM turns allowed for this goal. Defaults to 12. */
  max_steps?: number;
}

export interface PauseBlock extends BaseBlock {
  kind: "pause";
  message?: string;
}

export interface ClickBlock extends BaseBlock {
  kind: "click";
  /** Natural-language description of what to click. */
  target: string;
  /** Optional ARIA role filter; "any" means no constraint. */
  role?: ClickRole;
}

export interface FillBlock extends BaseBlock {
  kind: "fill";
  target: string;
  value: string; // may include $varName
}

export interface VerifyBlock extends BaseBlock {
  kind: "verify";
  /** Natural-language condition the AI checks against the current page. */
  condition: string;
  /** What to do if the condition is not met. Defaults to "halt". */
  on_fail?: "halt" | "pause";
}

export interface QuestionnaireBlock extends BaseBlock {
  kind: "questionnaire";
  /** Optional context note prepended to discover/answer prompts. */
  context?: string;
  /** Variable name to write unanswered questions into (default `unanswered`). */
  unanswered_var?: string;
}

export interface ExtractBlock extends BaseBlock {
  kind: "extract";
  /** What to extract, in natural language (e.g. "all visible product titles as a list"). */
  target: string;
  /** Variable name to write the result into. Other blocks reference it as $name. */
  var_name: string;
}

export interface ForEachBlock extends BaseBlock {
  kind: "for_each";
  /** Variable name that holds an array, OR a natural-language description for AI extraction. */
  items: string;
  /** Variable name bound to the current item inside `body`. Defaults to `item`. */
  item_var?: string;
  body: Block[];
}

export type Block =
  | NavigateBlock
  | GoalBlock
  | PauseBlock
  | ClickBlock
  | FillBlock
  | ExtractBlock
  | VerifyBlock
  | QuestionnaireBlock
  | ForEachBlock;

/** Build a fresh block of the given kind with sensible defaults. */
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

export function parseBlocks(json: string | null | undefined, fallbackInstruction = ""): Block[] {
  if (!json) {
    return fallbackInstruction.trim() ? instructionToBlocks(fallbackInstruction) : [];
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Block[]) : [];
  } catch {
    return fallbackInstruction.trim() ? instructionToBlocks(fallbackInstruction) : [];
  }
}

/** Replace `$varname` occurrences with the corresponding variable's string value. */
export function substituteVars(input: string, vars: Map<string, unknown>): string {
  if (!input.includes("$")) return input;
  return input.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name: string) => {
    if (!vars.has(name)) return match;
    const v = vars.get(name);
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  });
}

/** Recursively count blocks (including those nested in for_each.body). */
export function countBlocks(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    n++;
    if (b.kind === "for_each") n += countBlocks(b.body);
  }
  return n;
}

/** Walk every block, depth-first, calling visit on each. */
export function walkBlocks(blocks: Block[], visit: (b: Block) => void): void {
  for (const b of blocks) {
    visit(b);
    if (b.kind === "for_each") walkBlocks(b.body, visit);
  }
}
