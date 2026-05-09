import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import type { BlockStatus, RunStatsSample, SseEvent } from "../../../shared/run.ts";

export type { BlockStatus, RunStatsSample };

export type Entry = {
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

export type RunStreamState = {
  entries: Entry[];
  status: string;
  paused: boolean;
  pauseInfo: { reason?: string; auto?: boolean } | null;
  pageState: { url: string; title: string } | null;
  memory: string[];
  startedAt: string | null;
  finishedAt: string | null;
};

/**
 * Wire-shape of the SSE stream the route emits. Replay frames carry a
 * persisted step row; everything else is a live `SseEvent` from the
 * shared union.
 */
type StreamEvent =
  | {
      replay: true;
      step: { idx: number; kind: string; payload: string; screenshot_path: string | null };
    }
  | SseEvent;

/** Convert a persisted step's payload into the displayable string body. */
export function renderStepBody(kind: string, payload: Record<string, unknown>): string {
  const asStr = (v: unknown) => (typeof v === "string" ? v : "");
  if (kind === "thought") return asStr(payload.text);
  if (kind === "tool_call") return JSON.stringify(payload.args ?? {}, null, 2);
  if (kind === "tool_result") return asStr(payload.text);
  if (kind === "error") return asStr(payload.error);
  if (kind === "final") return asStr(payload.answer);
  return JSON.stringify(payload);
}

/**
 * Subscribe to `/api/runs/:id/stream` and surface the resulting state as
 * a React-friendly object. Handles:
 *   - bootstrap fetch of the run row (start time, paused snapshot)
 *   - SSE message parsing into typed entries / state
 *   - cleanup of the EventSource on unmount or runId change
 *
 * Callbacks are passed via a ref so they don't force the effect to re-run
 * on every render. Only `runId` is in the dependency array.
 */
export function useRunStream(
  runId: number,
  callbacks: {
    onStats?: (sample: RunStatsSample) => void;
    onBlockStatus?: (info: {
      blockId: string | null;
      statusMap: Record<string, BlockStatus>;
    }) => void;
  } = {},
): RunStreamState {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<string>("running");
  const [paused, setPaused] = useState(false);
  const [pauseInfo, setPauseInfo] = useState<{ reason?: string; auto?: boolean } | null>(null);
  const [pageState, setPageState] = useState<{ url: string; title: string } | null>(null);
  const [memory, setMemory] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<string | null>(null);

  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
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
            body: renderStepBody(s.kind, payload),
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
        latestStatusMapRef.current = {
          ...latestStatusMapRef.current,
          [ev.block_id]: "running",
        };
        latestRunningRef.current = ev.block_id;
        callbacksRef.current.onBlockStatus?.({
          blockId: ev.block_id,
          statusMap: latestStatusMapRef.current,
        });
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
        callbacksRef.current.onBlockStatus?.({
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
        callbacksRef.current.onStats?.({
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
  }, [runId]);

  return {
    entries,
    status,
    paused,
    pauseInfo,
    pageState,
    memory,
    startedAt,
    finishedAt,
  };
}
