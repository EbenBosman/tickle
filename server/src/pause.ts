type PauseEntry = {
  paused: boolean;
  reason?: string;
  auto?: boolean;
  waiters: (() => void)[];
};

const entries = new Map<number, PauseEntry>();

function ensure(runId: number): PauseEntry {
  let e = entries.get(runId);
  if (!e) {
    e = { paused: false, waiters: [] };
    entries.set(runId, e);
  }
  return e;
}

export function registerRun(runId: number): void {
  ensure(runId);
}

export function pause(runId: number, info?: { reason?: string; auto?: boolean }): boolean {
  const e = entries.get(runId);
  if (!e) return false;
  if (e.paused) return false;
  e.paused = true;
  e.reason = info?.reason;
  e.auto = info?.auto;
  return true;
}

export function resume(runId: number): boolean {
  const e = entries.get(runId);
  if (!e) return false;
  if (!e.paused) return false;
  e.paused = false;
  e.reason = undefined;
  e.auto = undefined;
  const waiters = e.waiters;
  e.waiters = [];
  for (const w of waiters) w();
  return true;
}

export function isPaused(runId: number): boolean {
  return entries.get(runId)?.paused ?? false;
}

export function getPauseInfo(runId: number): { reason?: string; auto?: boolean } | null {
  const e = entries.get(runId);
  if (!e || !e.paused) return null;
  return { reason: e.reason, auto: e.auto };
}

/** Resolve immediately if not paused; otherwise wait until resume() / clear() is called. */
export function awaitIfPaused(runId: number): Promise<void> {
  const e = entries.get(runId);
  if (!e || !e.paused) return Promise.resolve();
  return new Promise<void>((resolve) => {
    e.waiters.push(resolve);
  });
}

/** Wake any waiters and forget the run. Used at end of run / on cancel. */
export function clear(runId: number): void {
  const e = entries.get(runId);
  if (e) {
    const waiters = e.waiters;
    e.waiters = [];
    e.paused = false;
    for (const w of waiters) w();
  }
  entries.delete(runId);
}
