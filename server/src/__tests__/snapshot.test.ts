import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { takeSnapshot } from "../snapshot.ts";
import type { Session } from "../browser.ts";
import {
  newPageWithContent,
  startSharedContext,
  stopSharedContext,
} from "./helpers/playwrightFixture.ts";

// docs/specs/server/snapshot.md
//
// `takeSnapshot` walks the DOM, tags each visible interactive element
// with `data-tickle-id`, and returns a labeled list + screenshot. New
// invariants exercised here:
//   - aria-hidden="true" elements (and their descendants) are excluded.
//   - Stale data-tickle-id attributes from a previous pass are cleared
//     before the new tagging pass; ids are dense from 0 in tag order.

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

/** Build a Session-shaped object whose `screenshot()` is a tiny stub —
 *  takeSnapshot calls it but the test only inspects `elements`. */
function fakeSession(page: Page): Session {
  const stub = {
    page,
    runId: 0,
    shotIdx: 0,
    async screenshot() {
      // Return an empty 1x1 PNG to avoid touching the filesystem.
      const tinyPngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAUAAeImBZsAAAAASUVORK5CYII=";
      return { path: "", base64: tinyPngB64 };
    },
    async start() {
      /* unused */
    },
    async close() {
      /* unused */
    },
  };
  return stub;
}

async function snapshot(html: string) {
  const { page, close } = await newPageWithContent(html);
  closers.push(close);
  return takeSnapshot(fakeSession(page), { all: true });
}

describe("takeSnapshot — aria-hidden filter", () => {
  it("excludes a button with aria-hidden=true", async () => {
    const snap = await snapshot(`
      <button>Visible</button>
      <button aria-hidden="true">Ignored</button>
    `);
    const names = snap.elements.map((e) => e.name);
    expect(names).toContain("Visible");
    expect(names).not.toContain("Ignored");
  });

  it("excludes descendants of an aria-hidden=true ancestor", async () => {
    const snap = await snapshot(`
      <div aria-hidden="true">
        <button>Hidden child</button>
        <a href="https://example.com">Hidden link</a>
      </div>
      <button>Real</button>
    `);
    const names = snap.elements.map((e) => e.name);
    expect(names).toContain("Real");
    expect(names).not.toContain("Hidden child");
    expect(names).not.toContain("Hidden link");
  });

  it("includes a button when aria-hidden is set to a non-'true' value", async () => {
    // Only aria-hidden="true" hides; aria-hidden="false" or absent does not.
    const snap = await snapshot(`
      <button aria-hidden="false">Still visible</button>
    `);
    const names = snap.elements.map((e) => e.name);
    expect(names).toContain("Still visible");
  });
});

describe("takeSnapshot — data-tickle-id cleanup", () => {
  it("removes stale data-tickle-id attributes before re-tagging", async () => {
    const { page, close } = await newPageWithContent(`
      <button>One</button>
      <button>Two</button>
    `);
    closers.push(close);
    const session = fakeSession(page);

    const first = await takeSnapshot(session, { all: true });
    expect(first.elements.length).toBe(2);
    // Each element gets sequential ids starting at 0.
    expect(first.elements.map((e) => e.id)).toEqual([0, 1]);

    // Simulate an SPA injecting a stale stray data-tickle-id on an
    // element that the next pass should not "own". The cleanup step
    // must wipe this before new tagging.
    await page.evaluate(() => {
      const stray = document.createElement("span");
      stray.setAttribute("data-tickle-id", "999");
      stray.textContent = "stale-tag";
      document.body.appendChild(stray);
      // Also corrupt one of the existing buttons' tag to verify reset.
      const btns = document.querySelectorAll("button");
      btns[0].setAttribute("data-tickle-id", "777");
    });

    const second = await takeSnapshot(session, { all: true });
    // New tagging pass: ids dense from 0.
    expect(second.elements.map((e) => e.id)).toEqual([0, 1]);

    // The stale "999" must have been removed before re-tagging — so
    // searching for it now returns nothing.
    const stale999 = await page.evaluate(
      () => document.querySelectorAll('[data-tickle-id="999"]').length,
    );
    expect(stale999).toBe(0);

    // Same for "777".
    const stale777 = await page.evaluate(
      () => document.querySelectorAll('[data-tickle-id="777"]').length,
    );
    expect(stale777).toBe(0);

    // The non-interactive <span> that received the stray tag must NOT
    // appear in the snapshot output (it's not an interactive element).
    const names = second.elements.map((e) => e.name);
    expect(names).not.toContain("stale-tag");
  });
});
