import { createContext, useContext, useState, type ReactNode } from "react";
import {
  type Block,
  type BlockKind,
  blockMeta,
  newBlock,
  BLOCK_KINDS,
  CLICK_ROLES,
} from "../blocks.ts";

/**
 * Tree-wide drag context. Lifted out of the per-instance state so a drag
 * that starts in an outer list and ends in a nested for_each.body (or
 * vice versa) can complete: every BlockList sees the same `dragId` and
 * delegates the move to the root, which mutates the whole tree.
 */
type DragApi = {
  dragId: string | null;
  setDragId: (id: string | null) => void;
  /**
   * Move the block with `sourceId` from wherever it lives in the tree
   * to `beforeIdx` inside the children of `parentBlockId` (null = root).
   * No-op if dragging a `for_each` into itself or its own descendants.
   */
  moveTo: (sourceId: string, parentBlockId: string | null, beforeIdx: number) => void;
};

const DragCtx = createContext<DragApi | null>(null);

function findAndRemove(tree: Block[], id: string): { removed: Block | null; tree: Block[] } {
  const idx = tree.findIndex((b) => b.id === id);
  if (idx >= 0) {
    const next = tree.slice();
    const [removed] = next.splice(idx, 1);
    return { removed, tree: next };
  }
  for (let i = 0; i < tree.length; i++) {
    const b = tree[i];
    if (b.kind === "for_each") {
      const inner = findAndRemove(b.body, id);
      if (inner.removed) {
        const next = tree.slice();
        next[i] = { ...b, body: inner.tree };
        return { removed: inner.removed, tree: next };
      }
    }
  }
  return { removed: null, tree };
}

function insertAtPath(
  tree: Block[],
  parentBlockId: string | null,
  beforeIdx: number,
  block: Block,
): Block[] {
  if (parentBlockId === null) {
    const next = tree.slice();
    next.splice(beforeIdx, 0, block);
    return next;
  }
  return tree.map((b) => {
    if (b.kind !== "for_each") return b;
    if (b.id === parentBlockId) {
      const next = b.body.slice();
      next.splice(beforeIdx, 0, block);
      return { ...b, body: next };
    }
    return { ...b, body: insertAtPath(b.body, parentBlockId, beforeIdx, block) };
  });
}

function isAncestor(block: Block, candidateDescendantId: string): boolean {
  if (block.kind !== "for_each") return false;
  for (const child of block.body) {
    if (child.id === candidateDescendantId) return true;
    if (isAncestor(child, candidateDescendantId)) return true;
  }
  return false;
}

function findBlock(tree: Block[], id: string): Block | null {
  for (const b of tree) {
    if (b.id === id) return b;
    if (b.kind === "for_each") {
      const inner = findBlock(b.body, id);
      if (inner) return inner;
    }
  }
  return null;
}

function findParent(
  tree: Block[],
  id: string,
  currentParentId: string | null = null,
): { parentId: string | null; idx: number } | null {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return { parentId: currentParentId, idx: i };
    const b = tree[i];
    if (b.kind === "for_each") {
      const inner = findParent(b.body, id, b.id);
      if (inner) return inner;
    }
  }
  return null;
}

export function moveBlockInTree(
  tree: Block[],
  sourceId: string,
  parentBlockId: string | null,
  beforeIdx: number,
): Block[] {
  // Refuse to drop a for_each into itself or its own descendants —
  // would create an unreachable cycle.
  if (parentBlockId !== null) {
    const source = findBlock(tree, sourceId);
    if (source && (source.id === parentBlockId || isAncestor(source, parentBlockId))) {
      return tree;
    }
  }
  // beforeIdx is supplied by callers as a position in the pre-removal
  // array. When the source lives in the SAME list and comes before the
  // drop point, removing it shifts subsequent indices down by one — we
  // compensate so "drop after position 1" really means "land at the
  // visual gap the user clicked".
  const sourceLoc = findParent(tree, sourceId);
  if (!sourceLoc) return tree;
  let effectiveBefore = beforeIdx;
  if (sourceLoc.parentId === parentBlockId && sourceLoc.idx < beforeIdx) {
    effectiveBefore = beforeIdx - 1;
  }
  if (sourceLoc.parentId === parentBlockId && sourceLoc.idx === effectiveBefore) {
    return tree;
  }
  const { removed, tree: pruned } = findAndRemove(tree, sourceId);
  if (!removed) return tree;
  return insertAtPath(pruned, parentBlockId, effectiveBefore, removed);
}

export type BlockStatusMap = Record<string, "pending" | "running" | "done" | "failed" | "skipped">;

