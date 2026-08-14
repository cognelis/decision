import type { MethodologyRecord } from "../src/index.js";
import { buildMethodologyRecall } from "../src/index.js";
import { describe, expect, it } from "vitest";

const methodology = (
  id: string,
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T08:00:00.000Z",
  title: "先验证再扩大",
  principle: "先通过可回退的小步验证关键边界，再扩大不可逆投入。",
  appliesWhen: "兼容性和真实运行效果仍不明确时。",
  caution: "验证成本明显高于潜在返工损失时重新评估。",
  evidenceSummary: "历史复盘支持。",
  sourceDecisionIds: ["decision-1"],
  confidence: "medium",
  generation: {
    requestId: `methodology:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen",
    model: "qwen3.5",
  },
  ...overrides,
});

describe("methodology recall", () => {
  it("recalls only accepted principles with explainable deterministic overlap", () => {
    const matches = buildMethodologyRecall(
      [
        methodology("relevant"),
        methodology("candidate", { status: "candidate", confirmedAt: null }),
        methodology("unrelated", {
          title: "统一视觉层级",
          principle: "菜单图标应遵循系统视觉尺寸。",
          appliesWhen: "调整菜单栏图标时。",
          caution: "不要忽略高分辨率资源。",
        }),
      ],
      {
        question: "上线前是否先验证兼容边界？",
        selectedAnswer: "先做可回退的小范围验证",
        optionLabels: ["一次性全面上线", "先小范围验证"],
        context: "真实运行兼容性仍不明确，需要控制返工风险。",
      },
    );

    expect(matches.map((match) => match.principleId)).toEqual(["relevant"]);
    expect(matches[0]).toMatchObject({
      strength: "strong",
      matchedTerms: expect.arrayContaining(["边界"]),
    });
    expect(matches[0]?.reason).toContain("当前决策存在文本重合");
  });

  it("returns no suggestion when overlap is too weak", () => {
    expect(
      buildMethodologyRecall([methodology("principle-1")], {
        question: "采用哪种品牌插画风格？",
        selectedAnswer: "柔和水彩",
        optionLabels: ["水彩", "像素"],
        context: "需要匹配营销活动的视觉语气。",
      }),
    ).toEqual([]);
  });

  it("supports recall before an answer has been selected", () => {
    const matches = buildMethodologyRecall([methodology("principle-1")], {
      question: "上线前应该如何处理尚未确认的兼容边界？",
      selectedAnswer: null,
      optionLabels: ["直接全面上线", "先做可回退的小范围验证"],
      context: "真实运行兼容性仍不明确。",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      principleId: "principle-1",
      strength: "strong",
    });
  });
});
