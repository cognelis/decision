import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8",
);

const materialRule = (): string => {
  const match = css.match(
    /\.app-shell\s*\{(?<body>[^}]*)\}/su,
  );
  return match?.groups?.body ?? "";
};

describe("desktop glass theme", () => {
  it("uses one translucent material for the desktop shell", () => {
    const rule = materialRule();

    expect(rule).not.toBe("");
    expect(rule).toContain(
      "backdrop-filter: blur(24px) saturate(145%);",
    );
    expect(rule).toContain(
      "-webkit-backdrop-filter: blur(24px) saturate(145%);",
    );
    expect(rule).toContain("var(--window)");
  });

  it("keeps forced light and dark previews visibly translucent", () => {
    expect(css).toMatch(
      /html\[data-preview-theme="light"\]\s*\{[^}]*--window:\s*rgb\(238 238 236 \/ 14%\);/su,
    );
    expect(css).toMatch(
      /html\[data-preview-theme="dark"\]\s*\{[^}]*--window:\s*rgb\(8 9 12 \/ 40%\);/su,
    );
  });

  it("uses neutral glass instead of blue-green page tinting", () => {
    expect(css).toContain("--surface: rgb(20 21 24 / 26%);");
    expect(css).not.toContain("rgb(37 185 140 / 42%)");
    expect(css).not.toContain("rgb(75 104 192 / 38%)");
    expect(css).not.toContain(
      "color-mix(in srgb, var(--accent-surface) 28%, transparent)",
    );
  });

  it("uses a violet brand accent instead of the former green palette", () => {
    expect(css).toContain("--accent: #6553b8;");
    expect(css).toContain("--accent: #b9adff;");
    expect(css).toContain("--accent-surface: rgb(93 75 155 / 34%);");
    expect(css).not.toContain("--accent: #147c61;");
    expect(css).not.toContain("--accent: #8ee3c5;");
    expect(css).not.toContain("rgb(76 178 143 / 28%)");
  });

  it("lets native Liquid Glass own the backdrop on macOS 26", () => {
    const match = css.match(
      /html\[data-native-glass="true"\]\s+\.app-shell\s*\{(?<body>[^}]*)\}/su,
    );
    const rule = match?.groups?.body ?? "";

    expect(rule).not.toBe("");
    expect(rule).toContain("backdrop-filter: none;");
    expect(rule).toContain("-webkit-backdrop-filter: none;");
    expect(rule).not.toContain("radial-gradient");
  });
});
