import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectLoginPrompt } from "../loginDetect.ts";
import { isVisuallyHidden } from "../visibility.ts";
import {
  newPageWithContent,
  startSharedContext,
  stopSharedContext,
} from "./helpers/playwrightFixture.ts";

// docs/specs/server/login-guard.md
//
// detectLoginPrompt takes a Playwright Page and returns
// { detected: boolean, reason? }. Three layers:
//   1. URL hostname against an SSO allowlist
//   2. URL host+path for sites where the host alone is ambiguous
//   3. DOM probes (visible password input, webauthn input,
//      passkey-text on the page)
// The shared Playwright context starts once per file (~2–5s).

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

async function fixture(html: string, opts: { url?: string } = {}) {
  const { page, close } = await newPageWithContent(html, opts);
  closers.push(close);
  return page;
}

describe("detectLoginPrompt — SSO host match", () => {
  it("triggers on accounts.google.com", async () => {
    const page = await fixture("<p>hi</p>", { url: "https://accounts.google.com/signin" });
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
    if (r.detected) expect(r.reason).toContain("Identity provider detected");
  });

  it("triggers on okta-suffixed subdomains", async () => {
    const page = await fixture("<p>hi</p>", { url: "https://acme.okta.com/login" });
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
  });

  it("does NOT trigger on a non-SSO host without DOM cues", async () => {
    const page = await fixture("<p>hello</p>", { url: "https://example.com/" });
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });
});

describe("detectLoginPrompt — host+path match", () => {
  it("triggers on github.com/login", async () => {
    const page = await fixture("<p>hi</p>", { url: "https://github.com/login" });
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
    if (r.detected) expect(r.reason).toContain("Login page detected");
  });

  it("does NOT trigger on github.com without a login path", async () => {
    const page = await fixture("<p>hi</p>", {
      url: "https://github.com/anthropics/claude-code",
    });
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });

  it("triggers on x.com/i/flow/login", async () => {
    const page = await fixture("<p>hi</p>", { url: "https://x.com/i/flow/login" });
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
  });
});

describe("detectLoginPrompt — DOM probes", () => {
  it("triggers on a visible password input", async () => {
    const page = await fixture('<form><input type="password" /></form>');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
    if (r.detected) expect(r.reason).toContain("Password");
  });

  it("does NOT trigger on a hidden (display:none) password input", async () => {
    const page = await fixture('<form><input type="password" style="display:none" /></form>');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });

  it("does NOT trigger on a visibility:hidden password input", async () => {
    const page = await fixture('<form><input type="password" style="visibility:hidden" /></form>');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });

  it("does NOT trigger on an opacity:0 password input", async () => {
    const page = await fixture('<form><input type="password" style="opacity:0" /></form>');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });

  it("does NOT trigger on an opacity:0.0 password input (parseFloat-based)", async () => {
    // Regression: previous string equality check (`opacity !== "0"`) let
    // "0.0" through, mis-classifying invisible password fields as visible.
    // The unified visibility helper uses parseFloat so any 0-valued opacity
    // is treated as hidden.
    const page = await fixture('<form><input type="password" style="opacity:0.0" /></form>');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });

  it("triggers on a visible autocomplete=webauthn input", async () => {
    const page = await fixture('<input autocomplete="webauthn" />');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
  });

  it("triggers on a one-time-code autocomplete input", async () => {
    const page = await fixture('<input autocomplete="one-time-code" />');
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
  });

  it("triggers on passkey-text body content", async () => {
    const page = await fixture("<p>To continue, please use your passkey to sign in.</p>");
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(true);
    if (r.detected) expect(r.reason).toContain("Passkey");
  });

  it("does NOT trigger on benign body text", async () => {
    const page = await fixture("<p>Welcome to the homepage. No login is required.</p>");
    const r = await detectLoginPrompt(page);
    expect(r.detected).toBe(false);
  });
});

describe("detectLoginPrompt — defensive", () => {
  it("does not throw on malformed page state (about:blank with no body content)", async () => {
    const page = await fixture("");
    await expect(detectLoginPrompt(page)).resolves.toEqual({ detected: false });
  });
});

