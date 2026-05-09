import { resolve, sep } from "node:path";
import { SHOTS_DIR } from "./paths/storage.ts";

/**
 * Filesystem-resolution helpers shared between routes.
 *
 * SCREENSHOTS_DIR is anchored via `paths/storage.ts::SHOTS_DIR` (which
 * uses `import.meta.url` to point at `<server>/data/screenshots` regardless
 * of the launch cwd, with `TICKLE_SHOTS_DIR` env override).
 */
export const SCREENSHOTS_DIR = SHOTS_DIR;

/**
 * Resolve a path under `SCREENSHOTS_DIR` if and only if:
 *   1. The resolved absolute path stays inside `SCREENSHOTS_DIR`
 *      (no traversal via `..`, no absolute path takeover).
 *   2. The resolved path ends in `.png` (case-sensitive — we do not
 *      want `.PNG` paths from disk to be matched on case-insensitive
 *      filesystems and miss on case-sensitive ones).
 *
 * Returns `null` for any unsafe input. The caller should reply 404 on
 * `null` — never echo back why, never serve a fallback.
 *
 * The check is independent of whether the file actually exists on disk;
 * existence is a separate concern that the route handles via
 * `existsSync` after this returns a non-null path.
 */
export function safeResolveScreenshot(rest: string): string | null {
  if (!rest?.endsWith(".png")) return null;
  const base = resolve(SCREENSHOTS_DIR);
  const candidate = resolve(SCREENSHOTS_DIR, rest);
  // Separator-boundary guard: e.g. base = /tmp/screenshots; candidate
  // /tmp/screenshotsX/foo.png shares the prefix string but is a sibling
  // dir. Requiring `base + sep` rejects that.
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  return candidate;
}
