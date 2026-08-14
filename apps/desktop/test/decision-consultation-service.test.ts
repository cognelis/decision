import type { MethodologyRecord } from "@cognelis/decision-core";
import {
  DECISION_CONSULTATION_VERSION,
  type DecisionConsultationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import { buildDecisionConsultation } from "../src/main/decision-consultation-service.js";

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
  title: "先验证边界，再扩大投入",
  principle: "先通过可回退的小步验证关键边界，再扩大不可逆投入。",
  appliesWhen: "兼容性和真实运行效果仍不明确时。",
  caution: "验证成本明显高于潜在返工损失时重新评估。",
  evidenceSummary: "两条复盘支持。",
  sourceDecisionIds: ["decision-1", "decision-2"],
  confidence: "medium",
  generation: {
    requestId: `methodology:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen",
    model: "qwen3.5",
  },
  ...overrides,
});

const request = (
  overrides: Partial<DecisionConsultationRequest> = {},
): DecisionConsultationRequest => ({
  consultationVersion: DECISION_CONSULTATION_VERSION,
  requestId: "consultation-1",
  sourceClient: "codex",
  project: "decision",
  question: "上线前是否先验证兼容边界？",
  options: [{ label: "直接上线" }, { label: "先小范围验证" }],
  context: "真实运行兼容性仍不明确。",
  requestedAt: "2026-08-08T10:00:00.000Z",
  ...overrides,
});

describe("decision consultation service", () => {
  it("returns accepted principles and explicit non-writing boundaries", () => {
    const result = buildDecisionConsultation(request(), [
      methodology("relevant"),
      methodology("candidate", { status: "candidate", confirmedAt: null }),
    ]);

    expect(result).toMatchObject({
      status: "matched",
      generatedBy: "deterministic_local_match",
      boundary: {
        advisoryOnly: true,
        noDecisionWritten: true,
        noPrincipleApplied: true,
      },
    });
    expect(result.matches).toEqual([
      expect.objectContaining({
        principleId: "relevant",
        confidence: "medium",
        evidenceCount: 2,
        relevance: "strong",
      }),
    ]);
  });

  it("returns an honest no-match response instead of forcing a principle", () => {
    const result = buildDecisionConsultation(
      request({
        question: "应该采用哪种营销插画风格？",
        options: [{ label: "水彩" }, { label: "像素" }],
        context: "需要匹配节日活动视觉语气。",
      }),
      [methodology("unrelated")],
    );

    expect(result.status).toBe("no_match");
    expect(result.matches).toEqual([]);
  });
});
