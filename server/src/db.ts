import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StepKind } from "./domain/run.ts";
import { applyMigrations } from "./migrations/index.ts";

const DB_PATH = process.env.TICKLE_DB_PATH ?? "data/tickle.db";
if (DB_PATH !== ":memory:") {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

applyMigrations(db);

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
  kind: StepKind;
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

const insertLessonStmt = db.prepare(
  "INSERT INTO lessons (run_id, block_id, lesson, situation) VALUES (?, ?, ?, ?)",
);
const insertLessonFtsStmt = db.prepare(
  "INSERT INTO lessons_fts (rowid, lesson, situation) VALUES (?, ?, ?)",
);

export function addLesson(
  runId: number | null,
  blockId: string | null,
  lesson: string,
  situation: string | null,
): void {
  // Wrap both writes in a single transaction so the FTS5 mirror table can
  // never desync from the lessons table on a crash between the two inserts.
  // BEGIN/COMMIT auto-rolls back if anything throws.
  db.exec("BEGIN");
  try {
    const row = insertLessonStmt.run(runId, blockId, lesson, situation) as {
      lastInsertRowid: number;
    };
    insertLessonFtsStmt.run(row.lastInsertRowid, lesson, situation ?? "");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
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