const COLOR_BORDER: Record<string, string> = {
  indigo: "border-indigo-500/40",
  violet: "border-violet-500/40",
  amber: "border-amber-500/40",
  blue: "border-blue-500/40",
  cyan: "border-cyan-500/40",
  emerald: "border-emerald-500/40",
  pink: "border-pink-500/40",
  teal: "border-teal-500/40",
  rose: "border-rose-500/40",
};
const COLOR_BG: Record<string, string> = {
  indigo: "bg-indigo-500/5",
  violet: "bg-violet-500/5",
  amber: "bg-amber-500/5",
  blue: "bg-blue-500/5",
  cyan: "bg-cyan-500/5",
  emerald: "bg-emerald-500/5",
  pink: "bg-pink-500/5",
  teal: "bg-teal-500/5",
  rose: "bg-rose-500/5",
};
const COLOR_LABEL: Record<string, string> = {
  indigo: "text-indigo-300",
  violet: "text-violet-300",
  amber: "text-amber-300",
  blue: "text-blue-300",
  cyan: "text-cyan-300",
  emerald: "text-emerald-300",
  pink: "text-pink-300",
  teal: "text-teal-300",
  rose: "text-rose-300",
};

export function BlockList(props: {
  blocks: Block[];
  onChange: (next: Block[]) => void;
  statusMap?: BlockStatusMap;
  runningBlockId?: string | null;
}) {
  // Outer BlockList: own the drag state + tree-mutating moveTo and
  // hand it down via context so nested instances can drop into siblings.
  const [dragId, setDragId] = useState<string | null>(null);
  const api: DragApi = {
    dragId,
    setDragId,
    moveTo: (sourceId, parentBlockId, beforeIdx) => {
      props.onChange(moveBlockInTree(props.blocks, sourceId, parentBlockId, beforeIdx));
    },
  };
  return (
    <DragCtx.Provider value={api}>
      <BlockListInner
        blocks={props.blocks}
        onChange={props.onChange}
        parentBlockId={null}
        statusMap={props.statusMap}
        runningBlockId={props.runningBlockId}
      />
    </DragCtx.Provider>
  );
}

function NestedBlockList(props: {
  blocks: Block[];
  onChange: (next: Block[]) => void;
  parentBlockId: string;
  statusMap?: BlockStatusMap;
  runningBlockId?: string | null;
}) {
  // Reused for the for_each.body recursion. Same DragCtx provider as the
  // root, just a different parentBlockId so drops land in this body.
  return <BlockListInner {...props} />;
}

function BlockListInner({
  blocks,
  onChange,
  parentBlockId,
  statusMap,
  runningBlockId,
}: {
  blocks: Block[];
  onChange: (next: Block[]) => void;
  parentBlockId: string | null;
  statusMap?: BlockStatusMap;
  runningBlockId?: string | null;
}) {
  const drag = useContext(DragCtx);

  const update = (id: string, patch: Partial<Block>) => {
    onChange(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)));
  };
  const remove = (id: string) => {
    onChange(blocks.filter((b) => b.id !== id));
  };
  const insertAt = (idx: number, block: Block) => {
    const next = blocks.slice();
    next.splice(idx, 0, block);
    onChange(next);
  };
  const onDrop = (beforeIdx: number) => {
    if (!drag?.dragId) return;
    drag.moveTo(drag.dragId, parentBlockId, beforeIdx);
  };

  return (
    <div className="space-y-2">
      <AddBlockMenu onAdd={(kind) => insertAt(blocks.length, newBlock(kind))} />

      {blocks.length === 0 && (
        <div className="rounded-md border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
          No blocks yet — add one above.
        </div>
      )}

      {blocks.map((block, idx) => {
        const status = statusMap?.[block.id];
        const isRunning = runningBlockId === block.id;
        const isLocked = isRunning || status === "done" || status === "failed";

        return (
          <div key={block.id}>
            <DropZone onDrop={() => onDrop(idx)} />
            <BlockCard
              block={block}
              index={idx}
              status={status}
              isRunning={isRunning}
              isLocked={isLocked}
              statusMap={statusMap}
              runningBlockId={runningBlockId}
              onChange={(patch) => update(block.id, patch)}
              onRemove={() => remove(block.id)}
              onAddBelow={(kind) => insertAt(idx + 1, newBlock(kind))}
              onDragStart={() => drag?.setDragId(block.id)}
              onDragEnd={() => drag?.setDragId(null)}
            />
          </div>
        );
      })}
      <DropZone onDrop={() => onDrop(blocks.length)} />
    </div>
  );
}

function DropZone({ onDrop }: { onDrop: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop();
      }}
      className={`h-1.5 rounded transition-colors ${over ? "bg-emerald-500/40" : ""}`}
    />
  );
}

