import { describe, expect, it } from "vitest";
import { moveBlockInTree } from "../components/BlockList.tsx";
import type { Block, ForEachBlock } from "../blocks.ts";

// docs/specs/web/block-list.md
//
// moveBlockInTree relocates a single block by id from anywhere in a
// (possibly nested) tree to a target position inside the children of
// `parentBlockId` (or the root array when null). Refuses to drop a
// for_each into itself or its own descendants.

function nav(id: string, url = "https://x"): Block {
  return { id, kind: "navigate", url };
}

function fe(id: string, body: Block[]): ForEachBlock {
  return { id, kind: "for_each", items: "$xs", item_var: "x", body };
}

describe("moveBlockInTree — within the root array", () => {
  it("moves a block forward by one position", () => {
    const tree: Block[] = [nav("a"), nav("b"), nav("c")];
    const next = moveBlockInTree(tree, "a", null, 2);
    expect(next.map((b) => b.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a block backward (insert before earlier index)", () => {
    const tree: Block[] = [nav("a"), nav("b"), nav("c")];
    const next = moveBlockInTree(tree, "c", null, 0);
    expect(next.map((b) => b.id)).toEqual(["c", "a", "b"]);
  });

  it("moving to the same effective position is a no-op (still produces a new tree)", () => {
    const tree: Block[] = [nav("a"), nav("b"), nav("c")];
    const next = moveBlockInTree(tree, "b", null, 1);
    expect(next.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("moveBlockInTree — into a for_each.body", () => {
  it("moves a root block into the body of a for_each", () => {
    const tree: Block[] = [nav("a"), fe("loop", [nav("x"), nav("y")])];
    const next = moveBlockInTree(tree, "a", "loop", 1);
    expect(next).toHaveLength(1);
    const loop = next[0] as ForEachBlock;
    expect(loop.body.map((b) => b.id)).toEqual(["x", "a", "y"]);
  });

  it("moves a block out of a for_each body to root", () => {
    const tree: Block[] = [nav("a"), fe("loop", [nav("x"), nav("y")])];
    const next = moveBlockInTree(tree, "y", null, 1);
    expect(next.map((b) => b.id)).toEqual(["a", "y", "loop"]);
    const loop = next[2] as ForEachBlock;
    expect(loop.body.map((b) => b.id)).toEqual(["x"]);
  });

  it("reorders within a nested for_each body", () => {
    const tree: Block[] = [fe("loop", [nav("x"), nav("y"), nav("z")])];
    const next = moveBlockInTree(tree, "z", "loop", 0);
    const loop = next[0] as ForEachBlock;
    expect(loop.body.map((b) => b.id)).toEqual(["z", "x", "y"]);
  });
});

describe("moveBlockInTree — cycle prevention", () => {
  it("refuses to drop a for_each into its own body (would create a cycle)", () => {
    const tree: Block[] = [fe("loop", [nav("x")])];
    const next = moveBlockInTree(tree, "loop", "loop", 0);
    expect(next).toBe(tree);
  });

  it("refuses to drop a for_each into a descendant for_each", () => {
    const tree: Block[] = [fe("outer", [fe("inner", [nav("x")])])];
    const next = moveBlockInTree(tree, "outer", "inner", 0);
    expect(next).toBe(tree);
  });

  it("permits dropping a for_each into a SIBLING for_each (no cycle)", () => {
    const tree: Block[] = [fe("a", [nav("x")]), fe("b", [])];
    const next = moveBlockInTree(tree, "a", "b", 0);
    expect(next).toHaveLength(1);
    const b = next[0] as ForEachBlock;
    expect(b.id).toBe("b");
    expect(b.body.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("moveBlockInTree — unknown sourceId", () => {
  it("returns the original tree unchanged when sourceId is missing", () => {
    const tree: Block[] = [nav("a"), nav("b")];
    const next = moveBlockInTree(tree, "missing", null, 0);
    expect(next).toBe(tree);
  });
});
