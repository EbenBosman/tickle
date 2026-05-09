import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { TaskEditor } from "../components/TaskEditor.tsx";
import { UiPromptsProvider } from "../components/UiPrompts.tsx";
import type { Task } from "../api.ts";

// TaskEditor renders CompileFromText which calls useUiPrompts(). Wrap
// every render in the real provider so the hook resolves.
function renderInProvider(ui: ReactElement) {
  return render(<UiPromptsProvider>{ui}</UiPromptsProvider>);
}

// Mock the api module so updateTask / compileBlocks don't hit fetch.
vi.mock("../api.ts", async () => {
  const actual = await vi.importActual<typeof import("../api.ts")>("../api.ts");
  return {
    ...actual,
    api: {
      updateTask: vi.fn().mockResolvedValue({ id: 1 }),
      compileBlocks: vi.fn().mockResolvedValue({ blocks: [] }),
    },
  };
});

import { api } from "../api.ts";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    name: "My task",
    instruction: "",
    steps: null,
    created_at: "2026-05-09 12:00:00",
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(api.updateTask).mockClear();
  vi.mocked(api.compileBlocks).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TaskEditor", () => {
  it("prefills the name input from task.name", () => {
    renderInProvider(<TaskEditor task={makeTask({ name: "Hello" })} onSaved={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByDisplayValue("Hello")).toBeInTheDocument();
  });

  it("Run button is disabled when there are no blocks", () => {
    renderInProvider(<TaskEditor task={makeTask({ steps: "[]" })} onSaved={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^run$/i })).toBeDisabled();
  });

  it("Run button is disabled when runningBlockId is set, even with blocks present", () => {
    renderInProvider(
      <TaskEditor
        task={makeTask({
          steps: JSON.stringify([{ id: "x", kind: "navigate", url: "https://example.com" }]),
        })}
        onSaved={vi.fn()}
        onRun={vi.fn()}
        runningBlockId="x"
      />,
    );
    expect(screen.getByRole("button", { name: /^run$/i })).toBeDisabled();
  });

  it("Run button is enabled when blocks exist and nothing is running", () => {
    renderInProvider(
      <TaskEditor
        task={makeTask({
          steps: JSON.stringify([{ id: "x", kind: "navigate", url: "https://example.com" }]),
        })}
        onSaved={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^run$/i })).not.toBeDisabled();
  });

  it("editing the name marks the editor dirty and enables Save", async () => {
    const user = userEvent.setup();
    renderInProvider(<TaskEditor task={makeTask({ name: "Original" })} onSaved={vi.fn()} onRun={vi.fn()} />);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    const input = screen.getByDisplayValue("Original");
    await user.clear(input);
    await user.type(input, "Renamed");
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it("clicking Save calls api.updateTask with the new name and onSaved", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderInProvider(<TaskEditor task={makeTask({ name: "Original" })} onSaved={onSaved} onRun={vi.fn()} />);
    const input = screen.getByDisplayValue("Original");
    await user.clear(input);
    await user.type(input, "Edited");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(api.updateTask).toHaveBeenCalledTimes(1);
    expect(api.updateTask).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: "Edited" }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("clicking Run with unsaved changes saves first, then triggers onRun", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    renderInProvider(
      <TaskEditor
        task={makeTask({
          name: "T",
          steps: JSON.stringify([{ id: "x", kind: "navigate", url: "https://example.com" }]),
        })}
        onSaved={vi.fn()}
        onRun={onRun}
      />,
    );
    const input = screen.getByDisplayValue("T");
    await user.type(input, "2");
    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(api.updateTask).toHaveBeenCalled();
    expect(onRun).toHaveBeenCalled();
  });
});
