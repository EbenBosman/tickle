import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal .env loader. Lives in its own module so it runs BEFORE other imports
 * in index.ts evaluate — module evaluation order in ES modules is dependency
 * order, so importing this file first guarantees process.env is populated
 * before llm.ts captures MODEL/LLM_BASE_URL into its module-level constants.
 */
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
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
