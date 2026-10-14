import { z } from "zod";
import { decisionContextSourceSchema, decisionContextResultSchema, decisionContextResponseSchema } from "./decision-context.js";
import { decisionTaskScopeSchema } from "./decision-scope.js";

export const decisionSourceReferenceSchema = z.object({
  source: decisionContextSourceSchema,
  recordId: z.string().trim().min(1).max(200),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const decisionSourceOpenResultSchema = z.object({
  status: z.enum(["opened", "source_changed", "source_unavailable", "open_failed"]),
  relativePath: z.string().min(1).max(2_000).nullable(),
  noNoteWritten: z.literal(true),
}).strict();
const taskItems = z.array(z.string().trim().min(1).max(1_000)).max(10).default([]);
const handoffFieldsSchema = z.object({
  objective: z.string().trim().min(1).max(2_000),
  references: z.array(decisionSourceReferenceSchema).min(1).max(10),
  project: z.string().trim().min(1).max(500).optional(),
  taskScope: decisionTaskScopeSchema.optional(),
  openQuestions: taskItems,
  nextSteps: taskItems,
  verification: taskItems,
}).strict();
export const decisionHandoffRequestSchema = handoffFieldsSchema.refine((input) => new Set(input.references.map((ref) => JSON.stringify([ref.source, ref.recordId]))).size === input.references.length,
"Each source and record ID must be unique");
export const decisionHandoffResponseSchema = z.object({
  handoffVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  status: z.enum(["ready", "needs_review", "unavailable"]),
  coverage: decisionContextResponseSchema.shape.coverage,
  sources: decisionContextResponseSchema.shape.sources,
  task: handoffFieldsSchema.omit({ references: true }),
  evidence: z.array(z.object({
    reference: decisionSourceReferenceSchema,
    status: z.enum(["verified", "source_changed", "source_unavailable"]),
    record: decisionContextResultSchema.nullable(),
  }).strict()).max(10),
  reviewItems: z.array(z.string().max(1_000)).max(100),
  markdown: z.string().max(250_000),
  truncated: z.boolean(),
  boundary: z.object({ noNoteWritten: z.literal(true), taskClaimsVerified: z.literal(false), advisoryOnly: z.literal(true) }).strict(),
}).strict();
export type DecisionSourceReference = z.infer<typeof decisionSourceReferenceSchema>;
export type DecisionSourceOpenResult = z.infer<typeof decisionSourceOpenResultSchema>;
export type DecisionHandoffRequest = z.infer<typeof decisionHandoffRequestSchema>;
export type DecisionHandoffResponse = z.infer<typeof decisionHandoffResponseSchema>;
