/**
 * Server-side re-export of the rescue-model allowlist from the shared
 * workspace. Both server validation and web display now consume the same
 * `VALID_MODELS` list.
 */
export { VALID_MODELS, isValidModel } from "../../../shared/models.ts";
export type { ValidModel } from "../../../shared/models.ts";
