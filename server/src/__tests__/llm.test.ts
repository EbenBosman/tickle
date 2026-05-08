import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { newAnthropicClient, newLlmClient } from "../llm.ts";

// docs/specs/server/llm-client.md
//
// LlmClient is a thin wrapper around the OpenAI / Anthropic SDKs.
// The model name is per-call (ChatOptions.model), not per-client, so
// newLlmClient() and newAnthropicClient() take no arguments. A previous
// version accepted a `model` parameter on newAnthropicClient that was
// silently dropped — see "Likely bugs" in docs/specs/README.md.

describe("newLlmClient — provider selection", () => {
  const originalProvider = process.env.LLM_PROVIDER;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-xyz";
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  it("returns an openai-tagged client by default", () => {
    delete process.env.LLM_PROVIDER;
    const c = newLlmClient();
    expect(c.provider).toBe("openai");
    expect(c.client).toBeInstanceOf(OpenAI);
  });

  it("returns an anthropic-tagged client when LLM_PROVIDER=anthropic", () => {
    process.env.LLM_PROVIDER = "anthropic";
    const c = newLlmClient();
    expect(c.provider).toBe("anthropic");
    expect(c.client).toBeInstanceOf(Anthropic);
  });
});

describe("newAnthropicClient — rescue / explicit Anthropic factory", () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-xyz";
  });

  afterEach(() => {
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  it("returns an anthropic-tagged client backed by the SDK", () => {
    const c = newAnthropicClient();
    expect(c.provider).toBe("anthropic");
    expect(c.client).toBeInstanceOf(Anthropic);
  });

  it("takes no arguments (model is per-call via ChatOptions, not per-client)", () => {
    // Type-level assertion: the function signature must be `() => LlmClient`.
    // If a `model` parameter is ever re-added, this becomes a compile error.
    const fn: () => unknown = newAnthropicClient;
    expect(fn).toBe(newAnthropicClient);
  });
});
