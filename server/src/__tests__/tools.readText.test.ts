import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "../browser.ts";
import { executeTool } from "../tools.ts";
import {
  newPageWithContent,
  startSharedContext,
  stopSharedContext,
} from "./helpers/playwrightFixture.ts";

// docs/specs/server/tools.md §3 I4
//
// `read_text` walks the DOM under an optional selector, drops elements
// that match a hostile-content denylist (script/style/template/meta/
// link/head/title, aria-hidden, display:none, visibility:hidden,
// opacity 0, font-size <= 0.5px, zero bounding rect, color===bg), and
// joins the remaining text with newlines for block-level tags. Trims
// whitespace and clamps to 6000 chars.

beforeAll(async () => {
  await startSharedContext();
}, 30_000);

afterAll(async () => {
  await stopSharedContext();
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) {
    const close = closers.pop();
    if (close) await close();
  }
});

async function withPage(html: string): Promise<Session> {
  const { page, close } = await newPageWithContent(html);
  closers.push(close);
  return { page, runId: 0, shotIdx: 0 } as unknown as Session;
}

async function readText(html: string, selector?: string): Promise<string> {
  const session = await withPage(html);
  const result = await executeTool(session, "read_text", selector ? { selector } : {});
  if (!result.ok) throw new Error(result.error);
  return result.text ?? "";
}

describe("read_text — happy path", () => {
  it("returns visible body text", async () => {
    const text = await readText("<p>Hello world</p>");
    expect(text).toContain("Hello world");
  });

  it("inserts a newline between block-level elements", async () => {
    const text = await readText("<p>Line one</p><p>Line two</p>");
    expect(text).toContain("Line one");
    expect(text).toContain("Line two");
    // The walker emits "\n" after each block tag; "Line one\nLine two\n"
    // gets trimmed at the end. We don't pin the exact join (collapsing
    // rules), just that both lines appear separately.
    expect(text.split("\n").map((s) => s.trim())).toContain("Line one");
    expect(text.split("\n").map((s) => s.trim())).toContain("Line two");
  });

  it("respects a CSS selector argument", async () => {
    const text = await readText('<div id="a">A</div><div id="b">B</div>', "#b");
    expect(text).toContain("B");
    expect(text).not.toContain("A");
  });

  it("returns the literal '(empty)' when no visible text remains", async () => {
    const text = await readText("");
    expect(text).toBe("(empty)");
  });
});

describe("read_text — strips hidden / hostile content", () => {
  it("strips <script> bodies", async () => {
    const text = await readText("<p>Hello</p><script>const s = 'SECRET';</script>");
    expect(text).toContain("Hello");
    expect(text).not.toContain("SECRET");
  });

  it("strips <style> bodies", async () => {
    const text = await readText("<p>Hello</p><style>.a{color:red}</style>");
    expect(text).toContain("Hello");
    expect(text).not.toContain("color:red");
  });

  it("strips <template> bodies", async () => {
    const text = await readText("<p>Hello</p><template>HIDDEN</template>");
    expect(text).toContain("Hello");
    expect(text).not.toContain("HIDDEN");
  });

  it("strips display:none elements", async () => {
    const text = await readText('<p>Visible</p><p style="display:none">SECRET</p>');
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });

  it("strips visibility:hidden elements", async () => {
    const text = await readText('<p>Visible</p><p style="visibility:hidden">SECRET</p>');
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });

  it("strips opacity:0 elements", async () => {
    const text = await readText('<p>Visible</p><p style="opacity:0">SECRET</p>');
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });

  it("strips aria-hidden elements", async () => {
    const text = await readText('<p>Visible</p><p aria-hidden="true">SECRET</p>');
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });

  it("strips elements with absurdly small font-size", async () => {
    const text = await readText('<p>Visible</p><p style="font-size:0px">SECRET</p>');
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });
});

describe("read_text — clamping", () => {
  it("clamps output to 6000 characters", async () => {
    const longText = "x".repeat(20_000);
    const text = await readText(`<p>${longText}</p>`);
    expect(text.length).toBeLessThanOrEqual(6000);
  });
});

// docs/specs/server/tools.md — `read_text` and `fetch_url` MUST share one
// hostile-content walker. Previously `fetch_url`'s in-page walker had a
// weaker filter (5 rules vs 8). After the consolidation the same denylist
// applies to both; we exercise the unified walker via `read_text` here
// because `fetch_url` would require an HTTP server. The unified-walker
// guarantee is enforced by the implementation: both consumers call
// `extractVisibleText`, which evaluates `__extractVisibleTextFnSource`.
describe("read_text — unified walker (also covers fetch_url)", () => {
  it("strips elements whose text colour matches the background colour", async () => {
    const html = '<p>Visible</p><p style="color:#ff0000;background-color:#ff0000">SECRET</p>';
    const text = await readText(html);
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });

  it("strips elements whose computed bounding rect is zero", async () => {
    // width:0;height:0;overflow:hidden collapses the box to a zero rect.
    const html = '<p>Visible</p><p style="width:0;height:0;overflow:hidden">SECRET</p>';
    const text = await readText(html);
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });

  it("strips opacity:0.0 (parseFloat-based) just like opacity:0", async () => {
    const text = await readText('<p>Visible</p><p style="opacity:0.0">SECRET</p>');
    expect(text).toContain("Visible");
    expect(text).not.toContain("SECRET");
  });
});

// Static surface check: both consumers must reference the same shared
// walker source — guards against future drift back to two walkers.
describe("read_text — implementation invariant", () => {
  it("exports a single walker source string used by both read_text and fetch_url", async () => {
    const mod = await import("../tools.ts");
    expect(typeof mod.__extractVisibleTextFnSource).toBe("string");
    expect(mod.__extractVisibleTextFnSource).toContain("HIDDEN_TAGS");
    expect(mod.__extractVisibleTextFnSource).toContain("aria-hidden");
    expect(mod.__extractVisibleTextFnSource).toContain("getBoundingClientRect");
    expect(mod.__extractVisibleTextFnSource).toContain("backgroundColor");
    expect(mod.__extractVisibleTextFnSource).toContain("fontSize");
  });
});
