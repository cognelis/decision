import { z } from "zod";

import { capturedOptionSchema, sourceClientSchema } from "./capture.js";

export const DECISION_CONSULTATION_VERSION = 1 as const;
export const DECISION_CONSULTATION_METRICS_VERSION = 1 as const;
export const DECISION_CONSULTATION_FEEDBACK_VERSION = 1 as const;

const consultationText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

export const decisionConsultationRequestSchema = z
  .object({
    consultationVersion: z.literal(DECISION_CONSULTATION_VERSION),
    requestId: consultationText(200),
    sourceClient: sourceClientSchema,
    project: consultationText(500),
    question: consultationText(4_000),
    options: z.array(capturedOptionSchema).max(8),
    context: consultationText(6_000).nullable(),
    requestedAt: z.string().datetime(),
  })
  .strict();

export const decisionConsultationMatchSchema = z
  .object({
    principleId: consultationText(200),
    title: consultationText(500),
    principle: consultationText(2_000),
    appliesWhen: consultationText(2_000),
    caution: consultationText(2_000),
    confidence: z.enum(["low", "medium", "high"]),
    evidenceCount: z.number().int().nonnegative(),
    relevanceScore: z.number().int().min(0).max(100),
    relevance: z.enum(["strong", "possible"]),
    reason: consultationText(1_000),
    matchedTerms: z.array(consultationText(100)).max(3),
  })
  .strict();

