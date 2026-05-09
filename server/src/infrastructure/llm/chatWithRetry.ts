import { chatOnce, type LlmClient, type Message, type ChatResponse } from "../../llm.ts";

const RETRY_BACKOFFS_MS = [1500, 4000];

export function isTransientLLMError(msg: string): boolean {
  return /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted by/i.test(msg);
}

export type ChatRequest = {
  model: string;
  messages: Message[];
  tools?: unknown[];
  temperature?: number;
  think?: boolean;
};

/**
 * Wrap a single `chatOnce` call with bounded retry on transient failures.
 *
 * Retries on `fetch failed`, `ECONN*`, `ETIMEDOUT`, `socket hang up`, etc., at
 * 1.5s and 4s. Cancellation (via `isCancelled`) is honoured between attempts
 * and aborts any in-flight request via the AbortController set into
 * `setActiveController`.
 *
 * `aborted by` is included in the transient regex on purpose: some local LLM
 * backends emit that string as a generic disconnect, distinct from our own
 * cancellation. The `isCancelled()` check before each attempt distinguishes
 * the two — a real user cancel short-circuits before retry.
 */
export async function chatWithRetry(
  client: LlmClient,
  request: ChatRequest,
  isCancelled: () => boolean,
  setActiveController: (c: AbortController | null) => void,
  onRetry: (attempt: number, error: string, backoffMs: number) => void,
): Promise<ChatResponse> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    if (isCancelled()) {
      throw lastErr instanceof Error ? lastErr : new Error("cancelled before chat attempt");
    }
    const controller = new AbortController();
    setActiveController(controller);
    try {
      const response = await chatOnce(client, { ...request, signal: controller.signal });
      setActiveController(null);
      return response;
    } catch (err) {
      setActiveController(null);
      lastErr = err;
      const msg = (err as Error).message ?? String(err);
      if (isCancelled() || !isTransientLLMError(msg) || attempt === RETRY_BACKOFFS_MS.length) {
        throw err;
      }
      const backoff = RETRY_BACKOFFS_MS[attempt];
      onRetry(attempt + 1, msg, backoff);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastErr;
}
