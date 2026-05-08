# Spec — `browser`

> Path: `server/src/browser.ts` · Layer: `infrastructure/browser/` (post-refactor target) · Spec owner: `agent.ts` (Session lifecycle), `tools.ts` and `snapshot.ts` (page consumers)

## 1. Why

tickle drives a real Chromium instance to complete user tasks. The browser must (a) preserve login state across runs and across server restarts so users do not re-authenticate every run, (b) be visible by default so the user can watch and intervene, and (c) survive the page-side execution quirks introduced by tsx/esbuild compiling our `page.evaluate` callbacks. This module owns the single shared Chromium context, hands out one `Page` per run, and saves screenshots to disk for SSE replay.

> **Non-obvious why — profile persistence:** users authenticate once (Google, GitHub, banking, internal SSO, passkey) and that state lives in `server/data/profile/`. Wiping the profile means logging in to everything again. This is the entire reason a persistent context exists rather than ephemeral browsers per run.
> **Non-obvious why — `__name`/`__publicField` polyfill:** tsx/esbuild rewrites `page.evaluate` callback closures to reference `__name` and `__publicField` esbuild helpers. Those identifiers do not exist in the page's V8 realm, so any helper-using `evaluate` throws `ReferenceError: __name is not defined`. The polyfill is injected via `addInitScript` so it lands before any user code runs.
> **Non-obvious why — `viewport: null` + `--start-maximized`:** with a fixed `viewport`, Playwright pins the page to that size regardless of the OS Chrome window. Setting it to `null` lets the page's viewport track the actual Chrome window, so when the user maximizes or resizes, the page reflows naturally.

## 2. Public contract

### Exports

| Symbol            | Kind   | Signature / shape                                                  | Stability |
|-------------------|--------|--------------------------------------------------------------------|-----------|
| `Session`         | class  | `new Session(runId: number)` with `start()`, `close()`, `screenshot()` and public `page: Page` | stable    |
| `Session#start`   | method | `() => Promise<void>` — opens a fresh tab in the shared context; sets `page` | stable    |
| `Session#close`   | method | `() => Promise<void>` — closes the tab only; never the context     | stable    |
| `Session#screenshot` | method | `() => Promise<{ path: string; base64: string }>` — PNG, viewport-only, written to `screenshots/run-<runId>-<NNN>.png` | stable |
| `Session#page`    | field  | `Page` — populated after `start()` resolves; undefined before      | stable    |
| `getContext`      | —      | (intentionally not exported — module-internal singleton accessor)  | —         |
| `clearStaleProfileLocks` | — | (intentionally not exported)                                     | —         |

### Filesystem surface

- `server/data/profile/` — Chromium user-data dir. Auto-created on import. Gitignored. Carries cookies, localStorage, IndexedDB, ServiceWorker storage, saved passwords, and webauthn/passkey credentials. **Do not delete except as user-initiated reset.**
- `server/screenshots/run-<runId>-<NNN>.png` — viewport-only PNG, three-digit zero-padded index per run starting at `000`, monotonically increasing for the life of the `Session`. Auto-created on import. Served by `routes/runs.ts` as `/api/runs/:id/screenshots/*`.

### Errors

| Error                       | When                                       | Caller should…                              |
|-----------------------------|--------------------------------------------|---------------------------------------------|
| Playwright launch error     | Chromium binary missing (no `npx playwright install chromium` run) | Surface to user; README documents the install step |
| Profile lock contention     | Another Chromium has `SingletonLock` etc. open on the same profile dir | First-launch sweep removes stale files; if a *live* Chromium holds them, `rmSync` throws `EBUSY` (swallowed) and the subsequent `launchPersistentContext` surfaces the real error |
| `page.screenshot` throws    | Page closed mid-capture                    | Block executor catches and converts to `{ status: "failed" }` |

## 3. Invariants

- **I1 — Single shared context.** `getContext()` launches `chromium.launchPersistentContext(PROFILE_DIR, …)` exactly once per process; subsequent calls return the cached handle. Falsifiable: call twice, assert reference equality.
- **I2 — Page-per-run, never close-context.** `Session#close()` closes its `page` only. The shared context is never closed by this module — closing it would drop every other run's tabs and force a relaunch (with the lock-sweep race that implies). Falsifiable: after `close()`, `chromium` context still reports `pages().length >= 0` and a fresh `Session.start()` succeeds without relaunch.
- **I3 — Profile path is `server/data/profile/`.** Resolved relative to the server's CWD (the `server/` directory when launched via `npm run dev:server`). Auto-created with `mkdirSync(..., { recursive: true })` on module import.
- **I4 — Headed by default.** `HEADED` env var defaults to `"true"`; only the literal string `"false"` flips to headless. When headed, `--start-maximized` is passed.
- **I5 — `viewport: null` always.** Both headed and headless launches use `viewport: null` so the page tracks the OS window size.
- **I6 — Polyfill installed before any user navigation.** `addInitScript` is called on the context before the first `newPage()`, so every page in the context (now and forever) runs the polyfill at document start.
- **I7 — Screenshot index is per-`Session`.** `shotIdx` is owned by the `Session` instance and never reset across calls within a run; it does not coordinate across concurrent `Session`s (see drift §6).
- **I8 — Screenshots are viewport-only PNGs.** `fullPage: false`, `type: "png"`. Caller receives both `path` (for SSE/UI) and `base64` (for inlining into LLM messages).
- **I9 — Stale-lock sweep is best-effort.** `clearStaleProfileLocks()` removes `lockfile`, `SingletonLock`, `SingletonCookie`, `SingletonSocket` from the profile dir before launch. EBUSY (real live Chromium) is swallowed; the launch is then expected to surface the real error.
- **I10 — Auto-relaunch on close.** If the persistent context emits `close` (user closed the OS window, OS killed it), the cached handle is cleared so the next `getContext()` relaunches.

