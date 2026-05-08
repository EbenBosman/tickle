import { describe, expect, it } from "vitest";
import {
  type Block,
  type ForEachBlock,
  countBlocks,
  instructionToBlocks,
  newBlock,
  parseBlocks,
  substituteVars,
  walkBlocks,
} from "../blocks.ts";

// docs/specs/server/blocks.md
//
// blocks.ts is pure — no side effects, no mocks needed. Tests assert
// the documented contract. Where the spec flags drift (e.g. parseBlocks
// asymmetry, substituteVars non-string handling), tests capture
// CURRENT behaviour and comment-link the drift.

describe("newBlock — defaults per kind", () => {
  it("produces a unique id and the requested kind for every BlockKind", () => {
    const kinds = [
      "navigate",
      "goal",
      "pause",
      "click",
      "fill",
      "extract",
      "verify",
      "questionnaire",
      "for_each",
    ] as const;
    const ids = new Set<string>();
    for (const kind of kinds) {
      const b = newBlock(kind);
      expect(b.kind).toBe(kind);
      expect(b.id).toMatch(/^[0-9a-f-]+$/i);
      ids.add(b.id);
    }
    expect(ids.size).toBe(kinds.length);
  });

  it("seeds for_each with an empty body and item_var=item", () => {
    const b = newBlock("for_each") as ForEachBlock;
    expect(b.body).toEqual([]);
    expect(b.item_var).toBe("item");
  });

  it("seeds verify with on_fail=halt", () => {
    const b = newBlock("verify");
    if (b.kind !== "verify") throw new Error("wrong kind");
    expect(b.on_fail).toBe("halt");
  });
});

describe("instructionToBlocks", () => {
  it("wraps a free-text instruction into a single goal block", () => {
    const [b] = instructionToBlocks("buy milk");
    if (b.kind !== "goal") throw new Error("wrong kind");
    expect(b.description).toBe("buy milk");
  });

  it("trims surrounding whitespace from the instruction", () => {
    const [b] = instructionToBlocks("  hello  ");
    if (b.kind !== "goal") throw new Error("wrong kind");
    expect(b.description).toBe("hello");
  });
});

describe("parseBlocks — happy path", () => {
  it("returns the array when JSON parses to a Block[]", () => {
    const blocks: Block[] = [{ id: "x", kind: "navigate", url: "https://example.com" }];
    expect(parseBlocks(JSON.stringify(blocks))).toEqual(blocks);
  });

  it("returns [] when json is null/undefined and no fallback", () => {
    expect(parseBlocks(null)).toEqual([]);
    expect(parseBlocks(undefined)).toEqual([]);
    expect(parseBlocks("")).toEqual([]);
  });

  it("falls back to instructionToBlocks when json is null AND fallback provided", () => {
    const result = parseBlocks(null, "buy milk");
    expect(result).toHaveLength(1);
    if (result[0].kind !== "goal") throw new Error("wrong kind");
    expect(result[0].description).toBe("buy milk");
  });
});

describe("parseBlocks — defensive paths (current behaviour, see spec drift §6)", () => {
  it("returns [] when JSON parses to a NON-array, even if fallback provided", () => {
    // ⚠️ Drift per docs/specs/server/blocks.md §6: non-array drops fallback
    // while malformed JSON uses it. Documented asymmetry; pinning current
    // behaviour so a future fix is observable.
    expect(parseBlocks('{"not":"an array"}', "buy milk")).toEqual([]);
  });

  it("falls back to instructionToBlocks when JSON is malformed", () => {
    const result = parseBlocks("not json{{{", "buy milk");
    expect(result).toHaveLength(1);
    if (result[0].kind !== "goal") throw new Error("wrong kind");
    expect(result[0].description).toBe("buy milk");
  });

  it("returns [] when json is malformed AND fallback is empty/whitespace", () => {
    expect(parseBlocks("not json", "")).toEqual([]);
    expect(parseBlocks("not json", "   ")).toEqual([]);
  });
});

