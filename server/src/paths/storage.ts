import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Anchored storage paths.
 *
 * The server used to resolve `data/profile` and `screenshots` against
 * `process.cwd()`, which silently misbehaved when the server was launched
 * from anywhere other than `server/`. We now anchor every storage path
 * to the location of this module so the same paths are produced no matter
 * where the process is launched from.
 *
 * Both directories can be overridden by env var:
 *   - TICKLE_PROFILE_DIR — Chromium persistent profile
 *   - TICKLE_SHOTS_DIR   — per-run screenshot output
 *
 * Absolute env values are used as-is. Relative env values are resolved
 * against the server module root (the `server/` directory) — NOT the cwd.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/paths/storage.ts -> ../.. is server/
const SERVER_DIR = resolve(HERE, "..", "..");

export function envPath(envVar: string, defaultRel: string): string {
  const v = process.env[envVar];
  if (v && v.length > 0) {
    return isAbsolute(v) ? v : resolve(SERVER_DIR, v);
  }
  return resolve(SERVER_DIR, defaultRel);
}

/**
 * Default for SHOTS_DIR is "screenshots" (not "data/screenshots") to match
 * the existing on-disk layout and the path used by routes/runs.ts and
 * paths.ts. Aligning those references is a separate commit.
 */
export const PROFILE_DIR = envPath("TICKLE_PROFILE_DIR", "data/profile");
export const SHOTS_DIR = envPath("TICKLE_SHOTS_DIR", "screenshots");

export const __SERVER_DIR_FOR_TEST = SERVER_DIR;
