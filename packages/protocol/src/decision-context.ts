import { decisionOutcomeStateSchema } from "./decision-outcome.js";
import { z } from "zod";
import { amendmentStateSchema } from "./decision-amendment.js";
import { DECISION_SCOPE_REJECTIONS, decisionTaskScopeSchema, decisionApplicabilitySchema, repositoryRelativePathSchema } from "./decision-scope.js";
import { decisionRelationViewSchema } from "./decision-relation.js";
import { experienceViewSchema } from "./experience.js";

// A large PR's review searches with every file it changes (up to PR_REVIEW_MAX_FILES): matched against the first 100
// only, a record scoped to a path further down was hidden as out of scope. Feedback and handoffs, kept, keep their 100.
const searchScopeSchema = decisionTaskScopeSchema.extend({ files: z.array(repositoryRelativePathSchema).max(3_000).default([]) }).strict();

export const DECISION_CONTEXT_VERSION = 1 as const;
export const decisionContextSourceSchema = z.enum(["summarize", "decisions", "principles"]);
/** The user's own preferences and ideas: signals read from the Decision Journal, never decisions or principles. */
export const decisionContextSignalSourceSchema = z.enum(["preferences", "ideas"]);
/** Adopted execution experiences (IMP-191): a case with its source, read only when named; never a decision or a principle. */
export const decisionContextExperienceSourceSchema = z.enum(["experiences"]);
export const decisionContextAnySourceSchema = z.enum(["summarize", "decisions", "principles", "preferences", "ideas", "experiences"]);
export const decisionContextModeSchema = z.enum(["keyword", "semantic", "hybrid"]);

export type DecisionContextAnySource = z.infer<typeof decisionContextAnySourceSchema>;
export type DecisionContextMode = z.infer<typeof decisionContextModeSchema>;

export const isSignalSource = (source: DecisionContextAnySource): source is "preferences" | "ideas" =>
  source === "preferences" || source === "ideas";

/** One of the three decision sources (summarize, decisions, principles): what the decisions' own search reads. */
export const isDecisionSource = (source: DecisionContextAnySource): source is DecisionContextSource =>
  source === "summarize" || source === "decisions" || source === "principles";

/**
 * The sources a query names, one value or a list (the single value is what every earlier client sends), without
 * repeats; undefined when it names none, which stands for the three decision sources.
 */
export const contextSourcesOf = (source: DecisionContextQuery["source"]): DecisionContextAnySource[] | undefined =>
  source === undefined ? undefined : [...new Set(typeof source === "string" ? [source] : source)];

