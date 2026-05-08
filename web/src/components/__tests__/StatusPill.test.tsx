import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "../StatusPill.tsx";

// docs/specs/web/ui-primitives.md §2 StatusPill
//
// StatusPill is the canonical mapping from RunStatus (plus the synthetic
// "paused") to colour classes. If a status not in the table arrives, the
// pill renders with a grey fallback — that is the "drift signal".

const COLOURS: Record<string, string> = {
  running: "blue",
  paused: "amber",
  done: "emerald",
  error: "red",
  cancelled: "amber",
};

describe("StatusPill — known statuses", () => {
  for (const [status, family] of Object.entries(COLOURS)) {
    it(`renders the ${status} status with the ${family} colour family`, () => {
      render(<StatusPill status={status} />);
      const pill = screen.getByText(status);
      // We assert the colour-family token, not the full Tailwind class
      // string. Class shape is a UI implementation detail; the family is
      // the contract.
      expect(pill.className).toContain(`text-${family}-300`);
      expect(pill.className).toContain(`border-${family}-500/30`);
    });
  }
});

describe("StatusPill — unknown status", () => {
  it("falls back to the grey/zinc family for an unknown status", () => {
    render(<StatusPill status="exploded" />);
    const pill = screen.getByText("exploded");
    expect(pill.className).toContain("text-zinc-300");
  });

  it("renders the literal status text in upper-case styling (uppercase class)", () => {
    render(<StatusPill status="running" />);
    const pill = screen.getByText("running");
    expect(pill.className).toContain("uppercase");
  });
});
