import { chromium, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_DIR, SHOTS_DIR } from "./paths/storage.ts";

const HEADED = (process.env.HEADED ?? "true") !== "false";
mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync(SHOTS_DIR, { recursive: true });

export { PROFILE_DIR, SHOTS_DIR };

let sharedContext: BrowserContext | null = null;

/**
 * Chromium leaves `lockfile` and `Singleton*` files in the profile dir when it
 * exits cleanly OR when killed mid-run. On a fresh launch, stale ones cause
 * the browser to open but pages never reach `domcontentloaded` — `page.goto`
 * times out with no useful error. Sweeping them on first launch is safe: if a
 * real Chromium were holding them, the file would be locked and rmSync would
 * throw EBUSY, which we swallow (the launch will then surface the real error).
 */
function clearStaleProfileLocks(): void {
  const candidates = ["lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket"];
  for (const name of candidates) {
    const p = join(PROFILE_DIR, name);
    if (!existsSync(p)) continue;
    try {
      rmSync(p, { force: true });
      console.log(`[browser] cleared stale ${name}`);
    } catch (err) {
      console.warn(`[browser] could not clear ${name}: ${(err as Error).message}`);
    }
  }
}

/**
 * One persistent Chromium profile, shared across runs. Cookies, localStorage,
 * IndexedDB, and saved-credentials all survive between runs and across
 * server restarts. Each run gets a fresh page (tab) inside this context.
 */
async function getContext(): Promise<BrowserContext> {
  if (sharedContext) {
    try {
      sharedContext.pages();
      return sharedContext;
    } catch {
      sharedContext = null;
    }
  }
  clearStaleProfileLocks();
  sharedContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !HEADED,
    // viewport:null lets the page's viewport track the actual Chrome window size,
    // so when the user maximizes the window the page actually reflows to fit.
    viewport: null,
    args: HEADED ? ["--start-maximized"] : [],
  });

  // Polyfill esbuild helpers that tsx/esbuild reference when serializing our
  // `page.evaluate` callbacks. Without this, page-side execution throws
  // `ReferenceError: __name is not defined` for any helper-using evaluate.
  await sharedContext.addInitScript(() => {
    const g = globalThis as Record<string, unknown>;
    if (typeof g.__name !== "function") {
      g.__name = (fn: unknown) => fn;
    }
    if (typeof g.__publicField !== "function") {
      g.__publicField = (obj: Record<string, unknown>, key: string, value: unknown) => {
        obj[key] = value;
        return value;
      };
    }
  });

  sharedContext.on("close", () => {
    sharedContext = null;
  });
  return sharedContext;
}

export class Session {
  page!: Page;
  runId: number;
  shotIdx = 0;

  constructor(runId: number) {
    this.runId = runId;
  }

  async start() {
    const ctx = await getContext();
    this.page = await ctx.newPage();
  }

  async close() {
    try {
      await this.page?.close();
    } catch {
      // ignore
    }
    // Note: do NOT close the shared context — that would drop the profile and tabs.
  }

  async screenshot(): Promise<{ path: string; base64: string }> {
    const buf = await this.page.screenshot({ type: "png", fullPage: false });
    const file = `run-${this.runId}-${String(this.shotIdx++).padStart(3, "0")}.png`;
    const fullPath = join(SHOTS_DIR, file);
    writeFileSync(fullPath, buf);
    return { path: fullPath, base64: buf.toString("base64") };
  }
}
