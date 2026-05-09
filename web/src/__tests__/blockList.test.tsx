import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlockList } from "../components/BlockList.tsx";
import { newBlock, type Block, type ForEachBlock } from "../blocks.ts";

// Smoke tests for BlockList.
//
// BlockList owns drag context + tree mutation; the cycle-prevention math
// already has unit coverage in moveBlockInTree.test.ts. Here we verify
// the rendered surface: empty state, the AddBlockMenu, removal, and the
// recursive for_each body.

function renderBlockList(initial: Block[]) {
  let current = initial;
  const onChange = vi.fn((next: Block[]) => {
    current = next;
  });
  const utils = render(<BlockList blocks={current} onChange={onChange} />);
  return {
    ...utils,
    onChange,
    rerenderWith: (next: Block[]) => {
      current = next;
      utils.rerender(<BlockList blocks={current} onChange={onChange} />);
    },
    get blocks() {
      return current;
    },
  };
}

describe("BlockList", () => {
  it("renders the empty-state hint when there are no blocks", () => {
    renderBlockList([]);
    expect(screen.getByText(/no blocks yet/i)).toBeInTheDocument();
  });

  it("renders the AddBlockMenu with a button per block kind", () => {
    renderBlockList([]);
    const menu = screen.getByText(/add block/i).parentElement;
    expect(menu).not.toBeNull();
    if (!menu) return;
    // Every block kind exposes a button labelled with its meta.label.
    expect(within(menu).getByRole("button", { name: /navigate/i })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: /goal/i })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: /for each/i })).toBeInTheDocument();
  });

  it("clicking a kind button in AddBlockMenu calls onChange with one new block of that kind", async () => {
    const user = userEvent.setup();
    const { onChange } = renderBlockList([]);
    const menu = screen.getByText(/add block/i).parentElement;
    expect(menu).not.toBeNull();
    if (!menu) return;
    // The button's accessible name combines the icon and the "Navigate"
    // label; match loosely (the strict `^navigate$` form misses because
    // of the icon prefix).
    await user.click(within(menu).getByRole("button", { name: /navigate/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0].kind).toBe("navigate");
  });

  it("removing a block via the X button shrinks the list", async () => {
    const user = userEvent.setup();
    const a = newBlock("navigate");
    const b = newBlock("goal");
    const { onChange } = renderBlockList([a, b]);
    const removeButtons = screen.getAllByRole("button", { name: /✕/ });
    // Two block cards each render a remove button. We click the first.
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(b.id);
  });

  it("renders a for_each block's body as a nested list", () => {
    const inner = newBlock("navigate");
    const outer: ForEachBlock = {
      ...(newBlock("for_each") as ForEachBlock),
      items: "$titles",
      body: [inner],
    };
    renderBlockList([outer]);
    // The "Body" section header is unique to for_each.
    expect(screen.getByText(/^body$/i)).toBeInTheDocument();
    // Two AddBlockMenu instances now exist (outer + nested body).
    expect(screen.getAllByText(/add block/i)).toHaveLength(2);
  });

  it("dropping a block onto a different position reorders via onChange", () => {
    const a = newBlock("navigate");
    const b = newBlock("goal");
    const { onChange, container } = renderBlockList([a, b]);
    // Find the draggable card for `a` (the first card with role-less
    // wrapper marked draggable=true).
    const draggables = container.querySelectorAll('[draggable="true"]');
    expect(draggables.length).toBeGreaterThanOrEqual(2);
    // Start drag from the first card, drop into the trailing zone.
    fireEvent.dragStart(draggables[0]);
    // The trailing DropZone is the last empty div with the rounded class.
    const dropZones = container.querySelectorAll(".h-1\\.5");
    const last = dropZones[dropZones.length - 1];
    fireEvent.dragOver(last);
    fireEvent.drop(last);
    fireEvent.dragEnd(draggables[0]);
    expect(onChange).toHaveBeenCalled();
  });
});
