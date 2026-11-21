import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { accentTokens, contrast } from "../src/renderer/accent.js";
import { ACCENT_PRESET_IDS, ACCENT_PRESETS } from "../src/shared/appearance.js";

const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

const block = (pattern: RegExp): string => css.match(pattern)?.groups?.body ?? "";

const declared = (body: string, name: string): string | undefined =>
  body.match(new RegExp(`\\s${name}:\\s*(#[0-9a-f]{6});`, "u"))?.[1];

/* Where the accent sits (styles.css): text on the light window ground and on white; on a dark surface; and under
 * the text an accent fill carries, white in light and --surface-raised in dark. */
const readable = (light: string, dark: string): void => {
  expect(contrast(light, "#eef0f3")).toBeGreaterThanOrEqual(4.5);
  expect(contrast(light, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark, "#1a1d23")).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark, "#20242b")).toBeGreaterThanOrEqual(4.5);
};

describe("theme colour (IMP-140)", () => {
  it("declares the blue preset in the stylesheet, so the frame before the page applies the setting matches it", () => {
    const light = block(/^:root\s*\{(?<body>[^}]*)\}/mu);
    const dark = block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{(?<body>[^}]*)\}/u);
    expect(light).not.toBe("");
    expect(dark).not.toBe("");
    for (const [scheme, body] of [["light", light], ["dark", dark]] as const) {
      for (const [name, value] of Object.entries(accentTokens("blue", scheme))) {
        expect(declared(body, name), `${scheme} ${name}`).toBe(value);
      }
    }
  });

  it("keeps every preset readable wherever the accent sits", () => {
    for (const id of ACCENT_PRESET_IDS) {
      readable(ACCENT_PRESETS[id].light, ACCENT_PRESETS[id].dark);
      expect(accentTokens(id, "light")["--accent"]).toBe(ACCENT_PRESETS[id].light);
      expect(accentTokens(id, "dark")["--accent"]).toBe(ACCENT_PRESETS[id].dark);
    }
  });

  it("keeps the text on every derived colour readable: a fill and its hover, accent and its ink on the tint", () => {
    for (const preference of [...ACCENT_PRESET_IDS, "#ff0000", "#ffff00", "#8fd3fe", "#101010", "#7c3aed"] as const) {
      for (const [scheme, onFill] of [["light", "#ffffff"], ["dark", "#20242b"]] as const) {
        const tokens = accentTokens(preference, scheme);
        const at = `${preference} ${scheme}`;
        expect(contrast(onFill, tokens["--accent"]!), `${at} fill`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(onFill, tokens["--accent-bright"]!), `${at} hover`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens["--accent"]!, tokens["--accent-surface"]!), `${at} on tint`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens["--accent-ink"]!, tokens["--accent-surface"]!), `${at} ink on tint`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("darkens or lightens a colour of the reader's own until it reads at 4.5:1, and leaves a readable one as it is", () => {
    for (const color of ["#ffff00", "#8fd3fe", "#101010", "#7c3aed"] as const) {
      readable(accentTokens(color, "light")["--accent"]!, accentTokens(color, "dark")["--accent"]!);
    }
    expect(accentTokens("#1f4fa8", "light")["--accent"]).toBe("#1f4fa8");
  });
});
