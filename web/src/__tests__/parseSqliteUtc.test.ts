import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSqliteUtc, formatDuration, runDuration } from "../state/parseSqliteUtc.ts";

// docs/specs/web/run-view.md §4 + docs/specs/server/persistence.md §3 I3
//
// SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" without a zone
// suffix. Our JS-side writes use toISOString(). The frontend has to
// parse both forms identically — that's the point of parseSqliteUtc.

describe("parseSqliteUtc — null/empty input", () => {
  it("returns null for null", () => {
    expect(parseSqliteUtc(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseSqliteUtc(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSqliteUtc("")).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(parseSqliteUtc("not a date at all")).toBeNull();
  });
});

describe("parseSqliteUtc — both timestamp shapes round-trip to the same epoch", () => {
  it("space-separated (no zone) and ISO-with-Z parse to the same ms", () => {
    const space = "2026-05-08 13:42:01";
    const iso = "2026-05-08T13:42:01Z";
    expect(parseSqliteUtc(space)).toBe(parseSqliteUtc(iso));
  });

  it("ISO with milliseconds parses too", () => {
    expect(parseSqliteUtc("2026-05-08T13:42:01.123Z")).not.toBeNull();
  });

  it("treats the no-zone form as UTC, not local", () => {
    // If we forgot to force UTC, this would shift by the local offset.
    const expected = Date.UTC(2026, 4, 8, 13, 42, 1); // month is 0-indexed
    expect(parseSqliteUtc("2026-05-08 13:42:01")).toBe(expected);
  });
});

describe("formatDuration", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(7_500)).toBe("7s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("formats sub-hour durations in minutes + zero-padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("formats multi-hour durations as h m s", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
  });

  it("clamps negative inputs to 0", () => {
    expect(formatDuration(-100)).toBe("0s");
  });
});

describe("runDuration — combines parse + format", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T13:43:31Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a formatted elapsed string when both timestamps are present", () => {
    expect(runDuration("2026-05-08 13:42:01", "2026-05-08T13:42:11Z")).toBe("10s");
  });

  it("uses Date.now() when finishedAt is null (in-flight run)", () => {
    expect(runDuration("2026-05-08 13:42:01", null)).toBe("1m 30s");
  });

  it("returns an empty string when startedAt is unparseable", () => {
    expect(runDuration("garbage", null)).toBe("");
  });
});
