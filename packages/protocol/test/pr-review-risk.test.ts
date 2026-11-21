import { describe, expect, it } from "vitest";

import { assessPrRisk, parseReviewRiskTable, riskPathPattern } from "../src/index.js";

describe("a REVIEW.md path", () => {
  it("matches whole repository paths, ** across directories and * within one", () => {
    const auth = riskPathPattern("apps/auth/**");
    expect(["apps/auth/session.ts", "apps/auth/deep/x.ts"].every((path) => auth.test(path))).toBe(true);
    expect(auth.test("apps/authority/x.ts")).toBe(false);
    const markdown = riskPathPattern("**/*.md");
    expect(["README.md", "docs/a/b.md"].every((path) => markdown.test(path))).toBe(true);
    expect(riskPathPattern("*.md").test("docs/a.md")).toBe(false);
    expect(riskPathPattern("docs/").test("docs/a/b.png")).toBe(true);
    expect(riskPathPattern("/db/migrations/v?.sql").test("db/migrations/v1.sql")).toBe(true);
    expect(riskPathPattern("a+b.(ts)").test("a+b.(ts)")).toBe(true);
  });
});

describe("the 风险路径 section", () => {
  const review = [
    "# 评审时最要紧的",
    "",
    "## 认证",
    "1. 续期前要检查吊销。",
    "",
    "## 风险路径",
    "",
    "路径相对仓库根。",
    "",
    "| 等级 | 路径 | 说明 |",
    "| --- | --- | --- |",
    "| 高 | `apps/auth/**`、`apps/billing/**` | 认证与计费 |",
    "| 低风险 | `**/*.stories.tsx` | |",
    "| 很高 | `x/**` | 写错的等级 |",
    "| 中 | `../outside` | 越界 |",
    "",
    "## 其它",
    "| 高 | `not/**` | 不在这一节 |",
  ].join("\n");

  it("reads the table under the heading, and says which rows it could not read", () => {
    expect(parseReviewRiskTable(review)).toEqual({
      rows: [
        { level: "high", patterns: ["apps/auth/**", "apps/billing/**"], reason: "认证与计费" },
        { level: "low", patterns: ["**/*.stories.tsx"], reason: null },
      ],
      problems: ["风险路径表第 3 行的等级「很高」不认识，只能写高、中、低", "风险路径表第 4 行的路径「../outside」不能含 \\ 或 .."],
    });
    expect(parseReviewRiskTable("## Risk paths\n\n| Level | Paths |\n|---|---|\n| High | infra/** |")!.rows).toEqual([{ level: "high", patterns: ["infra/**"], reason: null }]);
    expect(parseReviewRiskTable("## 风险路径\n\n| 路径 | 说明 |\n| --- | --- |\n| a/** | x |")!.problems).toEqual(["风险路径表要有“等级”和“路径”两列"]);
    expect(parseReviewRiskTable("# REVIEW\n\n只有文字。")).toBeNull();
  });

  it("levels a PR by its highest file, and no table lowers the review's own rules or CI", () => {
    const table = parseReviewRiskTable(review);
    const risk = assessPrRisk(["apps/auth/session.ts", "apps/orders/list.ts", "docs/guide.md", "apps/auth/session.test.ts"], table);
    expect(risk).toMatchObject({ level: "high", table: "review_md", changesRules: false });
    expect(risk.reasons.map((item) => [item.level, item.reason, item.paths])).toEqual([
      ["high", "认证与计费", ["apps/auth/session.ts", "apps/auth/session.test.ts"]],
      ["medium", "普通改动", ["apps/orders/list.ts"]],
      ["low", "文档", ["docs/guide.md"]],
    ]);
    expect(risk.problems).toHaveLength(2);

    const lowered = parseReviewRiskTable("## 风险路径\n\n| 等级 | 路径 |\n| --- | --- |\n| 低 | `**` |")!;
    const rules = assessPrRisk(["REVIEW.md", ".github/workflows/ci.yml", ".gitattributes", "src/a.ts"], lowered);
    expect(rules.level).toBe("high");
    expect(rules.changesRules).toBe(true);
    expect(rules.reasons.map((item) => item.reason)).toEqual(["评审规则文件", "CI 与发布流程", "Git 行为文件", "REVIEW.md：**"]);
  });

  it("without a table: tests and documents are low, the rest medium, an empty change low", () => {
    expect(assessPrRisk(["README.md", "src/a.test.ts"], null)).toMatchObject({ level: "low", table: "default" });
    expect(assessPrRisk(["README.md", "src/a.ts"], null).level).toBe("medium");
    expect(assessPrRisk(["packages/x/AGENTS.md"], null)).toMatchObject({ level: "high", changesRules: true });
    expect(assessPrRisk([], null)).toMatchObject({ level: "low", reasons: [] });
    const many = assessPrRisk(Array.from({ length: 8 }, (_, index) => `src/${index}.ts`), null);
    expect(many.reasons[0]).toMatchObject({ paths: ["src/0.ts", "src/1.ts", "src/2.ts", "src/3.ts", "src/4.ts"], more: 3 });
  });
});
