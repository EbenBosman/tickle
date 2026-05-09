import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// docs/specs/server/persistence.md
//
// addLesson writes to two tables: `lessons` and the FTS5 mirror
// `lessons_fts`. Before the transaction wrap, a crash between the two
// could leave the mirror desynced. These tests exercise the wrap.

const originalDbPath = process.env.TICKLE_DB_PATH;
type DbModule = typeof import("../db.ts");
let dbm: DbModule;

beforeEach(async () => {
  process.env.TICKLE_DB_PATH = ":memory:";
  vi.resetModules();
  dbm = await import("../db.ts");
});

afterEach(() => {
  if (originalDbPath === undefined) delete process.env.TICKLE_DB_PATH;
  else process.env.TICKLE_DB_PATH = originalDbPath;
});

describe("addLesson — happy path writes both tables", () => {
  it("inserts a row in lessons AND in lessons_fts", () => {
    dbm.addLesson(null, null, "use the back button to retry", null);
    const main = dbm.db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number };
    const fts = dbm.db.prepare("SELECT COUNT(*) AS n FROM lessons_fts").get() as { n: number };
    expect(main.n).toBe(1);
    expect(fts.n).toBe(1);
  });

  it("the FTS rowid mirrors the lessons.id (so JOIN works in searchLessons)", () => {
    dbm.addLesson(null, null, "alpha", null);
    dbm.addLesson(null, null, "beta", null);
    const ids = dbm.db.prepare("SELECT id FROM lessons ORDER BY id").all() as { id: number }[];
    const ftsRowids = dbm.db
      .prepare("SELECT rowid FROM lessons_fts ORDER BY rowid")
      .all() as { rowid: number }[];
    expect(ftsRowids.map((r) => r.rowid)).toEqual(ids.map((i) => i.id));
  });
});

describe("addLesson — rollback on FTS insert failure", () => {
  it("rolls back the lessons row when the FTS insert fails", () => {
    // Drop the FTS table to force the second INSERT to throw. Without
    // the transaction wrap, the lessons row would survive — that's the
    // bug we're guarding against.
    dbm.db.exec("DROP TABLE lessons_fts");
    expect(() => dbm.addLesson(null, null, "this should rollback", null)).toThrow();
    const count = dbm.db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number };
    expect(count.n).toBe(0);
  });
});
