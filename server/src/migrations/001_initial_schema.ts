import type { DatabaseSync } from "node:sqlite";

/**
 * Initial schema migration. Captures the state of the DB up to and
 * including the `runs.status CHECK` constraint and the matching
 * INSERT/UPDATE triggers. Idempotent on existing DBs that pre-date the
 * migrations framework — every statement uses `IF NOT EXISTS`.
 */
export function initialSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      instruction TEXT NOT NULL,
      steps       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status      TEXT NOT NULL CHECK (status IN ('running', 'done', 'error', 'cancelled')),
      result      TEXT,
      error       TEXT,
      started_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS steps (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      idx             INTEGER NOT NULL,
      kind            TEXT NOT NULL,
      payload         TEXT NOT NULL,
      screenshot_path TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, idx);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lessons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER,
      block_id   TEXT,
      lesson     TEXT NOT NULL,
      situation  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lessons_run ON lessons(run_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
      lesson,
      situation,
      content='lessons',
      content_rowid='id'
    );
  `);

  // Lazy column add for tasks.steps on DBs that pre-date that field.
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  if (!taskCols.some((c) => c.name === "steps")) {
    db.exec("ALTER TABLE tasks ADD COLUMN steps TEXT");
  }

  // CHECK constraint above only applies to fresh tables. Triggers cover
  // existing DBs where SQLite can't ALTER a CHECK in.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS runs_status_check_insert
      BEFORE INSERT ON runs
      WHEN NEW.status NOT IN ('running', 'done', 'error', 'cancelled')
      BEGIN SELECT RAISE(ABORT, 'invalid runs.status: must be running|done|error|cancelled'); END;

    CREATE TRIGGER IF NOT EXISTS runs_status_check_update
      BEFORE UPDATE OF status ON runs
      WHEN NEW.status NOT IN ('running', 'done', 'error', 'cancelled')
      BEGIN SELECT RAISE(ABORT, 'invalid runs.status: must be running|done|error|cancelled'); END;
  `);
}
