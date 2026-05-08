import { afterEach, describe, expect, it, vi } from "vitest";
import { endTopic, publish, subscribe } from "../bus.ts";

// docs/specs/server/event-bus.md
//
// bus.ts is a Map<runId, Set<Subscriber>>. Tests use unique ids and
// endTopic() in afterEach. We do NOT enforce the empty-Set-leak fix or
// the replay/subscribe race fix here — both are open drift in the spec
// and Phase 4-5 work; their tests will be added when the fixes land.

let nextId = 1;
const used: number[] = [];
function freshId(): number {
  const id = 3_000_000 + nextId++;
  used.push(id);
  return id;
}
afterEach(() => {
  while (used.length) endTopic(used.pop()!);
});

// Helper: build an opaque event payload. We use `as never` so the strict
// `AgentEvent` import doesn't force us to construct every variant.
function ev(kind: string, extra: Record<string, unknown> = {}) {
  return { kind, ...extra } as never;
}

describe("event bus — subscribe / publish basics", () => {
  it("subscribers receive events for their run id", () => {
    const id = freshId();
    const fn = vi.fn();
    subscribe(id, fn);
    publish(id, ev("thought", { text: "hi" }));
    expect(fn).toHaveBeenCalledExactlyOnceWith({ kind: "thought", text: "hi" });
  });

  it("publishing to a run with no subscribers is a no-op (no throw)", () => {
    expect(() => publish(freshId(), ev("thought"))).not.toThrow();
  });

  it("unsubscribe stops further deliveries", () => {
    const id = freshId();
    const fn = vi.fn();
    const unsub = subscribe(id, fn);
    publish(id, ev("thought"));
    unsub();
    publish(id, ev("thought"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe is idempotent", () => {
    const id = freshId();
    const fn = vi.fn();
    const unsub = subscribe(id, fn);
    unsub();
    expect(() => unsub()).not.toThrow();
  });
});

describe("event bus — fan-out", () => {
  it("every subscriber receives every event in registration order", () => {
    const id = freshId();
    const order: string[] = [];
    subscribe(id, () => order.push("A"));
    subscribe(id, () => order.push("B"));
    subscribe(id, () => order.push("C"));
    publish(id, ev("thought"));
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("a throwing subscriber does not break delivery to siblings", () => {
    const id = freshId();
    const ok = vi.fn();
    subscribe(id, () => {
      throw new Error("boom");
    });
    subscribe(id, ok);
    expect(() => publish(id, ev("thought"))).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("event bus — per-run-id isolation", () => {
  it("an event for one run is not delivered to subscribers of another", () => {
    const a = freshId();
    const b = freshId();
    const fnA = vi.fn();
    const fnB = vi.fn();
    subscribe(a, fnA);
    subscribe(b, fnB);
    publish(a, ev("thought"));
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).not.toHaveBeenCalled();
  });
});

describe("event bus — endTopic", () => {
  it("endTopic stops all subscribers for that run", () => {
    const id = freshId();
    const fn = vi.fn();
    subscribe(id, fn);
    endTopic(id);
    publish(id, ev("thought"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("endTopic on an unknown run is a safe no-op", () => {
    expect(() => endTopic(freshId())).not.toThrow();
  });

  it("endTopic does not affect other runs", () => {
    const a = freshId();
    const b = freshId();
    const fnA = vi.fn();
    const fnB = vi.fn();
    subscribe(a, fnA);
    subscribe(b, fnB);
    endTopic(a);
    publish(b, ev("thought"));
    expect(fnA).not.toHaveBeenCalled();
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});
