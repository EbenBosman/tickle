import type { DatabaseSync } from "node:sqlite";
import { initialSchema } from "./001_initial_schema.ts";

/**
 * Tickle's migration registry. Each entry has an `id` that's recorded in
 * `schema_versions` after its `up` runs successfully. Order matters: this
 * array is applied head-first; new migrations append to the end.
 *
 * The "initial-schema" migration is idempotent (CREATE TABLE IF NOT EXISTS
 * everywhere) so applying it to an existing DB that pre-dates this
 * framework is a no-op modulo the schema_versions row.
 */
export const MIGRATIONS: Migration[] = [{ id: "001-initial-schema", up: initialSchema }];

export type Migration = {
  /** Stable id recorded in schema_versions. Format: `NNN-kebab-name`. */
  id: string;
  /** Runs the schema change. Wrap multi-statement work in BEGIN/COMMIT. */
  up: (db: DatabaseSync) => void;
};

/**
 * Apply pending migrations to `db`. Safe to call on every process start
 * — already-applied migrations are skipped via the `schema_versions`
 * table.
 *
 * Each migration runs inside its own BEGIN/COMMIT, so a failure halts
 * the chain without leaving the DB half-migrated.
 */
export function applyMigrations(db: DatabaseSync): { applied: string[]; skipped: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied: string[] = [];
  const skipped: string[] = [];
  const recorded = new Set(
    (db.prepare("SELECT id FROM schema_versions").all() as { id: string }[]).map((r) => r.id),
  );

  for (const m of MIGRATIONS) {
    if (recorded.has(m.id)) {
      skipped.push(m.id);
      continue;
    }
    db.exec("BEGIN");
    try {
      m.up(db);
      db.prepare("INSERT INTO schema_versions (id) VALUES (?)").run(m.id);
      db.exec("COMMIT");
      applied.push(m.id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { applied, skipped };
}
