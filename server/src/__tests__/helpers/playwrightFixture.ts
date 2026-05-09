import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * Shared Playwright test harness for modules whose contract runs through
 * `page.evaluate` (loginDetect, snapshot, formScan, tools.read_text).
 *
 * Launch is expensive (~2–5s); every test file that uses this should
 * reuse a single context across its tests. Each test gets a fresh tab
 * via `newPageWithContent(html, opts?)`. URL-spoofing is supported for
 * detectors that look at `page.url()` without actually navigating —
 * navigation requires a local HTTP server we deliberately don't run.
 */

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;

export async function startSharedContext(): Promise<BrowserContext> {
  if (_context) return _context;
  _browser = await chromium.launch({ headless: true });
  _context = await _browser.newContext();
  return _context;
}

export async function stopSharedContext(): Promise<void> {
  if (_context) await _context.close();
  if (_browser) await _browser.close();
  _context = null;
  _browser = null;
}

/**
 * Creates a real Page with the given HTML loaded via `setContent`.
 * Optionally returns a wrapped Page whose `url()` reports a synthetic
 * URL. The wrapper proxies everything else to the real Page; tests
 * that depend on cross-origin behaviour belong in a smoke test, not
 * here.
 */
export async function newPageWithContent(
  html: string,
  opts: { url?: string } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await startSharedContext();
  const realPage = await ctx.newPage();
  await realPage.setContent(html, { waitUntil: "load" });
  const close = () => realPage.close();
  if (!opts.url) return { page: realPage, close };
  // Spoof the URL on a Proxy. Most callers only use page.url() and
  // page.evaluate, so a thin proxy is enough.
  const spoofed: Page = new Proxy(realPage, {
    get(target, prop, receiver) {
      if (prop === "url") return () => opts.url ?? "";
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { page: spoofed, close };
}
