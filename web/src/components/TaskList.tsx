import type { Task } from "../api.ts";
import { useUiPrompts } from "./UiPrompts.tsx";

export function TaskList({
  tasks,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: {
  tasks: Task[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onDelete: (id: number) => void;
}) {
  const { confirm } = useUiPrompts();
  return (
    <div className="flex h-full flex-col gap-3">
      <button
        onClick={onCreate}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-500"
      >
        + New task
      </button>

      <div className="flex-1 space-y-1">
        {tasks.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-zinc-500">No tasks yet</div>
        )}
        {tasks.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-sm ${
              selectedId === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900"
            }`}
          >
            <button onClick={() => onSelect(t.id)} className="flex-1 truncate text-left">
              {t.name || "(untitled)"}
            </button>
            <button
              onClick={async () => {
                if (await confirm(`Delete "${t.name}"?`, { destructive: true })) onDelete(t.id);
              }}
              className="ml-2 hidden text-xs text-zinc-500 hover:text-red-400 group-hover:inline"
              aria-label="Delete"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
