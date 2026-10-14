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
      /html\[data-preview-theme="light"\]\s*\{[^}]*--window:\s*rgb\(232 234 230 \/ 14%\);/su,
    );
    expect(css).toMatch(
      /html\[data-preview-theme="dark"\]\s*\{[^}]*--window:\s*rgb\(13 14 16 \/ 42%\);/su,
    );
  });

  /*
   * 只有窗口本身半透明，好让 macOS 的原生玻璃有东西可透；里面的工作面一律不
   * 透明。旧版每一层都半透明，桌面壁纸透过四层叠加上来，文字对比度全看用户的
   * 桌面背景是什么。
   */
  it("keeps the work surfaces opaque behind the translucent window", () => {
    expect(css).toContain("--canvas: #e7e8e4;");
    expect(css).toContain("--surface: #f1f2ef;");
    expect(css).toContain("--canvas: #131416;");
    expect(css).toContain("--surface: #1b1d1f;");
    expect(css).not.toContain("--surface: rgb(20 21 24 / 26%);");
    expect(css).not.toContain("--surface: rgb(255 255 255 / 18%);");
  });

  /* 层级靠发丝线和底色，不靠投影把卡片托起来。 */
  it("draws hierarchy with hairlines rather than lifted cards", () => {
    expect(css).toContain("--shadow: rgb(25 27 24 / 0%);");
    expect(css).toContain("--shadow-soft: rgb(25 27 24 / 0%);");
    expect(css).toContain("--shadow: rgb(0 0 0 / 0%);");
    expect(css).not.toContain("--shadow: rgb(35 49 62 / 16%);");
  });

  it("uses a burnt sienna action colour instead of the former violet", () => {
    expect(css).toContain("--accent: #a8431c;");
    expect(css).toContain("--accent: #e07a48;");
    expect(css).toContain("--accent-surface: #f1ded2;");
    expect(css).not.toContain("--accent: #6553b8;");
    expect(css).not.toContain("--accent: #b9adff;");
    expect(css).not.toContain("--accent-surface: rgb(93 75 155 / 34%);");
  });

  /*
   * 行动色只说「这里需要你」。结果好坏另有自己的颜色，否则复盘结论和待办
   * 会长得一模一样。
   */
  it("gives outcomes their own semantic colours", () => {
    expect(css).toContain("--ok: #3d6b4a;");
    expect(css).toContain("--ok: #7fb58c;");
    expect(css).toContain("--danger-surface: #f2dbd8;");
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
