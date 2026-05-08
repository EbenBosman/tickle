import { describe, expect, it } from "vitest";
import { classifyFormInput } from "../formScan.ts";

// docs/specs/server/form-scan.md — "Likely bugs: scanForm includes
// [role='combobox'] but classifier has no combobox branch"
//
// classifyFormInput is the testable extract of the classification logic
// that lives inside the scanForm page.evaluate callback. The two copies
// must stay in sync; see the comment in formScan.ts. This test pins the
// expected outputs.

describe("classifyFormInput — native HTML inputs", () => {
  it("classifies a textarea as textarea", () => {
    expect(classifyFormInput({ tag: "textarea" })).toBe("textarea");
  });

  it("classifies a select as select", () => {
    expect(classifyFormInput({ tag: "select" })).toBe("select");
  });

  it("classifies an input[type=text] (and friends) as text", () => {
    for (const type of ["text", "email", "url", "search", "number", "tel", "password"]) {
      expect(classifyFormInput({ tag: "input", type })).toBe("text");
    }
  });

  it("classifies an input with no type attribute as text (HTML default)", () => {
    expect(classifyFormInput({ tag: "input" })).toBe("text");
  });

  it("classifies an input[type=checkbox] as checkbox", () => {
    expect(classifyFormInput({ tag: "input", type: "checkbox" })).toBe("checkbox");
  });

  it("classifies an input[type=radio] as radio", () => {
    expect(classifyFormInput({ tag: "input", type: "radio" })).toBe("radio");
  });

  it("classifies submit/button/reset inputs as button", () => {
    for (const type of ["submit", "button", "reset"]) {
      expect(classifyFormInput({ tag: "input", type })).toBe("button");
    }
  });
});

describe("classifyFormInput — ARIA roles", () => {
  it("classifies role=checkbox as checkbox", () => {
    expect(classifyFormInput({ tag: "div", role: "checkbox" })).toBe("checkbox");
  });

  it("classifies role=radio as radio", () => {
    expect(classifyFormInput({ tag: "div", role: "radio" })).toBe("radio");
  });

  it("classifies role=switch as checkbox (binary on/off)", () => {
    expect(classifyFormInput({ tag: "div", role: "switch" })).toBe("checkbox");
  });

  it("classifies role=textbox as textarea (rich-text editor pattern)", () => {
    expect(classifyFormInput({ tag: "div", role: "textbox" })).toBe("textarea");
  });

  it("classifies a contenteditable element as textarea", () => {
    expect(classifyFormInput({ tag: "div", isContentEditable: true })).toBe("textarea");
  });

  it("regression: classifies role=combobox as select", () => {
    // Previously fell through to "other" → unfillable. ARIA combobox is
    // "an input widget with an associated popup that enables users to
    // select a value from a collection" — value-from-a-set semantics
    // are exactly the select kind.
    expect(classifyFormInput({ tag: "div", role: "combobox" })).toBe("select");
  });

  it("regression: combobox classification beats input[type=text] inference", () => {
    // Real-world react-select / Headless UI comboboxes render as
    // <input role="combobox" type="text">. The role wins.
    expect(classifyFormInput({ tag: "input", role: "combobox", type: "text" })).toBe("select");
  });
});

describe("classifyFormInput — fallthrough", () => {
  it("returns 'other' for an unrecognised element", () => {
    expect(classifyFormInput({ tag: "span" })).toBe("other");
  });

  it("returns 'other' for an input with an unknown type", () => {
    // input[type=color] / input[type=range] etc — not handled by the
    // existing branches; classified as 'other' so they don't pretend to
    // be fillable text inputs.
    expect(classifyFormInput({ tag: "input", type: "color" })).toBe("other");
  });
});
