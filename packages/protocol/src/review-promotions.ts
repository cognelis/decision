import { z } from "zod";

import { PR_REVIEW_TOOLS_VERSION } from "./pr-review-tools.js";

/**
 * 晋升提议 (docs/review-collaboration-design.md「知识回路」): a rule that lives only in the user's Paraself, which review
 * keeps needing, proposed for the repository's REVIEW.md, where the author and everyone's review can see it. The signals:
 * its findings came up in two PRs or more; a P1 on it was fixed; an author answered that the repository has no such
 * rule; an escape's write-up said the change goes into a rule or a team norm.
 */
const count = z.number().int().nonnegative();
export const reviewPromotionSchema = z.object({
  key: z.string().max(600),
  /** A decision or local rule behind posted findings; or an escape's write-up. */
  kind: z.enum(["decision", "local_rule", "escape"]),
  title: z.string().max(500),
  /** The repository it would go into (owner/repo), where most of its findings were. */
  repository: z.string().max(1_000),
  /** What says it should be promoted, in words. */
  signals: z.array(z.string().max(300)).min(1).max(5),
  /** The findings it stood behind, newest first. */
  evidence: z.array(z.object({ reference: z.string().max(2_000), title: z.string().max(300), outcome: z.string().max(100) }).strict()).max(5),
  prs: count, fixed: count,
  /** The line proposed for REVIEW.md, for the user to change before it goes. */
  draft: z.string().max(1_000),
  /** Handed to the local review to write into the repository, as a task there. */
  proposed: z.object({ at: z.string(), jobId: z.string() }).strict().nullable(),
}).strict();
export type ReviewPromotion = z.infer<typeof reviewPromotionSchema>;

/** list_rule_promotion_candidates, and the quality page's list. */
export const reviewPromotionsQuerySchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), connection: z.string().trim().min(1).max(200).optional() }).strict();
export type ReviewPromotionsQuery = z.output<typeof reviewPromotionsQuerySchema>;
export const reviewPromotionsResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["ok", "connection_not_found", "connection_needed"]),
  connections: z.array(z.object({ id: z.string(), label: z.string(), platform: z.string() })),
  promotions: z.array(reviewPromotionSchema).max(30),
}).strict();
export type ReviewPromotionsResult = z.infer<typeof reviewPromotionsResultSchema>;

/** The review page: one proposed (its line, as the user left it, handed to the local review) or left. */
export const reviewPromotionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("propose"), connectionId: z.string().uuid(), key: z.string().max(600), draft: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ action: z.literal("dismiss"), key: z.string().max(600) }).strict(),
]);
export type ReviewPromotionAction = z.output<typeof reviewPromotionActionSchema>;
export const reviewPromotionActionResultSchema = z.object({ ok: z.boolean(), message: z.string().max(1_000), jobId: z.string().nullable() }).strict();
export type ReviewPromotionActionResult = z.infer<typeof reviewPromotionActionResultSchema>;