## 4. How (briefly)

- **Module-level state:** `sharedContext: BrowserContext | null`, lazily initialized.
- **Lifecycle:** `Session(runId)` is a thin wrapper. `start()` calls `getContext()` then `ctx.newPage()`. `close()` closes the page (swallows errors). The context outlives every `Session`.
- **Stale-lock sweep:** runs once per `getContext()` cold path. Chromium leaves `SingletonLock` / `SingletonCookie` / `SingletonSocket` / `lockfile` files in the profile dir on clean exit and on crash. Stale ones cause new pages to never reach `domcontentloaded` — `goto` times out with no useful error. Sweeping is safe because a live Chromium would hold the lock and `rmSync` would EBUSY.
- **Polyfill:** `addInitScript` injects no-op `__name` and a property-setting `__publicField` on `globalThis` if absent. The shape matches what esbuild generates for class-decorator helpers.
- **Concurrency:** Node single-threaded, single run at a time (CLAUDE.md "Quirks"). The cached-handle race in `getContext()` is benign in practice but not formally guarded — concurrent first-call awaits would launch twice (see drift §6).

## 5. How tested

| Spec section / claim             | Test file | Test name | Status |
|----------------------------------|-----------|-----------|--------|
| §3 I1 single shared context      | —         | —         | TODO(test) — integration scope |
| §3 I2 close page, not context    | —         | —         | TODO(test) — integration scope |
| §3 I3 profile path resolution    | —         | —         | TODO(test) — assertable cross-platform |
| §3 I6 polyfill installed before nav | —      | —         | TODO(test) — integration scope |
| §3 I7 screenshot naming convention | —       | —         | TODO(test) — file existence + regex on filename |
| §3 I9 stale-lock sweep on cold launch | —    | —         | TODO(test) — fs-only, no Playwright needed |
| §3 I10 auto-relaunch after context close | — | —         | TODO(test) — integration scope |

### Deliberately not tested

- Real `chromium.launchPersistentContext` behaviour. That is Playwright's contract.
- That a passkey survives a server restart. Manual smoke; depends on OS keyring.

## 6. Drift / open questions

- **⚠️ Drift — profile path is CWD-relative, not module-relative.** `PROFILE_DIR = "data/profile"` and `SHOTS_DIR = "screenshots"` resolve against `process.cwd()`. If anyone launches the server from a directory other than `server/`, the profile and screenshots end up in the wrong place (and a new empty profile is created — the user appears logged out). CLAUDE.md asserts the path is `server/data/profile/`; the code only honours that contract when CWD is `server/`. Fix: resolve relative to `import.meta.url` / a known anchor, or hoist to an explicit env var. Cross-platform correctness depends on this.
- **⚠️ Drift — concurrent first-call race.** Two awaiting callers on `getContext()` before `sharedContext` is set will each call `chromium.launchPersistentContext`. Today only one run executes at a time so this never fires; if multi-run is ever introduced, the second launch will EBUSY on the now-locked profile. Wrap the first-launch path in a `pendingContextPromise` to deduplicate.
- **⚠️ Drift — `Session#screenshot` requires `start()` first.** `this.page` is `!`-asserted (`page!: Page`); calling `screenshot()` before `start()` throws an unhelpful TypeError. Either change the type to `Page | undefined` and throw a domain error, or document the precondition explicitly.
- **⚠️ Drift — `viewport: null` in headless mode.** In headless, there is no OS window to track, and Chromium falls back to a default viewport (commonly 800×600). Snapshots taken in headless will reflect that. If headless is ever a primary mode (CI), set an explicit viewport conditionally.
- **⚠️ Guardrail — anti-pattern from CLAUDE.md.** "Do not add raw bare-chrome launch options that disable the persistent profile." Any future flag (`--incognito`, `--user-data-dir=…` override, `--guest`, custom `userDataDir`) that bypasses `PROFILE_DIR` silently destroys saved login state. New launch args must be reviewed against this contract.
- **❓ Question — should the screenshot helper move to `tools.ts`?** It is the only consumer today. Keeping it on `Session` couples the browser module to a specific filesystem layout. Post-refactor, `infrastructure/browser/context.ts` exposes the page; `infrastructure/observability/screenshotStore.ts` owns the file naming and persistence.
- **❓ Question — multi-run = multi-context?** Today one context, one page-per-run, single concurrency. If concurrent runs are ever supported, options are: (a) one context per run (loses shared login state — bad), (b) one context, multiple pages, isolation by `BrowserContext`-ish abstraction (storage state shared, which is the *point*), or (c) per-run incognito sub-contexts that import storage state from the shared profile (loses cookies set during the run). Option (b) is correct but needs care around `wait_for` and tab focus.