describe("substituteVars — pass-through", () => {
  it("returns input unchanged when there is no $ at all", () => {
    expect(substituteVars("hello world", new Map())).toBe("hello world");
  });

  it("leaves literal $ when not followed by a valid identifier", () => {
    // Regex requires [a-zA-Z_][a-zA-Z0-9_]*
    expect(substituteVars("price is $99", new Map())).toBe("price is $99");
    expect(substituteVars("dollar $", new Map())).toBe("dollar $");
  });

  it("leaves $name literal when name is not in the Map", () => {
    expect(substituteVars("hi $stranger", new Map())).toBe("hi $stranger");
  });
});

describe("substituteVars — replacement", () => {
  it("substitutes a string variable", () => {
    const vars = new Map<string, unknown>([["name", "Alice"]]);
    expect(substituteVars("hi $name", vars)).toBe("hi Alice");
  });

  it("JSON-stringifies non-string variables", () => {
    const vars = new Map<string, unknown>([
      ["count", 42],
      ["items", [1, 2, 3]],
      ["meta", { ok: true }],
    ]);
    expect(substituteVars("$count", vars)).toBe("42");
    expect(substituteVars("$items", vars)).toBe("[1,2,3]");
    expect(substituteVars("$meta", vars)).toBe('{"ok":true}');
  });

  it("substitutes multiple references in one input", () => {
    const vars = new Map<string, unknown>([
      ["a", "X"],
      ["b", "Y"],
    ]);
    expect(substituteVars("$a-$b-$a", vars)).toBe("X-Y-X");
  });

  it("substitutes adjacent references without separator", () => {
    const vars = new Map<string, unknown>([
      ["a", "X"],
      ["b", "Y"],
    ]);
    expect(substituteVars("$a$b", vars)).toBe("XY");
  });

  it("recognises identifiers with underscores and digits (after the first char)", () => {
    const vars = new Map<string, unknown>([
      ["_a", "first"],
      ["x1", "second"],
      ["snake_case_var", "third"],
    ]);
    expect(substituteVars("$_a $x1 $snake_case_var", vars)).toBe("first second third");
  });

  it("captures current-behaviour: an explicitly-set undefined value substitutes as the literal string \"undefined\"", () => {
    // ⚠️ Drift per docs/specs/server/blocks.md §6: setting undefined into
    // the Map differs from leaving the key absent. Pinning current
    // behaviour so the fix path is observable.
    const vars = new Map<string, unknown>([["v", undefined]]);
    expect(substituteVars("$v", vars)).toBe("undefined");
  });
});

describe("walkBlocks / countBlocks", () => {
  function navigate(id: string, url = "https://x"): Block {
    return { id, kind: "navigate", url };
  }
  function forEach(id: string, body: Block[]): ForEachBlock {
    return { id, kind: "for_each", items: "$xs", item_var: "x", body };
  }

  it("countBlocks is 0 for an empty list", () => {
    expect(countBlocks([])).toBe(0);
  });

  it("countBlocks counts each top-level block once", () => {
    expect(countBlocks([navigate("a"), navigate("b")])).toBe(2);
  });

  it("countBlocks recurses into for_each.body", () => {
    const blocks = [
      navigate("a"),
      forEach("loop", [navigate("a1"), navigate("a2")]),
      navigate("b"),
    ];
    expect(countBlocks(blocks)).toBe(5); // 1 + (1 + 2) + 1
  });

  it("walkBlocks visits every block depth-first, parent before children", () => {
    const blocks = [
      navigate("a"),
      forEach("loop", [navigate("a1"), navigate("a2")]),
      navigate("b"),
    ];
    const seen: string[] = [];
    walkBlocks(blocks, (b) => seen.push(b.id));
    expect(seen).toEqual(["a", "loop", "a1", "a2", "b"]);
  });

  it("walkBlocks handles nested for_each", () => {
    const blocks = [forEach("outer", [forEach("inner", [navigate("leaf")])])];
    const seen: string[] = [];
    walkBlocks(blocks, (b) => seen.push(b.id));
    expect(seen).toEqual(["outer", "inner", "leaf"]);
  });
});
