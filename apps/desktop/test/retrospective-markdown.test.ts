import { describe, expect, it } from "vitest";

import { retrospectiveMarkdown } from "../src/renderer/components/pages/methodology/DecisionAnalyticsView.js";

const period = {
  days: 7,
  startDate: "2026-09-20",
  endDate: "2026-09-26",
  decisions: 4,
  previousDecisions: 1,
  rationaleCaptured: 3,
  rationaleDeferred: 1,
  expectationMissing: 1,
  reviews: 3,
  previousReviews: 0,
  lessons: [
    {
      decisionId: "worst",
      question: "缓存要不要\n预热？",
      project: "Decision",
      sourceClient: "codex",
      verdict: "worse" as const,
      lesson: "冷启动比预期更慢。\n下次先压测。",
      expectedOutcome: "预热后首屏\n两秒内可用。",
      reviewedAt: new Date(2026, 8, 22, 12).toISOString(),
    },
    {
      decisionId: "quiet",
      question: "日志要不要落盘？",
      project: "Decision",
      sourceClient: "codex",
      verdict: "as_expected" as const,
      lesson: null,
      expectedOutcome: null,
      reviewedAt: new Date(2026, 8, 24, 12).toISOString(),
    },
  ],
  repeats: [
    {
      question: "发布窗口放在周几？",
      decisionIds: ["a", "b"],
      projects: 2,
      consistentAnswers: false,
    },
  ],
  projects: [{ label: "Decision", count: 4 }],
  principles: [{ id: "p1", title: "先验证再扩大", count: 2 }],
};

describe("retrospectiveMarkdown", () => {
  it("writes the window's counts, lessons, repeats and projects", () => {
    expect(retrospectiveMarkdown(period, 2)).toBe(
      [
        "## 决策回顾 · 2026-09-20 – 2026-09-26（近 7 天）",
        "",
        "- 新决策 4 条（前 7 天 1 条），理由补全 3 / 4，1 条尚未写预期",
        "- 完成复盘 3 条（前 7 天 0 条），当前待复盘 2 条",
        "",
        "### 写下的经验",
        "",
        "- **低于预期** · 缓存要不要 预热？（Decision · 9.22 复盘）",
        "  当时预期：预热后首屏 两秒内可用。",
        "  冷启动比预期更慢。",
        "  下次先压测。",
        "- **符合预期** · 日志要不要落盘？（Decision · 9.24 复盘）",
        "  没有写下经验。",
        "- 另有 1 条复盘未列出",
        "",
        "### 反复出现的问题",
        "",
        "- 发布窗口放在周几？：2 次，2 个项目，答案不一致",
        "",
        "### 用到的原则",
        "",
        "- 先验证再扩大：2 次",
        "",
        "### 项目分布",
        "",
        "- Decision：4",
        "",
      ].join("\n"),
    );
  });

  it("lists the first five of each and counts the rest", () => {
    const six = Array.from({ length: 6 }, (_, index) => index + 1);
    const markdown = retrospectiveMarkdown(
      {
        ...period,
        repeats: six.map((n) => ({
          question: `问题 ${n}？`,
          decisionIds: [`a${n}`, `b${n}`],
          projects: 1,
          consistentAnswers: true,
        })),
        principles: [...six, 7].map((n) => ({ id: `p${n}`, title: `原则 ${n}`, count: 1 })),
        projects: [...six, 7, 8].map((n) => ({ label: `项目 ${n}`, count: 1 })),
      },
      0,
    );
    expect(markdown).toContain("- 问题 5？：2 次，1 个项目，答案一致\n- 另有 1 个问题未列出\n");
    expect(markdown).toContain("- 原则 5：1 次\n- 另有 2 条原则未列出\n");
    expect(markdown).toContain("- 项目 5：1\n- 另有 3 个项目未列出\n");
    expect(markdown).not.toContain("项目 6");
  });

  it("says so when the window is quiet", () => {
    const markdown = retrospectiveMarkdown(
      {
        ...period,
        decisions: 0,
        rationaleCaptured: 0,
        rationaleDeferred: 0,
        expectationMissing: 0,
        reviews: 0,
        lessons: [],
        repeats: [],
        projects: [],
        principles: [],
      },
      0,
    );
    expect(markdown).toContain("- 新决策 0 条（前 7 天 1 条）\n");
    expect(markdown).toContain("本期没有完成复盘。");
    expect(markdown).toContain("没有重复决定的问题。");
    expect(markdown).not.toContain("### 项目分布");
  });
});
