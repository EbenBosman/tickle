// Block types live in the cross-workspace `shared/blocks.ts` so server
// and web share the contract. This module adds the web-only pieces:
// UI metadata (icons, colors), the BLOCK_KINDS list ordering, the
// browser-flavoured `newBlock`, and presentation helpers.
import type { Block, BlockKind, ClickRole } from "../../shared/blocks.ts";
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

const KIND_META: Record<
  BlockKind,
  { label: string; icon: string; color: string; description: string }
> = {
  navigate: {
    label: "Navigate",
    icon: "🌐",
    color: "indigo",
    description: "Open a URL in the browser.",
  },
  goal: {
    label: "Goal",
    icon: "🧠",
    color: "violet",
    description: "Free-form sub-task the AI figures out.",
  },
  pause: { label: "Pause", icon: "✋", color: "amber", description: "Stop and wait for the user." },
  click: {
    label: "Click",
    icon: "👆",
    color: "blue",
    description: "Click an element by description.",
  },
  fill: { label: "Fill", icon: "✏️", color: "cyan", description: "Type into a form field." },
  extract: {
    label: "Extract",
    icon: "📥",
    color: "emerald",
    description: "Pull data into a variable.",
  },
  verify: {
    label: "Verify",
    icon: "✅",
    color: "teal",
    description: "Check a condition; halt or pause on failure.",
  },
  questionnaire: {
    label: "Questionnaire",
    icon: "📋",
    color: "rose",
    description: "Answer every form question; verify each; track leftovers.",
  },
  for_each: {
    label: "For Each",
    icon: "🔁",
    color: "pink",
    description: "Loop over a list, run nested blocks per item.",
  },
};

/** Fallback shown when a block has an unrecognised `kind` (e.g. an older
 * persisted task from a future schema). Keeps the UI from crashing on
 * `KIND_META[unknown].color` access. */
const UNKNOWN_KIND_META = {
  label: "Unknown",
  icon: "?",
  color: "zinc",
  description: "Unsupported block kind. Update the app or remove this block.",
} as const;

/** Accepts a runtime string so callers can pass values from older
 * persisted tasks whose `kind` may not be in the current `BlockKind`
 * union. Returns a generic fallback record for unknown kinds. */
export function blockMeta(kind: string) {
  return KIND_META[kind as BlockKind] ?? UNKNOWN_KIND_META;
}

export const BLOCK_KINDS: BlockKind[] = [
  "navigate",
  "goal",
  "click",
  "fill",
  "extract",
  "verify",
  "questionnaire",
  "for_each",
  "pause",
];

export const CLICK_ROLES: ClickRole[] = [
  "any",
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "option",
  "textbox",
];

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // RFC 4122 v4-shaped fallback for the rare case `crypto.randomUUID` is
  // missing (older browsers, non-secure contexts). Uses Math.random
  // because clashes are vanishingly unlikely on a single-user local app
  // and we just need the SHAPE to match the server-side UUID so equality
  // checks across run boundaries still work.
  const hex = (size: number, len: number) =>
    Math.floor(Math.random() * size)
      .toString(16)
      .padStart(len, "0");
  // 8-4-4-4-12 hex digits, with the version nibble forced to 4 and the
  // variant nibble in [8,b].
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return (
    `${hex(0x100000000, 8)}-${hex(0x10000, 4)}-` +
    `4${hex(0x1000, 3)}-` +
    `${variant}${hex(0x1000, 3)}-` +
    `${hex(0x100000000, 8)}${hex(0x10000, 4)}`
  );
}

export function newBlock(kind: BlockKind): Block {
  const id = uuid();
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

export function summaryOf(block: Block): string {
  switch (block.kind) {
    case "navigate":
      return block.url || "(no url)";
    case "goal":
      return block.description.slice(0, 200) || "(empty goal)";
    case "pause": {
      const trimmed = block.message?.trim() ?? "";
      return trimmed.length > 0 ? trimmed.slice(0, 200) : "Pause for human";
    }
    case "click": {
      const role = block.role && block.role !== "any" ? `${block.role}: ` : "";
      return `Click ${role}${block.target || "(no target)"}`;
    }
    case "fill":
      return `Fill ${block.target || "(no target)"} → ${block.value.slice(0, 60) || "(empty)"}`;
    case "extract":
      return `${block.target || "(no target)"} → $${block.var_name || "var"}`;
    case "verify":
      return block.condition || "(no condition)";
    case "questionnaire":
      return block.context ? `Context: ${block.context.slice(0, 60)}` : "Auto-fill all questions";
    case "for_each":
      return `${block.items || "(no items)"} (${block.body.length} sub-block${block.body.length === 1 ? "" : "s"})`;
  }
}
