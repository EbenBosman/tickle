import type { AgentEvent } from "./agent.ts";

type Subscriber = (event: AgentEvent | { kind: "end"; status: string; result?: string; error?: string }) => void;

const subs = new Map<number, Set<Subscriber>>();

export function subscribe(runId: number, fn: Subscriber): () => void {
  if (!subs.has(runId)) subs.set(runId, new Set());
  subs.get(runId)!.add(fn);
  return () => {
    subs.get(runId)?.delete(fn);
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
