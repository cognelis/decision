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

describe("desktop theme", () => {
  /* 透明窗口和毛玻璃哪怕被别的窗口挡住，也让 WindowServer 一直在合成（IMP-139）。 */
  it("paints the desktop shell opaque, without blur", () => {
    const rule = materialRule();

    expect(rule).not.toBe("");
    expect(rule).toContain("var(--window)");
    expect(css).not.toContain("backdrop-filter");
  });

  it("keeps the window colour opaque in forced light and dark previews", () => {
    expect(css).toMatch(
      /html\[data-preview-theme="light"\]\s*\{[^}]*--window:\s*#eef0f3;/su,
    );
    expect(css).toMatch(
      /html\[data-preview-theme="dark"\]\s*\{[^}]*--window:\s*#0f1115;/su,
    );
    expect(css).not.toMatch(/--window:\s*rgb\([^)]*\/[^)]*\)/su);
  });

  /*
   * 工作面一律不透明。早先每一层都半透明，桌面壁纸透过四层叠加上来，文字
   * 对比度全看用户的桌面背景是什么。
   */
  it("keeps the work surfaces opaque", () => {
    expect(css).toContain("--canvas: #f6f7f9;");
    expect(css).toContain("--surface: #ffffff;");
    expect(css).toContain("--canvas: #14161b;");
    expect(css).toContain("--surface: #1a1d23;");
    expect(css).not.toContain("--surface: rgb(20 21 24 / 26%);");
    expect(css).not.toContain("--surface: rgb(255 255 255 / 18%);");
  });

  /* 层级靠发丝线和底色，不靠投影把卡片托起来。 */
  it("draws hierarchy with hairlines rather than lifted cards", () => {
    expect(css).toContain("--shadow: rgb(22 24 29 / 0%);");
    expect(css).toContain("--shadow-soft: rgb(22 24 29 / 0%);");
    expect(css).toContain("--shadow: rgb(0 0 0 / 0%);");
    expect(css).not.toContain("--shadow: rgb(35 49 62 / 16%);");
  });

  /* 主题色默认蓝，可在设置里换（IMP-140）；界面层按设置覆盖，这里是第一帧和没换过时的颜色。 */
  it("defaults the action colour to blue, never the former violet", () => {
    expect(css).toContain("--accent: #2563d9;");
    expect(css).toContain("--accent: #7aa7ff;");
    expect(css).toContain("--accent-surface: #e9effb;");
    expect(css).not.toContain("--accent: #6553b8;");
    expect(css).not.toContain("--accent: #b9adff;");
    expect(css).not.toContain("--accent-surface: rgb(93 75 155 / 34%);");
  });

  /*
   * 行动色只说「这里需要你」。结果好坏另有自己的颜色，否则复盘结论和待办
   * 会长得一模一样。
   */
  it("gives outcomes their own semantic colours", () => {
    expect(css).toContain("--ok: #2b6e44;");
    expect(css).toContain("--ok: #6cc28c;");
    expect(css).toContain("--danger-surface: #f9e3e1;");
  });

  /* 后端需要关注是琥珀；红只留给测试失败、删除这类危险操作。 */
  it("marks a model backend that needs attention amber, keeping red for failed tests", () => {
    expect(css).toMatch(/\.provider-status-attention\s*\{[^}]*color:\s*var\(--warning\)/su);
    expect(css).toMatch(/\.provider-test-failed,\s*\.danger-text\s*\{[^}]*color:\s*var\(--danger\)/su);
  });

  /* 停用的后端仍要读、仍能操作：用说明色压低，不整块调透明（深色下透明度把说明压到 2.9:1）。 */
  it("sets a disabled model backend aside in the quieter ink, never by fading it", () => {
    expect(css).not.toMatch(/\.provider-row\[data-disabled\][^{]*\{[^}]*opacity/su);
    expect(css).toMatch(/\.provider-row\[data-disabled\] \.provider-status-cell > span\s*\{[^}]*color:\s*var\(--muted\)/su);
  });

  /* 窄了，数据行让出「更新时间」，列头也得一起让，否则整排列头错开一列。 */
  it("keeps the practice list's column heads on the rows' columns when the time gives way", () => {
    expect(css).toMatch(/\.practice-asset-row,\s*\.practice-assets-list-head\s*\{\s*grid-template-columns:/su);
    expect(css).toMatch(/\.practice-asset-row time,\s*\.practice-assets-list-head > :nth-child\(4\)\s*\{\s*display:\s*none;/su);
  });
});
