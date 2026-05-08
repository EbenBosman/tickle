import { resolve, sep } from "node:path";

/**
 * Filesystem-resolution helpers shared between routes.
 *
 * Note on cwd-relativity: `SCREENSHOTS_DIR` is "screenshots" (relative).
 * It resolves against `process.cwd()` at call time, which today means
 * the server is launched from `server/`. The Phase 4-5 refactor will
 * anchor this to the server module location (per docs/specs/server/
 * browser.md drift note); until then, callers must launch from `server/`.
 */
export const SCREENSHOTS_DIR = "screenshots";

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
  if (!rest || !rest.endsWith(".png")) return null;
  const base = resolve(SCREENSHOTS_DIR);
  const candidate = resolve(SCREENSHOTS_DIR, rest);
  // Separator-boundary guard: e.g. base = /tmp/screenshots; candidate
  // /tmp/screenshotsX/foo.png shares the prefix string but is a sibling
  // dir. Requiring `base + sep` rejects that.
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  return candidate;
}
