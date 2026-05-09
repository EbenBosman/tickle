import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Minimal .env loader. Lives in its own module so it runs BEFORE other imports
 * in index.ts evaluate — module evaluation order in ES modules is dependency
 * order, so importing this file first guarantees process.env is populated
 * before llm.ts captures MODEL/LLM_BASE_URL into its module-level constants.
 *
 * Path resolution: anchored to this module's location (server/src/loadEnv.ts)
 * rather than process.cwd(), so launching the server from anywhere — repo
 * root, server/, or some other directory — finds the same .env file.
 *
 * Lookup order:
 *   1. <server>/.env       (the canonical location, server/.env.example)
 *   2. <repo-root>/.env    (fallback for users who put it at the repo top)
 * Stops at the first file that exists. Missing files are silently skipped.
 * Permission/IO errors (EACCES, EISDIR, etc.) are logged via console.error
 * and the loader moves on — never throws, so a misconfigured file cannot
 * crash startup before normal logging is up.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// server/src/loadEnv.ts -> ../ is server/
const SERVER_DIR = resolve(HERE, "..");
// server/ -> ../ is the repo root
const REPO_ROOT = resolve(SERVER_DIR, "..");

const CANDIDATES = [resolve(SERVER_DIR, ".env"), resolve(REPO_ROOT, ".env")];

function readCandidate(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[loadEnv] failed to read ${path}: ${reason}`);
    return null;
  }
}

function applyEnv(content: string): void {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

for (const candidate of CANDIDATES) {
  const content = readCandidate(candidate);
  if (content === null) continue;
  applyEnv(content);
  break;
}
