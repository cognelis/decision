import { z } from "zod";

import { PR_REVIEW_TOOLS_VERSION } from "./pr-review-tools.js";
import { reviewEscapeSchema } from "./review-escapes.js";
import { reviewPromotionSchema } from "./review-promotions.js";

/**
 * 评审质量 (docs/review-collaboration-design.md「评审改进回路」): what became of the findings posted, which rules authors
 * keep calling wrong, and the team's own figures read from the code platform, over the last 30 days against the 30
 * before. Only the platform and the user's own records: nothing of teammates' use of Paraself.
 */
export const REVIEW_QUALITY_DAYS = 30;
const count = z.number().int().nonnegative();
const connectionsListed = z.array(z.object({ id: z.string(), label: z.string(), platform: z.string() }));

/** 团队指标 over one window: the merged PRs the user reviewed or wrote there. */
export const reviewTeamWindowSchema = z.object({
  prs: count,
  /** People approving a PR, on average; null without a PR. */
  approvalsPerPr: z.number().nonnegative().nullable(),
  /** Comments people wrote on a PR, on average (not Paraself's own, not bots'). */
  humanCommentsPerPr: z.number().nonnegative().nullable(),
  /** Median hours from opening to the first person's approval, over the PRs someone approved. */
  waitHours: z.number().nonnegative().nullable(),
  /** Reverts merged (护栏). */
  rollbacks: count,
  /** PRs merged then that a later revert or fix showed review let through (漏网). */
  escapes: count,
}).strict();
export type ReviewTeamWindow = z.infer<typeof reviewTeamWindowSchema>;

export const REVIEW_BASIS_ROWS = ["repository", "personal", "none"] as const;
export const REVIEW_BASIS_ROW_LABELS = { repository: "仓库规则", personal: "个人决策与本机规则", none: "代码本身" } as const;
/** Findings posted in the window by what they stand on, and what became of each (发布后跟踪结果). */
export const reviewOutcomeRowSchema = z.object({
  basis: z.enum(REVIEW_BASIS_ROWS),
  published: count, fixed: count, wrong: count, intended: count, wontfix: count, later: count, none: count,
}).strict();
export type ReviewOutcomeRow = z.infer<typeof reviewOutcomeRowSchema>;

/** A rule whose posted findings authors keep calling wrong or not worth it (噪声统计): to rewrite, or turn off. */
export const reviewNoisyRuleSchema = z.object({
  kind: z.enum(["local_rule", "decision"]),
  /** The rule's file in its directory, or the decision's id. */
  id: z.string().max(500),
  /** A local rule's directory: Paraself's own can be turned off from here, code-meeseeks' only rewritten there. */
  source: z.enum(["decision", "code-meeseeks"]).nullable(),
  title: z.string().max(500),
  /** A decision's note in the vault, to open and rewrite it. */
  notePath: z.string().max(1_000).nullable(),
  settled: count, wrong: count, wontfix: count, prs: count,
  /** The authors' reasons, newest first. */
  words: z.array(z.string().max(500)).max(3),
}).strict();
export type ReviewNoisyRule = z.infer<typeof reviewNoisyRuleSchema>;

export const reviewQualitySchema = z.object({
  connectionId: z.string(), label: z.string(), platform: z.string(), days: count,
  team: z.object({
    current: reviewTeamWindowSchema, previous: reviewTeamWindowSchema,
    /** Merged PRs of the two windows not counted yet: read a few at a time, the rest on the next look. */
    unread: count,
    error: z.string().max(1_000).nullable(),
  }).strict(),
  outcomes: z.object({
    rows: z.array(reviewOutcomeRowSchema),
    /** Changed at their place since, with no answer from the author: kept out of the rows. */
    maybeFixed: count,
    total: count,
  }).strict(),
  noise: z.array(reviewNoisyRuleSchema).max(20),
  /** 漏网复盘 still to write or written, newest first. */
  escapes: z.array(reviewEscapeSchema).max(50),
  /** 晋升提议: the user's own rules review keeps needing, for the repository's REVIEW.md. */
  promotions: z.array(reviewPromotionSchema).max(30),
}).strict();
export type ReviewQuality = z.infer<typeof reviewQualitySchema>;

/** get_review_quality, and the page's read of one link. */
export const reviewQualityQuerySchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), connection: z.string().trim().min(1).max(200).optional() }).strict();
export type ReviewQualityQuery = z.output<typeof reviewQualityQuerySchema>;
export const reviewQualityResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["ok", "connection_not_found", "connection_needed"]),
  connections: connectionsListed,
  quality: reviewQualitySchema.nullable(),
}).strict();
export type ReviewQualityResult = z.infer<typeof reviewQualityResultSchema>;

/** update_review_rule: one of Paraself's own local review rules turned off, or on again. */
export const reviewRuleUpdateSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  /** The rule's file in Paraself's rules directory, as the quality page names it. */
  rule: z.string().trim().min(1).max(500),
  enabled: z.boolean(),
}).strict();
export type ReviewRuleUpdate = z.output<typeof reviewRuleUpdateSchema>;
export const reviewRuleUpdateResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["updated", "not_found", "failed"]),
  reason: z.string().max(1_000).nullable(),
}).strict();
export type ReviewRuleUpdateResult = z.infer<typeof reviewRuleUpdateResultSchema>;
