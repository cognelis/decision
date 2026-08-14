import type {
  MethodologyRecord,
  MethodologySuggestionEvidence,
} from "@cognelis/decision-core";
import { buildMethodologySuggestions } from "@cognelis/decision-core";
import { describe, expect, it } from "vitest";

const evidence = (
  id: string,
  overrides: Partial<MethodologySuggestionEvidence> = {},
): MethodologySuggestionEvidence => ({
  id,
  project: "Decision",
  question: "页面改造应该一次完成还是分步验证？",
  selectedAnswer: "先做可回退的小步改动",
  outcomeVerdict: "as_expected",
  outcomeLesson: "小步验证降低了返工范围。",
  reviewedAt: "2026-08-03T10:00:00.000Z",
  ...overrides,
});

const methodology = (
  sourceDecisionIds: string[],
  status: MethodologyRecord["status"] = "candidate",
): MethodologyRecord => ({
  id: `principle-${sourceDecisionIds.join("-")}`,
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:00:00.000Z",
  origin: "decision_evidence",
  status,
  confirmedAt: status === "accepted" ? "2026-08-03T10:00:00.000Z" : null,
  title: "先验证再扩大",
  principle: "先通过可回退的小步改动验证效果，再扩大范围。",
  appliesWhen: "仍有关键未知项时。",
  caution: "双轨成本过高时重新评估。",
  evidenceSummary: "两条结果证据支持这项做法。",
  sourceDecisionIds,
  confidence: "medium",
  generation: {
    requestId: "methodology:request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
});

describe("buildMethodologySuggestions", () => {
  it("groups related, directionally consistent reviews and scores readiness", () => {
    const suggestions = buildMethodologySuggestions(
      [
        evidence("decision-1"),
        evidence("decision-2", { project: "ClarAI" }),
        evidence("decision-3", {
          project: "Workbench",
          question: "功能重构应该一次上线还是先分步验证？",
          selectedAnswer: "先上线可回退的小范围改动",
        }),
      ],
      [],
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      title: "跨 3 个项目 · 相近复盘",
      readiness: "strong",
      direction: "favorable",
      evidenceCount: 3,
      projectCount: 3,
    });
    expect(suggestions[0]?.sourceDecisionIds).toEqual([
      "decision-1",
      "decision-2",
      "decision-3",
    ]);
  });

  it("does not merge opposite result directions", () => {
    const suggestions = buildMethodologySuggestions(
      [
        evidence("decision-good"),
        evidence("decision-bad", {
          outcomeVerdict: "worse",
          outcomeLesson: "小步验证增加了长期双轨成本。",
        }),
      ],
      [],
    );

    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((item) => item.readiness === "exploratory")).toBe(
      true,
    );
  });

  it("does not resurface evidence already handled by any principle candidate", () => {
    const records = [
      methodology(["decision-covered"], "accepted"),
      methodology(["decision-dismissed"], "dismissed"),
    ];

    const suggestions = buildMethodologySuggestions(
      [
        evidence("decision-covered"),
        evidence("decision-dismissed"),
        evidence("decision-new"),
      ],
      records,
    );

    expect(
      suggestions.flatMap((item) => item.sourceDecisionIds),
    ).not.toContain("decision-covered");
    expect(
      suggestions.flatMap((item) => item.sourceDecisionIds),
    ).not.toContain("decision-dismissed");
    expect(suggestions.flatMap((item) => item.sourceDecisionIds)).toContain(
      "decision-new",
    );
  });

  it("keeps unrelated reviews as clearly exploratory single-evidence suggestions", () => {
    const suggestions = buildMethodologySuggestions(
      [
        evidence("decision-ui"),
        evidence("decision-database", {
          project: "Storage",
          question: "索引损坏后应该如何恢复数据库？",
          selectedAnswer: "从 Markdown 重建 SQLite",
          outcomeLesson: "可重建索引避免了事实数据丢失。",
        }),
      ],
      [],
    );

    expect(suggestions).toHaveLength(2);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceCount: 1,
          readiness: "exploratory",
        }),
      ]),
    );
  });
});
