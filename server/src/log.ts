import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const LOG_PATH = "data/tickle.log";
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB → rotate to .1

mkdirSync(dirname(LOG_PATH), { recursive: true });

export type LogContext = {
  runId?: number;
  [key: string]: unknown;
};

function rotateIfNeeded() {
  try {
    const s = statSync(LOG_PATH);
    if (s.size >= MAX_BYTES) {
      if (existsSync(`${LOG_PATH}.1`)) {
        // overwrite the older rotated file
      }
      renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch {
    // file doesn't exist yet — nothing to rotate
  }
}

/** Write a structured trace line. Mirrored to stdout for live tail in the dev terminal. */
export function trace(event: string, ctx: LogContext = {}): void {
  rotateIfNeeded();
  const entry = { t: new Date().toISOString(), event, ...ctx };
  const line = JSON.stringify(entry) + "\n";
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // disk full or permissions — don't crash the agent for log failure
  }
  // Compact console form for live tail
  const head = ctx.runId !== undefined ? `[run ${ctx.runId}] ${event}` : event;
  const tail = Object.entries(ctx)
    .filter(([k, v]) => k !== "runId" && v !== undefined)
    .map(([k, v]) => {
      const raw = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
      return `${k}=${raw.slice(0, 120)}`;
    })
    .join(" ");
  console.log(head + (tail ? " " + tail : ""));
}

export const LOG_FILE = LOG_PATH;