export const decisionConsultationFeedbackReceiptSchema = z
  .object({
    token: consultationText(200),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const decisionConsultationResponseSchema = z
  .object({
    consultationVersion: z.literal(DECISION_CONSULTATION_VERSION),
    requestId: consultationText(200),
    status: z.enum(["matched", "no_match"]),
    generatedBy: z.literal("deterministic_local_match"),
    matches: z.array(decisionConsultationMatchSchema).max(3),
    feedback: decisionConsultationFeedbackReceiptSchema.nullable().default(null),
    boundary: z
      .object({
        advisoryOnly: z.literal(true),
        noDecisionWritten: z.literal(true),
        noPrincipleApplied: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((response, context) => {
    if (
      (response.status === "matched" && response.matches.length === 0) ||
      (response.status === "no_match" && response.matches.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "consultation status must agree with matches",
        path: ["status"],
      });
    }
  });

export type DecisionConsultationRequest = z.infer<
  typeof decisionConsultationRequestSchema
>;
export type DecisionConsultationMatch = z.infer<
  typeof decisionConsultationMatchSchema
>;
export type DecisionConsultationResponse = z.infer<
  typeof decisionConsultationResponseSchema
>;

export const decisionConsultationFeedbackRatingSchema = z.enum([
  "helpful",
  "not_helpful",
  "misleading",
]);

export const decisionConsultationFeedbackRequestSchema = z
  .object({
    feedbackVersion: z.literal(DECISION_CONSULTATION_FEEDBACK_VERSION),
    token: consultationText(200),
    rating: decisionConsultationFeedbackRatingSchema,
  })
  .strict();

export const decisionConsultationFeedbackResultSchema = z
  .object({
    feedbackVersion: z.literal(DECISION_CONSULTATION_FEEDBACK_VERSION),
    status: z.enum(["accepted", "expired", "not_found"]),
  })
  .strict();

export type DecisionConsultationFeedbackRating = z.infer<
  typeof decisionConsultationFeedbackRatingSchema
>;
export type DecisionConsultationFeedbackRequest = z.infer<
  typeof decisionConsultationFeedbackRequestSchema
>;
export type DecisionConsultationFeedbackResult = z.infer<
  typeof decisionConsultationFeedbackResultSchema
>;

const consultationMetricCount = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const emptyFeedbackCounts = {
  total: 0,
  helpful: 0,
  notHelpful: 0,
  misleading: 0,
} as const;

export const decisionConsultationFeedbackCountsSchema = z
  .object({
    total: consultationMetricCount,
    helpful: consultationMetricCount,
    notHelpful: consultationMetricCount,
    misleading: consultationMetricCount,
  })
  .strict();

export const decisionConsultationMetricsPeriodSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    requests: consultationMetricCount,
    matched: consultationMetricCount,
    noMatch: consultationMetricCount,
    matches: consultationMetricCount,
    strongMatches: consultationMetricCount,
    possibleMatches: consultationMetricCount,
    durationMs: consultationMetricCount,
    feedback: decisionConsultationFeedbackCountsSchema.default(
      emptyFeedbackCounts,
    ),
  })
  .strict();

export const decisionConsultationMetricsSnapshotSchema = z
  .object({
    metricsVersion: z.literal(DECISION_CONSULTATION_METRICS_VERSION),
    requests: consultationMetricCount,
    matched: consultationMetricCount,
    noMatch: consultationMetricCount,
    matches: consultationMetricCount,
    strongMatches: consultationMetricCount,
    possibleMatches: consultationMetricCount,
    durationMs: consultationMetricCount,
    byClient: z
      .object({
        claudeCode: consultationMetricCount,
        codex: consultationMetricCount,
      })
      .strict(),
    feedback: decisionConsultationFeedbackCountsSchema
      .extend({
        bySource: z
          .object({
            claudeCode: consultationMetricCount,
            codex: consultationMetricCount,
            preview: consultationMetricCount,
          })
          .strict(),
        byResult: z
          .object({
            strong: decisionConsultationFeedbackCountsSchema,
            possible: decisionConsultationFeedbackCountsSchema,
            noMatch: decisionConsultationFeedbackCountsSchema,
          })
          .strict(),
      })
      .strict()
      .default({
        ...emptyFeedbackCounts,
        bySource: { claudeCode: 0, codex: 0, preview: 0 },
        byResult: {
          strong: emptyFeedbackCounts,
          possible: emptyFeedbackCounts,
          noMatch: emptyFeedbackCounts,
        },
      }),
    recent: z.array(decisionConsultationMetricsPeriodSchema).max(30),
    lastConsultedAt: z.string().datetime().nullable(),
    privacy: z
      .object({
        storesQuestionText: z.literal(false),
        storesOptionText: z.literal(false),
        storesPrincipleIds: z.literal(false),
        storesFeedbackTokens: z.literal(false).default(false),
        storesIndividualEvents: z.literal(false).default(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.matched + snapshot.noMatch !== snapshot.requests ||
      snapshot.strongMatches + snapshot.possibleMatches !== snapshot.matches ||
      snapshot.byClient.claudeCode + snapshot.byClient.codex !==
        snapshot.requests ||
      snapshot.feedback.helpful +
        snapshot.feedback.notHelpful +
        snapshot.feedback.misleading !==
        snapshot.feedback.total ||
      snapshot.feedback.bySource.claudeCode +
        snapshot.feedback.bySource.codex +
        snapshot.feedback.bySource.preview !==
        snapshot.feedback.total ||
      snapshot.feedback.byResult.strong.total +
        snapshot.feedback.byResult.possible.total +
        snapshot.feedback.byResult.noMatch.total !==
        snapshot.feedback.total
    ) {
      context.addIssue({
        code: "custom",
        message: "consultation metrics counters must remain consistent",
      });
    }
    for (const [result, feedback] of Object.entries(
      snapshot.feedback.byResult,
    )) {
      if (
        feedback.helpful + feedback.notHelpful + feedback.misleading !==
        feedback.total
      ) {
        context.addIssue({
          code: "custom",
          message: "consultation feedback counters must remain consistent",
          path: ["feedback", "byResult", result],
        });
      }
    }
    for (const [index, period] of snapshot.recent.entries()) {
      if (
        period.matched + period.noMatch !== period.requests ||
        period.strongMatches + period.possibleMatches !== period.matches ||
        period.feedback.helpful +
          period.feedback.notHelpful +
          period.feedback.misleading !==
          period.feedback.total
      ) {
        context.addIssue({
          code: "custom",
          message: "consultation period counters must remain consistent",
          path: ["recent", index],
        });
      }
    }
  });

export type DecisionConsultationMetricsPeriod = z.infer<
  typeof decisionConsultationMetricsPeriodSchema
>;
export type DecisionConsultationMetricsSnapshot = z.infer<
  typeof decisionConsultationMetricsSnapshotSchema
>;
export type DecisionConsultationFeedbackCounts = z.infer<
  typeof decisionConsultationFeedbackCountsSchema
>;
