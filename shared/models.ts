/**
 * Allowlist for `settings.rescue_model`. Source of truth for both the
 * server (PUT /api/settings validation) and the web settings page
 * (model dropdown values).
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
