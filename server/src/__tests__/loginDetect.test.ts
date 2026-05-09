import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectLoginPrompt } from "../loginDetect.ts";
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
