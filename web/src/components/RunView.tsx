import { useEffect, useRef, useState, type ReactNode } from "react";
import { StatusPill } from "./StatusPill.tsx";
import { api } from "../api.ts";

export type BlockStatus = "pending" | "running" | "done" | "failed" | "skipped";

type StreamEvent =
  | {
      replay: true;
      step: { idx: number; kind: string; payload: string; screenshot_path: string | null };
    }
  | { kind: "thought"; text: string; block_id?: string }
  | { kind: "tool_call"; name: string; args: unknown; block_id?: string }
  | {
      kind: "tool_result";
      name: string;
      result: { ok: boolean; text?: string; error?: string; data?: unknown };
      screenshotPath?: string;
      block_id?: string;
    }
  | { kind: "block_start"; block_id: string; block_kind: string; summary: string; path: string[] }
  | {
      kind: "block_end";
      block_id: string;
      block_kind: string;
      status: BlockStatus;
      result?: string;
      error?: string;
      details?: unknown;
      path: string[];
    }
  | { kind: "var_set"; name: string; preview: string }
  | { kind: "remember"; note: string }
  | { kind: "page_state"; url: string; title: string }
  | {
      kind: "stats";
      model: string;
      prompt_tokens: number;
      output_tokens: number;
      eval_duration_ms: number;
      tps: number;
    }
  | { kind: "paused"; reason?: string; auto?: boolean }
  | { kind: "resumed" }
  | { kind: "error"; error: string; block_id?: string }
  | { kind: "final"; answer: string }
  | { kind: "end"; status: string; result?: string; error?: string };

type Entry = {
  id: string;
  kind:
    | "thought"
    | "tool_call"
    | "tool_result"
    | "error"
    | "final"
    | "block_start"
    | "block_end"
    | "var_set"
    | "remember";
  body: string;
  ok?: boolean;
  toolName?: string;
  screenshot?: string;
  blockKind?: string;
  /** For block_end of a questionnaire: list of unanswered question summaries. */
  unanswered?: { question: string; reason: string }[];
};

