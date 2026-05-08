import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Pluggable LLM client — either an OpenAI-compatible backend (LM Studio, Ollama,
 * vLLM, etc.) or the Anthropic API directly.
 *
 * OpenAI-compat (default — LM Studio):
 *   LLM_PROVIDER=openai  (or unset)
 *   LLM_BASE_URL=http://127.0.0.1:1234/v1
 *   LLM_MODEL=qwen3.6-27b-uncensored-hauhaucs-balanced
 *
 * Anthropic API:
 *   LLM_PROVIDER=anthropic
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   LLM_MODEL=claude-sonnet-4-6
 *
 * Rescue client (set independently of primary):
 *   ANTHROPIC_API_KEY=sk-ant-...  (rescue model comes from DB settings)
 */
export const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1";
export const MODEL =
  process.env.LLM_MODEL ??
  process.env.OLLAMA_MODEL ??
  "qwen3.6-27b-uncensored-hauhaucs-balanced";
/**
 * Context window of the loaded model. Used purely for the UI gauge — set this
 * to whatever you configured in LM Studio / Ollama / vLLM so the footer
 * accurately shows how full the prompt is getting. Falls back to 32k.
 */
export const CONTEXT_WINDOW = Number(process.env.LLM_CONTEXT_WINDOW ?? "32768");
const API_KEY = process.env.LLM_API_KEY ?? "not-needed";

export type LlmClient =
  | { provider: "openai"; client: OpenAI }
  | { provider: "anthropic"; client: Anthropic };

export function newLlmClient(): LlmClient {
  if (process.env.LLM_PROVIDER === "anthropic") {
    return {
      provider: "anthropic",
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    };
  }
  return {
    provider: "openai",
    client: new OpenAI({ baseURL: LLM_BASE_URL, apiKey: API_KEY }),
  };
}

export function newAnthropicClient(model: string): LlmClient {
  return {
    provider: "anthropic",
    client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  };
}

// ============================================================
// Internal message + tool-call shape used throughout agent.ts.
// We keep our own normalized format and convert on the way in/out
// of each provider's API.
// ============================================================

export type ToolCall = {
  function?: { name?: string; arguments?: Record<string, unknown> };
};

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: ToolCall[];
};

export type ChatOptions = {
  model: string;
  messages: Message[];
  tools?: unknown[];
  temperature?: number;
  /** When false, asks Qwen-family models to skip <think>...</think> output. */
  think?: boolean;
  signal?: AbortSignal;
};

export type ChatResponse = {
  message: { content: string; tool_calls: ToolCall[] };
  usage: { prompt_tokens: number; completion_tokens: number };
  /** Wall-clock time we measured ourselves. */
  duration_ms: number;
};

// ============================================================
// OpenAI-compatible format converters (unchanged)
// ============================================================

