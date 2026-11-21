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
    /**
     * The programming languages of the code the choice is about. A preference or idea kept for some languages is
     * recalled only where they meet; left out, such entries are recalled as before.
     */
    languages: z.array(consultationText(40)).max(8).optional(),
    /**
     * Where no `languages` were said: those a manifest at the repository's root would have shown and none does, as
     * canonical ids. A preference or idea kept only for these is left out; one kept for a language no manifest names
     * (Shell, SQL) is not. Sent as `languages`, the manifests found left out every preference kept for Shell.
     */
    absentLanguages: z.array(consultationText(40)).max(32).optional(),
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
  });

/**
 * A preference or an idea recalled beside the principles — never among them.
 *
 * `matches` are accepted principles: rules the reader confirmed through the
 * methodology flow. These are not, and the separation is the point. Every one
 * carries its `standing`, so no consumer can present it as settled.
 */
export const decisionConsultationSignalSchema = z
  .object({
    recordId: consultationText(200),
    kind: z.enum(["preference", "idea"]),
    title: consultationText(500),
    summary: consultationText(4_000),
    standing: consultationText(500),
    qualifier: consultationText(4_000).nullable(),
    relevanceScore: z.number().int().min(0).max(100),
    /**
     * Never "strong", unlike a principle match: a preference allows exceptions
     * and an idea is not a commitment, so the boundary is held here rather than
     * left to every caller to respect.
     */
    relevance: z.literal("possible"),
    reason: consultationText(1_000),
    matchedTerms: z.array(consultationText(100)).max(3),
  });

export const decisionConsultationFeedbackReceiptSchema = z
  .object({
    token: consultationText(200),
    expiresAt: z.string().datetime(),
  });

/**
 * An answer, its keys unknown to this build passed over rather than refused: 1.1.0's bridge refused every key it
 * did not know, and told an agent Decision was unavailable at every consultation the App answered with more.
 */
export const decisionConsultationResponseSchema = z
  .object({
    consultationVersion: z.literal(DECISION_CONSULTATION_VERSION),
    requestId: consultationText(200),
    status: z.enum(["matched", "no_match"]),
    noMatchReason: z.enum(["no_accepted_principles", "no_relevant_principles"]).optional(),
    generatedBy: z.literal("deterministic_local_match"),
    matches: z.array(decisionConsultationMatchSchema).max(3),
    /**
     * Defaulted rather than required: a caller on the previous shape still
     * parses, and gets an empty list rather than a missing field.
     */
    signals: z.array(decisionConsultationSignalSchema).max(3).default([]),
    /**
     * The reader's preferences and ideas could not be read this time (a folder the App may not list): none listed
     * is then not none held. Unsaid, an agent went on as if the reader had stated no constraint at all.
     */
    signalsUnavailable: z.literal(true).optional(),
    /**
     * Some of the reader's preferences and ideas could not be read (a note iCloud moved off this Mac, one edited past
     * reading): those listed may not be all the reader holds.
     */
    signalsIncomplete: z.literal(true).optional(),
    /**
     * Some principle notes could not be read (edited past reading, a sync conflict's copy beside one): what matched, or
     * nothing matching, is then not all there is, and no `noMatchReason` is given. Unsaid, an agent was told the reader
     * had adopted no principle while the page said one could not be read.
     */
    principlesIncomplete: z.literal(true).optional(),
    feedback: decisionConsultationFeedbackReceiptSchema.nullable().default(null),
    boundary: z
      .object({
        advisoryOnly: z.literal(true),
        noDecisionWritten: z.literal(true),
        noPrincipleApplied: z.literal(true),
        /** Nothing here was treated as a rule, whatever it matched. */
        noPreferencePromoted: z.literal(true).default(true),
      }),
  })
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
export type DecisionConsultationSignal = z.infer<
  typeof decisionConsultationSignalSchema
>;
export type DecisionConsultationResponse = z.infer<
  typeof decisionConsultationResponseSchema
>;

/**
 * Sent by a bridge that reads what the App has answered with since 1.1.0 (the reader's preferences and ideas, why
 * nothing matched). One that does not send it is answered in 1.1.0's shape: an MCP server started before an update
 * runs on in its session, and 1.1.0's refused every key it did not know. A header, which an App from before ignores.
 */
export const CONSULTATION_SHAPE_HEADER = "x-decision-consultation-shape";
export const CONSULTATION_SHAPE = "2";

/** A consultation as Decision 1.1.0 answered one: without what was added since. */
export const consultationAsReleased = (response: DecisionConsultationResponse): Record<string, unknown> => {
  const {
    noMatchReason: _reason, signals: _signals, signalsUnavailable: _unavailable, signalsIncomplete: _signalsIncomplete,
    principlesIncomplete: _principlesIncomplete, boundary, ...released
  } = response;
  const { noPreferencePromoted: _promoted, ...releasedBoundary } = boundary;
  return { ...released, boundary: releasedBoundary };
};

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

/**
 * Counts by client id. 1.2.0 and before kept them under fixed keys, Claude Code's as `claudeCode`: read as its id,
 * so a snapshot written then still loads.
 */
const countsByClient = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, count]) => [key === "claudeCode" ? "claude-code" : key, count]),
        )
      : value,
  z.record(sourceClientSchema, consultationMetricCount),
);

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((total, count) => total + count, 0);

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
    byClient: countsByClient,
    feedback: decisionConsultationFeedbackCountsSchema
      .extend({
        // `preview`: the App's own preview page, beside the clients.
        bySource: countsByClient,
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
        bySource: {},
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
      sum(snapshot.byClient) !== snapshot.requests ||
      snapshot.feedback.helpful +
        snapshot.feedback.notHelpful +
        snapshot.feedback.misleading !==
        snapshot.feedback.total ||
      sum(snapshot.feedback.bySource) !== snapshot.feedback.total ||
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
