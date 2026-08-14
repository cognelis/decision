import { z } from "zod";

import { capturedDecisionContextSchema } from "./capture.js";

export const SEMANTIC_PAIR_VERSION = 1 as const;
export const CAPTURE_AUDIT_VERSION = 1 as const;

const bounded = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const semanticBandSchema = z.enum([
  "high",
  "medium",
  "low",
]);

export const semanticModelBandSchema = z.enum([
  "high",
  "medium",
  "low",
  "unavailable",
]);

export const decisionIntentSchema = z.enum([
  "decision",
  "approval",
  "information_request",
  "self_resolved",
  "none",
]);

export const answerRelationSchema = z.enum([
  "answers",
  "mixed",
  "new_task",
  "uncertain",
]);

export const semanticDecisionPairSchema = z
  .object({
    version: z.literal(SEMANTIC_PAIR_VERSION),
    pairId: bounded(200),
    sourceClient: z.enum(["claude-code", "codex"]),
    sessionId: bounded(500),
    assistantTurnId: bounded(500).optional(),
    userTurnId: bounded(500).optional(),
    cwd: bounded(2_000),
    assistantText: bounded(8_000),
    userText: bounded(2_000),
    context: capturedDecisionContextSchema.optional(),
    capturedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((pair, context) => {
    if (
      Date.parse(pair.expiresAt) <= Date.parse(pair.capturedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "semantic pair expiry must follow capture",
        path: ["expiresAt"],
      });
    }
  });

export const captureAuditStageSchema = z.enum([
  "hook_received",
  "assistant_text_resolved",
  "pending_saved",
  "user_prompt_matched",
  "pair_spooled",
  "classification_completed",
  "routed",
  "failed",
]);

export const captureAuditErrorCodeSchema = z.enum([
  "assistant_text_unavailable",
  "pending_write_failed",
  "pair_not_found",
  "pair_write_failed",
  "pair_delivery_failed",
  "classification_timeout",
  "provider_unavailable",
  "provider_invalid_output",
  "routing_failed",
  "receipt_write_failed",
  "model_missing",
  "checksum_failed",
  "runtime_unavailable",
  "helper_missing",
  "helper_crashed",
  "trace_write_failed",
  "unknown",
]);

export const captureAuditReceiptSchema = z
  .object({
    version: z.literal(CAPTURE_AUDIT_VERSION),
    receiptId: bounded(200),
    sourceClient: z.enum(["claude-code", "codex"]),
    sessionFingerprint: fingerprintSchema,
    turnFingerprint: fingerprintSchema.optional(),
    stage: captureAuditStageSchema,
    textSource: z
      .enum(["hook_payload", "transcript_tail"])
      .optional(),
    ruleBand: semanticBandSchema.optional(),
    modelBand: semanticModelBandSchema.optional(),
    finalBand: semanticBandSchema.optional(),
    errorCode: captureAuditErrorCodeSchema.optional(),
    durationMs: z.number().int().nonnegative().max(60_000).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const semanticClassificationSchema = z
  .object({
    decisionIntent: decisionIntentSchema,
    answerRelation: answerRelationSchema,
    question: z.string().trim().min(1).max(4_000).nullable(),
    optionLabels: z.array(bounded(500)).max(8),
    answerExcerpt: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .nullable(),
    confidence: z.number().min(0).max(1),
    provider: bounded(100),
    modelVersion: bounded(200),
    promptVersion: bounded(100),
  })
  .strict();

export const semanticRouteDecisionSchema = z
  .object({
    ruleBand: semanticBandSchema,
    ruleScore: z.number().int().min(0).max(100),
    modelBand: semanticModelBandSchema,
    finalBand: semanticBandSchema,
    answerRelation: answerRelationSchema.nullable(),
    detectorVersion: bounded(200),
    signals: z.array(bounded(100)).max(32),
  })
  .strict();

export const semanticRecognitionStatusSchema = z
  .object({
    provider: z.enum([
      "apple",
      "qwen",
      "openai",
      "anthropic",
      "openai-compatible",
      "codex-cli",
      "claude-code-cli",
      "rules",
    ]),
    providerLabel: bounded(100),
    availability: z.enum([
      "available",
      "loading",
      "device_not_eligible",
      "apple_intelligence_disabled",
      "assets_unavailable",
      "model_missing",
      "checksum_failed",
      "runtime_unavailable",
      "helper_missing",
      "unavailable",
    ]),
    mode: z.enum([
      "trace",
      "shadow",
      "disagreement_review",
      "hybrid",
    ]),
    modelVersion: bounded(200).optional(),
    promptVersion: bounded(100).optional(),
    processed7d: z.number().int().nonnegative(),
    high7d: z.number().int().nonnegative(),
    medium7d: z.number().int().nonnegative(),
    failures7d: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const semanticPairDeliveryReceiptSchema = z
  .object({
    accepted: z.boolean(),
  })
  .strict();

export type SemanticBand = z.infer<typeof semanticBandSchema>;
export type SemanticModelBand = z.infer<
  typeof semanticModelBandSchema
>;
export type DecisionIntent = z.infer<typeof decisionIntentSchema>;
export type AnswerRelation = z.infer<typeof answerRelationSchema>;
export type SemanticDecisionPair = z.infer<
  typeof semanticDecisionPairSchema
>;
export type CaptureAuditStage = z.infer<
  typeof captureAuditStageSchema
>;
export type CaptureAuditErrorCode = z.infer<
  typeof captureAuditErrorCodeSchema
>;
export type CaptureAuditReceipt = z.infer<
  typeof captureAuditReceiptSchema
>;
export type SemanticClassification = z.infer<
  typeof semanticClassificationSchema
>;
export type SemanticRouteDecision = z.infer<
  typeof semanticRouteDecisionSchema
>;
export type SemanticRecognitionStatus = z.infer<
  typeof semanticRecognitionStatusSchema
>;
export type SemanticPairDeliveryReceipt = z.infer<
  typeof semanticPairDeliveryReceiptSchema
>;
