import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { newLlmClient, chatOnce, MODEL } from "../llm.ts";
import { type Block, type BlockKind } from "../blocks.ts";
import { trace } from "../log.ts";
import { asString } from "../coerce.ts";

const COMPILE_SYSTEM = `You are a compiler that turns a user's natural-language task description into a JSON array of typed automation blocks. Output ONLY a JSON object of the form {"blocks": [...]} — no prose, no commentary, no markdown.

Block kinds:
- {"kind": "navigate", "url": "https://..."}
- {"kind": "click", "target": "<short description>", "role": "tab"|"link"|"button"|"checkbox"|"radio"|"menuitem"|"any"}
- {"kind": "fill", "target": "<field description>", "value": "<text or $var>"}
- {"kind": "extract", "target": "<what to extract>", "var_name": "<snake_case name>"}
- {"kind": "goal", "description": "<free-form sub-task>"}
- {"kind": "verify", "condition": "<assertion>", "on_fail": "halt"|"pause"}
- {"kind": "questionnaire", "context": "<short context>"}
- {"kind": "pause", "message": "<short message>"}
- {"kind": "for_each", "items": "$<varname>", "item_var": "item", "body": [<nested blocks>]}

Rules:
- Prefer specific kinds over goal. Use click for "click X", fill for "type X into Y", questionnaire for "complete the form / quiz / questionnaire", verify for "make sure X is true / check that ...".
- DEFAULT \`role\` TO "any" for click blocks. The role filter is a strict matcher and many real sites don't tag tabs/menus with proper ARIA roles. Only set a specific role when the user's wording AND visible UI conventions make it unambiguous (e.g. "the Submit button" → role="button" is fine; "the X tab" → still use "any" because most sites render tabs as plain buttons).
- DROP purely procedural steps the agent handles automatically (e.g. "scroll down", "wait for the page to load"). Do not emit blocks for them.
- For "do not submit the form" instructions: end with a pause block whose message warns about that.
- Use "questionnaire" for ANY task that says complete/answer/fill out questions on a form/page.
- When a step description is fuzzy or contains optional clauses, lean toward a "goal" block rather than guessing strict parameters. The agent is better at handling ambiguity in natural language than in over-specified blocks.
- Order matters — emit blocks in execution order.
- Do NOT include id fields; the host adds them.

If the user's description is empty or unparseable, return {"blocks": []}.`;

const VALID_KINDS: BlockKind[] = [
  "navigate",
  "goal",
  "pause",
  "click",
  "fill",
  "extract",
  "verify",
  "questionnaire",
  "for_each",
];

type RawBlock = Record<string, unknown> & { kind?: string };

function sanitiseBlock(raw: RawBlock): Block | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind ?? "")
    .toLowerCase()
    .trim() as BlockKind;
  if (!VALID_KINDS.includes(kind)) return null;
  const id = randomUUID();

  switch (kind) {
    case "navigate":
      return { id, kind, url: asString(raw.url).trim() };
    case "click": {
      const VALID_ROLES = new Set([
        "any",
        "button",
        "link",
        "tab",
        "menuitem",
        "checkbox",
        "radio",
        "switch",
        "combobox",
        "option",
        "textbox",
      ]);
      const role = typeof raw.role === "string" && VALID_ROLES.has(raw.role) ? raw.role : "any";
      return {
        id,
        kind,
        target: asString(raw.target).trim(),
        role: role as "any",
      };
    }
    case "fill":
      return {
        id,
        kind,
        target: asString(raw.target).trim(),
        value: asString(raw.value).trim(),
      };
    case "extract":
      return {
        id,
        kind,
        target: asString(raw.target).trim(),
        var_name:
          asString(raw.var_name)
            .replace(/[^a-zA-Z0-9_]/g, "")
            .trim() || "result",
      };
    case "goal":
      return { id, kind, description: asString(raw.description ?? raw.goal).trim() };
    case "verify":
      return {
        id,
        kind,
        condition: asString(raw.condition).trim(),
        on_fail: raw.on_fail === "pause" ? "pause" : "halt",
      };
    case "questionnaire":
      return {
        id,
        kind,
        context: typeof raw.context === "string" ? raw.context.trim() : "",
        unanswered_var:
          typeof raw.unanswered_var === "string" && raw.unanswered_var.trim()
            ? raw.unanswered_var.replace(/[^a-zA-Z0-9_]/g, "")
            : "unanswered",
      };
    case "pause":
      return { id, kind, message: asString(raw.message).trim() };
    case "for_each": {
      const body = Array.isArray(raw.body)
        ? (raw.body as RawBlock[]).map(sanitiseBlock).filter((b): b is Block => b !== null)
        : [];
      return {
        id,
        kind,
        items: asString(raw.items).trim(),
        item_var: typeof raw.item_var === "string" && raw.item_var.trim() ? raw.item_var : "item",
        body,
      };
    }
  }
  return null;
}

export async function compileRoutes(app: FastifyInstance) {
  app.post<{ Body: { prompt?: string } }>("/api/blocks/compile", async (req, reply) => {
    const prompt = String(req.body?.prompt ?? "").trim();
    if (!prompt) {
      return { blocks: [] as Block[] };
    }

    const client = newLlmClient();
    let content = "";
    try {
      const response = await chatOnce(client, {
        model: MODEL,
        messages: [
          { role: "system", content: COMPILE_SYSTEM },
          { role: "user", content: `Convert this task description into blocks:\n\n${prompt}` },
        ],
        temperature: 0.1,
        // Compile is a single-turn JSON request; thinking mode just adds latency.
        think: false,
      });
      content = response.message.content.trim();
    } catch (err) {
      trace("compile.error", { error: (err as Error).message });
      return reply.code(502).send({ error: `LLM call failed: ${(err as Error).message}` });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      trace("compile.parse_error", { content_preview: content.slice(0, 200) });
      return reply.code(502).send({
        error: "Model output was not valid JSON",
        raw: content.slice(0, 1000),
      });
    }

    let rawBlocks: unknown = parsed;
    if (parsed && typeof parsed === "object" && "blocks" in parsed) {
      rawBlocks = (parsed).blocks;
    }
    if (!Array.isArray(rawBlocks)) {
      return reply.code(502).send({
        error: "Model output did not contain a `blocks` array",
        raw: JSON.stringify(parsed).slice(0, 1000),
      });
    }

    const blocks = (rawBlocks as RawBlock[])
      .map(sanitiseBlock)
      .filter((b): b is Block => b !== null);

    trace("compile.ok", { input_chars: prompt.length, blocks: blocks.length });
    return { blocks };
  });
}
