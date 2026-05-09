/**
 * Allowlist for `settings.rescue_model`. The set of Anthropic model IDs
 * we support routing rescue traffic through.
 *
 * Source of truth for the server side (PUT /api/settings validation).
 *
 * The web SettingsPage carries a richer per-model record (cost, label) for
 * display, and must keep the `value` column in sync with this list. Marked
 * `keep-in-sync: domain/models.ts` in `web/src/components/SettingsPage.tsx`.
 */
export const VALID_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
] as const;

export type ValidModel = (typeof VALID_MODELS)[number];

export function isValidModel(value: string): value is ValidModel {
  return (VALID_MODELS as readonly string[]).includes(value);
}
