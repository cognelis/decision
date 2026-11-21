import { z } from "zod";

/** A record's context at most, as saved; a summary put in front of one must leave it within this too. */
export const CONTEXT_MAX_CHARS = 8_000;

const proactiveCommonShape = {
  title: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(8_000),
  sourceKind: z.enum([
    "app_manual",
    "offline_conversation",
    "meeting",
    "observation",
  ]),
  sourceForm: z.enum(["user_original", "user_paraphrase"]),
  sensitivity: z.enum(["private", "personal", "shareable"]),
  project: z.string().trim().min(1).max(500).optional(),
  occurredAt: z.string().datetime().optional(),
  knowledgeStatus: z.enum(["inbox", "active", "archived"]).optional(),
  context: z.string().trim().min(1).max(CONTEXT_MAX_CHARS).optional(),
  rationale: z.string().trim().min(1).max(8_000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(12),
};
export const proactiveRecordInputSchema = z.discriminatedUnion("kind", [
  z.object({
    ...proactiveCommonShape,
    kind: z.literal("decision"),
    // Only a decision comes from a PR comment, and then it keeps the comment's link.
    sourceKind: z.enum([...proactiveCommonShape.sourceKind.options, "pr_comment"]),
    sourceUrl: z.string().url().max(2_000).optional(),
    options: z.array(z.string().trim().min(1).max(2_000)).max(8),
    expectedOutcome: z.string().trim().min(1).max(4_000).optional(),
    reviewDueDate: z.string().date().optional(),
  }).strict(),
  z.object({
    ...proactiveCommonShape,
    kind: z.literal("preference"),
    appliesWhen: z.string().trim().min(1).max(4_000).optional(),
    exceptions: z.string().trim().min(1).max(4_000).optional(),
    // Left out, not said: a new entry takes the default, a restated one keeps what it has.
    strength: z.enum(["hard_constraint", "default", "weak_signal"]).optional(),
    evidenceMaturity: z.enum(["self_declared", "repeated", "reviewed"]).optional(),
    // Left out: a new entry is general, a restated one keeps its own.
    languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  }).strict(),
  z.object({
    ...proactiveCommonShape,
    kind: z.literal("idea"),
    ideaForm: z.enum(["observation", "question", "hypothesis", "possibility"]).optional(),
    whyInteresting: z.string().trim().min(1).max(4_000).optional(),
    openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(8),
    nextTest: z.string().trim().min(1).max(4_000).optional(),
    incubateUntil: z.string().date().optional(),
    languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  }).strict(),
]);
export type ProactiveRecordInput = z.infer<typeof proactiveRecordInputSchema>;

/** A record's context for the local model to summarize, with what the record says, to show it what matters. */
export const recordContextSummaryRequestSchema = z.object({
  requestId: z.string().uuid(),
  context: z.string().trim().min(1).max(CONTEXT_MAX_CHARS),
  title: z.string().trim().max(500).optional(),
  choice: z.string().trim().max(8_000).optional(),
}).strict();
export type RecordContextSummaryRequest = z.infer<typeof recordContextSummaryRequestSchema>;

/**
 * What the local model made of it, for the reader to use or not. `clipped`: it read only the start and the end of a
 * long context. `unavailable`: nothing on this machine can write one, and why.
 */
export const recordContextSummarySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("summarized"), summary: z.string().min(1).max(8_000), model: z.string().min(1).max(200), clipped: z.boolean() }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1).max(500) }).strict(),
]);
export type RecordContextSummary = z.infer<typeof recordContextSummarySchema>;
