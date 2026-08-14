import type {
  DecisionConsultationFeedbackMetricRecord,
} from "../src/main/decision-consultation-metrics-store.js";
import { DecisionConsultationFeedbackService } from "../src/main/decision-consultation-feedback-service.js";
import type { DecisionConsultationResponse } from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

const response = (relevance: "strong" | "possible" | null) =>
  ({
    consultationVersion: 1,
    requestId: "private-request-id",
    status: relevance === null ? "no_match" : "matched",
    generatedBy: "deterministic_local_match",
    matches:
      relevance === null
        ? []
        : [
            {
              principleId: "private-principle-id",
              title: "先验证",
              principle: "先验证关键边界。",
              appliesWhen: "结果不确定时。",
              caution: "验证成本需要受控。",
              confidence: "medium",
              evidenceCount: 2,
              relevanceScore: 48,
              relevance,
              reason: "存在边界重合。",
              matchedTerms: ["边界"],
            },
          ],
    feedback: null,
    boundary: {
      advisoryOnly: true,
      noDecisionWritten: true,
      noPrincipleApplied: true,
    },
  }) satisfies DecisionConsultationResponse;

describe("DecisionConsultationFeedbackService", () => {
  it("consumes one short-lived receipt and records content-free aggregates", async () => {
    const records: DecisionConsultationFeedbackMetricRecord[] = [];
    const service = new DecisionConsultationFeedbackService({
      metrics: {
        recordFeedback: async (record) => {
          records.push(record);
        },
      },
      now: () => new Date("2026-08-08T10:00:00.000Z"),
      tokenFactory: () => "opaque-token",
    });

    const issued = service.issue(response("strong"), "codex");
    expect(issued.feedback).toEqual({
      token: "opaque-token",
      expiresAt: "2026-08-08T10:30:00.000Z",
    });
    await expect(
      service.submit({
        feedbackVersion: 1,
        token: "opaque-token",
        rating: "helpful",
      }),
    ).resolves.toEqual({ feedbackVersion: 1, status: "accepted" });
    expect(records).toEqual([
      {
        source: "codex",
        result: "strong",
        rating: "helpful",
        recordedAt: "2026-08-08T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private-request-id");
    expect(JSON.stringify(records)).not.toContain("private-principle-id");
    await expect(
      service.submit({
        feedbackVersion: 1,
        token: "opaque-token",
        rating: "helpful",
      }),
    ).resolves.toEqual({ feedbackVersion: 1, status: "not_found" });
  });

  it("expires receipts without writing a feedback event", async () => {
    let now = new Date("2026-08-08T10:00:00.000Z");
    const recordFeedback = vi.fn(async () => undefined);
    const service = new DecisionConsultationFeedbackService({
      metrics: { recordFeedback },
      now: () => now,
      tokenFactory: () => "expiring-token",
      receiptTtlMs: 1_000,
    });
    service.issue(response(null), "preview");
    now = new Date("2026-08-08T10:00:01.000Z");

    await expect(
      service.submit({
        feedbackVersion: 1,
        token: "expiring-token",
        rating: "not_helpful",
      }),
    ).resolves.toEqual({ feedbackVersion: 1, status: "expired" });
    expect(recordFeedback).not.toHaveBeenCalled();
  });
});
