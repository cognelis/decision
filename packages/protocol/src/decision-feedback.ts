import { z } from "zod";
import { decisionSourceReferenceSchema } from "./decision-handoff.js";
import { decisionTaskScopeSchema } from "./decision-scope.js";
import { decisionContextSourceSchema } from "./decision-context.js";

export const decisionFeedbackRatingSchema = z.enum(["helpful", "not_applicable", "insufficient_context", "irrelevant"]);
const fields = z.object({
  reference: decisionSourceReferenceSchema,
  task: z.string().trim().min(1).max(1_000),
  project: z.string().trim().min(1).max(500).optional(),
  taskScope: decisionTaskScopeSchema.optional(),
  rating: decisionFeedbackRatingSchema,
  reason: z.string().trim().min(1).max(2_000),
  withdrawn: z.boolean().default(false),
}).strict();
export const decisionFeedbackUpdateSchema = fields.extend({
  feedbackId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
}).strict();
const revision = fields.extend({ revision: z.number().int().positive(), updatedAt: z.iso.datetime() }).strict();
export const decisionFeedbackRecordSchema = revision.extend({ feedbackVersion: z.literal(1), feedbackId: z.uuid(), history: z.array(revision).max(20) }).strict();
export const decisionFeedbackUpdateResultSchema = z.object({
  status: z.enum(["saved", "unchanged", "source_changed", "source_unavailable", "revision_conflict", "feedback_unavailable", "feedback_not_found"]),
  feedbackId: z.uuid(), revision: z.number().int().nonnegative(), noDecisionChanged: z.literal(true),
}).strict();
export const decisionFeedbackQuerySchema = z.object({
  source: decisionContextSourceSchema.optional(), recordId: z.string().trim().min(1).max(200).optional(),
  project: z.string().trim().min(1).max(500).optional(),
  includeWithdrawn: z.boolean().default(false), limit: z.number().int().min(1).max(20).default(10), offset: z.number().int().min(0).max(10_000).default(0),
}).strict().refine((value) => (value.source === undefined) === (value.recordId === undefined), "Supply source and recordId together");
const counts = z.object({ helpful: z.number().int().nonnegative(), not_applicable: z.number().int().nonnegative(), insufficient_context: z.number().int().nonnegative(), irrelevant: z.number().int().nonnegative() }).strict();
export const decisionFeedbackResponseSchema = z.object({
  coverage: z.enum(["complete", "partial", "unavailable"]),
  results: z.array(z.object({ record: decisionFeedbackRecordSchema, sourceState: z.enum(["current", "changed", "missing", "unavailable"]), relativePath: z.string().max(2_000) }).strict()).max(20),
  total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  activeCount: z.number().int().nonnegative(), withdrawnCount: z.number().int().nonnegative(),
  ratings: counts, currentSourceRatings: counts,
  guidance: z.string().max(2_000), noDecisionChanged: z.literal(true),
}).strict();
export type DecisionFeedbackUpdate = z.infer<typeof decisionFeedbackUpdateSchema>;
export type DecisionFeedbackRecord = z.infer<typeof decisionFeedbackRecordSchema>;
export type DecisionFeedbackUpdateResult = z.infer<typeof decisionFeedbackUpdateResultSchema>;
export type DecisionFeedbackQuery = z.infer<typeof decisionFeedbackQuerySchema>;
export type DecisionFeedbackResponse = z.infer<typeof decisionFeedbackResponseSchema>;
