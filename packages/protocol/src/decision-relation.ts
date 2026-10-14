import { z } from "zod";

export const decisionRelationReferenceSchema = z.object({
  source: z.enum(["summarize", "decisions"]),
  recordId: z.string().trim().min(1).max(200),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export const decisionRelationDispositionSchema = z.enum(["conflict", "supersedes", "unrelated", "revoked"]);

const relationFields = {
  first: decisionRelationReferenceSchema,
  second: decisionRelationReferenceSchema,
  disposition: decisionRelationDispositionSchema,
  successor: z.enum(["first", "second"]).nullable().default(null),
  reason: z.string().trim().min(1).max(2_000),
};
const validPair = (value: { first: { source: string; recordId: string }; second: { source: string; recordId: string }; disposition: string; successor: string | null }) =>
  (value.first.source !== value.second.source || value.first.recordId !== value.second.recordId) &&
  (value.disposition === "supersedes" ? value.successor !== null : value.successor === null);

export const decisionRelationUpdateSchema = z.object({
  ...relationFields,
  expectedRevision: z.number().int().min(0),
}).strict().refine(validPair, "Relations require two distinct decisions; only supersedes has a successor");

export const decisionRelationRevisionSchema = z.object({
  ...relationFields,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
}).strict().refine(validPair, "Invalid relation revision");

export const decisionRelationRecordSchema = z.object({
  ...relationFields,
  relationVersion: z.literal(1),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  history: z.array(decisionRelationRevisionSchema).max(20),
}).strict().refine(validPair, "Invalid relation");

export const decisionRelationUpdateResultSchema = z.object({
  status: z.enum(["saved", "unchanged", "source_changed", "revision_conflict", "source_unavailable", "cycle_rejected", "relation_not_found"]),
  revision: z.number().int().nonnegative(),
  originalNotesUnchanged: z.literal(true),
}).strict();

export const decisionRelationViewSchema = z.object({
  relationId: z.string().min(1).max(1_000),
  disposition: decisionRelationDispositionSchema,
  state: z.enum(["current", "stale", "missing_source", "revoked"]),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  reason: z.string().max(2_000),
  successor: z.enum(["self", "other"]).nullable(),
  other: z.object({ source: z.enum(["summarize", "decisions"]), recordId: z.string().max(200), title: z.string().max(500).nullable() }).strict(),
  relativePath: z.string().max(2_000),
  historyCount: z.number().int().nonnegative(),
  first: decisionRelationReferenceSchema,
  second: decisionRelationReferenceSchema,
  history: z.array(z.object({
    revision: z.number().int().positive(), disposition: decisionRelationDispositionSchema,
    updatedAt: z.string().datetime(), reason: z.string().max(500),
  }).strict()).max(5),
}).strict();

export type DecisionRelationReference = z.infer<typeof decisionRelationReferenceSchema>;
export type DecisionRelationRecord = z.infer<typeof decisionRelationRecordSchema>;
export type DecisionRelationUpdate = z.infer<typeof decisionRelationUpdateSchema>;
export type DecisionRelationUpdateResult = z.infer<typeof decisionRelationUpdateResultSchema>;
export type DecisionRelationView = z.infer<typeof decisionRelationViewSchema>;
