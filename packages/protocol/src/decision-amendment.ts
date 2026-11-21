import { z } from "zod";

export const DECISION_AMENDMENT_VERSION = 1 as const;
/** Principles are not here: they change through the App's methodology flow. */
export const amendableSourceSchema = z.enum(["decisions", "summarize", "preferences", "ideas"]);
export type AmendableSource = z.infer<typeof amendableSourceSchema>;

const basisSchema = z.enum(["user_said", "user_confirmed"]);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const text = (max: number) => z.string().trim().min(1).max(max);
const common = {
  amendVersion: z.literal(DECISION_AMENDMENT_VERSION),
  source: amendableSourceSchema,
  recordId: text(200),
  sourceClient: text(100),
};

/**
 * What `revise` may rewrite: the three fields a search shows of any record, and, of a decision alone, what the reader
 * wrote at the time (question, choice, rationale, context, expectedOutcome). Absent: unchanged; null: cleared.
 */
export const amendmentFieldsSchema = z.object({
  summary: text(4_000).optional(),
  appliesWhen: text(2_000).nullable().optional(),
  caution: text(2_000).nullable().optional(),
  question: text(2_000).optional(),
  choice: text(4_000).optional(),
  rationale: text(8_000).nullable().optional(),
  context: text(8_000).nullable().optional(),
  expectedOutcome: text(4_000).nullable().optional(),
}).strict();
/** The fields only a decision has: a revise of one needs a basis, and is refused for any other source. */
export const DECISION_ONLY_FIELDS = ["question", "choice", "rationale", "context", "expectedOutcome"] as const;
export type AmendmentFields = z.infer<typeof amendmentFieldsSchema>;

export const decisionAmendmentRequestSchema = z.discriminatedUnion("action", [
  z.object({
    ...common,
    action: z.literal("append"),
    text: text(4_000),
    /** Said by the caller: what the user did, never what the agent inferred. */
    basis: basisSchema,
    reason: text(1_000).optional(),
  }).strict(),
  z.object({
    ...common,
    action: z.literal("revise"),
    /** Required of a preference or idea the user wrote: what the user said or agreed to, never an inference. */
    basis: basisSchema.optional(),
    expectedContentHash: sha,
    expectedRevision: z.number().int().min(0).max(100_000),
    fields: amendmentFieldsSchema.refine((fields) => Object.keys(fields).length > 0, "Provide a field to revise"),
    reason: text(2_000),
  }).strict(),
  z.object({
    ...common,
    action: z.literal("withdraw"),
    basis: basisSchema.optional(),
    expectedRevision: z.number().int().min(0).max(100_000),
    reason: text(2_000),
  }).strict(),
  /** The reader's own: puts back what the rewrite of that revision replaced, from the full text kept in the history. */
  z.object({
    ...common,
    action: z.literal("revert"),
    toRevision: z.number().int().min(1).max(100_000),
    basis: basisSchema.optional(),
    expectedContentHash: sha,
    expectedRevision: z.number().int().min(0).max(100_000),
    reason: text(2_000),
  }).strict(),
  z.object({
    ...common,
    action: z.literal("restore"),
    basis: basisSchema,
    expectedRevision: z.number().int().min(0).max(100_000),
    reason: text(2_000),
  }).strict(),
]);
export type DecisionAmendmentRequest = z.infer<typeof decisionAmendmentRequestSchema>;

export const decisionAmendmentResultSchema = z.object({
  amendVersion: z.literal(DECISION_AMENDMENT_VERSION),
  status: z.enum([
    "saved", "unchanged", "not_found", "source_changed", "revision_conflict", "source_unavailable", "not_allowed", "limit_reached", "basis_required", "revision_unknown",
    "revision_unknown",
  ]),
  revision: z.number().int().nonnegative(),
  /** The amendment note, in the vault. */
  relativePath: z.string().max(2_000).nullable(),
  originalUnchanged: z.literal(true),
}).strict();
export type DecisionAmendmentResult = z.infer<typeof decisionAmendmentResultSchema>;

/** One appended text, as a search returns it. */
export const amendmentViewSchema = z.object({
  n: z.number().int().positive(),
  at: z.string().max(100),
  client: z.string().max(100),
  text: z.string().max(4_000),
  basis: z.string().max(50),
  reason: z.string().max(1_000).nullable(),
}).strict();

/** What a record's amendments add to it in a search: `revision` is the number to pass back as expectedRevision. */
export const amendmentStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  relativePath: z.string().max(2_000),
  amendments: z.array(amendmentViewSchema).max(200),
  /** The rewrite in force, with the fields it changed; `stale`: the original has changed since, so it is not applied. */
  revised: z.object({
    fields: z.array(z.enum(["summary", "appliesWhen", "caution", "question", "choice", "rationale", "context", "expectedOutcome"])).max(8),
    /** The rewritten values, whether or not the original still matches (`stale`), to check with the user. */
    values: amendmentFieldsSchema,
    at: z.string().max(100), client: z.string().max(100), reason: z.string().max(2_000), stale: z.boolean(),
  }).strict().nullable(),
  withdrawn: z.object({ at: z.string().max(100), client: z.string().max(100), reason: z.string().max(2_000) }).strict().nullable(),
  /** What each rewritten field said before the first rewrite of it: the reader's own words, whatever came since. */
  originals: amendmentFieldsSchema.optional(),
  /** The latest actions, the text a rewrite replaced kept in `before`. */
  history: z.array(z.object({
    revision: z.number().int().positive(), at: z.string().max(100), client: z.string().max(100),
    action: z.enum(["append", "revise", "withdraw", "restore"]), reason: z.string().max(2_000).nullable(),
    before: amendmentFieldsSchema.nullable(),
    /** The rewrite a later one replaced while it was stale: what the user approved, kept. */
    replacedOverride: amendmentFieldsSchema.nullable().optional(),
    basis: z.string().max(50).nullable().optional(),
    /** `before` shows a cut of what was replaced; a restore uses the whole. */
    beforeTruncated: z.boolean().optional(),
  }).strict()).max(60),
}).strict();
export type AmendmentState = z.infer<typeof amendmentStateSchema>;
