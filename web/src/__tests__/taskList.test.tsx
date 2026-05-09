import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskList } from "../components/TaskList.tsx";
import { UiPromptsProvider } from "../components/UiPrompts.tsx";
import type { Task } from "../api.ts";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    name: "Buy milk",
    instruction: "go to the store",
    steps: null,
    created_at: "2026-05-09 12:00:00",
    ...over,
  };
}

function renderList(props: {
  tasks: Task[];
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  onCreate?: () => void;
  onDelete?: (id: number) => void;
}) {
  const onSelect = props.onSelect ?? vi.fn();
  const onCreate = props.onCreate ?? vi.fn();
  const onDelete = props.onDelete ?? vi.fn();
  const utils = render(
    <UiPromptsProvider>
      <TaskList
        tasks={props.tasks}
        selectedId={props.selectedId ?? null}
        onSelect={onSelect}
        onCreate={onCreate}
        onDelete={onDelete}
      />
    </UiPromptsProvider>,
  );
  return { ...utils, onSelect, onCreate, onDelete };
}

describe("TaskList", () => {
  it("shows the empty-state copy when no tasks exist", () => {
    renderList({ tasks: [] });
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("renders each task's name", () => {
    renderList({
      tasks: [makeTask({ id: 1, name: "Alpha" }), makeTask({ id: 2, name: "Beta" })],
    });
    expect(screen.getByRole("button", { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /beta/i })).toBeInTheDocument();
  });

  it("renders \"(untitled)\" as a fallback when a task name is empty", () => {
    renderList({ tasks: [makeTask({ id: 9, name: "" })] });
    expect(screen.getByRole("button", { name: /\(untitled\)/i })).toBeInTheDocument();
  });

  it("highlights the selected task with the active class", () => {
    renderList({
      tasks: [makeTask({ id: 1, name: "Alpha" }), makeTask({ id: 2, name: "Beta" })],
      selectedId: 2,
    });
    // Only the selected row carries the bg-zinc-800 modifier.
    const beta = screen.getByRole("button", { name: /beta/i }).parentElement;
    const alpha = screen.getByRole("button", { name: /alpha/i }).parentElement;
    expect(beta?.className).toMatch(/bg-zinc-800/);
    expect(alpha?.className).not.toMatch(/bg-zinc-800/);
  });

  it("calls onSelect when a task row is clicked", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderList({ tasks: [makeTask({ id: 7, name: "Pick me" })] });
    await user.click(screen.getByRole("button", { name: /pick me/i }));
    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it("calls onCreate when the + New task button is clicked", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderList({ tasks: [] });
    await user.click(screen.getByRole("button", { name: /\+ new task/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("clicking the X opens the UiPrompts confirm dialog and confirming calls onDelete", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderList({
      tasks: [makeTask({ id: 5, name: "Doomed" })],
    });
    // The delete button has aria-label "Delete".
    await user.click(screen.getByRole("button", { name: "Delete" }));
    // The confirm dialog mounts with role="dialog" and a Delete button
    // (since destructive: true was passed).
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/delete "doomed"\?/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalledWith(5);
  });

  it("clicking Cancel in the confirm dialog leaves onDelete uncalled", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderList({
      tasks: [makeTask({ id: 5, name: "Safe" })],
    });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(onDelete).not.toHaveBeenCalled();
  });
});
