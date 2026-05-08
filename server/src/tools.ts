import type { Session } from "./browser.ts";
import { takeSnapshot } from "./snapshot.ts";

/**
 * Tool definitions sent to Ollama. The primary loop is `snapshot` → `act` —
 * `snapshot` gives the model a labeled list of every visible interactive
 * element on the page (each tagged with `data-tickle-id`), and `act` performs
 * an action by id. Selectors are no longer the model's concern.
 */
export const toolDefs = [
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the browser to a URL. Auto-snapshots the new page.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "snapshot",
      description:
        "Inspect the current page: returns a labeled list of visible interactive elements (tabs, buttons, links, inputs, …) with id, role, and accessible name. Use these ids with `act`. On dense pages, defaults to elements currently in the viewport — scroll then snapshot again to see more, or pass `all=true` to bypass the filter, or `query` to search the whole page by substring.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive name substring; searches the whole page (ignores viewport filter)" },
          all: { type: "boolean", description: "Include off-screen elements too. Default false on dense pages, true on sparse ones.", default: false },
          max: { type: "number", description: "Maximum elements (default 150)", default: 150 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "act",
      description:
        "Perform an action on an element from the most recent snapshot. Actions: click, fill (typing into a textbox — `value` is the text), press (a key while focused — `value` is the key), check, uncheck, hover, select_option (`value` is the option text or value).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Element id from the latest snapshot" },
          action: {
            type: "string",
            enum: ["click", "fill", "press", "check", "uncheck", "hover", "select_option"],
          },
          value: { type: "string", description: "Required for fill, press, select_option" },
        },
        required: ["id", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_text",
      description:
        "Read the visible text content of the page or a specific element. Skips scripts, hidden elements, and other non-visible content. Use this for extracting page content; use `snapshot` for finding things to click.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string", description: "Optional CSS selector" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page by a number of pixels (positive = down).",
      parameters: {
        type: "object",
        properties: { pixels: { type: "number" } },
        required: ["pixels"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for",
      description: "Wait for an element matching a CSS selector to appear in the DOM.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          timeout_ms: { type: "number", default: 8000 },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a key at the page level (no element focus). Use act(id, 'press', key) to press into a specific element.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", description: "e.g. Enter, Escape, Tab, ArrowDown" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Take a fresh screenshot of the current viewport (the model receives the image). Most state changes auto-screenshot — use this only when you want a new view without changing state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch the readable text of a URL in a temporary background tab — does NOT navigate the main page. Useful for following 'instructions', 'tool schema', or 'documentation' links to gather context without losing your place. Returns up to ~6KB of cleaned text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
        },
        required: ["url"],
      },
    },
  },
] as const;

export type ToolResult =
  | { ok: true; text?: string; image_base64?: string; data?: unknown }
  | { ok: false; error: string };

type Args = Record<string, unknown>;

