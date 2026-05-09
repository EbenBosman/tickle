import { describe, expect, it } from "vitest";
import {
  type Block,
  type BlockKind,
  type ForEachBlock,
  BLOCK_KINDS,
  blockMeta,
  newBlock,
  summaryOf,
} from "../blocks.ts";

// docs/specs/web/blocks.md
//
// web/src/blocks.ts mirrors the server's Block union and adds UI
// metadata (label/icon/color) plus a UI-ordered list. The mirroring
// is the main drift surface — server/web parity is enforced here.

const ALL_KINDS: BlockKind[] = [
  "navigate",
  "goal",
  "pause",
  "click",
  "fill",
  "extract",
  "verify",
  "questionnaire",
  "for_each",
];

describe("newBlock — defaults per kind", () => {
  it("produces the requested kind with a non-empty id", () => {
    for (const kind of ALL_KINDS) {
      const b = newBlock(kind);
      expect(b.kind).toBe(kind);
      expect(b.id).toBeTruthy();
      expect(typeof b.id).toBe("string");
    }
  });

  it("produces unique ids across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(newBlock("navigate").id);
    expect(ids.size).toBe(50);
  });

  it("seeds verify with on_fail='halt'", () => {
    const b = newBlock("verify");
    if (b.kind !== "verify") throw new Error("wrong kind");
    expect(b.on_fail).toBe("halt");
  });

  it("seeds questionnaire with default unanswered_var", () => {
    const b = newBlock("questionnaire");
    if (b.kind !== "questionnaire") throw new Error("wrong kind");
    expect(b.unanswered_var).toBe("unanswered");
  });

  it("seeds for_each with empty body and item_var='item'", () => {
    const b = newBlock("for_each") as ForEachBlock;
    expect(b.body).toEqual([]);
    expect(b.item_var).toBe("item");
  });

  it("seeds click with role='any'", () => {
    const b = newBlock("click");
    if (b.kind !== "click") throw new Error("wrong kind");
    expect(b.role).toBe("any");
  });
});

describe("blockMeta — UI metadata", () => {
  it("returns a label, icon, color, and description for every kind", () => {
    for (const kind of ALL_KINDS) {
      const m = blockMeta(kind);
      expect(m.label).toBeTruthy();
      expect(m.icon).toBeTruthy();
      expect(m.color).toBeTruthy();
      expect(m.description).toBeTruthy();
    }
  });

  it("returns a fallback shape (no throw) for an unknown kind", () => {
    // Future-schema scenario: a persisted task with a kind the current
    // frontend doesn't know about. blockMeta must NOT throw on the
    // missing record.
    const m = blockMeta("future_kind_we_do_not_know");
    expect(m.label).toBe("Unknown");
    expect(m.color).toBe("zinc");
    expect(m.icon).toBeTruthy();
  });
});

describe("newBlock — id format", () => {
  it("produces RFC 4122 v4-shaped ids", () => {
    // Either crypto.randomUUID (real v4) or our fallback — both should
    // match the v4 shape: 8-4-4-4-12 hex with version 4 and variant in [8,b].
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (let i = 0; i < 10; i++) {
      expect(newBlock("navigate").id).toMatch(v4);
    }
  });
});

describe("BLOCK_KINDS — UI ordering", () => {
  it("includes every BlockKind exactly once", () => {
    expect(new Set(BLOCK_KINDS)).toEqual(new Set(ALL_KINDS));
    expect(BLOCK_KINDS.length).toBe(ALL_KINDS.length);
  });

  it("places `pause` last (UI convention: it is the breakpoint kind)", () => {
    expect(BLOCK_KINDS[BLOCK_KINDS.length - 1]).toBe("pause");
  });
});

describe("summaryOf — every kind handled", () => {
  it("returns a non-empty string for every kind", () => {
    for (const kind of ALL_KINDS) {
      const summary = summaryOf(newBlock(kind));
      expect(summary).toBeTruthy();
      expect(typeof summary).toBe("string");
    }
  });

  it("falls back gracefully when fields are empty", () => {
    expect(summaryOf({ id: "x", kind: "navigate", url: "" })).toBe("(no url)");
    expect(summaryOf({ id: "x", kind: "goal", description: "" })).toBe("(empty goal)");
    expect(summaryOf({ id: "x", kind: "verify", condition: "" })).toBe("(no condition)");
  });

  it("renders click with optional role prefix", () => {
    const noRole: Block = { id: "x", kind: "click", target: "Sign in", role: "any" };
    const withRole: Block = { id: "y", kind: "click", target: "Sign in", role: "button" };
    expect(summaryOf(noRole)).toBe("Click Sign in");
    expect(summaryOf(withRole)).toBe("Click button: Sign in");
  });

  it("truncates long goal descriptions to 200 chars", () => {
    const long = "a".repeat(300);
    const s = summaryOf({ id: "x", kind: "goal", description: long });
    expect(s.length).toBeLessThanOrEqual(200);
  });

  it("truncates long fill values to 60 chars", () => {
    const long = "v".repeat(120);
    const s = summaryOf({ id: "x", kind: "fill", target: "field", value: long });
    expect(s.length).toBeLessThan(120);
  });

  it("for_each summary includes child count", () => {
    const empty: Block = {
      id: "x",
      kind: "for_each",
      items: "$xs",
      item_var: "x",
      body: [],
    };
    const withChildren: Block = {
      id: "x",
      kind: "for_each",
      items: "$xs",
      item_var: "x",
      body: [
        { id: "a", kind: "navigate", url: "" },
        { id: "b", kind: "navigate", url: "" },
      ],
    };
    expect(summaryOf(empty)).toContain("0 sub-block");
    expect(summaryOf(withChildren)).toContain("2 sub-blocks");
  });
});
