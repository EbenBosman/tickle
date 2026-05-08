import type { FastifyCorsOptions } from "@fastify/cors";

/**
 * CORS allowlist for the local dev experience.
 *
 * tickle binds to 127.0.0.1 and is single-user local. The previous
 * `origin: true` config let any web page in the user's browser drive
 * the API — DNS-rebinding territory. Restrict to the dev origins we
 * actually own.
 *
 * If a future deployment needs more origins, add them here explicitly
 * (no env-var allowlist — that path is one config typo away from
 * `origin: "*"`).
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  // Vite dev server (CLAUDE.md "Quirks": Vite 8 binds IPv6-only by default;
  // both name- and address-form variants are real in practice).
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
  // Direct browsing of the Fastify server (rare, but useful for poking the
  // health endpoint from a browser tab).
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

/**
 * Pure policy: does this Origin header value get a CORS pass?
 *
 * - Missing/empty Origin → allowed (same-origin requests, curl, SSE clients
 *   that don't send Origin). The browser only enforces CORS on cross-origin
 *   requests; absent Origin can't be a cross-origin attack.
 * - Anything else → exact string match against the allowlist. We do NOT
 *   normalise (trailing slash, case) — browsers send a canonical form, and
 *   exact match avoids surprises.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

type CorsOriginCallback = (err: Error | null, allow: boolean) => void;

export const corsOptions: FastifyCorsOptions = {
  origin: (origin: string | undefined, cb: CorsOriginCallback) => {
    cb(null, isAllowedOrigin(origin));
  },
};
