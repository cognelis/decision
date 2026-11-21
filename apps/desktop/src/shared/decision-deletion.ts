import { z } from "zod";

export const decisionDeletionTargetSchema = z.object({
  id: z.string().trim().min(1).max(200),
  storage: z.enum(["vault", "local"]),
}).strict();
export const decisionDeletionRequestSchema = decisionDeletionTargetSchema.extend({
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  /** 识别错误: the reader says the capture should never have been a decision; a receipt without its text is kept. */
  misrecognized: z.boolean().optional(),
  /** The preview's organization.previewHash, when it named anything: what is forgotten with the decision is what was shown. */
  expectedOrganizationPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
export const decisionDeletionPreviewSchema = decisionDeletionTargetSchema.extend({
  question: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  evidencePrinciples: z.number().int().nonnegative(),
  adoptedPrinciples: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  /** Set only while other records of the same capture remain. */
  batchId: z.string().nullable(),
  /** Captured from a conversation (not written by hand): only then can it be marked 识别错误. */
  captured: z.boolean(),
  /** Still waiting in the capture runtime for its rationale: deleting it ends those reminders too. */
  deferredHeld: z.boolean(),
  /** Shown under the question so the reader can tell which one this is. */
  selectedAnswer: z.string(),
  project: z.string(),
  /**
   * 普通源删除联动机器派生内容与调用记录，保留已确认的独立选择；显式遗忘是另一入口。
   * Absent: nothing there. Send previewHash back as expectedOrganizationPreviewHash.
   */
  organization: z.object({
    experiences: z.array(z.object({ id: z.string().max(200), title: z.string().max(500) }).strict()).max(200),
    suggestions: z.number().int().nonnegative(),
    modelCalls: z.number().int().nonnegative(),
    complete: z.boolean(),
    previewHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().optional(),
}).strict();
export const decisionDeletionResultSchema = z.object({ deleted: z.literal(true), warnings: z.array(z.string()) }).strict();
const counts = z.record(z.string().max(100), z.number().int().nonnegative());
/** What a misrecognized deletion leaves behind: labels, counts and times, never a word of the decision. */
export const misrecognitionReceiptSchema = z.object({
  version: z.literal(1),
  /** A transcript the rules read, or a structured question the client asked: only the first has a band and signals. */
  captureMode: z.enum(["transcript", "structured_tool"]),
  detectorVersion: z.string().regex(/^[a-z0-9.+-]{1,64}$/u).nullable(),
  band: z.enum(["high", "medium"]).nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  signals: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/u)).max(32),
  sourceClient: z.string().regex(/^[a-z-]{1,32}$/u),
  optionCount: z.number().int().nonnegative(),
  capturedAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime(),
}).strict();
export const misrecognitionSummarySchema = z.object({
  days: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  byMode: z.object({ transcript: z.number().int().nonnegative(), structured_tool: z.number().int().nonnegative() }).strict(),
  byBand: z.object({ high: z.number().int().nonnegative(), medium: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
  bySignal: counts,
  byDetector: counts,
  unavailable: z.literal(true).optional(),
}).strict();
export type MisrecognitionReceipt = z.infer<typeof misrecognitionReceiptSchema>;
export type MisrecognitionSummary = z.infer<typeof misrecognitionSummarySchema>;
export type DecisionDeletionTarget = z.infer<typeof decisionDeletionTargetSchema>;
export type DecisionDeletionRequest = z.infer<typeof decisionDeletionRequestSchema>;
export type DecisionDeletionPreview = z.infer<typeof decisionDeletionPreviewSchema>;
export type DecisionDeletionResult = z.infer<typeof decisionDeletionResultSchema>;
