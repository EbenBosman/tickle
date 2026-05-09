import { useEffect, useMemo, useState } from "react";
import { api, type Task } from "../api.ts";
import { type Block } from "../blocks.ts";
import { BlockList, type BlockStatusMap } from "./BlockList.tsx";
import { CompileFromText } from "./CompileFromText.tsx";

export function TaskEditor({
  task,
  onSaved,
  onRun,
  statusMap,
  runningBlockId,
}: {
  task: Task;
  onSaved: () => void;
  onRun: () => void;
  statusMap?: BlockStatusMap;
  runningBlockId?: string | null;
}) {
  const [name, setName] = useState(task.name);
  const [blocks, setBlocks] = useState<Block[]>(() => parseSteps(task.steps));
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setName(task.name);
    setBlocks(parseSteps(task.steps));
  }, [task.id, task.steps, task.name]);

  const initialBlocksJson = useMemo(() => task.steps ?? "[]", [task.steps]);
  const dirty = name !== task.name || JSON.stringify(blocks) !== initialBlocksJson;

  const save = async () => {
    await api.updateTask(task.id, { name, steps: blocks });
    setSavedAt(new Date().toLocaleTimeString());
    onSaved();
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <label className="block text-xs uppercase tracking-wide text-zinc-500">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm focus:border-zinc-600 focus:outline-none"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-2 flex items-center justify-between">
          <label className="block text-xs uppercase tracking-wide text-zinc-500">Steps</label>
          {runningBlockId && (
            <span className="text-[10px] text-zinc-500">
              Running block is locked. Pending blocks can be edited live.
            </span>
          )}
        </div>

        <CompileFromText
          disabled={!!runningBlockId}
          existingCount={blocks.length}
          onApply={(newBlocks, mode) => {
            setBlocks(mode === "replace" ? newBlocks : [...blocks, ...newBlocks]);
          }}
        />

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
          <BlockList
            blocks={blocks}
            onChange={setBlocks}
            statusMap={statusMap}
            runningBlockId={runningBlockId ?? null}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-zinc-500">
          {savedAt ? `Saved at ${savedAt}` : dirty ? "Unsaved changes" : "Saved"}
        </div>
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={!dirty}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={async () => {
              if (dirty) await save();
              onRun();
            }}
            disabled={blocks.length === 0 || !!runningBlockId}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

function parseSteps(json: string | null): Block[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Block[]) : [];
  } catch {
    return [];
  }
}
