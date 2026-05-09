import type { Session } from "./browser.ts";

export type SnapshotElement = {
  id: number;
  role: string;
  name: string;
  state?: string;
  href?: string;
  value?: string;
};

export type Snapshot = {
  elements: SnapshotElement[];
  hidden_below_fold: number;
  text: string;
  base64: string;
  url: string;
  title: string;
};

/**
 * Walk the page, collect every visible interactive element, tag with
 * `data-tickle-id`, return a labeled list + screenshot. The model uses
 * the ids to drive the `act` tool — no selectors needed.
 */
export async function takeSnapshot(
  session: Session,
  opts: { query?: string; max?: number; all?: boolean } = {},
): Promise<Snapshot> {
  const max = Math.max(1, Math.min(500, Number(opts.max ?? 150)));
  const query = opts.query ? String(opts.query).toLowerCase() : null;
  // When dense pages would otherwise drown the model in elements, default to
  // showing only what's currently in viewport. Caller can opt out with all=true.
  const viewportOnly = !opts.all && !query;
  const VIEWPORT_FILTER_THRESHOLD = 50;

  const result = await session.page.evaluate(
    ({ max, query, viewportOnly, threshold }) => {
      // Clear stale data-tickle-id attributes from any prior snapshot/scan.
      // SPAs can re-render between calls and clobber tags in unpredictable
      // ways; resetting here makes id assignment deterministic.
      document
        .querySelectorAll("[data-tickle-id]")
        .forEach((el) => el.removeAttribute("data-tickle-id"));

      const SELECTOR = [
        "a[href]",
        "button",
        'input:not([type="hidden"])',
        "select",
        "textarea",
        "[contenteditable='true']",
        "[role='button']",
        "[role='link']",
        "[role='tab']",
        "[role='menuitem']",
        "[role='checkbox']",
        "[role='radio']",
        "[role='switch']",
        "[role='combobox']",
        "[role='option']",
        "[role='treeitem']",
        "[role='searchbox']",
        "[role='textbox']",
        "[onclick]",
      ].join(",");

      // keep-in-sync: visibility.ts (display:none / visibility:hidden /
      // opacity 0 / zero rect). Inline because page.evaluate can't import.
      const isVisible = (el: Element): boolean => {
        // aria-hidden="true" on self or any ancestor removes the element
        // from the accessibility tree — never expose to the model.
        if (el.closest("[aria-hidden='true']")) return false;
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const s = window.getComputedStyle(el);
        if (s.display === "none") return false;
        if (s.visibility === "hidden") return false;
        if (parseFloat(s.opacity || "1") === 0) return false;
        // walk up: any ancestor with display:none / visibility:hidden hides this
        let p: Element | null = el.parentElement;
        while (p) {
          const ps = window.getComputedStyle(p);
          if (ps.display === "none" || ps.visibility === "hidden") return false;
          p = p.parentElement;
        }
        return true;
      };

      const inferRole = (el: Element): string | null => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return el.hasAttribute("href") ? "link" : null;
        if (tag === "button") return "button";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const t = ((el as HTMLInputElement).type || "text").toLowerCase();
          if (t === "checkbox") return "checkbox";
          if (t === "radio") return "radio";
          if (t === "submit" || t === "button" || t === "reset") return "button";
          if (t === "range") return "slider";
          if (t === "file") return "button";
          return "textbox";
        }
        if ((el as HTMLElement).isContentEditable) return "textbox";
        if (el.hasAttribute("onclick")) return "button";
        return null;
      };

      const accessibleName = (el: Element): string => {
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel.trim();

        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const ids = labelledBy.split(/\s+/);
          const parts: string[] = [];
          for (const id of ids) {
            const ref = document.getElementById(id);
            if (ref) parts.push((ref.textContent || "").trim());
          }
          const joined = parts.filter(Boolean).join(" ");
          if (joined) return joined;
        }

        // <label for="id">
        const id = el.getAttribute("id");
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) {
            const t = (lbl.textContent || "").trim();
            if (t) return t;
          }
        }

        // wrapping <label>
        const wrappingLabel = el.closest("label");
        if (wrappingLabel) {
          const t = (wrappingLabel.textContent || "").trim();
          if (t) return t;
        }

        // alt text on contained image
        const img = el.querySelector("img[alt]");
        if (img) {
          const alt = img.getAttribute("alt") ?? "";
          if (alt.trim()) return alt.trim();
        }

        // visible text
        const text = ((el as HTMLElement).innerText || el.textContent || "").trim();
        if (text) return text.replace(/\s+/g, " ");

        // input placeholder / value
        if ("placeholder" in el && (el as HTMLInputElement).placeholder) {
          return `(placeholder: ${(el as HTMLInputElement).placeholder.trim()})`;
        }
        if ("value" in el && (el as HTMLInputElement).value) {
          return `(value: ${(el as HTMLInputElement).value.trim().slice(0, 60)})`;
        }

        const title = el.getAttribute("title");
        if (title) return title.trim();

        return "";
      };

      const stateOf = (el: Element): string => {
        const flags: string[] = [];
        if (el.getAttribute("aria-selected") === "true") flags.push("selected");
        if (el.getAttribute("aria-checked") === "true") flags.push("checked");
        if ("checked" in el && (el as HTMLInputElement).checked) flags.push("checked");
        if (el.getAttribute("aria-disabled") === "true") flags.push("disabled");
        if ("disabled" in el && (el as HTMLInputElement).disabled) flags.push("disabled");
        if (el.getAttribute("aria-expanded") === "true") flags.push("expanded");
        const cur = el.getAttribute("aria-current");
        if (cur && cur !== "false") flags.push(cur === "true" ? "current" : `current=${cur}`);
        if (document.activeElement === el) flags.push("focused");
        return flags.join(",");
      };

      const isInViewport = (el: Element): boolean => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
      };

      // Two-pass: collect everything that qualifies, then maybe filter to viewport.
      const seen = new Set<Element>();
      const candidates = Array.from(document.querySelectorAll(SELECTOR));
      type Item = {
        id: number;
        role: string;
        name: string;
        state?: string;
        href?: string;
        value?: string;
      };
      const all: { el: Element; item: Item; inViewport: boolean }[] = [];

      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el)) continue;
        const role = inferRole(el);
        if (!role) continue;
        const name = accessibleName(el).slice(0, 240);
        const isInputLike = ["textbox", "combobox", "searchbox"].includes(role);
        if (!name && !isInputLike) continue;
        if (query && !name.toLowerCase().includes(query)) continue;
        const item: Item = { id: -1, role, name };
        const state = stateOf(el);
        if (state) item.state = state;
        if (el.tagName === "A") {
          const h = (el as HTMLAnchorElement).href;
          if (h) item.href = h;
        }
        if (isInputLike && "value" in el && (el as HTMLInputElement).value) {
          item.value = (el as HTMLInputElement).value.slice(0, 100);
        }
        all.push({ el, item, inViewport: isInViewport(el) });
      }

      const useViewport = viewportOnly && all.length > threshold;
      const chosen = useViewport ? all.filter((x) => x.inViewport) : all;
      const hidden = useViewport ? all.length - chosen.length : 0;

      const out: Item[] = [];
      let nextId = 0;
      for (const { el, item } of chosen) {
        if (out.length >= max) break;
        item.id = nextId;
        el.setAttribute("data-tickle-id", String(nextId));
        out.push(item);
        nextId++;
      }
      return { elements: out, hidden_below_fold: hidden };
    },
    { max, query, viewportOnly, threshold: VIEWPORT_FILTER_THRESHOLD },
  );

  const elements = result.elements;
  const hiddenBelowFold = result.hidden_below_fold;

  // Render text form
  const lines = elements.map((e) => {
    const stateStr = e.state ? ` (${e.state})` : "";
    const valueStr = e.value ? ` = "${e.value}"` : "";
    const hrefStr = e.href ? ` → ${e.href.slice(0, 80)}` : "";
    return `[${e.id}] ${e.role} "${e.name}"${stateStr}${valueStr}${hrefStr}`;
  });
  let headline: string;
  if (elements.length === 0) {
    headline = query
      ? `(no visible elements match "${query}")`
      : "(no visible interactive elements)";
  } else {
    const matchClause = query ? ` matching "${query}"` : "";
    const inViewportClause = hiddenBelowFold > 0 ? " in viewport" : "";
    headline = `${elements.length} visible interactive element${
      elements.length === 1 ? "" : "s"
    }${inViewportClause}${matchClause}:`;
  }
  const footer =
    hiddenBelowFold > 0
      ? `\n\n[${hiddenBelowFold} more interactive element${
          hiddenBelowFold === 1 ? "" : "s"
        } off-screen — scroll, then snapshot again to see them. Or call snapshot(query="...") to search across the whole page.]`
      : "";
  const text = `${headline}\n${lines.join("\n")}${footer}`;

  const shot = await session.screenshot();
  const url = session.page.url();
  let title = "";
  try {
    title = await session.page.title();
  } catch {
    // ignore
  }

  return { elements, hidden_below_fold: hiddenBelowFold, text, base64: shot.base64, url, title };
}
