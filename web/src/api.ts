import type { Block } from "./blocks.ts";

export type Task = {
  id: number;
  name: string;
  instruction: string;
  steps: string | null;
  created_at: string;
};

export type Run = {
  id: number;
  task_id: number;
  status: "running" | "done" | "error" | "cancelled";
  result: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  is_paused?: boolean;
};

export type Step = {
  id: number;
  run_id: number;
  idx: number;
  kind:
    | "thought"
    | "tool_call"
    | "tool_result"
    | "block_start"
    | "block_end"
    | "var_set"
    | "remember"
    | "error"
    | "final"
    | "page_state"
    | "stats"
    | "messages_export";
  payload: string;
  screenshot_path: string | null;
  created_at: string;
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export type Settings = {
  rescue_enabled: boolean;
  rescue_model: string;
  rescue_on_cancel: boolean;
  api_key_configured: boolean;
  lesson_count: number;
};

export type Lesson = {
  id: number;
  run_id: number | null;
  block_id: string | null;
  lesson: string;
  situation: string | null;
  created_at: string;
};

export const api = {
  listTasks: () => fetch("/api/tasks").then((r) => j<Task[]>(r)),
  getTask: (id: number) => fetch(`/api/tasks/${id}`).then((r) => j<Task>(r)),
  createTask: (name: string, instruction: string) =>
    fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, instruction }),
    }).then((r) => j<Task>(r)),
  updateTask: (id: number, patch: { name?: string; instruction?: string; steps?: Block[] }) =>
    fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<Task>(r)),
  deleteTask: (id: number) =>
    fetch(`/api/tasks/${id}`, { method: "DELETE" }).then((r) => j<{ ok: true }>(r)),
  startRun: (taskId: number) =>
    fetch(`/api/tasks/${taskId}/run`, { method: "POST" }).then((r) => j<{ run_id: number }>(r)),
  cancelRun: (runId: number) =>
    fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  pauseRun: (runId: number) =>
    fetch(`/api/runs/${runId}/pause`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  resumeRun: (runId: number) =>
    fetch(`/api/runs/${runId}/resume`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  deleteRun: (runId: number) =>
    fetch(`/api/runs/${runId}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),
  clearTaskRuns: (taskId: number, opts?: { force?: boolean; resetIds?: boolean }) => {
    const qs: string[] = [];
    if (opts?.force) qs.push("force=true");
    if (opts?.resetIds) qs.push("reset_ids=true");
    const url = `/api/tasks/${taskId}/runs${qs.length ? "?" + qs.join("&") : ""}`;
    return fetch(url, { method: "DELETE" }).then(async (r) => {
      if (r.status === 409) {
        const body = (await r.json().catch(() => ({}))) as { error?: string; active?: number };
        throw Object.assign(new Error(body.error ?? "runs still active"), {
          status: 409,
          active: body.active,
        });
      }
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json() as Promise<{ ok: boolean; deleted: number; forced: number }>;
    });
  },
  compileBlocks: (prompt: string) =>
    fetch("/api/blocks/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    }).then((r) => j<{ blocks: import("./blocks.ts").Block[] }>(r)),
  listRuns: (taskId: number) => fetch(`/api/tasks/${taskId}/runs`).then((r) => j<Run[]>(r)),
  getRun: (runId: number) =>
    fetch(`/api/runs/${runId}`).then((r) =>
      j<{ run: Run; steps: Step[]; pause_info: { reason?: string; auto?: boolean } | null }>(r),
    ),

  getSettings: () => fetch("/api/settings").then((r) => j<Settings>(r)),
  updateSettings: (patch: {
    rescue_enabled?: boolean;
    rescue_model?: string;
    rescue_on_cancel?: boolean;
  }) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => j<Settings>(r)),

  listLessons: (offset = 0, limit = 50) =>
    fetch(`/api/lessons?offset=${offset}&limit=${limit}`).then((r) =>
      j<{ lessons: Lesson[]; total: number }>(r),
    ),
  deleteLesson: (id: number) =>
    fetch(`/api/lessons/${id}`, { method: "DELETE" }).then((r) => j<{ ok: boolean }>(r)),

  exportTrainingData: (onlyRescued = false) => {
    const url = `/api/export${onlyRescued ? "?status=rescued" : ""}`;
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.blob();
    });
  },
};
