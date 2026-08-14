import { describe, expect, it } from "vitest";

import {
  buildMethodologyBuildProgress,
  type MethodologyRecord,
  type PracticeAssetRecord,
} from "../src/index.js";

const methodology = (
  id: string,
  status: MethodologyRecord["status"],
): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  origin: "decision_evidence",
  status,
  confirmedAt: status === "accepted" ? "2026-08-01T01:00:00.000Z" : null,
  title: `原则 ${id}`,
  principle: "先验证，再扩大。",
  appliesWhen: "仍有未知项时。",
  caution: "验证成本过高时重新评估。",
  evidenceSummary: "来自完整复盘。",
  sourceDecisionIds: ["decision-1"],
  confidence: "medium",
  generation: {
    requestId: `methodology:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen",
    model: "qwen3.5",
  },
});

const practiceAsset = (
  id: string,
  status: PracticeAssetRecord["status"],
): PracticeAssetRecord => ({
  id,
  slug: id,
  kind: "skill",
  status,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  acceptedAt: status === "accepted" ? "2026-08-01T01:00:00.000Z" : null,
  title: `实践 ${id}`,
  summary: "总结",
  trigger: "触发条件",
  steps: ["执行"],
  checks: ["检查"],
  fallback: "回退",
  sourcePrincipleIds: ["principle-accepted"],
  generation: {
    requestId: `skill:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen",
    model: "qwen3.5",
  },
});

describe("methodology build progress", () => {
  it("counts the complete local lifecycle without truncating facts", () => {
    const progress = buildMethodologyBuildProgress(
      [
        ...Array.from({ length: 201 }, () => ({
          outcome: null,
          outcomeVerdict: null,
        })),
        { outcome: "已上线", outcomeVerdict: null },
        { outcome: "已完成迁移", outcomeVerdict: null },
        { outcome: "效果符合预期", outcomeVerdict: "as_expected" },
        { outcome: "结果不理想", outcomeVerdict: "worse" },
      ],
      [
        methodology("candidate", "candidate"),
        methodology("accepted", "accepted"),
        methodology("retired", "retired"),
        methodology("dismissed", "dismissed"),
      ],
      [
        practiceAsset("candidate", "candidate"),
        practiceAsset("accepted-1", "accepted"),
        practiceAsset("accepted-2", "accepted"),
        practiceAsset("dismissed", "dismissed"),
      ],
    );

    expect(progress).toEqual({
      decisions: {
        total: 205,
        pendingOutcome: 201,
        pendingReview: 2,
        reviewed: 2,
      },
      principles: {
        candidate: 1,
        accepted: 1,
        retired: 1,
        dismissed: 1,
      },
      practiceAssets: {
        candidate: 1,
        accepted: 2,
        dismissed: 1,
      },
    });
  });
});