function BlockCard({
  block,
  index,
  status,
  isRunning,
  isLocked,
  statusMap,
  runningBlockId,
  onChange,
  onRemove,
  onAddBelow,
  onDragStart,
  onDragEnd,
}: {
  block: Block;
  index: number;
  status?: BlockStatusMap[string];
  isRunning: boolean;
  isLocked: boolean;
  statusMap?: BlockStatusMap;
  runningBlockId?: string | null;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
  onAddBelow: (kind: BlockKind) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const meta = blockMeta(block.kind);
  const border = COLOR_BORDER[meta.color];
  const bg = COLOR_BG[meta.color];
  const label = COLOR_LABEL[meta.color];

  const ringCls = isRunning
    ? "ring-2 ring-blue-500/60 animate-pulse"
    : status === "done"
      ? "ring-1 ring-emerald-500/40 opacity-80"
      : status === "failed"
        ? "ring-1 ring-red-500/40"
        : status === "skipped"
          ? "ring-1 ring-zinc-600 opacity-50"
          : "";

  return (
    <div
      draggable={!isLocked}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`rounded-md border ${border} ${bg} ${ringCls}`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-800/60 px-3 py-1.5">
        <span className="font-mono text-[10px] text-zinc-500">{index + 1}</span>
        <span className="text-base">{meta.icon}</span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${label}`}>
          {meta.label}
        </span>
        {status && <StatusBadge status={status} running={isRunning} />}
        <div className="ml-auto flex items-center gap-1">
          <label
            className="flex cursor-pointer items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
            title="Pause the run after this block completes"
          >
            <input
              type="checkbox"
              checked={!!block.pauseAfter}
              onChange={(e) => onChange({ pauseAfter: e.target.checked })}
              disabled={isLocked}
              className="h-3 w-3 accent-amber-500"
            />
            stop after
          </label>
          <button
            type="button"
            onClick={onRemove}
            disabled={isLocked}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-500"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="px-3 py-2">
        <BlockBody
          block={block}
          onChange={onChange}
          disabled={isLocked}
          statusMap={statusMap}
          runningBlockId={runningBlockId}
        />
      </div>

      <div className="flex items-center justify-end border-t border-zinc-800/40 px-2 py-1">
        <SmallAddMenu onAdd={onAddBelow} />
      </div>
    </div>
  );
}

function BlockBody({
  block,
  onChange,
  disabled,
  statusMap,
  runningBlockId,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  disabled: boolean;
  statusMap?: BlockStatusMap;
  runningBlockId?: string | null;
}) {
  const inputCls =
    "w-full rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-50";
  switch (block.kind) {
    case "navigate":
      return (
        <Field label="URL">
          <input
            className={inputCls}
            type="url"
            placeholder="https://example.com"
            value={block.url}
            disabled={disabled}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        </Field>
      );
    case "goal":
      return (
        <div className="space-y-2">
          <Field label="Goal description">
            <textarea
              className={`${inputCls} min-h-[60px] font-mono leading-relaxed`}
              placeholder="What should the AI accomplish in this step?"
              value={block.description}
              disabled={disabled}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </Field>
          <Field label="Max LLM turns (optional, default 12)">
            <input
              className={`${inputCls} max-w-[160px]`}
              type="number"
              min={1}
              max={100}
              placeholder="12"
              value={block.max_steps ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  onChange({ max_steps: undefined });
                } else {
                  const n = Number(v);
                  if (Number.isFinite(n) && n > 0) onChange({ max_steps: Math.floor(n) });
                }
              }}
            />
          </Field>
        </div>
      );
    case "pause":
      return (
        <Field label="Message (optional)">
          <input
            className={inputCls}
            type="text"
            placeholder="Pause and verify the form looks right"
            value={block.message ?? ""}
            disabled={disabled}
            onChange={(e) => onChange({ message: e.target.value })}
          />
        </Field>
      );
    case "click":
      return (
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <Field label="Target (described)">
            <input
              className={inputCls}
              type="text"
              placeholder='e.g. "the Submit button" or "the Qualifications tab"'
              value={block.target}
              disabled={disabled}
              onChange={(e) => onChange({ target: e.target.value })}
            />
          </Field>
          <Field label="Role filter">
            <select
              className={inputCls}
              value={block.role ?? "any"}
              disabled={disabled}
              onChange={(e) => onChange({ role: e.target.value as (typeof CLICK_ROLES)[number] })}
            >
              {CLICK_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
        </div>
      );
    case "fill":
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Field">
            <input
              className={inputCls}
              type="text"
              placeholder="e.g. Search box"
              value={block.target}
              disabled={disabled}
              onChange={(e) => onChange({ target: e.target.value })}
            />
          </Field>
          <Field label="Value">
            <input
              className={inputCls}
              type="text"
              placeholder="text to type (use $var to interpolate)"
              value={block.value}
              disabled={disabled}
              onChange={(e) => onChange({ value: e.target.value })}
            />
          </Field>
        </div>
      );
    case "extract":
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="What to extract">
            <input
              className={inputCls}
              type="text"
              placeholder="e.g. all visible product titles as a list"
              value={block.target}
              disabled={disabled}
              onChange={(e) => onChange({ target: e.target.value })}
            />
          </Field>
          <Field label="Variable name">
            <input
              className={inputCls}
              type="text"
              placeholder="titles"
              value={block.var_name}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  var_name: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                })
              }
            />
          </Field>
        </div>
      );
    case "verify":
      return (
        <div className="grid grid-cols-[1fr_120px] gap-2">
          <Field label="Condition">
            <input
              className={inputCls}
              type="text"
              placeholder='e.g. "the form has been fully completed"'
              value={block.condition}
              disabled={disabled}
              onChange={(e) => onChange({ condition: e.target.value })}
            />
          </Field>
          <Field label="On fail">
            <select
              className={inputCls}
              value={block.on_fail ?? "halt"}
              disabled={disabled}
              onChange={(e) => onChange({ on_fail: e.target.value as "halt" | "pause" })}
            >
              <option value="halt">halt run</option>
              <option value="pause">pause run</option>
            </select>
          </Field>
        </div>
      );
    case "questionnaire":
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Context (optional, prepended to prompts)">
            <input
              className={inputCls}
              type="text"
              placeholder="e.g. JavaScript fundamentals quiz"
              value={block.context ?? ""}
              disabled={disabled}
              onChange={(e) => onChange({ context: e.target.value })}
            />
          </Field>
          <Field label="Unanswered variable">
            <input
              className={inputCls}
              type="text"
              placeholder="unanswered"
              value={block.unanswered_var ?? "unanswered"}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  unanswered_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                })
              }
            />
          </Field>
        </div>
      );
    case "for_each":
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Items (variable, e.g. $titles)">
              <input
                className={inputCls}
                type="text"
                placeholder="$titles"
                value={block.items}
                disabled={disabled}
                onChange={(e) => onChange({ items: e.target.value })}
              />
            </Field>
            <Field label="Item variable name">
              <input
                className={inputCls}
                type="text"
                placeholder="item"
                value={block.item_var ?? "item"}
                disabled={disabled}
                onChange={(e) => onChange({ item_var: e.target.value })}
              />
            </Field>
          </div>
          <div className="rounded border border-zinc-800/80 bg-zinc-950/40 p-2">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">Body</div>
            <NestedBlockList
              blocks={block.body}
              onChange={(body) => onChange({ body })}
              parentBlockId={block.id}
              statusMap={statusMap}
              runningBlockId={runningBlockId}
            />
          </div>
        </div>
      );
    default: {
      // Unrecognised kind — render a placeholder rather than nothing.
      // This catches the case where a future schema adds a kind the
      // current frontend doesn't know about; without the default branch
      // the body silently disappears and BlockCard's meta.color access
      // can throw. blockMeta() also returns a safe fallback now.
      const k = (block as { kind: string }).kind;
      return (
        <div className="text-xs text-zinc-500">
          Unsupported block kind: <code>{k}</code>. Update the app or remove this block.
        </div>
      );
    }
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function StatusBadge({ status, running }: { status: BlockStatusMap[string]; running: boolean }) {
  if (running) {
    return (
      <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider text-blue-200">
        running
      </span>
    );
  }
  const cls =
    status === "done"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : status === "failed"
        ? "border-red-500/40 bg-red-500/10 text-red-200"
        : status === "skipped"
          ? "border-zinc-600 bg-zinc-800 text-zinc-400"
          : "border-zinc-700 bg-zinc-900 text-zinc-400";
  return (
    <span
      className={`rounded-full border px-1.5 py-0 text-[9px] font-semibold uppercase tracking-wider ${cls}`}
    >
      {status}
    </span>
  );
}

function AddBlockMenu({ onAdd }: { onAdd: (kind: BlockKind) => void }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-800 p-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Add block</div>
      <div className="flex flex-wrap gap-1">
        {BLOCK_KINDS.map((kind) => {
          const meta = blockMeta(kind);
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onAdd(kind)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${COLOR_BORDER[meta.color]} ${COLOR_BG[meta.color]} ${COLOR_LABEL[meta.color]} hover:brightness-125`}
              title={meta.description}
            >
              <span>{meta.icon}</span>
              <span>{meta.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SmallAddMenu({ onAdd }: { onAdd: (kind: BlockKind) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
      >
        + add below
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 flex flex-wrap gap-1 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
          {BLOCK_KINDS.map((kind) => {
            const meta = blockMeta(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  onAdd(kind);
                  setOpen(false);
                }}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <span>{meta.icon}</span>
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
