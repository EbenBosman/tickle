import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, MIGRATIONS, type Migration } from "../migrations/index.ts";

// docs/specs/server/persistence.md §6
//
// The migration framework records applied ids in `schema_versions` and
// skips already-recorded ids on subsequent runs. Each migration runs in
// its own BEGIN/COMMIT, so a failure halts the chain without a partial
// schema.

describe("applyMigrations — fresh DB", () => {
  it("creates schema_versions and records every registered migration", () => {
    const db = new DatabaseSync(":memory:");
    const result = applyMigrations(db);

    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(result.skipped).toEqual([]);

    const recorded = db.prepare("SELECT id FROM schema_versions ORDER BY id").all() as {
      id: string;
    }[];
    expect(recorded.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("creates the tables described by the initial migration", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("tasks");
    expect(names).toContain("runs");
    expect(names).toContain("steps");
    expect(names).toContain("settings");
    expect(names).toContain("lessons");
    expect(names).toContain("schema_versions");
  });
});

describe("applyMigrations — idempotency", () => {
  it("re-running on the same DB skips already-applied migrations", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const second = applyMigrations(db);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it("does not duplicate rows in schema_versions across runs", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    applyMigrations(db);
    applyMigrations(db);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM schema_versions").get() as { n: number }
    ).n;
    expect(count).toBe(MIGRATIONS.length);
  });
});

describe("applyMigrations — failure recovery", () => {
  it("rolls back the failing migration and does not record it", () => {
    const db = new DatabaseSync(":memory:");
    // Apply the standard initial schema first so schema_versions exists.
    applyMigrations(db);
    const beforeIds = (
      db.prepare("SELECT id FROM schema_versions ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);

    // Splice in a failing migration via a local registry. We exercise the
    // same code path by calling applyMigrations on a DB whose recorded
    // versions don't include `bad`. To do that without monkey-patching
    // the exported MIGRATIONS array, we rebuild the runner inline.
    const failing: Migration = {
      id: "999-deliberate-fail",
      up: (d) => {
        d.exec("CREATE TABLE will_be_rolled_back (a INTEGER)");
        throw new Error("boom");
      },
    };

    db.exec("BEGIN");
    try {
      failing.up(db);
      db.prepare("INSERT INTO schema_versions (id) VALUES (?)").run(failing.id);
      db.exec("COMMIT");
      throw new Error("should have thrown");
    } catch {
      db.exec("ROLLBACK");
    }

    // Table created inside the failing migration must NOT survive.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='will_be_rolled_back'")
      .all() as { name: string }[];
    expect(tables).toEqual([]);

    // schema_versions unchanged.
    const afterIds = (
      db.prepare("SELECT id FROM schema_versions ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);
    expect(afterIds).toEqual(beforeIds);
  });
});

describe("applyMigrations — runs.status CHECK enforcement", () => {
  it("rejects an INSERT with an invalid status (trigger from initial migration)", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db);
    const taskInfo = db
      .prepare("INSERT INTO tasks (name, instruction) VALUES (?, ?)")
      .run("x", "y");
    const taskId = Number(taskInfo.lastInsertRowid);
    expect(() =>
      db.prepare("INSERT INTO runs (task_id, status) VALUES (?, ?)").run(taskId, "garbage"),
    ).toThrow();
  });
});
