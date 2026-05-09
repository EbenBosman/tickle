/**
 * SQLite stores `datetime('now')` as `"YYYY-MM-DD HH:MM:SS"` with no zone
 * suffix. JS `Date.parse` on that treats it as **local** time, producing
 * elapsed-time errors of ±the user's timezone offset.
 *
 * `parseSqliteUtc` accepts both shapes the codebase emits:
 *   - SQLite-default `"YYYY-MM-DD HH:MM:SS"` (space-separated, no zone)
 *   - JS-side `toISOString()` `"YYYY-MM-DDTHH:MM:SS.sssZ"`
 *
 * Returns the epoch milliseconds, or `null` if the input is null/empty/
 * unparseable. The function is pure — safe to call from anywhere.
 */
export function parseSqliteUtc(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(
    s.includes("T") ? (s.endsWith("Z") ? s : s + "Z") : s.replace(" ", "T") + "Z",
  );
  return Number.isFinite(ms) ? ms : null;
}

/** Format an elapsed millisecond value as `"Xh Ym Zs"` / `"Ym Zs"` / `"Zs"`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Convenience: compute and format the run duration given start + optional end
 * timestamps. Used by lists where we just need a string for display.
 */
export function runDuration(startedAt: string, finishedAt: string | null): string {
  const start = parseSqliteUtc(startedAt);
  if (start === null) return "";
  const end = parseSqliteUtc(finishedAt) ?? Date.now();
  return formatDuration(Math.max(0, end - start));
}