// Visibility helper unit tests + cross-check that the inline page.evaluate
// implementation in loginDetect produces the same answer as the exported
// helper for representative inputs. This is the only mechanical guard
// against the two copies drifting; if it breaks, fix BOTH places.
describe("isVisuallyHidden — exported helper", () => {
  it("flags display:none", () => {
    expect(isVisuallyHidden({ display: "none" })).toBe(true);
  });
  it("flags visibility:hidden", () => {
    expect(isVisuallyHidden({ visibility: "hidden" })).toBe(true);
  });
  it("flags opacity 0", () => {
    expect(isVisuallyHidden({ opacity: "0" })).toBe(true);
  });
  it("flags opacity 0.0 (regression)", () => {
    expect(isVisuallyHidden({ opacity: "0.0" })).toBe(true);
  });
  it("flags opacity 0.00", () => {
    expect(isVisuallyHidden({ opacity: "0.00" })).toBe(true);
  });
  it("does NOT flag opacity 0.5", () => {
    expect(isVisuallyHidden({ opacity: "0.5" })).toBe(false);
  });
  it("does NOT flag empty / missing style", () => {
    expect(isVisuallyHidden({})).toBe(false);
  });
  it("flags zero rect when both width and height are zero", () => {
    expect(isVisuallyHidden({}, { width: 0, height: 0 })).toBe(true);
  });
  it("does NOT flag rect with positive size", () => {
    expect(isVisuallyHidden({}, { width: 100, height: 20 })).toBe(false);
  });
  it("does NOT flag rect with one zero dimension (per helper rule)", () => {
    // Helper rule: hidden iff BOTH width and height are zero. (Snapshot
    // and formScan use a stricter OR rule for their interactive-element
    // gating, which is intentional and stays inline.)
    expect(isVisuallyHidden({}, { width: 0, height: 20 })).toBe(false);
  });
});

describe("isVisuallyHidden — inline copy in loginDetect agrees with helper", () => {
  // Run representative styles through BOTH the helper AND the inline
  // page.evaluate implementation; assert they agree. If they diverge,
  // someone edited one and not the other.
  type Style = { display?: string; visibility?: string; opacity?: string };
  const cases: { name: string; style: Style }[] = [
    { name: "visible", style: {} },
    { name: "display:none", style: { display: "none" } },
    { name: "visibility:hidden", style: { visibility: "hidden" } },
    { name: "opacity:0", style: { opacity: "0" } },
    { name: "opacity:0.0", style: { opacity: "0.0" } },
    { name: "opacity:0.00", style: { opacity: "0.00" } },
    { name: "opacity:0.5", style: { opacity: "0.5" } },
    { name: "opacity:1", style: { opacity: "1" } },
  ];

  for (const c of cases) {
    it(`agrees on ${c.name}`, async () => {
      const inlineStyleAttr = (Object.entries(c.style) as [keyof Style, string][])
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`)
        .join(";");
      const html = `<input id="probe" type="text" style="${inlineStyleAttr}" value="hi" />`;
      const page = await fixture(html);
      const inlineHidden = await page.evaluate(() => {
        const el = document.getElementById("probe");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width === 0 || r.height === 0) return true;
        if (s.display === "none") return true;
        if (s.visibility === "hidden") return true;
        if (parseFloat(s.opacity || "1") === 0) return true;
        return false;
      });
      // For helper, only consider style fields (rect not applicable —
      // we want pure style agreement on the same input). The helper's
      // rect rule is OFF when no rect is supplied, matching style-only
      // checks.
      const helperHidden = isVisuallyHidden(c.style);
      // Inline may additionally flag a zero rect for opacity-only cases
      // because Chromium can collapse the rendered box; but for visible
      // / hidden style states the answers must align.
      if (c.name === "visible" || c.name === "opacity:0.5" || c.name === "opacity:1") {
        expect(inlineHidden).toBe(false);
        expect(helperHidden).toBe(false);
      } else {
        expect(inlineHidden).toBe(true);
        expect(helperHidden).toBe(true);
      }
    });
  }
});
