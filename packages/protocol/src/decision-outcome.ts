import { z } from "zod";

// Internal section delimiters must not be mistaken for user supplied evidence.
const evidence = z.string().trim().min(1).max(8_000).refine((text) =>
  !/<!--\s*decision:|#{2,3} (?:后续结果|复盘结论|复盘经验)/u.test(text),
"Evidence contains reserved note delimiters");
const date = z.iso.date();
export const decisionOutcomeReviewSchema = z.object({
  verdict: z.enum(["better", "as_expected", "mixed", "worse", "unclear"]),
  lesson: z.string().max(8_000).nullable(),
  reviewedAt: z.string().min(1).max(100),
}).strict();
export const decisionOutcomeStateSchema = z.object({
  expectedOutcome: z.string().max(8_000).nullable(),
  outcome: z.string().max(8_000).nullable(),
  review: decisionOutcomeReviewSchema.nullable(),
  reviewDueDate: date.nullable(),
}).strict();
export const decisionOutcomeUpdateSchema = z.object({
  source: z.literal("decisions"),
  recordId: z.string().trim().min(1).max(200),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  // Read back, a 预期结果 heading would end the outcome there, so the note refuses it in an outcome (a lesson sits
  // elsewhere and takes it): refused here, the agent is told so, not "Outcome contains reserved note delimiters".
  outcome: evidence.refine((text) => text !== "（尚未记录）", "Provide an actual observation, not the empty-outcome placeholder")
    .refine((text) => !/#{2,3} 预期结果/u.test(text), "Outcome contains the expected-outcome heading").optional(),
  review: z.object({
    verdict: decisionOutcomeReviewSchema.shape.verdict,
    lesson: evidence.nullable(),
  }).strict().nullable().optional(),
  reviewDueDate: date.nullable().optional(),
}).strict().refine((input) => input.outcome !== undefined || input.review !== undefined || input.reviewDueDate !== undefined,
"Provide an outcome, review or review date to update");
export const decisionOutcomeUpdateResultSchema = z.object({
  status: z.enum(["saved", "unchanged", "source_changed", "source_unavailable", "outcome_required", "review_required", "review_completed"]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  relativePath: z.string().min(1).max(2_000).nullable(),
  state: decisionOutcomeStateSchema.nullable(),
  indexed: z.boolean().nullable(),
  warnings: z.array(z.string().max(500)).max(10),
}).strict();
export type DecisionOutcomeUpdate = z.infer<typeof decisionOutcomeUpdateSchema>;
export type DecisionOutcomeState = z.infer<typeof decisionOutcomeStateSchema>;
export type DecisionOutcomeUpdateResult = z.infer<typeof decisionOutcomeUpdateResultSchema>;
