import { afterEach, describe, expect, it } from "vitest";
import {
  awaitIfPaused,
  clear,
  getPauseInfo,
  isPaused,
  pause,
  registerRun,
  resume,
} from "../pause.ts";

// docs/specs/server/run-control-pause.md
//
// pause.ts holds a module-level Map keyed by runId. Each test uses a unique
// id so we never collide with another test, and afterEach clears it for
// hygiene. We do not introduce a "reset all" — that would mask real
// per-id-leakage bugs the registry could have.

let nextId = 1;
const used: number[] = [];
function freshId(): number {
  const id = 1_000_000 + nextId++;
  used.push(id);
  return id;
}
afterEach(() => {
  while (used.length) clear(used.pop()!);
});

describe("pause registry — registration", () => {
  it("pause returns false for an unknown run id", () => {
    expect(pause(freshId())).toBe(false);
  });

  it("pause works once registerRun has been called", () => {
    const id = freshId();
    registerRun(id);
    expect(pause(id)).toBe(true);
    expect(isPaused(id)).toBe(true);
  });
});

describe("pause registry — state transitions", () => {
  it("pause is idempotent: a second pause returns false", () => {
    const id = freshId();
    registerRun(id);
    expect(pause(id)).toBe(true);
    expect(pause(id)).toBe(false);
    expect(isPaused(id)).toBe(true);
  });

  it("resume returns true only on a real running→paused→running transition", () => {
    const id = freshId();
    registerRun(id);
    expect(resume(id)).toBe(false); // not paused
    pause(id);
    expect(resume(id)).toBe(true);
    expect(resume(id)).toBe(false); // already resumed
    expect(isPaused(id)).toBe(false);
  });

  it("resume returns false for an unknown run id", () => {
    expect(resume(freshId())).toBe(false);
  });
});

describe("pause registry — pause info", () => {
  it("getPauseInfo returns null when not paused", () => {
    const id = freshId();
    registerRun(id);
    expect(getPauseInfo(id)).toBeNull();
  });

  it("getPauseInfo reflects reason + auto while paused", () => {
    const id = freshId();
    registerRun(id);
    pause(id, { reason: "login detected", auto: true });
    expect(getPauseInfo(id)).toEqual({ reason: "login detected", auto: true });
  });

  it("resume clears pause info", () => {
    const id = freshId();
    registerRun(id);
    pause(id, { reason: "stall", auto: true });
    resume(id);
    expect(getPauseInfo(id)).toBeNull();
  });

  it("getPauseInfo returns null for an unknown run id", () => {
    expect(getPauseInfo(freshId())).toBeNull();
  });
});

describe("pause registry — awaitIfPaused", () => {
  it("resolves immediately if the run is not paused", async () => {
    const id = freshId();
    registerRun(id);
    await expect(awaitIfPaused(id)).resolves.toBeUndefined();
  });

  it("resolves immediately for an unknown run id (defensive fast path)", async () => {
    await expect(awaitIfPaused(freshId())).resolves.toBeUndefined();
  });

  it("blocks while paused and unblocks on resume", async () => {
    const id = freshId();
    registerRun(id);
    pause(id);

    let resolved = false;
    const waiter = awaitIfPaused(id).then(() => {
      resolved = true;
    });

    // Yield once; promise must NOT resolve while still paused.
    await Promise.resolve();
    expect(resolved).toBe(false);

    resume(id);
    await waiter;
    expect(resolved).toBe(true);
  });

  it("drains every waiter when resume is called", async () => {
    const id = freshId();
    registerRun(id);
    pause(id);

    const flags = [false, false, false];
    const waiters = flags.map((_, i) =>
      awaitIfPaused(id).then(() => {
        flags[i] = true;
      }),
    );

    resume(id);
    await Promise.all(waiters);
    expect(flags).toEqual([true, true, true]);
  });
});

describe("pause registry — clear", () => {
  it("clear wakes all waiters even though they were not formally resumed", async () => {
    const id = freshId();
    registerRun(id);
    pause(id);

    let resolved = false;
    const waiter = awaitIfPaused(id).then(() => {
      resolved = true;
    });

    clear(id);
    await waiter;
    expect(resolved).toBe(true);
  });

  it("clear forgets the run; subsequent pause returns false", () => {
    const id = freshId();
    registerRun(id);
    clear(id);
    expect(pause(id)).toBe(false);
  });

  it("clear is a safe no-op for an unknown run id", () => {
    expect(() => clear(freshId())).not.toThrow();
  });
});

describe("pause registry — per-run-id isolation", () => {
  it("pausing one run does not affect another", () => {
    const a = freshId();
    const b = freshId();
    registerRun(a);
    registerRun(b);

    pause(a, { reason: "a paused" });
    expect(isPaused(a)).toBe(true);
    expect(isPaused(b)).toBe(false);
    expect(getPauseInfo(b)).toBeNull();
  });

  it("resuming one run does not wake waiters of another", async () => {
    const a = freshId();
    const b = freshId();
    registerRun(a);
    registerRun(b);
    pause(a);
    pause(b);

    let aResolved = false;
    let bResolved = false;
    const aWaiter = awaitIfPaused(a).then(() => {
      aResolved = true;
    });
    const bWaiter = awaitIfPaused(b).then(() => {
      bResolved = true;
    });

    resume(a);
    await aWaiter;
    expect(aResolved).toBe(true);
    expect(bResolved).toBe(false);

    resume(b);
    await bWaiter;
    expect(bResolved).toBe(true);
  });
});
