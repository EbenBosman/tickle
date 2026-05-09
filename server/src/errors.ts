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
 * Never throws.
 */
export function errorMessageFromThrow(value: unknown): string {
  if (value instanceof Error) return value.message || "Error";
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  // Objects (including arrays). Try JSON first; fall back to a typed
  // toString tag so the message is at least informative for the
  // BigInt-member / circular-reference cases.
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through to the toString tag below
  }
  return Object.prototype.toString.call(value);
}
