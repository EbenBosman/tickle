/**
 * Block types and runtime helpers shared between server and web.
 *
 * The TYPES are the contract: a task's `steps` JSON in SQLite, the
 * `/api/blocks/compile` response, the SSE `block_start` payload, and the
 * web editor's tree all use the same shape. Any change here is a schema
 * change in both directions.
 *
 * The runtime helpers (`substituteVars`, `walkBlocks`, `countBlocks`,
 * `parseBlocks`) are pure and have no node-/browser-specific deps, so
 * they can live here too. `newBlock` does NOT — it needs a UUID source,
 * which differs between `node:crypto` and `globalThis.crypto`. Each
 * workspace defines its own `newBlock` on top of these types.
 */

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
  value: string;
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
  /** What to extract, in natural language. */
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

/** Replace `$varname` occurrences with the corresponding variable's string value. */
export function substituteVars(input: string, vars: Map<string, unknown>): string {
  if (!input.includes("$")) return input;
  return input.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, name: string) => {
    if (!vars.has(name)) return match;
    const v = vars.get(name);
    if (v === undefined) return "";
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

/** Parse a `tasks.steps` JSON column into a Block[]. Returns [] on
 *  unparseable input. Does NOT auto-derive from instruction — that's
 *  the caller's job (server uses `instructionToBlocks` from its own
 *  `blocks.ts` because it needs `randomUUID`).
 */
export function parseBlocksJson(json: string | null | undefined): Block[] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Block[]) : null;
  } catch {
    return null;
  }
}
