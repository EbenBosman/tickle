import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusPill } from "./StatusPill.tsx";
import { useUiPrompts } from "./UiPrompts.tsx";
import { api } from "../api.ts";
import { parseSqliteUtc, formatDuration } from "../state/parseSqliteUtc.ts";
import {
  useRunStream,
  type BlockStatus,
  type Entry,
  type RunStatsSample,
} from "../state/useRunStream.ts";

export type { BlockStatus, RunStatsSample };

export function RunView({
  runId,
  onClose,
  onDeleted,
  onStats,
  onBlockStatus,
}: {
  runId: number;
  onClose?: () => void;
  onDeleted?: () => void;
  onStats?: (sample: RunStatsSample) => void;
  onBlockStatus?: (info: {
    blockId: string | null;
    statusMap: Record<string, BlockStatus>;
  }) => void;
}) {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { toast, confirm: askConfirm } = useUiPrompts();

  const { entries, status, paused, pauseInfo, pageState, memory, startedAt, finishedAt } =
    useRunStream(runId, { onStats, onBlockStatus });

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [entries.length]);

  // Tick once per second while the run is running, so the elapsed time updates live.
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  const elapsed = computeElapsed(startedAt, finishedAt, now);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {onClose && (
            <button
              onClick={onClose}
              className="text-xs text-zinc-500 hover:text-zinc-300"
              aria-label="Back to recent runs"
            >
              ← Back
            </button>
          )}
          <div className="text-sm text-zinc-300">Run #{runId}</div>
          {elapsed && (
            <div
              className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 ${
                finishedAt ? "border-zinc-700 bg-zinc-900" : "border-blue-500/40 bg-blue-500/10"
              }`}
              title={finishedAt ? "Total duration" : "Elapsed time"}
            >
              <span
                className={`text-[9px] font-semibold uppercase tracking-wider ${
                  finishedAt ? "text-zinc-500" : "text-blue-300/80"
                }`}
              >
                {finishedAt ? "Total" : "Elapsed"}
              </span>
              <span
                className={`font-mono text-sm tabular-nums ${
                  finishedAt ? "text-zinc-100" : "text-blue-200"
                }`}
              >
                {elapsed}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status === "running" ? (
            <>
              {paused ? (
                <button
                  onClick={async () => {
                    try {
                      await api.resumeRun(runId);
                    } catch (err) {
                      toast.error(`Could not resume: ${(err as Error).message}`);
                    }
                  }}
                  className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20"
                >
                  Resume
                </button>
              ) : (
                <button
                  onClick={async () => {
                    try {
                      await api.pauseRun(runId);
                    } catch (err) {
                      toast.error(`Could not pause: ${(err as Error).message}`);
                    }
                  }}
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20"
                >
                  Pause
                </button>
              )}
              <button
                onClick={async () => {
                  try {
                    await api.cancelRun(runId);
                  } catch (err) {
                    toast.error(`Could not cancel: ${(err as Error).message}`);
                  }
                }}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-200 hover:bg-red-500/20"
              >
                Stop
              </button>
            </>
          ) : (
            <button
              onClick={async () => {
                if (!(await askConfirm(`Delete run #${runId}?`, { destructive: true }))) return;
                try {
                  await api.deleteRun(runId);
                  onDeleted?.();
                } catch (err) {
                  toast.error(`Could not delete: ${(err as Error).message}`);
                }
              }}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-xs text-zinc-400 hover:border-red-500/40 hover:text-red-300"
            >
              Delete
            </button>
          )}
          <StatusPill status={paused && status === "running" ? "paused" : status} />
        </div>
      </div>

      {pageState && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Page state
          </div>
          <div className="mt-1 truncate text-sm text-zinc-200" title={pageState.title}>
            {pageState.title || "(no title)"}
          </div>
          <div className="truncate font-mono text-xs text-zinc-500" title={pageState.url}>
            {pageState.url}
          </div>
        </div>
      )}

      {memory.length > 0 && (
        <div className="rounded-md border border-violet-500/30 bg-violet-500/5">
          <button
            onClick={() => setMemoryOpen((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-300">
              Global memory · {memory.length} {memory.length === 1 ? "note" : "notes"}
            </span>
            <span className="text-xs text-violet-300/60">{memoryOpen ? "▾" : "▸"}</span>
          </button>
          {memoryOpen && (
            <ol className="space-y-1 border-t border-violet-500/20 px-3 py-2 text-[11px] text-violet-100">
              {memory.map((m, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-violet-400/60">{i + 1}.</span>
                  <span>{m}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {paused && pauseInfo?.auto && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-300">
            Auto-paused
          </div>
          <div className="mt-1">
            {pauseInfo.reason ?? "Login required."} The browser is yours — finish the login, then
            click <span className="font-semibold">Resume</span>.
          </div>
        </div>
      )}

      <div ref={scrollerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {entries.map((e) => (
          <EntryCard key={e.id} entry={e} />
        ))}
        {entries.length === 0 && (
          <div className="text-xs text-zinc-500">Waiting for the agent to start…</div>
        )}
      </div>
    </div>
  );
}

function EntryCard({ entry }: { entry: Entry }) {
  const base = "rounded-md border px-3 py-2 text-sm";
  if (entry.kind === "block_start") {
    return (
      <div className="rounded-md border-2 border-dashed border-zinc-700 bg-zinc-900/30 px-3 py-2 text-sm">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
          ▶ Block · {entry.blockKind}
        </div>
        <div className="mt-1 text-zinc-300">{entry.body}</div>
      </div>
    );
  }
  if (entry.kind === "block_end") {
    const needsReview = entry.unanswered && entry.unanswered.length > 0;
    const cls = needsReview
      ? "border-amber-500/40 bg-amber-500/5 text-amber-100"
      : entry.ok
        ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-200"
        : "border-red-500/40 bg-red-500/5 text-red-200";
    return (
      <div className={`rounded-md border px-3 py-2 text-xs ${cls}`}>
        <div>
          ◼ Block end · {entry.blockKind} {entry.ok ? "✓" : "✗"}{" "}
          {needsReview && (
            <span className="ml-1 rounded-full border border-amber-500/60 bg-amber-500/20 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
              needs review
            </span>
          )}{" "}
          {entry.body && <span className="opacity-80">— {entry.body}</span>}
        </div>
        {needsReview && (
          <ul className="mt-2 space-y-1 border-t border-amber-500/20 pt-2 text-[11px]">
            {entry.unanswered!.map((u, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-amber-400">•</span>
                <div>
                  <div className="text-amber-100">{u.question.slice(0, 200)}</div>
                  <div className="text-amber-400/70">{u.reason}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (entry.kind === "remember") {
    return (
      <div className="rounded-md border border-violet-500/30 bg-violet-500/5 px-3 py-1.5 text-xs text-violet-200">
        <span className="text-[10px] uppercase tracking-wider text-violet-400">remembered · </span>
        {entry.body}
      </div>
    );
  }
  if (entry.kind === "var_set") {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-200">
        <span className="text-[10px] uppercase tracking-wider text-emerald-300/70">var set · </span>
        <span className="font-mono">{entry.body}</span>
      </div>
    );
  }
  if (entry.kind === "thought") {
    return (
      <div className={`${base} border-zinc-800 bg-zinc-900/50`}>
        <Label>Thought</Label>
        <div className="mt-1 whitespace-pre-wrap text-zinc-200">{entry.body}</div>
      </div>
    );
  }
  if (entry.kind === "tool_call") {
    return (
      <div className={`${base} border-blue-500/30 bg-blue-500/5`}>
        <Label>→ {entry.toolName}</Label>
        <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-blue-200">{entry.body}</pre>
      </div>
    );
  }
  if (entry.kind === "tool_result") {
    const okCls = entry.ok
      ? "border-emerald-500/30 bg-emerald-500/5"
      : "border-red-500/30 bg-red-500/5";
    return (
      <div className={`${base} ${okCls}`}>
        <Label>
          ← {entry.toolName} {entry.ok ? "" : "(error)"}
        </Label>
        {entry.screenshot && (
          <img
            src={`/screenshots/${entry.screenshot}`}
            alt="screenshot"
            className="mt-2 w-full rounded border border-zinc-800"
          />
        )}
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-zinc-300">
          {entry.body}
        </pre>
      </div>
    );
  }
  if (entry.kind === "error") {
    return (
      <div className={`${base} border-red-500/40 bg-red-500/10`}>
        <Label>Error</Label>
        <div className="mt-1 whitespace-pre-wrap text-red-200">{entry.body}</div>
      </div>
    );
  }
  return (
    <div className={`${base} border-emerald-500/40 bg-emerald-500/10`}>
      <Label>Final answer</Label>
      <div className="mt-1 whitespace-pre-wrap text-emerald-100">{entry.body}</div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-zinc-500">{children}</div>;
}

function computeElapsed(
  startedAt: string | null,
  finishedAt: string | null,
  now: number,
): string | null {
  const start = parseSqliteUtc(startedAt);
  if (start === null) return null;
  const end = parseSqliteUtc(finishedAt) ?? now;
  return formatDuration(end - start);
}
