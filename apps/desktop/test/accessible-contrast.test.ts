import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * Contrast worked out from the colour tokens themselves, in all four palettes (light and dark, by the system or forced
 * for a preview). The app's text runs 9–12px, so text needs 4.5:1; a focus indicator needs 3:1 against what it sits on.
 */
const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

/** The declarations of the block opened by the first `{` after `marker`. */
const block = (marker: string): string => {
  const opening = css.indexOf("{", css.indexOf(marker));
  let depth = 0;
  for (let cursor = opening; cursor < css.length; cursor++) {
    if (css[cursor] === "{") depth++;
    else if (css[cursor] === "}" && --depth === 0) return css.slice(opening + 1, cursor);
  }
  throw new Error(`unbalanced block after ${marker}`);
};
const palette = (marker: string): Record<string, string> =>
  Object.fromEntries([...block(marker).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map((match) => [match[1]!, match[2]!.toLowerCase()]));
const palettes = {
  light: palette(":root {"),
  dark: palette("@media (prefers-color-scheme: dark)"),
  "preview light": palette('html[data-preview-theme="light"] {'),
  "preview dark": palette('html[data-preview-theme="dark"] {'),
};

const luminance = (hex: string): number => {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const ratio = (left: string, right: string): number => {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05);
};
const grounds = ["canvas", "surface", "surface-raised", "surface-hover", "surface-inset", "modal-surface"];
const worstOn = (theme: Record<string, string>, colour: string): number =>
  Math.min(...grounds.map((ground) => ratio(theme[colour]!, theme[ground]!)));

/** Every rule as selector and declarations, nested blocks (media queries) unwrapped. */
const rules = (): Array<{ selector: string; body: string }> =>
  [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/gu, " "),
    body: match[2]!,
  }));

describe("text you can read", () => {
  // --subtle colours some two hundred kinds of 9–11px text (list columns, form labels, counts): it was 2.4–3.6:1.
  it("keeps the two lighter inks at 4.5:1 on every ground, --muted a step stronger than --subtle", () => {
    for (const [name, theme] of Object.entries(palettes)) {
      expect(worstOn(theme, "subtle"), `${name} --subtle`).toBeGreaterThanOrEqual(4.5);
      expect(worstOn(theme, "muted"), `${name} --muted`).toBeGreaterThan(worstOn(theme, "subtle"));
    }
  });
});

describe("state not told by colour alone", () => {
  // The fill that marked a chosen 判断依据 was 1.2:1 against an unchosen one.
  it("marks a chosen rationale factor by weight and a tick as well", () => {
    const selected = rules().filter(({ selector }) => selector.startsWith(".factor-button.selected"));
    expect(selected.some(({ body }) => /font-weight: 6\d\d/u.test(body))).toBe(true);
    expect(selected.some(({ selector, body }) => selector.endsWith("::before") && /content: "✓"/u.test(body))).toBe(true);
  });
});

describe("focus you can see", () => {
  it("outlines a focused list row, where the hover tint alone was 1.1–1.3:1", () => {
    const rows = [
      ".dashboard-review-open", ".decision-search-clear", ".decision-library-row", ".methodology-create-option",
      ".methodology-row", ".methodology-validation-decisions button", ".practice-asset-row", ".methodology-relation-main",
    ];
    for (const row of rows) {
      const focused = rules().filter(({ selector }) => selector.split(", ").includes(`${row}:focus-visible`));
      expect(focused.length, row).toBeGreaterThan(0);
      expect(focused.some(({ body }) => /outline: 2px solid var\(--accent-bright\)/u.test(body)), row).toBe(true);
      expect(focused.some(({ body }) => /outline: 0/u.test(body)), row).toBe(false);
    }
  });

  it("rings a focused field in the bright accent, not the faint tints a select showed nothing else with", () => {
    const fieldFocus = rules().filter(({ selector }) => /:focus/u.test(selector) && !/:hover/u.test(selector));
    expect(fieldFocus.length).toBeGreaterThan(10);
    for (const { selector, body } of fieldFocus) {
      expect(body, selector).not.toMatch(/(?:outline|box-shadow|border-color):[^;]*var\(--accent-(?:surface|border)\)/u);
    }
    for (const [name, theme] of Object.entries(palettes)) {
      expect(worstOn(theme, "accent-bright"), name).toBeGreaterThanOrEqual(3);
    }
  });
});
