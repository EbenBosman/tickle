import type { Session } from "./browser.ts";

export type FormQuestionInput = {
  /** The data-tickle-id we tagged on this input (numeric in string form). */
  tickle_id: number;
  type: "radio" | "checkbox" | "text" | "textarea" | "select" | "button" | "other";
  /** For radio/checkbox: the visible option label or value. */
  option?: string;
  /** For radio: name attribute that groups options. */
  group?: string;
  /** Native input value attribute (for radio/checkbox). */
  value?: string;
  /** Currently checked / selected. */
  checked?: boolean;
  /** Currently filled value (for text/textarea/select). */
  current_value?: string;
};

export type FormQuestion = {
  /** Surface-level question text we believe goes with this group. */
  question: string;
  /** All inputs that we believe are part of this question. */
  inputs: FormQuestionInput[];
  /** Best-guess kind for the question as a whole. */
  kind: "radio" | "checkbox" | "text" | "textarea" | "select" | "mixed";
};

export type FormScan = {
  questions: FormQuestion[];
  /** Total number of inputs detected, regardless of grouping. */
  input_count: number;
};

/**
 * Walk every visible form input on the page, tag each with data-tickle-id,
 * and group them into "questions" by proximity + radio name. Returns a
 * canonical structure that the AI pass can enrich semantically.
 */
/**
 * Deterministic post-action check: given a set of `data-tickle-id` values for
 * the inputs that belong to one question, return whether at least one is now
 * "answered" (a radio/checkbox is checked, a text/select has a non-default
 * value, or a contenteditable has any content). This avoids burning an extra
 * LLM call to ask "is this question answered?" — which on a 26-30B class model takes
 * 30-60s per question and hallucinates when the page is busy.
 */
export async function checkQuestionAnswered(
  session: Session,
  ids: number[],
): Promise<{
  answered: boolean;
  hits: { id: number; type: string; state: string; value?: string }[];
  reason: string;
}> {
  if (ids.length === 0) {
    return { answered: false, hits: [], reason: "no inputs to check" };
  }
  return await session.page.evaluate(
    (ids) => {
      const hits: { id: number; type: string; state: string; value?: string }[] = [];
      let answered = false;
      for (const id of ids) {
        const el = document.querySelector(`[data-tickle-id="${id}"]`);
        if (!el) {
          hits.push({ id, type: "missing", state: "absent" });
          continue;
        }
        const tag = el.tagName.toLowerCase();
        const t = (el as HTMLInputElement).type?.toLowerCase?.() ?? "";
        const role = el.getAttribute("role") ?? "";

        const isCheckable = role === "checkbox" || role === "radio" || role === "switch" || t === "checkbox" || t === "radio";
        const isText = tag === "textarea" || (tag === "input" && (t === "text" || t === "email" || t === "url" || t === "search" || t === "number" || t === "tel" || !t));
        const isSelect = tag === "select";
        const isCE = (el as HTMLElement).isContentEditable;

        if (isCheckable) {
          const checked =
            (el as HTMLInputElement).checked === true ||
            el.getAttribute("aria-checked") === "true" ||
            el.getAttribute("aria-selected") === "true";
          hits.push({ id, type: role || t, state: checked ? "checked" : "unchecked" });
          if (checked) answered = true;
        } else if (isText) {
          const v = ((el as HTMLInputElement).value ?? "").trim();
          hits.push({ id, type: "text", state: v ? "filled" : "empty", value: v.slice(0, 80) });
          if (v) answered = true;
        } else if (isSelect) {
          const sel = el as HTMLSelectElement;
          const v = sel.value;
          const opt = sel.options[sel.selectedIndex];
          const isDefault = sel.selectedIndex <= 0 && (!v || v === "" || (opt && (opt.disabled || /please|choose|select/i.test(opt.text))));
          hits.push({ id, type: "select", state: isDefault ? "default" : "selected", value: v });
          if (!isDefault) answered = true;
        } else if (isCE) {
          const v = ((el as HTMLElement).innerText ?? "").trim();
          hits.push({ id, type: "contenteditable", state: v ? "filled" : "empty", value: v.slice(0, 80) });
          if (v) answered = true;
        } else {
          hits.push({ id, type: tag, state: "unknown" });
        }
      }
      return {
        answered,
        hits,
        reason: answered
          ? "at least one input has an answer"
          : "no input is checked or filled",
      };
    },
    ids,
  );
}

