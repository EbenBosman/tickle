import type { AgentEvent } from "./agent.ts";

type Subscriber = (
  event: AgentEvent | { kind: "end"; status: string; result?: string; error?: string },
) => void;

const subs = new Map<number, Set<Subscriber>>();

export function subscribe(runId: number, fn: Subscriber): () => void {
  let set = subs.get(runId);
  if (!set) {
    set = new Set();
    subs.set(runId, set);
  }
  set.add(fn);
  return () => {
    const current = subs.get(runId);
    if (!current) return;
    current.delete(fn);
    // GC the empty Set so a long-lived process doesn't accumulate one
    // entry per run forever after every subscriber leaves.
    if (current.size === 0) subs.delete(runId);
  };
}

export function publish(
  runId: number,
  event: AgentEvent | { kind: "end"; status: string; result?: string; error?: string },
) {
  const set = subs.get(runId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function endTopic(runId: number) {
  subs.delete(runId);
}

/** Test/diagnostics: number of distinct runs with at least one subscriber. */
export function topicCount(): number {
  return subs.size;
}
