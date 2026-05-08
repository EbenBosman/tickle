import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const LOG_PATH = "data/tickle.log";
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB → rotate to .1

mkdirSync(dirname(LOG_PATH), { recursive: true });

export type LogContext = {
  runId?: number;
  [key: string]: unknown;
};

const REDACTED = "[redacted]";

/**
 * Default denylist of context keys whose VALUES are replaced with the
 * redaction marker before writing. The set is matched case-insensitively
 * so `Authorization` and `apikey` both hit. Add more keys via the
 * `LOG_REDACT` env var (comma-separated).
 *
 * The replacement is value-only: the key remains visible so debugging
 * "did this code path receive an api key" still works without leaking
 * the value itself.
 */
const DEFAULT_DENYLIST: readonly string[] = [
  "apikey",
  "authorization",
  "cookie",
  "password",
  "token",
];

function buildDenylist(): ReadonlySet<string> {
  const extra = (process.env.LOG_REDACT ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set([...DEFAULT_DENYLIST, ...extra]);
}

/**
 * Walk a value, returning a structurally-cloned copy with denylisted
 * keys' values replaced by the redaction marker. Handles arrays and
 * cycles (a WeakSet of seen objects breaks them, replacing the
 * second visit with the marker so we never recurse forever).
 *
 * Primitives, null, undefined, and unknowns pass through unchanged.
 */
function redact(value: unknown, deny: ReadonlySet<string>, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, deny, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (deny.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, deny, seen);
    }
  }
  return out;
}

function rotateIfNeeded() {
  try {
    const s = statSync(LOG_PATH);
    if (s.size >= MAX_BYTES) {
      renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

/** Write a structured trace line. Mirrored to stdout for live tail in the dev terminal. */
export function trace(event: string, ctx: LogContext = {}): void {
  rotateIfNeeded();
  const denylist = buildDenylist();
  const safeCtx = redact(ctx, denylist, new WeakSet()) as Record<string, unknown>;
  const entry = { t: new Date().toISOString(), event, ...safeCtx };
  let line: string;
  try {
    line = JSON.stringify(entry) + "\n";
  } catch {
    // Defensive: even after circular-ref handling above, structured-clone
    // edge cases (BigInt, non-cyclic but unstringifiable) shouldn't crash
    // the trace path.
    line = JSON.stringify({ t: entry.t, event, error: "trace-serialization-failed" }) + "\n";
  }
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // disk full or permissions — don't crash the agent for log failure
  }
  // Compact console form for live tail. Uses the redacted ctx so the
  // stdout mirror is also safe.
  const head =
    typeof safeCtx.runId === "number" ? `[run ${safeCtx.runId}] ${event}` : event;
  const tail = Object.entries(safeCtx)
    .filter(([k, v]) => k !== "runId" && v !== undefined)
    .map(([k, v]) => {
      const raw = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
      return `${k}=${raw.slice(0, 120)}`;
    })
    .join(" ");
  console.log(head + (tail ? " " + tail : ""));
}

export const LOG_FILE = LOG_PATH;
