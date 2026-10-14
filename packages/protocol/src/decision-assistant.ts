import { z } from "zod";

import { modelProviderKindSchema } from "./model.js";

export const DECISION_ASSISTANT_VERSION = 1 as const;
/** Ceiling for a turn's context; archived conversation history is not truncated. */
export const ASSISTANT_MAX_MESSAGES = 40;
export const ASSISTANT_MAX_MESSAGE_CHARS = 8_000;
export const ASSISTANT_MAX_FEEDBACK_NOTE_CHARS = 2_000;

/**
 * Ceiling on the evidence one turn may gather, and therefore on the citation
 * numbering. Searches, successor lookups, wikilinks and the citations a
 * follow-up carries all feed the same list, so the bound has to live where both
 * the schema and the agent can read it — a citation numbered past what the
 * schema accepts fails at the process boundary and throws away a turn the
 * reader has already paid for.
 */
export const ASSISTANT_MAX_EVIDENCE = 40;

/** Sources one answer may cite. */
export const ASSISTANT_MAX_CITATIONS = 12;

export const retrievalAnswerScopeSchema = z.enum([
  "decisions",
  "obsidian",
  "all",
]);

export const retrievalAnswerCitationSchema = z
  .object({
    /** 1-based, matching the [n] markers in the answer text. */
    index: z.number().int().min(1).max(ASSISTANT_MAX_EVIDENCE),
    /**
     * A preference and an idea are not weaker decisions: the domain says a
     * preference allows exceptions and is not an adopted principle, and an
     * idea is not a commitment at all. They get their own kinds so nothing
     * downstream can present one as a conclusion the reader has settled.
     */
    kind: z.enum(["decision", "principle", "note", "preference", "idea"]),
    title: z.string().min(1).max(500),
    reference: z.string().min(1).max(2_000),
    /**
     * The record's own id, when this app holds it — which is what lets a
     * citation open the decision or principle page rather than the Markdown
     * behind it. Absent for notes and for decisions in the historical format,
     * whose ids the current index does not carry.
     */
    recordId: z.string().min(1).max(200).optional(),
    excerpt: z.string().max(2_000),
    matchReason: z.string().max(1_000),
    /**
     * Whether a cited decision or principle still stands. Absent for notes,
     * which have no lifecycle. A superseded record answering as if it were the
     * current conclusion is the one failure this tool must not commit.
     */
    lifecycle: z.enum(["current", "superseded", "uncertain"]).optional(),
  })
  .strict();

export const assistantSourceCheckSchema = z.object({
  status: z.enum(["matched", "review", "unavailable"]),
  content: z.string().max(20_000),
  truncated: z.boolean(),
}).strict();
export type AssistantSourceCheck = z.infer<typeof assistantSourceCheckSchema>;

/** A provider described for the model picker and the answer footer. */
export const retrievalAnswerProviderSchema = z
  .object({
    profileId: z.string().min(1).max(200),
    label: z.string().min(1).max(100),
    kind: modelProviderKindSchema,
    model: z.string().max(200).nullable(),
    leavesDevice: z.boolean(),
  })
  .strict();

export type RetrievalAnswerScope = z.infer<typeof retrievalAnswerScopeSchema>;
export type RetrievalAnswerCitation = z.infer<
  typeof retrievalAnswerCitationSchema
>;
export type RetrievalAnswerProvider = z.infer<
  typeof retrievalAnswerProviderSchema
>;

/** How many actions one turn may take before it must answer. */
export const ASSISTANT_MAX_STEPS = 8;

/**
 * Longest title the agent may put on a step or a citation. Note titles and
 * heading breadcrumbs are each clipped to 500 code points by the indexer, so a
 * joined "title · heading" reaches a thousand characters — well past what the
 * step schema accepts. The agent clips to this same constant, because a title
 * the boundary rejects fails the whole turn rather than the one field.
 */
export const ASSISTANT_MAX_TITLE_CHARS = 300;

/**
 * One observable action the agent took while answering. Steps are shown to the
 * user so a turn is never a black box: what it searched for is as reviewable
 * as what it concluded.
 */
export const assistantStepSchema = z
  .object({
    kind: z.enum(["search", "read", "answer", "step_limit"]),
    query: z.string().max(500).optional(),
    scope: retrievalAnswerScopeSchema.optional(),
    hits: z.number().int().nonnegative().max(50).optional(),
    /** Document title for "read", or a search/step-limit explanation. */
    title: z.string().max(ASSISTANT_MAX_TITLE_CHARS).optional(),
  })
  .strict();

/**
 * What a turn spent. Absent when no backend reported usage at all; when
 * `unreportedSteps` is above zero the totals are a floor, not the bill, and
 * must be presented as such rather than as an exact figure.
 */
const assistantTokensSchema = z
  .object({
    input: z.number().int().nonnegative().max(10_000_000),
    output: z.number().int().nonnegative().max(10_000_000),
    unreportedSteps: z.number().int().nonnegative().max(16),
    /** Present only when the reader gave this backend a price. */
    cost: z
      .object({
        currency: z.string().min(1).max(8),
        amount: z.number().nonnegative().max(1_000_000),
      })
      .strict()
      .optional(),
  })
  .strict();

