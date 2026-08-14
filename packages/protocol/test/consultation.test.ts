import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  DECISION_CONSULTATION_METRICS_VERSION,
  DECISION_CONSULTATION_VERSION,
  decisionConsultationFeedbackRequestSchema,
  decisionConsultationFeedbackResultSchema,
  decisionConsultationMetricsSnapshotSchema,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("decision consultation protocol", () => {
  it("accepts a bounded read-only consultation round trip", () => {
    const request = decisionConsultationRequestSchema.parse({
      consultationVersion: DECISION_CONSULTATION_VERSION,
      requestId: "consultation-1",
      sourceClient: "codex",
      project: "decision",
      question: "是否先验证兼容边界？",
      options: [{ label: "先小范围验证" }, { label: "直接上线" }],
      context: "需要控制不可逆风险。",
      requestedAt: "2026-08-08T10:00:00.000Z",
    });

    expect(
      decisionConsultationResponseSchema.parse({
        consultationVersion: DECISION_CONSULTATION_VERSION,
        requestId: request.requestId,
        status: "matched",
        generatedBy: "deterministic_local_match",
        feedback: {
          token: "anonymous-feedback-token",
          expiresAt: "2026-08-08T10:30:00.000Z",
        },
        matches: [
          {
            principleId: "principle-1",
            title: "先验证再扩大",
            principle: "先验证关键边界，再扩大不可逆投入。",
            appliesWhen: "真实运行结果仍不明确时。",
            caution: "验证成本过高时重新评估。",
            confidence: "medium",
            evidenceCount: 2,
            relevanceScore: 48,
            relevance: "strong",
            reason: "适用条件与当前决策存在文本重合。",
            matchedTerms: ["边界"],
          },
        ],
        boundary: {
          advisoryOnly: true,
          noDecisionWritten: true,
          noPrincipleApplied: true,
        },
      }).status,
    ).toBe("matched");
  });

  it("accepts one bounded anonymous quality feedback round trip", () => {
    const request = decisionConsultationFeedbackRequestSchema.parse({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      token: "anonymous-feedback-token",
      rating: "helpful",
    });

    expect(request.rating).toBe("helpful");
    expect(
      decisionConsultationFeedbackResultSchema.parse({
        feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
        status: "accepted",
      }),
    ).toEqual({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      status: "accepted",
    });
    expect(() =>
      decisionConsultationFeedbackRequestSchema.parse({
        ...request,
        rating: "free-form-content",
      }),
    ).toThrow();
  });

  it("rejects a no-match status that contains matches", () => {
    expect(() =>
      decisionConsultationResponseSchema.parse({
        consultationVersion: DECISION_CONSULTATION_VERSION,
        requestId: "consultation-1",
        status: "no_match",
        generatedBy: "deterministic_local_match",
        matches: [{}],
        boundary: {
          advisoryOnly: true,
          noDecisionWritten: true,
          noPrincipleApplied: true,
        },
      }),
    ).toThrow();
  });

  it("accepts content-free aggregate metrics and rejects inconsistent counters", () => {
    const metrics = {
      metricsVersion: DECISION_CONSULTATION_METRICS_VERSION,
      requests: 3,
      matched: 2,
      noMatch: 1,
      matches: 4,
      strongMatches: 3,
      possibleMatches: 1,
      durationMs: 24,
      byClient: { claudeCode: 1, codex: 2 },
      feedback: {
        total: 3,
        helpful: 2,
        notHelpful: 1,
        misleading: 0,
        bySource: { claudeCode: 1, codex: 1, preview: 1 },
        byResult: {
          strong: {
            total: 2,
            helpful: 2,
            notHelpful: 0,
            misleading: 0,
          },
          possible: {
            total: 1,
            helpful: 0,
            notHelpful: 1,
            misleading: 0,
          },
          noMatch: {
            total: 0,
            helpful: 0,
            notHelpful: 0,
            misleading: 0,
          },
        },
      },
      recent: [
        {
          date: "2026-08-08",
          requests: 3,
          matched: 2,
          noMatch: 1,
          matches: 4,
          strongMatches: 3,
          possibleMatches: 1,
          durationMs: 24,
          feedback: {
            total: 3,
            helpful: 2,
            notHelpful: 1,
            misleading: 0,
          },
        },
      ],
      lastConsultedAt: "2026-08-08T12:00:00.000Z",
      privacy: {
        storesQuestionText: false,
        storesOptionText: false,
        storesPrincipleIds: false,
        storesFeedbackTokens: false,
        storesIndividualEvents: false,
      },
    };

    expect(decisionConsultationMetricsSnapshotSchema.parse(metrics)).toEqual(
      metrics,
    );
    expect(() =>
      decisionConsultationMetricsSnapshotSchema.parse({
        ...metrics,
        noMatch: 2,
      }),
    ).toThrow("counters must remain consistent");
  });
});
