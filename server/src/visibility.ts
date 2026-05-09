/**
 * Visibility helper — single source of truth for "is this element visually
 * hidden on the page?".
 *
 * IMPORTANT: this exported function runs in the Node-side test environment
 * and on plain shape objects. The same logic is duplicated INLINE inside
 * `page.evaluate` blocks in `formScan.ts` and `loginDetect.ts` — those
 * blocks cannot import this module (they execute inside the browser
 * context, with no module loader). Both inline copies are marked with a
 * `// keep-in-sync: visibility.ts` comment. Any change here must be
 * mirrored there, and vice versa.
 *
 * Rule: hidden iff
 *   - display === "none"
 *   - OR visibility === "hidden"
 *   - OR parseFloat(opacity) === 0  (catches "0", "0.0", "0.00", etc.)
 *   - OR (rect provided AND rect.width === 0 AND rect.height === 0)
 */

type StyleShape = {
  display?: string;
  visibility?: string;
  opacity?: string;
};

type RectShape = {
  width: number;
  height: number;
};

export function isVisuallyHidden(
  style: StyleShape | CSSStyleDeclaration,
  rect?: RectShape | DOMRect,
): boolean {
  if (style.display === "none") return true;
  if (style.visibility === "hidden") return true;
  const opacity = style.opacity;
  if (typeof opacity === "string" && opacity !== "" && parseFloat(opacity) === 0) {
    return true;
  }
  if (rect?.width === 0 && rect?.height === 0) return true;
  return false;
}