export async function executeTool(
  session: Session,
  name: string,
  args: Args,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "navigate": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, error: "navigate.url must be http(s)://" };
        }
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        return { ok: true, text: `Navigated to ${session.page.url()}` };
      }

      case "snapshot": {
        const snap = await takeSnapshot(session, {
          query: args.query ? String(args.query) : undefined,
          all: Boolean(args.all),
          max: args.max ? Number(args.max) : undefined,
        });
        return {
          ok: true,
          text: snap.text,
          data: {
            elements: snap.elements,
            hidden_below_fold: snap.hidden_below_fold,
            url: snap.url,
            title: snap.title,
          },
          image_base64: snap.base64,
        };
      }

      case "act": {
        const id = Number(args.id ?? -1);
        const action = String(args.action ?? "");
        const value = args.value !== undefined ? String(args.value) : undefined;
        if (!Number.isInteger(id) || id < 0) {
          return { ok: false, error: "act.id must be a non-negative integer from the latest snapshot" };
        }
        const selector = `[data-tickle-id="${id}"]`;
        const locator = session.page.locator(selector).first();
        const count = await locator.count();
        if (count === 0) {
          return {
            ok: false,
            error: `No element with id ${id}. The page may have changed; call snapshot() again.`,
          };
        }

        switch (action) {
          case "click":
            await locator.click({ timeout: 8000 });
            return { ok: true, text: `Clicked [${id}]. URL is now ${session.page.url()}` };
          case "fill": {
            if (typeof value !== "string") {
              return { ok: false, error: "act.fill requires a `value` string" };
            }
            await locator.fill(value, { timeout: 8000 });
            return { ok: true, text: `Filled [${id}] with "${value.slice(0, 80)}"` };
          }
          case "press": {
            if (!value) return { ok: false, error: "act.press requires a `value` (key name)" };
            await locator.press(value, { timeout: 8000 });
            return { ok: true, text: `Pressed ${value} on [${id}]. URL is now ${session.page.url()}` };
          }
          case "check":
            await locator.check({ timeout: 8000 });
            return { ok: true, text: `Checked [${id}]` };
          case "uncheck":
            await locator.uncheck({ timeout: 8000 });
            return { ok: true, text: `Unchecked [${id}]` };
          case "hover":
            await locator.hover({ timeout: 8000 });
            return { ok: true, text: `Hovered [${id}]` };
          case "select_option": {
            if (typeof value !== "string") {
              return { ok: false, error: "act.select_option requires a `value`" };
            }
            await locator.selectOption(value, { timeout: 8000 });
            return { ok: true, text: `Selected "${value}" in [${id}]` };
          }
          default:
            return {
              ok: false,
              error: `Unknown action "${action}". Valid: click, fill, press, check, uncheck, hover, select_option.`,
            };
        }
      }

      case "read_text": {
        const selector = args.selector ? String(args.selector) : null;
        const text = await session.page.evaluate((sel) => {
          const root = sel ? document.querySelector(sel) : document.body;
          if (!root) return "";

          const HIDDEN_TAGS = new Set([
            "script", "style", "template", "noscript", "meta", "link", "head", "title",
          ]);

          const isInjectionRisk = (el: Element): boolean => {
            const tag = el.tagName.toLowerCase();
            if (HIDDEN_TAGS.has(tag)) return true;
            if (el.getAttribute("aria-hidden") === "true") return true;
            const style = window.getComputedStyle(el as Element);
            if (style.display === "none") return true;
            if (style.visibility === "hidden") return true;
            if (parseFloat(style.opacity || "1") === 0) return true;
            if (parseFloat(style.fontSize || "16") <= 0.5) return true;
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return true;
            if (style.color && style.backgroundColor && style.color === style.backgroundColor) {
              return true;
            }
            return false;
          };

          const blockTags = new Set([
            "div", "p", "br", "tr", "li", "section", "article",
            "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "nav",
          ]);

          const walk = (node: Node): string => {
            if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
            if (node.nodeType !== Node.ELEMENT_NODE) return "";
            const el = node as Element;
            if (isInjectionRisk(el)) return "";
            let out = "";
            for (const child of Array.from(el.childNodes)) {
              out += walk(child);
            }
            if (blockTags.has(el.tagName.toLowerCase())) out += "\n";
            return out;
          };

          return walk(root);
        }, selector);
        const trimmed = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
        return { ok: true, text: trimmed || "(empty)" };
      }

      case "scroll": {
        const pixels = Number(args.pixels ?? 0);
        await session.page.evaluate((px) => window.scrollBy(0, px), pixels);
        return { ok: true, text: `Scrolled ${pixels}px` };
      }

      case "wait_for": {
        const selector = String(args.selector ?? "");
        const timeout = Number(args.timeout_ms ?? 8000);
        await session.page.locator(selector).first().waitFor({ state: "attached", timeout });
        return { ok: true, text: `Element ${selector} present` };
      }

      case "press_key": {
        await session.page.keyboard.press(String(args.key ?? ""));
        return { ok: true, text: `Pressed ${args.key}` };
      }

      case "screenshot": {
        const { base64 } = await session.screenshot();
        return { ok: true, image_base64: base64, text: "(screenshot attached)" };
      }

      case "fetch_url": {
        const url = String(args.url ?? "");
        if (!/^https?:\/\//i.test(url)) {
          return { ok: false, error: "fetch_url.url must be http(s)://" };
        }
        const ctx = session.page.context();
        const tempPage = await ctx.newPage();
        try {
          await tempPage.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
          const text = await tempPage.evaluate(() => {
            const HIDDEN = new Set(["script", "style", "template", "noscript", "meta", "link", "head", "title"]);
            const isHidden = (el: Element): boolean => {
              if (HIDDEN.has(el.tagName.toLowerCase())) return true;
              if (el.getAttribute("aria-hidden") === "true") return true;
              const s = window.getComputedStyle(el as Element);
              if (s.display === "none" || s.visibility === "hidden") return true;
              if (parseFloat(s.opacity || "1") === 0) return true;
              return false;
            };
            const block = new Set([
              "div", "p", "br", "tr", "li", "section", "article",
              "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "nav",
            ]);
            const walk = (node: Node): string => {
              if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
              if (node.nodeType !== Node.ELEMENT_NODE) return "";
              const el = node as Element;
              if (isHidden(el)) return "";
              let out = "";
              for (const c of Array.from(el.childNodes)) out += walk(c);
              if (block.has(el.tagName.toLowerCase())) out += "\n";
              return out;
            };
            const root = document.body || document.documentElement;
            return walk(root)
              .replace(/[ \t]+\n/g, "\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          });
          const finalUrl = tempPage.url();
          const trimmed = text.slice(0, 6000);
          return {
            ok: true,
            text: `Fetched ${finalUrl} (${text.length} chars, returning first ${trimmed.length}):\n\n${trimmed}`,
          };
        } catch (err) {
          return { ok: false, error: `fetch_url failed: ${(err as Error).message}` };
        } finally {
          try {
            await tempPage.close();
          } catch {
            // ignore
          }
        }
      }

      default:
        // finish_step is intercepted by agent.ts::runAiSubGoal before
        // dispatch reaches here. Any other unknown name is a model
        // hallucination; report it cleanly so the loop can stall-detect.
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