export const assistantMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(ASSISTANT_MAX_MESSAGE_CHARS),
    /** Display-only provenance; bad optional metadata must not erase an answer. */
    provider: retrievalAnswerProviderSchema.optional().catch(undefined),
    citations: z
      .array(retrievalAnswerCitationSchema)
      .max(ASSISTANT_MAX_CITATIONS)
      .optional(),
    steps: z.array(assistantStepSchema).max(16).optional(),
    /**
     * The turn that produced this answer. Rating an answer and reading its
     * calls back out of the audit log both need it, and only the answer itself
     * can say which turn it came from once the conversation scrolls.
     */
    turnId: z.string().min(1).max(200).optional(),
    tokens: assistantTokensSchema.optional(),
  })
  .strict();

/**
 * One step, pushed as it happens. A turn can take eight model calls, so the
 * reader must see what the agent is doing rather than a spinner that could
 * equally mean "thinking" or "hung".
 */
export const assistantProgressSchema = z
  .object({
    turnId: z.string().min(1).max(200),
    step: assistantStepSchema,
  })
  .strict();

export const assistantTurnRequestSchema = z
  .object({
    /** Recent conversation context, oldest first, ending on the user's turn. */
    messages: z.array(assistantMessageSchema).min(1).max(ASSISTANT_MAX_MESSAGES),
    /** Correlates pushed progress with this turn; progress is dropped without it. */
    turnId: z.string().trim().min(1).max(200).optional(),
    scope: retrievalAnswerScopeSchema.default("all"),
    selectedSources: z.array(retrievalAnswerCitationSchema).min(1).max(12).optional(),
    profileId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/**
 * What the reader thought of one answer. Deliberately two values and an
 * optional note: the decision-context feedback requires a written reason, which
 * is right for a considered judgement about a source and wrong here — a rating
 * nobody can give in one click is a rating nobody gives.
 */
export const assistantFeedbackRatingSchema = z.enum([
  "helpful",
  "not_helpful",
]);

export const assistantFeedbackInputSchema = z
  .object({
    /** The same id the turn's model calls carry, so the log can be read back. */
    turnId: z.string().trim().min(1).max(200),
    rating: assistantFeedbackRatingSchema,
    question: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE_CHARS),
    note: z.string().trim().max(ASSISTANT_MAX_FEEDBACK_NOTE_CHARS).optional(),
    /**
     * Vault-relative paths the answer cited. Paths, never excerpts: enough to
     * ask "which sources keep showing up in answers that missed", without
     * copying the notes themselves into a second store.
     */
    citedReferences: z
      .array(z.string().min(1).max(2_000))
      .max(ASSISTANT_MAX_CITATIONS)
      .default([]),
  })
  .strict();

export const assistantFeedbackResultSchema = z
  .object({
    status: z.enum(["saved", "unavailable"]),
    /** Ratings kept for this question's turn, after this one. */
    recorded: z.number().int().nonnegative().max(10_000),
  })
  .strict();

export const assistantFeedbackSummarySchema = z
  .object({
    helpful: z.number().int().nonnegative().max(1_000_000),
    notHelpful: z.number().int().nonnegative().max(1_000_000),
    /** The ratings file could not be read: the zeros are not counts. */
    unavailable: z.literal(true).optional(),
  })
  .strict();

/**
 * Conversations live only in renderer storage, so they are the one thing this
 * app holds that a reader cannot already take with them — decisions and notes
 * are Markdown in their own vault. Export writes wherever they choose, outside
 * the knowledge base: a conversation is not a record, and dropping it into the
 * vault would make it look like one.
 */
export const assistantExportResultSchema = z
  .object({
    status: z.enum(["saved", "cancelled", "failed"]),
    /** Absent unless something was written. */
    path: z.string().max(4_096).optional(),
  })
  .strict();

export const assistantTurnResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      version: z.literal(DECISION_ASSISTANT_VERSION),
      status: z.literal("answered"),
      message: assistantMessageSchema,
      provider: retrievalAnswerProviderSchema,
      durationMs: z.number().int().nonnegative().max(600_000),
      requestId: z.string().min(1).max(200),
      /** True when the agent ran out of steps and answered from what it had. */
      truncated: z.boolean(),
      /** The answer itself ran past its length and was cut: said apart from a search that was limited. */
      answerCut: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(DECISION_ASSISTANT_VERSION),
      status: z.literal("unavailable"),
      message: z.string().min(1).max(1_000),
      /** Spent before it failed: billed all the same. */
      tokens: assistantTokensSchema.optional(),
    })
    .strict(),
  /**
   * The reader stopped the turn. Distinct from a failure: nothing went wrong,
   * so the steps it did get through are reported rather than an error.
   */
  z
    .object({
      version: z.literal(DECISION_ASSISTANT_VERSION),
      status: z.literal("cancelled"),
      steps: z.array(assistantStepSchema).max(16),
      durationMs: z.number().int().nonnegative().max(600_000),
      /** Spent before it was stopped. */
      tokens: assistantTokensSchema.optional(),
    })
    .strict(),
]);

export type AssistantStep = z.infer<typeof assistantStepSchema>;
export type AssistantProgress = z.infer<typeof assistantProgressSchema>;
export type AssistantFeedbackRating = z.infer<
  typeof assistantFeedbackRatingSchema
>;
export type AssistantFeedbackInput = z.infer<
  typeof assistantFeedbackInputSchema
>;
export type AssistantFeedbackResult = z.infer<
  typeof assistantFeedbackResultSchema
>;
export type AssistantFeedbackSummary = z.infer<
  typeof assistantFeedbackSummarySchema
>;
export type AssistantExportResult = z.infer<
  typeof assistantExportResultSchema
>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;
export type AssistantTurnResponse = z.infer<typeof assistantTurnResponseSchema>;
