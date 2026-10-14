import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheet = () =>
  readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

/** The declarations of the block opened by the first `{` after `marker`. */
const paletteBlock = (css: string, marker: string): string => {
  const opening = css.indexOf("{", css.indexOf(marker));
  let depth = 0;
  let cursor = opening;
  while (true) {
    if (css[cursor] === "{") depth += 1;
    else if (css[cursor] === "}" && (depth -= 1) === 0) break;
    cursor += 1;
  }
  return css.slice(opening, cursor);
};

const tokenNames = (block: string): string[] =>
  [...block.matchAll(/(--[\w-]+):/g)].map((match) => match[1]!);

/**
 * 版式、形状和尺度不随主题变化，只在 `:root` 出现一次；四套调色板里只放颜色。
 * 整族 token（字体 `--font-*`、字号 `--t-*`、圆角 `--r-*`）按前缀排除，以后新增
 * 一个尺寸不必再回来改这份清单。
 */
const LAYOUT_ONLY_PREFIXES = ["--font-", "--t-", "--r-"];
const LAYOUT_ONLY = new Set([
  "--page-padding-block",
  "--page-padding-inline",
  "--primary-toolbar-height",
  "--rail-width",
  "--row-height",
  "--control-height",
]);

const isColorToken = (name: string): boolean =>
  !LAYOUT_ONLY.has(name) &&
  !LAYOUT_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix));

describe("preview theme", () => {
  it("can force dark colors even when the host system is light", async () => {
    expect(await stylesheet()).toContain('html[data-preview-theme="dark"]');
  });

  it("gives every color token a value in all four palettes", async () => {
    const css = await stylesheet();
    const expected = tokenNames(paletteBlock(css, ":root {")).filter(
      isColorToken,
    );
    expect(expected.length).toBeGreaterThan(20);

    for (const marker of [
      "@media (prefers-color-scheme: dark)",
      'html[data-preview-theme="light"] {',
      'html[data-preview-theme="dark"] {',
    ]) {
      expect({ marker, tokens: tokenNames(paletteBlock(css, marker)).sort() }).toEqual({
        marker,
        tokens: [...expected].sort(),
      });
    }
  });
});
