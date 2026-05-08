/**
 * Normalise any thrown value into a non-empty string.
 *
 * JS lets you throw absolutely anything (Error, string, plain object,
 * `undefined`, `null`, a Symbol, a function, etc.). When the unhandled
 * rejection from `runAgent` lands in the route's catch, we need a
 * stable string for `runs.error` and the SSE `error` event. This helper
 * is small enough to inline, but keeping it named makes the test
 * surface explicit.
 *
 * Never throws — any failure path inside falls back to `String(value)`.
 */
export function errorMessageFromThrow(value: unknown): string {
  if (value instanceof Error) return value.message || "Error";
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  // Primitives stringify cleanly.
  if (typeof value !== "object" && typeof value !== "function") {
    return String(value);
  }
  // Objects (including arrays): try JSON first, fall back to String().
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json;
  } catch {
    return String(value);
  }
}
