import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Task } from "./api.ts";
import { TaskList } from "./components/TaskList.tsx";
import { TaskEditor } from "./components/TaskEditor.tsx";
import { RunView, type RunStatsSample, type BlockStatus } from "./components/RunView.tsx";
import { StatusPill } from "./components/StatusPill.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";

// Fallback if /api/health doesn't return context_window for some reason.
const CONTEXT_WINDOW_FALLBACK = 32_768;

type AggStats = {
  model: string;
  promptTokens: number; // most recent
  outputTokens: number; // most recent
  totalOutputTokens: number; // accumulated across the run
  totalEvalMs: number; // accumulated across the run
  lastTps: number;
};

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [stats, setStats] = useState<AggStats | null>(null);
  const [serverModel, setServerModel] = useState<string | null>(null);
  const [serverContextWindow, setServerContextWindow] = useState<number>(CONTEXT_WINDOW_FALLBACK);
  const [blockStatusMap, setBlockStatusMap] = useState<Record<string, BlockStatus>>({});
  const [runningBlockId, setRunningBlockId] = useState<string | null>(null);

  const refresh = async () => setTasks(await api.listTasks());

  useEffect(() => {
    refresh().catch(console.error);
    const fetchHealth = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((j: { model?: string; context_window?: number }) => {
          setServerModel(j.model ?? null);
          if (typeof j.context_window === "number" && j.context_window > 0) {
            setServerContextWindow(j.context_window);
          }
        })
        .catch(() => {
          // ignore — health endpoint may be momentarily unavailable
        });
    void fetchHealth();
    // Re-fetch when the tab regains focus (catches server restarts)
    // and on a slow poll so the displayed model stays current.
    const onFocus = () => fetchHealth();
    window.addEventListener("focus", onFocus);
    const id = window.setInterval(fetchHealth, 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, []);

  // Auto-select the most recent task when nothing is selected (e.g. fresh page
  // load, or after the currently selected task was deleted).
  useEffect(() => {
    if (selectedId === null && tasks.length > 0) {
      setSelectedId(tasks[0].id);
    }
  }, [tasks, selectedId]);

  // Reset accumulated stats whenever we switch to a different run.
  const lastRunRef = useRef<number | null>(null);
  useEffect(() => {
    if (activeRunId !== lastRunRef.current) {
      lastRunRef.current = activeRunId;
      setStats(null);
      setBlockStatusMap({});
      setRunningBlockId(null);
    }
  }, [activeRunId]);

  const handleBlockStatus = useCallback(
    (info: { blockId: string | null; statusMap: Record<string, BlockStatus> }) => {
      setRunningBlockId(info.blockId);
      setBlockStatusMap(info.statusMap);
    },
    [],
  );

  const handleStats = useCallback((sample: RunStatsSample) => {
    setStats((prev) => {
      const totalOutputTokens = (prev?.totalOutputTokens ?? 0) + sample.output_tokens;
      const totalEvalMs = (prev?.totalEvalMs ?? 0) + sample.eval_duration_ms;
      return {
        model: sample.model,
        promptTokens: sample.prompt_tokens,
        outputTokens: sample.output_tokens,
        totalOutputTokens,
        totalEvalMs,
        lastTps: sample.tps,
      };
    });
  }, []);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">tickle</h1>
          <span className="text-xs text-zinc-500">local AI · browser agent</span>
        </div>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
            showSettings ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
          }`}
        >
          Settings
        </button>
      </header>

      {showSettings && (
        <div className="absolute inset-0 top-[46px] z-10 flex justify-end">
          <div className="flex-1 bg-black/40" onClick={() => setShowSettings(false)} />
          <div className="w-[480px] overflow-y-auto border-l border-zinc-800 bg-zinc-950">
            <SettingsPage onClose={() => setShowSettings(false)} />
          </div>
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-12 gap-0">
        <aside className="col-span-3 min-h-0 overflow-y-auto border-r border-zinc-800 p-3">
          <TaskList
            tasks={tasks}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setActiveRunId(null);
            }}
            onCreate={async () => {
              try {
                const t = await api.createTask("Untitled task", "");
                await refresh();
                setSelectedId(t.id);
                setActiveRunId(null);
              } catch (err) {
                alert(`Could not create task: ${(err as Error).message}`);
              }
            }}
            onDelete={async (id) => {
              try {
                await api.deleteTask(id);
                if (selectedId === id) setSelectedId(null);
                await refresh();
              } catch (err) {
                alert(`Could not delete: ${(err as Error).message}`);
              }
            }}
          />
        </aside>

        <section className="col-span-5 min-h-0 overflow-y-auto border-r border-zinc-800 p-5">
          {selected ? (
            <TaskEditor
              key={selected.id}
              task={selected}
              onSaved={refresh}
              onRun={async () => {
                const { run_id } = await api.startRun(selected.id);
                setActiveRunId(run_id);
              }}
              statusMap={blockStatusMap}
              runningBlockId={runningBlockId}
            />
          ) : (
            <Empty title="No task selected" hint="Create a task on the left to get started." />
          )}
        </section>

        <section className="col-span-4 min-h-0 overflow-y-auto p-5">
          {activeRunId ? (
            <RunView
              runId={activeRunId}
              onClose={() => setActiveRunId(null)}
              onDeleted={() => setActiveRunId(null)}
              onStats={handleStats}
              onBlockStatus={handleBlockStatus}
            />
          ) : selected ? (
            <RecentRuns taskId={selected.id} onOpen={(id) => setActiveRunId(id)} />
          ) : (
            <Empty title="No run" hint="Start a run to watch the agent work." />
          )}
        </section>
      </main>

      <StatsFooter stats={stats} fallbackModel={serverModel} contextWindow={serverContextWindow} />
    </div>
  );
}

function StatsFooter({
  stats,
  fallbackModel,
  contextWindow,
}: {
  stats: AggStats | null;
  fallbackModel: string | null;
  contextWindow: number;
}) {
  const model = stats?.model ?? fallbackModel ?? "—";
  const ctxUsed = stats ? stats.promptTokens + stats.outputTokens : 0;
  const ctxPct = stats ? Math.min(100, (ctxUsed / contextWindow) * 100) : 0;
  const avgTps =
    stats && stats.totalEvalMs > 0 ? (stats.totalOutputTokens / stats.totalEvalMs) * 1000 : 0;
  const lastTps = stats?.lastTps ?? 0;

  return (
    <footer className="flex items-center gap-5 border-t border-zinc-800 bg-zinc-950/80 px-4 py-1.5 font-mono text-[11px] text-zinc-500">
      <span>
        <span className="text-zinc-600">model</span> <span className="text-zinc-300">{model}</span>
      </span>

      <span className="flex items-center gap-2">
        <span className="text-zinc-600">context</span>
        <span className="text-zinc-300">
          {stats ? formatTokens(ctxUsed) : "—"} / {formatTokens(contextWindow)}
        </span>
        <span className="relative h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
          <span
            className={`absolute inset-y-0 left-0 ${
              ctxPct > 80 ? "bg-red-500" : ctxPct > 50 ? "bg-amber-500" : "bg-emerald-500"
            }`}
            style={{ width: `${ctxPct}%` }}
          />
        </span>
        <span className="text-zinc-500">{stats ? `${ctxPct.toFixed(1)}%` : ""}</span>
      </span>

      <span>
        <span className="text-zinc-600">avg</span>{" "}
        <span className="text-zinc-300">{stats && avgTps > 0 ? avgTps.toFixed(1) : "—"}</span>
        <span className="text-zinc-600"> tok/s</span>
      </span>

      <span>
        <span className="text-zinc-600">last</span>{" "}
        <span className="text-zinc-300">{stats && lastTps > 0 ? lastTps.toFixed(1) : "—"}</span>
        <span className="text-zinc-600"> tok/s</span>
      </span>

      <span className="ml-auto text-zinc-600">
        {stats ? `${stats.totalOutputTokens} tokens generated` : "idle"}
      </span>
    </footer>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <div className="text-sm font-medium text-zinc-300">{title}</div>
        <div className="mt-1 text-xs text-zinc-500">{hint}</div>
      </div>
    </div>
  );
}

function runDuration(startedAt: string, finishedAt: string | null): string {
  const parse = (s: string): number =>
    Date.parse(s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s.replace(" ", "T") + "Z");
  const start = parse(startedAt);
  const end = finishedAt ? parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const ms = Math.max(0, end - start);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function RecentRuns({ taskId, onOpen }: { taskId: number; onOpen: (id: number) => void }) {
  const [runs, setRuns] = useState<
    { id: number; status: string; started_at: string; finished_at: string | null }[]
  >([]);

  const refresh = () => api.listRuns(taskId).then(setRuns).catch(console.error);

  useEffect(() => {
    void refresh();
    // refresh is recreated each render; we only want to re-run on taskId change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const deleteOne = async (id: number) => {
    if (!confirm(`Delete run #${id}?`)) return;
    try {
      await api.deleteRun(id);
      await refresh();
    } catch (err) {
      alert(`Could not delete: ${(err as Error).message}`);
    }
  };

  const clearAll = async () => {
    if (!confirm(`Delete all ${runs.length} runs for this task?`)) return;
    try {
      await api.clearTaskRuns(taskId, { resetIds: true });
      await refresh();
    } catch (err) {
      const e = err as Error & { status?: number; active?: number };
      if (e.status === 409) {
        const proceed = confirm(
          `${e.active ?? "Some"} run(s) are still marked "running" — likely zombies from a server restart.\n\nForce-delete them all and reset run numbering?`,
        );
        if (!proceed) return;
        try {
          await api.clearTaskRuns(taskId, { force: true, resetIds: true });
          await refresh();
        } catch (err2) {
          alert(`Could not force-clear: ${(err2 as Error).message}`);
        }
      } else {
        alert(`Could not clear: ${e.message}`);
      }
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Recent runs</div>
        {runs.length > 0 && (
          <button onClick={clearAll} className="text-xs text-zinc-500 hover:text-red-400">
            Clear all
          </button>
        )}
      </div>

      {runs.length === 0 && (
        <div className="px-2 py-6 text-center text-xs text-zinc-500">No runs yet</div>
      )}

      {runs.map((r) => (
        <div
          key={r.id}
          className="group flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm hover:border-zinc-700"
        >
          <button onClick={() => onOpen(r.id)} className="flex-1 text-left">
            Run #{r.id}
          </button>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-zinc-500">
              {runDuration(r.started_at, r.finished_at)}
            </span>
            <StatusPill status={r.status} />
            <button
              onClick={() => deleteOne(r.id)}
              className="hidden text-xs text-zinc-500 hover:text-red-400 group-hover:inline"
              aria-label="Delete run"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
