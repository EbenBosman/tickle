/**
 * Tiny narrowing helpers for `unknown` values that arrive at trust
 * boundaries (LLM tool args, JSON.parse output, untyped DB columns).
 * `String(unknown)` would yield `[object Object]` for a misshaped
 * value, which is both ugly and unsafe — these return a typed
 * fallback instead.
 */

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
