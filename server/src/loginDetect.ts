import type { Page } from "playwright";

/** Known SSO / identity provider hostnames. High-precision matches. */
const KNOWN_LOGIN_HOSTS: RegExp[] = [
  /(^|\.)accounts\.google\.com$/i,
  /(^|\.)login\.live\.com$/i,
  /(^|\.)login\.microsoftonline\.com$/i,
  /(^|\.)login\.microsoft\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)auth0\.com$/i,
  /(^|\.)id\.atlassian\.com$/i,
  /(^|\.)appleid\.apple\.com$/i,
  /(^|\.)login\.yahoo\.com$/i,
];

/** Path patterns for sites where the host alone doesn't tell you it's a login page. */
const KNOWN_LOGIN_PATHS: { host: RegExp; path: RegExp }[] = [
  { host: /(^|\.)github\.com$/i, path: /^\/(login|sessions|sign_in)/i },
  { host: /(^|\.)linkedin\.com$/i, path: /^\/(login|uas\/login|checkpoint)/i },
  { host: /(^|\.)x\.com$/i, path: /^\/(i\/flow\/login|login)/i },
  { host: /(^|\.)twitter\.com$/i, path: /^\/(i\/flow\/login|login)/i },
  { host: /(^|\.)facebook\.com$/i, path: /^\/(login|checkpoint)/i },
];

export type LoginDetection = { detected: false } | { detected: true; reason: string };

export async function detectLoginPrompt(page: Page): Promise<LoginDetection> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return { detected: false };
  }

  if (KNOWN_LOGIN_HOSTS.some((h) => h.test(url.hostname))) {
    return { detected: true, reason: `Identity provider detected: ${url.hostname}` };
  }

  for (const { host, path } of KNOWN_LOGIN_PATHS) {
    if (host.test(url.hostname) && path.test(url.pathname)) {
      return { detected: true, reason: `Login page detected: ${url.hostname}${url.pathname}` };
    }
  }

  // Generic: visible password field, or visible passkey/webauthn UI cues.
  const dom = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    };

    const pwd = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (pwd) return { kind: "password" as const };

    const webauthn = document.querySelector(
      'input[autocomplete*="webauthn"], input[autocomplete*="one-time-code"]',
    );
    if (webauthn && isVisible(webauthn)) return { kind: "webauthn" as const };

    // Passkey-style prompts often surface a "Use your passkey" / "Sign in" CTA.
    const text = (document.body?.innerText ?? "").slice(0, 4000).toLowerCase();
    const passkeyHint =
      /\buse your passkey\b/.test(text) ||
      /\bcontinue with passkey\b/.test(text) ||
      /\bsign in with passkey\b/.test(text);
    if (passkeyHint) return { kind: "passkey-text" as const };

    return { kind: "none" as const };
  });

  if (dom.kind === "password") {
    return { detected: true, reason: "Password field detected" };
  }
  if (dom.kind === "webauthn") {
    return { detected: true, reason: "Passkey / one-time-code field detected" };
  }
  if (dom.kind === "passkey-text") {
    return { detected: true, reason: "Passkey prompt detected on page" };
  }

  return { detected: false };
}
