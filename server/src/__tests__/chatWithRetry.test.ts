import { describe, expect, it, vi } from "vitest";

// docs/specs/server/llm-client.md
//
// chatWithRetry wraps chatOnce with bounded retry on transient errors.
// Tests stub chatOnce via vi.mock to script the failure / success
// sequence and assert (a) retry-on-transient, (b) no-retry-on-fatal,
// (c) cancellation interrupts before/between attempts.

const calls = vi.hoisted(() => ({ count: 0, lastSignalAborted: false }));

vi.mock("../llm.ts", () => ({
  chatOnce: vi.fn(),
  // Re-export the types/values that chatWithRetry imports. Vitest only
  // needs `chatOnce` to be a mock; the others can be no-ops since we
  // import them by type only.
  newLlmClient: () => ({}),
  MODEL: "x",
  LLM_BASE_URL: "x",
  CONTEXT_WINDOW: 1,
}));

import { chatWithRetry, isTransientLLMError } from "../infrastructure/llm/chatWithRetry.ts";
import { chatOnce, type LlmClient } from "../llm.ts";

const mockChatOnce = chatOnce as unknown as ReturnType<typeof vi.fn>;

const noopController = vi.fn();
const noopRetry = vi.fn();

function reset() {
  calls.count = 0;
  mockChatOnce.mockReset();
  noopController.mockReset();
  noopRetry.mockReset();
}

describe("isTransientLLMError", () => {
  it.each([
    "fetch failed",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN abc",
    "socket hang up",
    "network error",
    "request was aborted by upstream",
  ])("treats %s as transient", (msg) => {
    expect(isTransientLLMError(msg)).toBe(true);
  });

  it.each(["400 bad request", "context length exceeded", "model not found"])(
    "treats %s as fatal",
    (msg) => {
      expect(isTransientLLMError(msg)).toBe(false);
    },
  );
});

describe("chatWithRetry — happy path", () => {
  it("returns the first successful response without retrying", async () => {
    reset();
    mockChatOnce.mockResolvedValueOnce({ message: { content: "ok", tool_calls: [] } });
    const fakeClient = { provider: "openai" as const, client: {} } as unknown as LlmClient;
    const out = await chatWithRetry(
      fakeClient,
      { model: "m", messages: [] },
      () => false,
      noopController,
      noopRetry,
    );
    expect(out.message.content).toBe("ok");
    expect(mockChatOnce).toHaveBeenCalledTimes(1);
    expect(noopRetry).not.toHaveBeenCalled();
  });
});

describe("chatWithRetry — retry on transient", () => {
  it("retries and eventually succeeds (transient then ok)", async () => {
    reset();
    mockChatOnce
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({ message: { content: "second", tool_calls: [] } });
    const fakeClient = { provider: "openai" as const, client: {} } as unknown as LlmClient;
    const out = await chatWithRetry(
      fakeClient,
      { model: "m", messages: [] },
      () => false,
      noopController,
      noopRetry,
    );
    expect(out.message.content).toBe("second");
    expect(mockChatOnce).toHaveBeenCalledTimes(2);
    expect(noopRetry).toHaveBeenCalledTimes(1);
    expect(noopRetry.mock.calls[0][0]).toBe(1); // attempt 1 -> retry 1
  }, 10_000);

  it("gives up after all backoffs and re-throws", async () => {
    reset();
    mockChatOnce
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("fetch failed"));
    const fakeClient = { provider: "openai" as const, client: {} } as unknown as LlmClient;
    await expect(
      chatWithRetry(
        fakeClient,
        { model: "m", messages: [] },
        () => false,
        noopController,
        noopRetry,
      ),
    ).rejects.toThrow(/fetch failed/);
    // 1 initial + 2 retries (RETRY_BACKOFFS_MS has 2 entries) = 3 attempts
    expect(mockChatOnce).toHaveBeenCalledTimes(3);
  }, 15_000);
});

describe("chatWithRetry — fatal errors aren't retried", () => {
  it("re-throws on the first non-transient error", async () => {
    reset();
    mockChatOnce.mockRejectedValueOnce(new Error("400 bad request"));
    const fakeClient = { provider: "openai" as const, client: {} } as unknown as LlmClient;
    await expect(
      chatWithRetry(
        fakeClient,
        { model: "m", messages: [] },
        () => false,
        noopController,
        noopRetry,
      ),
    ).rejects.toThrow(/400 bad request/);
    expect(mockChatOnce).toHaveBeenCalledTimes(1);
    expect(noopRetry).not.toHaveBeenCalled();
  });
});

describe("chatWithRetry — cancellation", () => {
  it("throws immediately when isCancelled() is true before the first attempt", async () => {
    reset();
    const fakeClient = { provider: "openai" as const, client: {} } as unknown as LlmClient;
    await expect(
      chatWithRetry(
        fakeClient,
        { model: "m", messages: [] },
        () => true,
        noopController,
        noopRetry,
      ),
    ).rejects.toThrow(/cancelled before chat attempt/);
    expect(mockChatOnce).not.toHaveBeenCalled();
  });

  it("does not retry once cancelled mid-flight", async () => {
    reset();
    let cancelled = false;
    mockChatOnce.mockImplementationOnce(() => {
      cancelled = true;
      return Promise.reject(new Error("fetch failed"));
    });
    const fakeClient = { provider: "openai" as const, client: {} } as unknown as LlmClient;
    await expect(
      chatWithRetry(
        fakeClient,
        { model: "m", messages: [] },
        () => cancelled,
        noopController,
        noopRetry,
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(mockChatOnce).toHaveBeenCalledTimes(1);
    expect(noopRetry).not.toHaveBeenCalled();
  });
});
