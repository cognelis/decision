import { describe, expect, it } from "vitest";

import {
  decisionMarkdown,
  decisionsMarkdown,
} from "../src/renderer/components/pages/decisions/decision-markdown.js";

const base = {
  id: "d1",
  created: new Date(2026, 6, 30, 12).toISOString(),
  sourceClient: "codex",
  project: "decision",
  question: "决策工作流应该\n从设置中拆出吗？",
  selectedAnswer: "建立独立决策中心",
  rationaleStatus: "captured" as const,
  rationale: "更容易维护。",
  context: null,
  expectedOutcome: "常用入口两步内可达。",
  outcome: "页面切换稳定。",
  outcomeReview: {
    verdict: "as_expected" as const,
    lesson: null,
    reviewedAt: new Date(2026, 7, 1, 12).toISOString(),
  },
  reviewDueDate: null,
  appliedPrincipleIds: [],
  appliedPrinciples: [],
};

describe("decisionMarkdown", () => {
  it("writes only the parts the record holds", () => {
    expect(decisionMarkdown(base)).toBe(
      [
        "### 决策工作流应该 从设置中拆出吗？",
        "",
        "- 选择：建立独立决策中心",
        "- 项目：decision · 2026年7月30日",
        "",
        "**理由**",
        "",
        "更容易维护。",
        "",
        "**预期结果**",
        "",
        "常用入口两步内可达。",
        "",
        "**实际结果**",
        "",
        "页面切换稳定。",
        "",
        "**复盘 · 符合预期**",
        "",
        "没有写下经验。",
        "",
      ].join("\n"),
    );
    expect(
      decisionMarkdown({ ...base, rationale: null, outcome: null, outcomeReview: null }),
    ).not.toMatch(/理由|实际结果|复盘/u);
  });

  it("puts a filtered list under one heading, a blank line between records", () => {
    const second = { ...base, id: "d2", question: "第二个问题？", outcomeReview: null };
    const markdown = decisionsMarkdown([base, second]);
    expect(markdown.startsWith("## 决策记录（2 条）\n\n### 决策工作流应该 从设置中拆出吗？\n")).toBe(
      true,
    );
    expect(markdown).toContain("没有写下经验。\n\n### 第二个问题？\n");
  });
});