export async function scanForm(session: Session): Promise<FormScan> {
  return await session.page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      const s = window.getComputedStyle(el as HTMLElement);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (parseFloat(s.opacity || "1") === 0) return false;
      let p: Element | null = el.parentElement;
      while (p) {
        const ps = window.getComputedStyle(p);
        if (ps.display === "none" || ps.visibility === "hidden") return false;
        p = p.parentElement;
      }
      return true;
    };

    const labelFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return ((lbl as HTMLElement).innerText || lbl.textContent || "").trim();
      }
      const wrap = el.closest("label");
      if (wrap) return ((wrap as HTMLElement).innerText || wrap.textContent || "").trim();
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const ref = document.getElementById(labelledBy);
        if (ref) return ((ref as HTMLElement).innerText || ref.textContent || "").trim();
      }
      return "";
    };

    /** Walk up the DOM until we find a likely "question container" — fieldset, role=group, .form-group/.field/.question class, or the closest ancestor that contains 2+ radio/checkbox inputs (i.e., a multi-option question). */
    const findQuestionContainer = (el: Element): Element => {
      let p: Element | null = el.parentElement;
      while (p && p !== document.body) {
        const tag = p.tagName.toLowerCase();
        if (tag === "fieldset") return p;
        const role = p.getAttribute("role");
        if (role === "group" || role === "radiogroup") return p;
        if (
          p.classList &&
          (p.classList.contains("form-group") ||
            p.classList.contains("field") ||
            p.classList.contains("question"))
        ) {
          return p;
        }
        // Heuristic: if this ancestor contains 2-12 checkable inputs and our
        // own input is one of them, treat it as a multi-option question container.
        const checkables = p.querySelectorAll(
          "input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']",
        );
        if (checkables.length >= 2 && checkables.length <= 14) {
          return p;
        }
        p = p.parentElement;
      }
      return el.parentElement || el;
    };

    /** Stable hash for using a DOM element as a Map key (path of indices to root). */
    const elementPath = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.parentElement && cur !== document.body) {
        const idx = Array.from(cur.parentElement.children).indexOf(cur);
        parts.push(`${cur.tagName.toLowerCase()}:${idx}`);
        cur = cur.parentElement;
      }
      return parts.join("/");
    };

    /** Get the question text near a container. Walks UP looking for a heading or preceding paragraph; only falls back to the container's own innerText as a last resort (because that often includes the input labels themselves). */
    const questionTextFor = (container: Element): string => {
      // 1. legend inside container
      const legend = container.querySelector("legend");
      if (legend) {
        const t = ((legend as HTMLElement).innerText || legend.textContent || "").trim();
        if (t) return t;
      }
      // 2. Heading inside container that isn't part of an input label
      const heading = container.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading && !heading.closest("label")) {
        const t = ((heading as HTMLElement).innerText || heading.textContent || "").trim();
        if (t) return t;
      }
      // 3. Walk UP looking for a heading or paragraph ABOVE this container.
      //    We climb through up to 4 ancestor levels and check preceding siblings at each.
      let cur: Element | null = container;
      for (let level = 0; level < 4 && cur; level++) {
        let prev: Element | null = cur.previousElementSibling;
        let scans = 0;
        while (prev && scans < 6) {
          if (/^(h[1-6]|legend)$/i.test(prev.tagName)) {
            const t = ((prev as HTMLElement).innerText || prev.textContent || "").trim();
            if (t.length > 3 && t.length < 400) return t;
          }
          if (/^(p|label|div|span)$/i.test(prev.tagName)) {
            const t = ((prev as HTMLElement).innerText || prev.textContent || "").trim();
            // Substantive text — short labels like "Yes" / "No" disqualify
            if (t.length > 8 && t.length < 400 && !/^(yes|no|true|false)\W?$/i.test(t)) {
              return t;
            }
          }
          prev = prev.previousElementSibling;
          scans++;
        }
        cur = cur.parentElement;
      }
      // 4. Last resort: container's own text. Often this is the radio labels
      //    concatenated together — caller should treat this as low-confidence.
      return ((container as HTMLElement).innerText || container.textContent || "").trim().slice(0, 240);
    };

    const SELECTOR =
      "input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='checkbox'], [role='radio'], [role='switch'], [role='combobox'], [role='textbox']";

    /** Reject inputs whose ancestor chain crosses a clear non-form region
     *  (nav / header / aside / footer / role=navigation). Also reject inputs
     *  that sit inside an <a href> — clicking them would navigate. */
    const isInsideNonFormRegion = (el: Element): boolean => {
      let p: Element | null = el.parentElement;
      while (p && p !== document.body) {
        const tag = p.tagName.toLowerCase();
        if (tag === "nav" || tag === "header" || tag === "aside" || tag === "footer") return true;
        const role = p.getAttribute("role");
        if (role === "navigation" || role === "banner" || role === "complementary" || role === "contentinfo") {
          return true;
        }
        // Inputs nested inside an anchor are navigation hazards — clicking
        // bubbles up and triggers the link.
        if (tag === "a" && p.hasAttribute("href")) {
          const href = p.getAttribute("href") ?? "";
          // Allow href="#" and href="javascript:..." — those don't navigate.
          if (href && href !== "#" && !href.startsWith("javascript:")) return true;
        }
        p = p.parentElement;
      }
      return false;
    };

    /** True if the element is a "real" form input — actual <input>, <select>,
     *  <textarea>, or contenteditable. Role-only elements (div role=radio etc)
     *  are styled buttons that may have surprising click handlers. */
    const isRealFormInput = (el: Element): boolean => {
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    };

    /** Prefer to scope the scan to the dominant form container — falls back to
     *  document if no <form> is found. */
    const pickRoot = (): ParentNode => {
      const forms = Array.from(document.querySelectorAll("form")) as HTMLFormElement[];
      if (forms.length === 0) return document;
      // Pick the form with the most form-input descendants.
      let best: HTMLFormElement | null = null;
      let bestCount = 0;
      for (const f of forms) {
        const count = f.querySelectorAll(SELECTOR).length;
        if (count > bestCount) {
          best = f;
          bestCount = count;
        }
      }
      return best ?? document;
    };

    const root = pickRoot();
    const allMatched = Array.from((root as ParentNode).querySelectorAll(SELECTOR))
      .filter(isVisible)
      .filter((el) => !isInsideNonFormRegion(el));

    // Two-tier strategy: prefer real form inputs (<input>/<select>/<textarea>/
    // contenteditable). Only fall back to role-based elements if the page has
    // no real inputs at all (which would mean a fully custom React form).
    const realInputs = allMatched.filter(isRealFormInput);
    const inputs = realInputs.length > 0 ? realInputs : allMatched;

    let inputCount = 0;
    type RawInput = {
      el: Element;
      input: FormQuestionInput;
      groupKey: string;
    };
    const raws: RawInput[] = [];

    // We pre-tag inputs with a unique id so the AI / executor can address them.
    let nextId = 0;

    for (const el of inputs) {
      inputCount++;
      const tag = el.tagName.toLowerCase();
      const explicitRole = el.getAttribute("role");
      const t = (el as HTMLInputElement).type?.toLowerCase?.();
      let kind: FormQuestionInput["type"] = "other";
      if (tag === "textarea") kind = "textarea";
      else if (tag === "select") kind = "select";
      else if (explicitRole === "checkbox" || t === "checkbox") kind = "checkbox";
      else if (explicitRole === "radio" || t === "radio") kind = "radio";
      else if (explicitRole === "switch") kind = "checkbox";
      else if (tag === "input" && (t === "text" || t === "email" || t === "url" || t === "search" || !t || t === "number" || t === "tel" || t === "password")) {
        kind = "text";
      } else if (tag === "input" && (t === "submit" || t === "button" || t === "reset")) {
        kind = "button";
      } else if (explicitRole === "textbox" || (el as HTMLElement).isContentEditable) {
        kind = "textarea";
      }

      el.setAttribute("data-tickle-id", String(nextId));

      const optionLabel = labelFor(el);
      const name = el.getAttribute("name") || "";
      const value = (el as HTMLInputElement).value;
      const checked = (el as HTMLInputElement).checked === true;

      // Group: radios with the same name (or, if no name, the same question
      // container) merge into one question. Checkboxes group by name OR by
      // shared container. Text inputs stand alone unless they share a small
      // container with another input (rare).
      const container = findQuestionContainer(el);
      const containerKey = elementPath(container);
      let groupKey: string;
      if (kind === "radio") {
        groupKey = name ? `radio:${name}` : `radio-container:${containerKey}`;
      } else if (kind === "checkbox") {
        groupKey = name ? `checkbox:${name}` : `checkbox-container:${containerKey}`;
      } else {
        groupKey = `solo:${nextId}`;
      }

      raws.push({
        el,
        groupKey,
        input: {
          tickle_id: nextId,
          type: kind,
          option: optionLabel || undefined,
          group: name || undefined,
          value: value || undefined,
          checked: kind === "radio" || kind === "checkbox" ? checked : undefined,
          current_value: kind === "text" || kind === "textarea" || kind === "select" ? value : undefined,
        },
      });

      nextId++;
    }

    // Fold into questions by groupKey (radios merge, others stay solo).
    const byGroup = new Map<string, RawInput[]>();
    for (const r of raws) {
      const arr = byGroup.get(r.groupKey) ?? [];
      arr.push(r);
      byGroup.set(r.groupKey, arr);
    }

    const questions: FormQuestion[] = [];
    for (const arr of byGroup.values()) {
      const first = arr[0];
      const container = findQuestionContainer(first.el);
      const questionText = questionTextFor(container);
      const types = new Set(arr.map((a) => a.input.type));
      const kind: FormQuestion["kind"] =
        types.size === 1
          ? (Array.from(types)[0] as FormQuestion["kind"])
          : "mixed";
      questions.push({
        question: questionText.slice(0, 400),
        kind,
        inputs: arr.map((a) => a.input),
      });
    }

    return { questions, input_count: inputCount };
  });
}
