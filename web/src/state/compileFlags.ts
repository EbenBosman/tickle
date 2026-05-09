import type { Block } from "../blocks.ts";

/**
 * Pure helpers for "is this proposed block worth a closer look before we
 * run it?" — used by the CompileFromText preview to surface potentially
 * dangerous compile output that the user should not just rubber-stamp.
 *
 * The detection is intentionally conservative: false positives (a
 * harmless Wikipedia link flagged as "off-host") are cheaper than false
 * negatives (an unflagged credit-card field).
 */

/** Hosts treated as "the user's own machine". Anything else is off-host. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

export function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return !LOCAL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function externalHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (LOCAL_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * Returns a single-sentence reason if `text` looks like a credential or
 * sensitive datum; null otherwise. Pattern set is deliberate: each match
 * is distinctive enough that an unrelated normal field rarely trips it.
 */
export function looksLikeCredential(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return null;

  // Keyword match against common sensitive-field labels.
  if (
    /\b(password|passwd|pw|secret|api[_-]?key|token|ssn|social.{0,3}security|credit.{0,3}card|card.?number|cvv|cvc|pin|otp|2fa|mfa)\b/i.test(
      t,
    )
  ) {
    return "looks like a credential / sensitive field";
  }

  // 13–19 contiguous digits (after stripping spaces/dashes) = card number territory.
  const digits = t.replace(/[\s-]/g, "");
  if (/^\d{13,19}$/.test(digits)) {
    return "value looks like a credit-card number";
  }

  // US SSN format: 3-2-4 digits.
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(t)) {
    return "value looks like a US SSN";
  }

  return null;
}

export type BlockFlag = {
  severity: "warn" | "info";
  reason: string;
};

/**
 * Inspect a single block and return a flag if it warrants extra review,
 * or null if it looks routine. Currently checks:
 *   - navigate: off-host URLs (non-localhost)
 *   - fill: credential-shaped target description OR value
 */
export function flagBlock(b: Block): BlockFlag | null {
  if (b.kind === "navigate") {
    const host = externalHost(b.url);
    if (host) return { severity: "warn", reason: `navigates off-host to ${host}` };
  }
  if (b.kind === "fill") {
    const targetReason = looksLikeCredential(b.target);
    if (targetReason) return { severity: "warn", reason: `field ${targetReason}` };
    const valueReason = looksLikeCredential(b.value);
    if (valueReason) return { severity: "warn", reason: `value ${valueReason}` };
  }
  return null;
}

/** Convenience: inspect every block (incl. for_each.body) and return the flags. */
export function flagBlocks(blocks: Block[]): { idx: number; flag: BlockFlag }[] {
  const out: { idx: number; flag: BlockFlag }[] = [];
  blocks.forEach((b, i) => {
    const f = flagBlock(b);
    if (f) out.push({ idx: i, flag: f });
  });
  return out;
}