export type RunStatsSample = {
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  eval_duration_ms: number;
  tps: number;
};

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
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<string>("running");
  const [paused, setPaused] = useState(false);
  const [pauseInfo, setPauseInfo] = useState<{ reason?: string; auto?: boolean } | null>(null);
  const [pageState, setPageState] = useState<{ url: string; title: string } | null>(null);
  const [memory, setMemory] = useState<string[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const latestStatusMapRef = useRef<Record<string, BlockStatus>>({});
  const latestRunningRef = useRef<string | null>(null);

  useEffect(() => {
    setEntries([]);
    setStatus("running");
    setPaused(false);
    setPauseInfo(null);
    setPageState(null);
    setMemory([]);
    setStartedAt(null);
    setFinishedAt(null);
    latestStatusMapRef.current = {};
    latestRunningRef.current = null;

    api
      .getRun(runId)
      .then(({ run, pause_info }) => {
        setStartedAt(run.started_at);
        setFinishedAt(run.finished_at);
        if (run.status !== "running") setStatus(run.status);
        // Fallback for SSE-event misses on reconnect: server tells us if the
        // run is currently paused so the Resume button shows immediately.
        if (run.is_paused) {
          setPaused(true);
          setPauseInfo(pause_info ?? null);
        }
      })
      .catch(() => {
        // ignore — run might not exist yet on a fresh start
      });

    const es = new EventSource(`/api/runs/${runId}/stream`);
    let counter = 0;
    es.onmessage = (msg) => {
      const ev = JSON.parse(msg.data as string) as StreamEvent;
      counter++;
      if ("replay" in ev) {
        const s = ev.step;
        const payload = JSON.parse(s.payload) as Record<string, unknown>;
        setEntries((prev) => [
          ...prev,
          {
            id: `r-${s.idx}`,
            kind: s.kind as Entry["kind"],
            body: renderBody(s.kind, payload),
            ok: s.kind === "tool_result" ? Boolean(payload.ok) : undefined,
            toolName: typeof payload.name === "string" ? payload.name : undefined,
            screenshot: s.screenshot_path ?? undefined,
          },
        ]);
      } else if (ev.kind === "thought") {
        setEntries((p) => [...p, { id: `t-${counter}`, kind: "thought", body: ev.text }]);
      } else if (ev.kind === "tool_call") {
        setEntries((p) => [
          ...p,
          {
            id: `tc-${counter}`,
            kind: "tool_call",
            toolName: ev.name,
            body: JSON.stringify(ev.args, null, 2),
          },
        ]);
      } else if (ev.kind === "tool_result") {
        setEntries((p) => [
          ...p,
          {
            id: `tr-${counter}`,
            kind: "tool_result",
            toolName: ev.name,
            ok: ev.result.ok,
            body: ev.result.ok ? (ev.result.text ?? "") : (ev.result.error ?? ""),
            screenshot: ev.screenshotPath,
          },
        ]);
      } else if (ev.kind === "error") {
        setEntries((p) => [...p, { id: `e-${counter}`, kind: "error", body: ev.error }]);
      } else if (ev.kind === "block_start") {
        setEntries((p) => [
          ...p,
          {
            id: `bs-${ev.block_id}-${counter}`,
            kind: "block_start",
            body: ev.summary,
            blockKind: ev.block_kind,
          },
        ]);
        onBlockStatus?.({
          blockId: ev.block_id,
          statusMap: {
            ...latestStatusMapRef.current,
            [ev.block_id]: "running",
          },
        });
        latestStatusMapRef.current = {
          ...latestStatusMapRef.current,
          [ev.block_id]: "running",
        };
        latestRunningRef.current = ev.block_id;
      } else if (ev.kind === "block_end") {
        const details = ev.details as
          | { unanswered?: { question: string; reason: string }[]; total?: number }
          | undefined;
        const unanswered = Array.isArray(details?.unanswered) ? details.unanswered : undefined;
        setEntries((p) => [
          ...p,
          {
            id: `be-${ev.block_id}-${counter}`,
            kind: "block_end",
            body: ev.result ?? ev.error ?? "",
            blockKind: ev.block_kind,
            ok: ev.status === "done",
            unanswered: unanswered && unanswered.length > 0 ? unanswered : undefined,
          },
        ]);
        latestStatusMapRef.current = {
          ...latestStatusMapRef.current,
          [ev.block_id]: ev.status,
        };
        if (latestRunningRef.current === ev.block_id) latestRunningRef.current = null;
        onBlockStatus?.({
          blockId: latestRunningRef.current,
          statusMap: latestStatusMapRef.current,
        });
      } else if (ev.kind === "var_set") {
        setEntries((p) => [
          ...p,
          { id: `var-${counter}`, kind: "var_set", body: `$${ev.name} = ${ev.preview}` },
        ]);
      } else if (ev.kind === "remember") {
        setMemory((m) => [...m, ev.note]);
        setEntries((p) => [...p, { id: `mem-${counter}`, kind: "remember", body: ev.note }]);
      } else if (ev.kind === "page_state") {
        setPageState({ url: ev.url, title: ev.title });
      } else if (ev.kind === "stats") {
        onStats?.({
          model: ev.model,
          prompt_tokens: ev.prompt_tokens,
          output_tokens: ev.output_tokens,
          eval_duration_ms: ev.eval_duration_ms,
          tps: ev.tps,
        });
      } else if (ev.kind === "paused") {
        setPaused(true);
        setPauseInfo({ reason: ev.reason, auto: ev.auto });
      } else if (ev.kind === "resumed") {
        setPaused(false);
        setPauseInfo(null);
      } else if (ev.kind === "final") {
        setEntries((p) => [...p, { id: `f-${counter}`, kind: "final", body: ev.answer }]);
      } else if (ev.kind === "end") {
        setStatus(ev.status);
        es.close();
        // Freeze the timer immediately so the user sees a final total even if
        // the canonical fetch is slow or fails.
        setFinishedAt((prev) => prev ?? new Date().toISOString());
        // Then replace with the server's canonical finished_at when it arrives.
        api
          .getRun(runId)
          .then(({ run }) => {
            if (run.finished_at) setFinishedAt(run.finished_at);
          })
          .catch(() => {
            // ignore — terminal-state finalisation is best-effort
          });
      }
    };
    es.onerror = () => {
      es.close();
    };

    return () => es.close();
    // The callbacks (onBlockStatus, onStats) are intentionally omitted —
    // we only want to (re)open the EventSource when the runId itself
    // changes. Phase 5 should hoist this whole effect into a
    // state/useRunStream hook so the dependency story is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

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
                      alert(`Could not resume: ${(err as Error).message}`);
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
                      alert(`Could not pause: ${(err as Error).message}`);
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
                    alert(`Could not cancel: ${(err as Error).message}`);
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
                if (!confirm(`Delete run #${runId}?`)) return;
                try {
                  await api.deleteRun(runId);
                  onDeleted?.();
                } catch (err) {
                  alert(`Could not delete: ${(err as Error).message}`);
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

/**
 * SQLite stores datetime('now') as "YYYY-MM-DD HH:MM:SS" in UTC, with no zone suffix.
 * JS Date.parse on that treats it as local time — wrong by hours. Force UTC.
 */
function parseSqliteUtc(s: string | null): number | null {
  if (!s) return null;
  const ms = Date.parse(
    s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s.replace(" ", "T") + "Z",
  );
  return Number.isFinite(ms) ? ms : null;
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
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

function renderBody(kind: string, payload: Record<string, unknown>): string {
  const asStr = (v: unknown) => (typeof v === "string" ? v : "");
  if (kind === "thought") return asStr(payload.text);
  if (kind === "tool_call") return JSON.stringify(payload.args ?? {}, null, 2);
  if (kind === "tool_result") return asStr(payload.text);
  if (kind === "error") return asStr(payload.error);
  if (kind === "final") return asStr(payload.answer);
  return JSON.stringify(payload);
}
