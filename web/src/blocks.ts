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
  pauseAfter?: boolean;
}

export interface NavigateBlock extends BaseBlock {
  kind: "navigate";
  url: string;
}
export interface GoalBlock extends BaseBlock {
  kind: "goal";
  description: string;
  max_steps?: number;
}
export interface PauseBlock extends BaseBlock {
  kind: "pause";
  message?: string;
}
export interface ClickBlock extends BaseBlock {
  kind: "click";
  target: string;
  role?: ClickRole;
}
export interface FillBlock extends BaseBlock {
  kind: "fill";
  target: string;
  value: string;
}
export interface ExtractBlock extends BaseBlock {
  kind: "extract";
  target: string;
  var_name: string;
}
export interface VerifyBlock extends BaseBlock {
  kind: "verify";
  condition: string;
  on_fail?: "halt" | "pause";
}
export interface QuestionnaireBlock extends BaseBlock {
  kind: "questionnaire";
  context?: string;
  unanswered_var?: string;
}
export interface ForEachBlock extends BaseBlock {
  kind: "for_each";
  items: string;
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

export function blockMeta(kind: BlockKind) {
  return KIND_META[kind];
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
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
    case "pause":
      return block.message?.slice(0, 200) ?? "Pause for human";
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