export const decisionContextQuerySchema = z.object({
  query: z.string().trim().max(2_000).default(""),
  recordId: z.string().trim().min(1).max(200).optional(),
  source: z.union([decisionContextAnySourceSchema, z.array(decisionContextAnySourceSchema).min(1).max(6)]).optional(),
  /** Absent: hybrid. Only a shape-2 client sends it (see CONTEXT_SHAPE). */
  mode: decisionContextModeSchema.optional(),
  /** semantic mode alone: the least cosine similarity a record needs, 0 to 1; absent: 0.45. */
  minSimilarity: z.number().min(0).max(1).optional(),
  /** Preferences and ideas withdrawn by the user, and archived experiences, are left out unless this is true. */
  includeWithdrawn: z.boolean().optional(),
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

/** What a preference or an idea carries beyond a decision's fields; only on those two kinds. */
export const decisionContextSignalSchema = z.object({
  /** What it may be used as, in the App's words (JOURNAL_STANDING). */
  standing: z.string().max(500),
  knowledgeStatus: z.string().max(50),
  strength: z.string().max(50).optional(),
  evidenceMaturity: z.string().max(50).optional(),
  ideaForm: z.string().max(50).optional(),
  languages: z.array(z.string().max(100)).max(30),
  createdAt: z.string().max(100),
  updatedAt: z.string().max(100),
}).strict();

export const decisionContextResultSchema = z.object({
  source: decisionContextAnySourceSchema,
  kind: z.enum(["summarized_decision", "recorded_decision", "adopted_principle", "preference", "idea", "experience"]),
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
  /** Cosine similarity to the query, 0 to 1, of a record found by meaning. Only a shape-2 client is sent it. */
  similarity: z.number().min(-1).max(1).optional(),
  /** Texts appended to it and rewrites of it, kept beside the note (update_decision_journal_entry). Only a shape-2 client is sent it. */
  amendment: amendmentStateSchema.optional(),
  /** Of a preference or an idea only. */
  signal: decisionContextSignalSchema.optional(),
  /** Of an experience only (kind experience); only a shape-3 client is sent it. */
  experience: experienceViewSchema.optional(),
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
    source: decisionContextAnySourceSchema,
    status: z.enum(["ready", "empty", "partial", "unavailable"]),
    records: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }).strict()).max(6),
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
 * How the App begins the matchReason of a record found by meaning alone, no keyword having matched it: a field of its
 * own, a bridge already running refused the whole answer (the schemas are strict). Told apart by it, such a record is
 * not read as one its words were found in.
 */
export const SEMANTIC_MATCH_PREFIX = "语义相近";
export const foundByMeaning = (result: Pick<DecisionContextResult, "matchReason">): boolean =>
  result.matchReason.startsWith(SEMANTIC_MATCH_PREFIX);

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

/**
 * The shape of the App's answers a bridge reads, sent as a request header. A bridge from before sends none: it reads the
 * three decision sources and kinds only, and refuses a key it does not know (the schemas are strict), so it is answered
 * without `similarity` and `signal`, and a request for what it could not have asked is refused.
 */
export const CONTEXT_SHAPE_HEADER = "x-decision-context-shape";
/**
 * The newest shape: "3" also reads experiences (IMP-191). Levels, not names: a bridge sending "2" still gets all a
 * shape-2 answer holds, and a bridge sends "3" only for a query that names experiences, so it works with an App from
 * before as well.
 */
export const CONTEXT_SHAPE = "3";
export const CONTEXT_SHAPE_SIGNALS = "2";
export type ContextShapeLevel = 1 | 2 | 3;

/** The shape a request's header says it reads: none (or one not known) is 1, the shape before any of this. */
export const contextShapeLevel = (header: string | readonly string[] | undefined): ContextShapeLevel => {
  const value = Array.isArray(header) ? header[0] : header;
  return value === "3" ? 3 : value === "2" ? 2 : 1;
};

const namesExperiences = (source: DecisionContextQuery["source"]): boolean =>
  source !== undefined && (typeof source === "string" ? source === "experiences" : source.includes("experiences"));

/** The least shape a query needs: 3 to name experiences; 2 for a preference or idea source, a list of sources, a mode. */
export const contextShapeNeeded = (query: Pick<DecisionContextQuery, "source" | "mode" | "minSimilarity" | "includeWithdrawn">): ContextShapeLevel =>
  namesExperiences(query.source) ? 3
    : typeof query.source === "object" || (typeof query.source === "string" && isSignalSource(query.source)) ||
      query.mode !== undefined || query.minSimilarity !== undefined || query.includeWithdrawn !== undefined ? 2 : 1;

/** Whether a query uses what only a shape-2 client sends: a preference or idea source, a list of sources, a mode. */
export const queryNeedsContextShape = (query: Pick<DecisionContextQuery, "source" | "mode" | "minSimilarity" | "includeWithdrawn">): boolean =>
  contextShapeNeeded(query) > 1;

/** A context answer as a bridge of that shape reads it: 1 without similarity, signal and amendment; 2 without experience. */
export const contextAsReleased = (response: DecisionContextResponse, level: ContextShapeLevel = 1): DecisionContextResponse => ({
  ...response,
  results: level >= 3 ? response.results
    : level === 2 ? response.results.map(({ experience: _experience, ...released }) => released)
    : response.results.map(({ similarity: _similarity, signal: _signal, amendment: _amendment, experience: _experience, ...released }) => released),
});

/**
 * The decision source of a record that came from a decision-sources search (decisions, summaries, principles): the
 * handoff, feedback, review and evidence code only ever holds such records, and refuses a preference or an idea.
 */
export const decisionSourceOf = (result: Pick<DecisionContextResult, "source">): DecisionContextSource => {
  if (!isDecisionSource(result.source)) throw new Error(`${result.source} is not a decision source`);
  return result.source;
};