function toOpenAI(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content };
    }
    if (m.images && m.images.length > 0 && (m.role === "user" || m.role === "system")) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const b64 of m.images) {
        parts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } });
      }
      return { role: m.role, content: parts };
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: m.content || "",
        tool_calls: m.tool_calls.map((tc, idx) => ({
          id: `call_${idx}`,
          type: "function",
          function: {
            name: tc.function?.name ?? "",
            arguments: JSON.stringify(tc.function?.arguments ?? {}),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

// ============================================================
// Anthropic format converters
// ============================================================

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
};

/**
 * Convert our internal Message[] to Anthropic's messages API format.
 * - Pulls system messages out as the top-level `system` string.
 * - Groups consecutive tool-role messages into one user message (Anthropic requirement).
 * - Assigns deterministic tool_use IDs based on position for correlation.
 */
export function toAnthropic(messages: Message[]): { system: string; messages: AnthropicMessage[] } {
  let system = "";
  const result: AnthropicMessage[] = [];

  let i = 0;
  let pendingToolUseIds: string[] = [];

  while (i < messages.length) {
    const m = messages[i];

    if (m.role === "system") {
      system += (system ? "\n" : "") + m.content;
      i++;
      continue;
    }

    if (m.role === "tool") {
      // Batch consecutive tool messages into one user message.
      const toolResultBlocks: AnthropicContent[] = [];
      let j = 0;
      while (i < messages.length && messages[i].role === "tool") {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: pendingToolUseIds[j] ?? `toolu_missing_${j}`,
          content: messages[i].content,
        });
        i++;
        j++;
      }
      result.push({ role: "user", content: toolResultBlocks });
      pendingToolUseIds = [];
      continue;
    }

    if (m.role === "user") {
      const content: AnthropicContent[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const b64 of m.images ?? []) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
      }
      result.push({
        role: "user",
        content: content.length === 1 && content[0].type === "text" ? m.content : content,
      });
      pendingToolUseIds = [];
      i++;
      continue;
    }

    if (m.role === "assistant") {
      const content: AnthropicContent[] = [];
      if (m.content) content.push({ type: "text", text: m.content });

      pendingToolUseIds = [];
      for (let k = 0; k < (m.tool_calls ?? []).length; k++) {
        const tc = m.tool_calls![k];
        const id = `toolu_${i}_${k}`;
        pendingToolUseIds.push(id);
        content.push({
          type: "tool_use",
          id,
          name: tc.function?.name ?? "",
          input: (tc.function?.arguments ?? {}) as Record<string, unknown>,
        });
      }
      result.push({ role: "assistant", content });
      i++;
      continue;
    }

    i++;
  }

  return { system, messages: result };
}

type AnthropicTool = { name: string; description?: string; input_schema: unknown };

function toAnthropicTools(tools: unknown[]): AnthropicTool[] {
  return (tools as { type: string; function: { name: string; description?: string; parameters: unknown } }[])
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
}

// ============================================================
// Shared helpers
// ============================================================

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * One chat call with conversion at the boundaries — internal Message[] in,
 * normalised ChatResponse out. Cancellable via AbortSignal.
 */
export async function chatOnce(client: LlmClient, opts: ChatOptions): Promise<ChatResponse> {
  const start = Date.now();

  if (client.provider === "anthropic") {
    const { system, messages } = toAnthropic(opts.messages);
    const anthropicTools = toAnthropicTools(opts.tools ?? []);

    const params: Parameters<typeof client.client.messages.create>[0] = {
      model: opts.model,
      max_tokens: 8192,
      temperature: opts.temperature ?? 0.2,
      messages: messages as Parameters<typeof client.client.messages.create>[0]["messages"],
      ...(system ? { system } : {}),
      ...(anthropicTools.length > 0
        ? { tools: anthropicTools as Parameters<typeof client.client.messages.create>[0]["tools"], tool_choice: { type: "auto" } }
        : {}),
    };

    const response = (await client.client.messages.create(params, {
      signal: opts.signal,
    } as Parameters<typeof client.client.messages.create>[1])) as Anthropic.Message;

    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          function: {
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        });
      }
    }

    return {
      message: { content, tool_calls: toolCalls },
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
      },
      duration_ms: Date.now() - start,
    };
  }

  // OpenAI-compatible path (unchanged)
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAI(opts.messages),
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.think === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const completion = (await client.client.chat.completions.create(
    body as unknown as Parameters<typeof client.client.chat.completions.create>[0],
    { signal: opts.signal },
  )) as unknown as {
    choices: Array<{
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = completion.choices[0];
  const msg = choice.message;
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    function: { name: tc.function.name, arguments: safeParseArgs(tc.function.arguments) },
  }));

  return {
    message: { content: msg.content ?? "", tool_calls: toolCalls },
    usage: {
      prompt_tokens: completion.usage?.prompt_tokens ?? 0,
      completion_tokens: completion.usage?.completion_tokens ?? 0,
    },
    duration_ms: Date.now() - start,
  };
}
