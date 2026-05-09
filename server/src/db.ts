import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "data/tickle.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

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
  status      TEXT NOT NULL,
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

// Migration: add `steps` column on existing DBs that pre-date it.
const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
if (!taskCols.some((c) => c.name === "steps")) {
  db.exec("ALTER TABLE tasks ADD COLUMN steps TEXT");
}

// On every process start, sweep any rows still marked `running`. They can only
// be from a previous process lifetime — tsx-watch reload, crash, OS restart —
// because a clean shutdown updates them in runAgent's finally block. Without
// this sweep, the cancel button on those zombie rows returns 404 forever.
const sweptRunning = db
  .prepare(
    "UPDATE runs SET status='cancelled', error='Stale — server restarted before run completed', finished_at=? WHERE status='running'",
  )
  .run(new Date().toISOString());
if (sweptRunning.changes > 0) {
  console.log(
    `[db] swept ${sweptRunning.changes} stale running run${sweptRunning.changes === 1 ? "" : "s"} from previous process`,
  );
}

export type Task = {
  id: number;
  name: string;
  instruction: string;
  steps: string | null;
  created_at: string;
};

export type Run = {
  id: number;
  task_id: number;
  status: "running" | "done" | "error" | "cancelled";
  result: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type Step = {
  id: number;
  run_id: number;
  idx: number;
  kind: "thought" | "tool_call" | "tool_result" | "error" | "final";
  payload: string;
  screenshot_path: string | null;
  created_at: string;
};

// ── Settings ────────────────────────────────────────────────

const SETTING_DEFAULTS: Record<string, string> = {
  rescue_enabled: "false",
  rescue_model: "claude-sonnet-4-6",
  rescue_on_cancel: "false",
};

for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// ── Lessons ─────────────────────────────────────────────────

export type Lesson = {
  id: number;
  run_id: number | null;
  block_id: string | null;
  lesson: string;
  situation: string | null;
  created_at: string;
};

export function addLesson(
  runId: number | null,
  blockId: string | null,
  lesson: string,
  situation: string | null,
): void {
  const row = db
    .prepare("INSERT INTO lessons (run_id, block_id, lesson, situation) VALUES (?, ?, ?, ?)")
    .run(runId, blockId, lesson, situation) as { lastInsertRowid: number };
  const rowid = row.lastInsertRowid;
  db.prepare("INSERT INTO lessons_fts (rowid, lesson, situation) VALUES (?, ?, ?)").run(
    rowid,
    lesson,
    situation ?? "",
  );
}

export function searchLessons(query: string, limit = 5): Lesson[] {
  if (!query.trim()) {
    return db.prepare("SELECT * FROM lessons ORDER BY id DESC LIMIT ?").all(limit) as Lesson[];
  }
  // FTS5 match; fall back to recency on error (e.g. query syntax issues)
  try {
    const rows = db
      .prepare(
        `SELECT l.* FROM lessons l
         JOIN lessons_fts f ON l.id = f.rowid
         WHERE lessons_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query.replace(/[^\w\s]/g, " "), limit) as Lesson[];
    if (rows.length > 0) return rows;
  } catch {
    // fall through
  }
  return db.prepare("SELECT * FROM lessons ORDER BY id DESC LIMIT ?").all(limit) as Lesson[];
}

export function listLessons(offset = 0, limit = 50): { lessons: Lesson[]; total: number } {
  const total = (db.prepare("SELECT COUNT(*) as n FROM lessons").get() as { n: number }).n;
  const lessons = db
    .prepare("SELECT * FROM lessons ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as Lesson[];
  return { lessons, total };
}
