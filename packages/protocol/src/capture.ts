import { z } from "zod";

export const CAPTURE_EVENT_VERSION = 1 as const;
export const CAPTURE_CANDIDATE_VERSION = 1 as const;

const humanText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

export const captureModeSchema = z.enum([
  "structured_tool",
  "transcript",
]);
export const sourceClientSchema = z.enum([
  "claude-code",
  "codex",
  "test",
]);

export const capturedOptionSchema = z
  .object({
    id: humanText(200).optional(),
    label: humanText(500),
    description: humanText(2_000).optional(),
  })
  .strict();

export const capturedAnswerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("preset"),
      values: z.array(humanText(2_000)).length(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("multiple"),
      values: z.array(humanText(2_000)).min(1).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      values: z.array(humanText(2_000)).length(1),
    })
    .strict(),
]);

export const capturedQuestionSchema = z
  .object({
    questionIndex: z.number().int().min(0).max(7),
    header: humanText(200).optional(),
    question: humanText(4_000),
    options: z.array(capturedOptionSchema).max(8),
    answer: capturedAnswerSchema,
    multiSelect: z.boolean(),
  })
  .strict();

export const capturedDecisionContextSchema = z
  .object({
    taskBackground: humanText(4_000).optional(),
    decisionFraming: humanText(4_000).optional(),
    truncated: z.boolean().optional(),
  })
  .strict()
  .superRefine((contextValue, context) => {
    const length =
      (contextValue.taskBackground?.length ?? 0) +
      (contextValue.decisionFraming?.length ?? 0);
    if (length > 6_000) {
      context.addIssue({
        code: "custom",
        message:
          "captured context must not exceed 6000 characters",
      });
    }
  });

export const captureDetectionSchema = z
  .object({
    band: z.enum(["high", "medium"]),
    score: z.number().int().min(0).max(100),
    detectorVersion: humanText(100),
    signals: z.array(humanText(100)).max(32),
  })
  .strict();

export const capturedDecisionEventSchema = z
  .object({
    eventVersion: z.literal(CAPTURE_EVENT_VERSION),
    captureMode: captureModeSchema,
    sourceClient: sourceClientSchema,
    sessionId: humanText(500),
    turnId: humanText(500).optional(),
    sourceEventId: humanText(500).optional(),
    toolUseId: humanText(500).optional(),
    batchId: humanText(1_000),
    project: humanText(500),
    cwd: humanText(2_000),
    capturedAt: z.string().datetime(),
    questions: z.array(capturedQuestionSchema).min(1).max(8),
    context: capturedDecisionContextSchema.optional(),
    detection: captureDetectionSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const indexes = event.questions.map(
      (question) => question.questionIndex,
    );
    if (new Set(indexes).size !== indexes.length) {
      context.addIssue({
        code: "custom",
        message: "question indexes must be unique",
        path: ["questions"],
      });
    }
  });

export const capturedDecisionCandidateSchema = z
  .object({
    candidateVersion: z.literal(CAPTURE_CANDIDATE_VERSION),
    candidateId: humanText(200),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    event: capturedDecisionEventSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.event.detection?.band !== "medium") {
      context.addIssue({
        code: "custom",
        message:
          "captured decision candidate must contain medium detection",
        path: ["event", "detection", "band"],
      });
    }
    if (
      Date.parse(candidate.expiresAt) <=
      Date.parse(candidate.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate expiry must follow creation",
        path: ["expiresAt"],
      });
    }
  });

export const captureReceiptSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
  })
  .strict();

export type CaptureMode = z.infer<typeof captureModeSchema>;
export type SourceClient = z.infer<typeof sourceClientSchema>;
export type CapturedOption = z.infer<typeof capturedOptionSchema>;
export type CapturedAnswer = z.infer<typeof capturedAnswerSchema>;
export type CapturedQuestion = z.infer<typeof capturedQuestionSchema>;
export type CapturedDecisionContext = z.infer<
  typeof capturedDecisionContextSchema
>;
export type CaptureDetection = z.infer<
  typeof captureDetectionSchema
>;
export type CapturedDecisionEvent = z.infer<
  typeof capturedDecisionEventSchema
>;
export type CapturedDecisionCandidate = z.infer<
  typeof capturedDecisionCandidateSchema
>;
export type CaptureReceipt = z.infer<typeof captureReceiptSchema>;
