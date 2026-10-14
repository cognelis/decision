import type {
  MethodologyEvidenceMatchInput,
  MethodologyRecord,
} from "@cognelis/decision-core";
import {
  buildMethodologyEvidenceMatches,
  withSemanticEvidenceMatches,
} from "@cognelis/decision-core";
import { describe, expect, it } from "vitest";

const methodology = (
  sourceDecisionIds: string[] = [],
): MethodologyRecord => ({
  id: "principle-imported",
  createdAt: "2026-08-03T10:00:00.000Z",
  updatedAt: "2026-08-03T10:00:00.000Z",
  origin: "markdown_import",
  status: "candidate",
  confirmedAt: null,
  title: "先验证再扩大",
  principle: "先验证关键假设，再扩大实施范围。",
  appliesWhen: "结果仍有关键未知项时。",
  caution: "小范围验证无效或双轨成本过高时重新评估。",
  evidenceSummary: "本地导入，尚未关联复盘。",
  sourceDecisionIds,
  confidence: "low",
  generation: {
    requestId: "methodology-import:1",
    profileId: "local-markdown-import",
    provider: "本地导入",
    model: "Markdown",
  },
});

const evidence = (
  id: string,
  overrides: Partial<MethodologyEvidenceMatchInput> = {},
): MethodologyEvidenceMatchInput => ({
  id,
  project: "Decision",
  question: "功能应该直接全面发布，还是先验证关键假设？",
  selectedAnswer: "先小范围验证，再扩大实施范围",
  rationale: "结果仍有未知项，需要保留回退路径。",
  context: "当前缺少真实用户反馈。",
  outcome: "小范围验证发现了问题，避免了全面返工。",
  outcomeVerdict: "better",
  outcomeLesson: "先验证关键假设能够降低扩大范围后的返工成本。",
  reviewedAt: "2026-08-03T10:00:00.000Z",
  ...overrides,
});

describe("buildMethodologyEvidenceMatches", () => {
  it("ranks explainable reviewed evidence and exposes matching terms", () => {
    const matches = buildMethodologyEvidenceMatches(methodology(), [
      evidence("related"),
      evidence("unrelated", {
        project: "Storage",
        question: "数据库索引损坏后应该怎样恢复？",
        selectedAnswer: "从 Markdown 重建 SQLite",
        rationale: "事实数据不能依赖派生索引。",
        context: "SQLite 文件已经损坏。",
        outcome: "索引重建成功，原始记录没有丢失。",
        outcomeLesson: "可重建索引应与事实源分离。",
      }),
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      sourceDecisionId: "related",
      strength: "strong",
      alreadyLinked: false,
    });
    expect(matches[0]!.score).toBeGreaterThanOrEqual(24);
    expect(matches[0]!.matchedTerms).toContain("先验证关键假设");
    expect(matches[0]!.reason).toContain("原则内容");
  });

  it("keeps current links visible but does not manufacture weak matches", () => {
    const matches = buildMethodologyEvidenceMatches(methodology(["related"]), [
      evidence("related"),
      evidence("unrelated", {
        question: "菜单栏图标应该使用多大尺寸？",
        selectedAnswer: "使用系统模板尺寸",
        rationale: null,
        context: null,
        outcome: "菜单栏显示正常。",
        outcomeLesson: "模板图标应遵循系统视觉尺寸。",
      }),
    ]);

    expect(matches).toEqual([
      expect.objectContaining({
        sourceDecisionId: "related",
        alreadyLinked: true,
      }),
    ]);
  });

  it("requires a complete reviewed result and respects the result limit", () => {
    const matches = buildMethodologyEvidenceMatches(
      methodology(),
      [
        evidence("newest", { reviewedAt: "2026-08-05T10:00:00.000Z" }),
        evidence("older", { reviewedAt: "2026-08-04T10:00:00.000Z" }),
        evidence("incomplete", { outcome: null }),
      ],
      1,
    );

    expect(matches.map((item) => item.sourceDecisionId)).toEqual(["newest"]);
  });
});

describe("withSemanticEvidenceMatches", () => {
  const overlap = () =>
    buildMethodologyEvidenceMatches(methodology(), [evidence("decision-a")]);

  it("adds only what the wording missed, and never above it", () => {
    const matches = overlap();
    expect(matches).toHaveLength(1);

    const merged = withSemanticEvidenceMatches(
      matches,
      [
        // Already found by wording: adding it again would show one decision
        // twice under two different explanations.
        { sourceDecisionId: "decision-a", rank: 0 },
        { sourceDecisionId: "decision-b", rank: 1 },
      ],
      new Set(),
    );

    expect(merged.map((match) => match.sourceDecisionId)).toEqual([
      "decision-a",
      "decision-b",
    ]);
    expect(merged[0]?.matchKind).toBe("keyword");
    expect(merged[1]?.matchKind).toBe("semantic");
  });

  it("never lets an unexplainable hit claim strength", () => {
    const [supplement] = withSemanticEvidenceMatches(
      [],
      [{ sourceDecisionId: "decision-b", rank: 0 }],
      new Set(),
    );

    // Nothing overlapped, so there is nothing to show and nothing to promise.
    expect(supplement?.strength).toBe("possible");
    expect(supplement?.matchedTerms).toEqual([]);
    expect(supplement?.score).toBe(0);
    expect(supplement?.reason).toContain("没有共同用词");
  });

  it("keeps the retrieval order and caps how many it adds", () => {
    const merged = withSemanticEvidenceMatches(
      [],
      [
        { sourceDecisionId: "decision-c", rank: 2 },
        { sourceDecisionId: "decision-a", rank: 0 },
        { sourceDecisionId: "decision-b", rank: 1 },
        { sourceDecisionId: "decision-d", rank: 3 },
      ],
      new Set(),
      3,
    );

    expect(merged.map((match) => match.sourceDecisionId)).toEqual([
      "decision-a",
      "decision-b",
      "decision-c",
    ]);
  });

  it("marks a supplement that is already linked", () => {
    const [supplement] = withSemanticEvidenceMatches(
      [],
      [{ sourceDecisionId: "decision-b", rank: 0 }],
      new Set(["decision-b"]),
    );

    expect(supplement?.alreadyLinked).toBe(true);
  });
});
