import { z } from "zod";

export const PROACTIVE_RECORD_VERSION = 1 as const;

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalText = (maximum: number) => text(maximum).optional();
// A journal note keeps its title as a heading and each open question as a list item: one line each.
const line = (maximum: number) => text(maximum).regex(/^[^\r\n]*$/u, "must be a single line");
/** The programming languages a preference or idea is about; left out or empty, it holds for every language. */
export const recordLanguagesSchema = z.array(text(40)).max(8);

export const proactiveRecordSourceKindSchema = z.enum([
  "app_manual",
  "offline_conversation",
  "meeting",
  "observation",
  "agent_capture",
]);
export const proactiveRecordSourceFormSchema = z.enum([
  "user_original",
  "user_paraphrase",
  "machine_summary",
]);
export const recordSensitivitySchema = z.enum([
  "private",
  "personal",
  "shareable",
]);
export const knowledgeStatusSchema = z.enum(["inbox", "active", "archived"]);

const common = {
  recordVersion: z.literal(PROACTIVE_RECORD_VERSION),
  requestId: text(200),
  sourceClient: z.enum(["manual", "claude-code", "codex", "test"]),
  sourceKind: proactiveRecordSourceKindSchema,
  sourceForm: proactiveRecordSourceFormSchema,
  sensitivity: recordSensitivitySchema.default("private"),
  project: optionalText(500),
  occurredAt: z.string().datetime().optional(),
  title: text(500),
  content: text(8_000),
  knowledgeStatus: knowledgeStatusSchema.optional(),
  context: optionalText(8_000),
  rationale: optionalText(8_000),
  tags: z.array(text(100)).max(12).default([]),
};

const decisionRequestSchema = z
  .object({
    ...common,
    kind: z.literal("decision"),
    // A PR comment is only ever a decision's source; preferences and ideas keep the base kinds.
    sourceKind: z.enum([...proactiveRecordSourceKindSchema.options, "pr_comment"]),
    sourceUrl: z.string().url().max(2_000).optional(),
    options: z.array(text(2_000)).max(8).default([]),
    expectedOutcome: optionalText(4_000),
    reviewDueDate: z.string().date().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.sourceKind === "pr_comment") !== (value.sourceUrl !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "PR comment decisions carry their comment link, and only they do",
      });
    }
  });

const preferenceRequestSchema = z
  .object({
    ...common,
    kind: z.literal("preference"),
    title: line(500),
    languages: recordLanguagesSchema.optional(),
    appliesWhen: optionalText(4_000),
    exceptions: optionalText(4_000),
    // Left out, not said: a new entry takes the default, a restated one keeps what it has.
    strength: z.enum(["hard_constraint", "default", "weak_signal"]).optional(),
    evidenceMaturity: z.enum(["self_declared", "repeated", "reviewed"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.knowledgeStatus === "active" &&
      (value.appliesWhen === undefined || value.exceptions === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "active preferences require appliesWhen and exceptions",
      });
    }
  });

const ideaRequestSchema = z
  .object({
    ...common,
    kind: z.literal("idea"),
    title: line(500),
    languages: recordLanguagesSchema.optional(),
    ideaForm: z.enum(["observation", "question", "hypothesis", "possibility"]).optional(),
    whyInteresting: optionalText(4_000),
    openQuestions: z.array(line(1_000)).max(8).default([]),
    nextTest: optionalText(4_000),
    incubateUntil: z.string().date().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.knowledgeStatus === "active" && value.whyInteresting === undefined) {
      context.addIssue({
        code: "custom",
        message: "active ideas require whyInteresting",
      });
    }
  });

export const proactiveRecordRequestSchema = z.discriminatedUnion("kind", [
  decisionRequestSchema,
  preferenceRequestSchema,
  ideaRequestSchema,
]);

export const proactiveRecordResultSchema = z
  .object({
    recordVersion: z.literal(PROACTIVE_RECORD_VERSION),
    // updated: a preference or idea restated with something new, kept as a revision of the one already there.
    status: z.enum(["created", "duplicate", "updated"]),
    recordKind: z.enum(["decision", "preference", "idea"]),
    recordId: text(200),
    knowledgeStatus: z.enum(["active", "inbox", "archived"]),
    sensitivity: recordSensitivitySchema,
    storedTranscript: z.literal(false),
  })
  .strict();

export type ProactiveRecordRequest = z.infer<
  typeof proactiveRecordRequestSchema
>;
export type ProactiveRecordResult = z.infer<typeof proactiveRecordResultSchema>;
