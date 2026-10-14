import { decisionOutcomeStateSchema } from "./decision-outcome.js";
import { z } from "zod";
import { DECISION_SCOPE_REJECTIONS, decisionTaskScopeSchema, decisionApplicabilitySchema, repositoryRelativePathSchema } from "./decision-scope.js";
import { decisionRelationViewSchema } from "./decision-relation.js";

// A large PR's review searches with every file it changes (up to PR_REVIEW_MAX_FILES): matched against the first 100
// only, a record scoped to a path further down was hidden as out of scope. Feedback and handoffs, kept, keep their 100.
const searchScopeSchema = decisionTaskScopeSchema.extend({ files: z.array(repositoryRelativePathSchema).max(3_000).default([]) }).strict();

export const DECISION_CONTEXT_VERSION = 1 as const;
export const decisionContextSourceSchema = z.enum(["summarize", "decisions", "principles"]);

export const decisionContextQuerySchema = z.object({
  query: z.string().trim().max(2_000).default(""),
  recordId: z.string().trim().min(1).max(200).optional(),
  source: decisionContextSourceSchema.optional(),
  project: z.string().trim().min(1).max(500).optional(),
  taskScope: searchScopeSchema.optional(),
  includeOutOfScope: z.boolean().default(false),
  relation: z.enum(["conflict", "superseded", "needs_review"]).optional(),
  limit: z.number().int().min(1).max(20).default(8),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict();

const referenceSchema = z.object({
  source: decisionContextSourceSchema.optional(),
  id: z.string().min(1).max(200),
  title: z.string().max(500),
  status: z.string().max(100),
  relativePath: z.string().min(1).max(2_000),
}).strict();

export const decisionContextResultSchema = z.object({
  source: decisionContextSourceSchema,
  kind: z.enum(["historical_decision", "recorded_decision", "adopted_principle"]),
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  project: z.string().max(500).nullable(),
  status: z.string().max(100),
  current: z.boolean(),
  summary: z.string().max(4_000),
  appliesWhen: z.string().max(2_000).nullable(),
  caution: z.string().max(2_000).nullable(),
  tags: z.array(z.string().max(100)).max(30),
  supersedes: z.array(z.string().min(1).max(200)).max(50),
  supersededBy: z.array(z.string().min(1).max(200)).max(50),
  successors: z.array(referenceSchema).max(50),
  predecessors: z.array(referenceSchema).max(50).optional(),
  unresolvedPredecessorIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  unresolvedSuccessorIds: z.array(z.string().min(1).max(200)).max(50),
  sourceRef: z.object({
    relativePath: z.string().min(1).max(2_000),
    client: z.string().max(100).nullable(),
    sessionId: z.string().max(200).nullable(),
    excerpt: z.string().max(3_000),
    excerptStartLine: z.number().int().positive(),
    truncated: z.boolean(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).strict(),
  matchReason: z.string().max(1_000),
  warnings: z.array(z.string().max(500)).max(10),
  applicability: decisionApplicabilitySchema.optional(),
  scopeState: z.enum(["unrecorded", "inline", "current", "stale", "unavailable"]).optional(),
  scopeRevision: z.number().int().nonnegative().optional(),
  lifecycleState: z.enum(["current", "superseded", "uncertain"]).optional(),
  relations: z.array(decisionRelationViewSchema).max(20).optional(),
  relationCount: z.number().int().nonnegative().optional(),
  outcomeState: decisionOutcomeStateSchema.optional(),
}).strict();

export const decisionContextResponseSchema = z.object({
  contextVersion: z.literal(DECISION_CONTEXT_VERSION),
  status: z.enum(["matched", "no_match", "empty", "unavailable"]),
  coverage: z.enum(["complete", "partial", "unavailable"]),
  sources: z.array(z.object({
    source: decisionContextSourceSchema,
    status: z.enum(["ready", "empty", "partial", "unavailable"]),
    records: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict()).max(3),
  results: z.array(decisionContextResultSchema).max(20),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  guidance: z.string().max(2_000),
  taskScope: searchScopeSchema.optional(),
  excludedByScope: z.number().int().nonnegative().optional(),
  boundary: z.object({
    advisoryOnly: z.literal(true),
    noDecisionWritten: z.literal(true),
    noPrincipleApplied: z.literal(true),
  }).strict(),
}).strict();

export type DecisionContextQuery = z.infer<typeof decisionContextQuerySchema>;
export type DecisionContextSource = z.infer<typeof decisionContextSourceSchema>;
export type DecisionContextResult = z.infer<typeof decisionContextResultSchema>;
export type DecisionContextResponse = z.infer<typeof decisionContextResponseSchema>;

/**
 * The project a decision is filed under, when that alone keeps it out of the current one: with no project recorded for
 * it (no scope at all, or one of paths or modules only), the note's own project stood in for one. A scope someone
 * recorded and found not to apply is another matter: a project or repository it names, or any other dimension it ruled
 * out by.
 */
export const otherProjectOf = (result: Pick<DecisionContextResult, "project" | "applicability">): string | null => {
  const applicability = result.applicability;
  // Read as saved, a record in a review kept on this machine may lack the arrays the schema fills in.
  if (applicability?.status !== "out_of_scope" || (applicability.scope?.projects?.length ?? 0) > 0 || (applicability.scope?.repositoryIds?.length ?? 0) > 0) return null;
  const rejections = Object.values(DECISION_SCOPE_REJECTIONS).filter((reason) => applicability.reasons?.includes(reason));
  return rejections.length === 1 && rejections[0] === DECISION_SCOPE_REJECTIONS.project ? result.project : null;
};
