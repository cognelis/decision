import { z } from "zod";

import { prReviewFindingSchema } from "./pr-review.js";
import { prReviewStatusSchema } from "./pr-review-approval.js";
import { prRiskLevelSchema, prRiskSchema } from "./pr-review-risk.js";
import { prCommentRespondResultSchema, prPublishedOutcomeSchema, prReceivedCommentsSchema } from "./pr-review-responses.js";

/**
 * PR 评审给 agent 的工具：读的有 list_prs、list_pr_reviews、get_pr_review，写的有 update_pr_review_finding（不采纳、撤回）和
 * record_pr_comments（把选定的问题发到 PR）。bridge 经 App 的本地接口问，App 读写平台和主进程里的评审历史。批准与合并不在
 * 这里：AI 的批准不算人。
 */
export const PR_REVIEW_TOOLS_VERSION = 1 as const;

const findingCountsSchema = z.object({ P1: z.number().int().nonnegative(), P2: z.number().int().nonnegative(), P3: z.number().int().nonnegative() });

/** One review or Q&A record, as a listing shows it. */
export const prReviewRecordSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["review", "chat"]),
  at: z.string(),
  model: z.string(),
  /** running: under way, or left so when the App stopped. */
  state: z.enum(["running", "finished", "interrupted", "failed"]),
  connectionId: z.string().nullable(),
  reference: z.string(),
  title: z.string(),
  sourceCommit: z.string(),
  risk: prRiskLevelSchema.nullable(),
  /** The review's status (completed, incomplete…); null for a Q&A or one that never finished. */
  status: z.string().nullable(),
  findings: findingCountsSchema,
  published: z.number().int().nonnegative(),
  /** Which review of this PR on this connection it was, counting from 1; null for a Q&A. */
  round: z.number().int().positive().nullable(),
  /** Started by 自动预评审. */
  auto: z.literal(true).optional(),
});
export type PrReviewRecordSummary = z.infer<typeof prReviewRecordSummarySchema>;

export const prReviewRecordFindingSchema = prReviewFindingSchema.extend({
  index: z.number().int().nonnegative(),
  basis: z.discriminatedUnion("tier", [
    z.object({ tier: z.literal("repository"), guides: z.array(z.string()) }),
    // `blocking`: the local rules it rests on that the reviewer marked blocking, by file; a P1 on one may block.
    z.object({ tier: z.literal("personal"), decisions: z.boolean(), localRules: z.boolean(), blocking: z.array(z.string()).default([]) }),
    z.object({ tier: z.literal("none") }),
  ]),
  /** The decisions it cites, by title. */
  decisions: z.array(z.string()),
  /** The latest re-evaluation, or the reviewer's own 不采纳 (by "reviewer") with its reason. */
  verdict: z.object({ verdict: z.enum(["keep", "replace", "drop"]), reason: z.string(), by: z.enum(["model", "reviewer"]), replacement: z.object({ title: z.string(), body: z.string() }).nullable() }).nullable(),
  published: z.boolean(),
  /** Posted as a blocking item (a Bitbucket task, or a discussion to resolve elsewhere). */
  blocking: z.boolean().default(false),
  /** Posted: what became of it on the PR as last read (发布后跟踪结果); null before it was read. */
  outcome: prPublishedOutcomeSchema.nullable().default(null),
});
export type PrReviewRecordFinding = z.infer<typeof prReviewRecordFindingSchema>;

/** One record in full but for its process log. */
export const prReviewRecordSchema = prReviewRecordSummarySchema.extend({
  focus: z.string(),
  destinationBranch: z.string().nullable(),
  riskDetail: prRiskSchema.nullable(),
  guides: z.array(z.string()),
  rules: z.array(z.string()),
  summary: z.string().nullable(),
  warnings: z.array(z.string()),
  findingsList: z.array(prReviewRecordFindingSchema),
  needsContext: z.array(z.object({ title: z.string(), path: z.string(), line: z.number(), reason: z.string(), missing: z.string() })),
  /** Candidates the review set aside: could not place on a changed line, or verification rejected. */
  setAside: z.object({ unplaced: z.number().int().nonnegative(), rejected: z.number().int().nonnegative() }),
  turns: z.array(z.object({ question: z.string(), answer: z.string(), state: z.string() })),
  error: z.string(),
});
export type PrReviewRecord = z.infer<typeof prReviewRecordSchema>;

export const prReviewRecordsQuerySchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  /** A PR exactly as the platform names it ("owner/repo#12"), or a repository ("owner/repo") for all of its PRs. */
  reference: z.string().trim().min(1).max(2_000).optional(),
  connectionId: z.string().uuid().optional(),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export type PrReviewRecordsQuery = z.output<typeof prReviewRecordsQuerySchema>;

export const prReviewRecordsResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  /** Record files the App could not read, left where they are. */
  unreadable: z.number().int().nonnegative(),
  records: z.array(prReviewRecordSummarySchema),
});
export type PrReviewRecordsResult = z.infer<typeof prReviewRecordsResultSchema>;

export const prReviewRecordRequestSchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), id: z.string().uuid() }).strict();
export type PrReviewRecordRequest = z.output<typeof prReviewRecordRequestSchema>;
export const prReviewRecordResultSchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), record: prReviewRecordSchema.nullable() });
export type PrReviewRecordResult = z.infer<typeof prReviewRecordResultSchema>;

export const prListToolQuerySchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  /** A connection's id or its label as the 链接 page shows it; left out, every connection's first page. */
  connection: z.string().trim().min(1).max(200).optional(),
  view: z.enum(["review_requested", "created", "merged"]).default("review_requested"),
  page: z.number().int().min(1).max(10_000_000).default(1),
}).strict();
export type PrListToolQuery = z.output<typeof prListToolQuerySchema>;

export const prListToolResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  /** connection_not_found: no connection has that id or label; the connections are listed. */
  status: z.enum(["ok", "connection_not_found"]),
  connections: z.array(z.object({ id: z.string(), label: z.string(), platform: z.string() })),
  lists: z.array(z.object({
    connectionId: z.string(),
    /** Why this connection's list could not be read; null when it was. */
    error: z.string().nullable(),
    nextPage: z.number().int().positive().nullable(),
    prs: z.array(z.object({
      reference: z.string(), title: z.string(), repository: z.string(), number: z.string(), author: z.string(), updatedAt: z.string(),
      /** This PR's latest record here, if any: its review state, risk and round. */
      latest: prReviewRecordSummarySchema.nullable(),
      /** Its build, people's approvals and open blockers on the platform now; null when not read (merged, or not in time). */
      status: prReviewStatusSchema.nullable().default(null),
    })),
  })),
});
export type PrListToolResult = z.infer<typeof prListToolResultSchema>;

/** 不采纳 a finding with its reason, or take that back: what the review page's 不采纳 and 撤回 do. */
export const prReviewFindingUpdateSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  id: z.string().uuid(),
  /** Its number as get_pr_review lists it, from 1. */
  finding: z.number().int().min(1).max(500),
  action: z.enum(["dismiss", "restore"]),
  /** dismiss only, and needed there: why it is not taken. Later reviews of the repository are told it. */
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
export type PrReviewFindingUpdate = z.output<typeof prReviewFindingUpdateSchema>;

/**
 * updated: written, the record as it now stands. unchanged: it stood so already. not_found: no such record.
 * refused: nothing written, said in `reason` (no such finding, a review still running, a finding already posted…).
 */
export const prReviewFindingUpdateResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["updated", "unchanged", "not_found", "refused"]),
  reason: z.string().max(500).nullable(),
  record: prReviewRecordSchema.nullable(),
});
export type PrReviewFindingUpdateResult = z.infer<typeof prReviewFindingUpdateResultSchema>;

/** Findings one record_pr_comments posts at most: each is a few platform calls, and the whole answers within a minute. */
export const PR_COMMENTS_PER_CALL = 10;

/** Findings of one review posted to its PR as line comments, on the review's own commits, as the review page posts them. */
export const prReviewCommentsRecordSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  id: z.string().uuid(),
  findings: z.array(z.object({
    /** Its number as get_pr_review lists it, from 1. */
    finding: z.number().int().min(1).max(500),
    /** A blocking item: a task on Bitbucket; elsewhere an ordinary comment the repository's "resolve discussions first" holds. Left out: a P1 that may block is one, as the review page has it. */
    blocking: z.boolean().optional(),
    /** Words to post instead of the finding's own; the line saying what it stands on is added either way. */
    body: z.string().trim().min(1).max(9_000).optional(),
    /** Post it even though a comment at its place already says the same (another reviewer's Paraself, say): only when the user insists. */
    evenIfDuplicate: z.boolean().optional(),
  }).strict()).min(1).max(PR_COMMENTS_PER_CALL),
}).strict();
export type PrReviewCommentsRecord = z.output<typeof prReviewCommentsRecordSchema>;

/**
 * posted: every one asked for is on the PR (some may have been already). partial: stopped at a failure after posting
 * some; failed: the first to post failed. Those after a failure were not tried. not_found: no such record; refused:
 * nothing posted, said in `reason`.
 */
export const prReviewCommentsResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["posted", "partial", "failed", "not_found", "refused"]),
  reason: z.string().max(1_000).nullable(),
  results: z.array(z.object({
    finding: z.number().int().positive(),
    /** duplicate: not posted, a comment at its place on the PR already says it (`message` names whose). */
    outcome: z.enum(["posted", "already_posted", "duplicate", "failed", "not_tried"]),
    blocking: z.boolean(),
    message: z.string().max(2_000),
  })).max(PR_COMMENTS_PER_CALL),
  /** What was not checked: the PR's comments that could not be read, so nothing was checked against them. */
  warnings: z.array(z.string().max(500)).max(5).default([]),
  record: prReviewRecordSchema.nullable(),
});
export type PrReviewCommentsResult = z.infer<typeof prReviewCommentsResultSchema>;

/** A PR named for the description tools: by its link (id or label as the 链接 page shows it; the only one when left out). */
const prTarget = {
  connection: z.string().trim().min(1).max(200).optional(),
  /** As the platform names it: owner/repo#12, PROJECT/repo#12. */
  reference: z.string().trim().min(1).max(2_000),
};
const connectionsListed = z.array(z.object({ id: z.string(), label: z.string(), platform: z.string() }));
const descriptionVersion = z.string().regex(/^[0-9a-f]{16}$/u);

/** get_pr_description_draft: the PR's description as it stands, and the three parts drafted where it lacks them. */
export const prDescriptionDraftQuerySchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), ...prTarget }).strict();
export type PrDescriptionDraftQuery = z.output<typeof prDescriptionDraftQuerySchema>;
/**
 * connection_not_found: no link by that name; connection_needed: more than one and none named (both list them).
 * failed: the PR could not be read, said in `reason`.
 */
export const prDescriptionDraftResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["ok", "connection_not_found", "connection_needed", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  draft: z.object({
    connectionId: z.string(), reference: z.string(), title: z.string(),
    /** The description as the platform has it now, and its version: update_pr writes over this one only. */
    description: z.string(), baseVersion: descriptionVersion,
    present: z.object({ verification: z.boolean(), risk: z.boolean(), rollback: z.boolean() }),
    /** The parts added, in order; none when it has all three. */
    added: z.array(z.enum(["verification", "risk", "rollback"])),
    /** The description with them added, what the author is asked to confirm or change. */
    text: z.string(),
    /** What they were drafted from. */
    facts: z.object({ risk: prRiskLevelSchema.nullable(), build: z.string().nullable(), reviewRound: z.number().int().nullable(), rollbackFromOverview: z.boolean() }),
  }).nullable(),
});
export type PrDescriptionDraftResult = z.infer<typeof prDescriptionDraftResultSchema>;

/** update_pr: the description written back, as the user confirmed it, over the version read. Nothing else about the PR. */
export const prUpdateRequestSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), ...prTarget,
  description: z.string().max(60_000),
  baseVersion: descriptionVersion,
}).strict();
export type PrUpdateRequest = z.output<typeof prUpdateRequestSchema>;
/** changed: the description moved since it was read (the author, another reviewer); nothing written. */
export const prUpdateResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["updated", "connection_not_found", "connection_needed", "changed", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  message: z.string().max(2_000).nullable(),
});
export type PrUpdateResult = z.infer<typeof prUpdateResultSchema>;

/**
 * run_pr_review: a review started as the review page starts one, the PR read fresh. A later round reads only what the
 * new commits changed unless the whole PR is asked for; a high-risk PR is reviewed deep unless said otherwise.
 */
export const prReviewRunToolRequestSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), ...prTarget,
  depth: z.enum(["standard", "deep"]).optional(),
  scope: z.enum(["since_last_review", "all"]).default("since_last_review"),
  focus: z.string().trim().max(2_000).default(""),
  /** A model's id or label as the review page lists it; left out, the one the PR's last review used, else the first. */
  model: z.string().trim().min(1).max(200).optional(),
}).strict();
export type PrReviewRunToolRequest = z.output<typeof prReviewRunToolRequestSchema>;
/**
 * started: running now, in the record `run.id` (get_pr_review reads it, done or not). busy: another review is running;
 * no_model / model_not_found: no model to review with, or none by that name (the models are listed).
 */
export const prReviewRunToolResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["started", "connection_not_found", "connection_needed", "busy", "no_model", "model_not_found", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  run: z.object({
    id: z.string().uuid(), reference: z.string(), title: z.string(), model: z.string(), depth: z.enum(["standard", "deep"]),
    /** The commit the last review read, when this round reads only what came after it. */
    since: z.string().nullable(),
    risk: prRiskLevelSchema.nullable(),
    round: z.number().int().positive(),
  }).nullable(),
});
export type PrReviewRunToolResult = z.infer<typeof prReviewRunToolResultSchema>;

/** list_pr_comments: someone else's comments on the user's own PR, each with what the user answered (作者回应). */
export const prCommentsToolQuerySchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), ...prTarget }).strict();
export type PrCommentsToolQuery = z.output<typeof prCommentsToolQuerySchema>;
export const prCommentsToolResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["listed", "connection_not_found", "connection_needed", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  read: prReceivedCommentsSchema.nullable(),
});
export type PrCommentsToolResult = z.infer<typeof prCommentsToolResultSchema>;
/** update_pr_comment: 不修 (wrong, intended, wontfix) with the user's reason, or 转后续 (later), sent as a standard reply. */
export const prCommentUpdateToolSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), ...prTarget,
  comment: z.string().trim().min(1).max(200),
  response: z.enum(["wrong", "intended", "wontfix", "later"]),
  reason: z.string().trim().max(4_000).default(""),
  todo: z.string().trim().min(1).max(200).optional(),
}).strict().refine((request) => request.response === "later" || request.reason.length > 0, { message: "不修要写明理由。", path: ["reason"] });
export type PrCommentUpdateTool = z.output<typeof prCommentUpdateToolSchema>;
/** refused: answered already, not found, or the user's own; failed: the platform did not take it, said in `reason`. */
export const prCommentUpdateToolResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["answered", "connection_not_found", "connection_needed", "refused", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  result: prCommentRespondResultSchema.nullable(),
});
export type PrCommentUpdateToolResult = z.infer<typeof prCommentUpdateToolResultSchema>;

/** get_pr_review_settings: each link's 自动预评审, and what it spent today. */
export const prReviewSettingsQuerySchema = z.object({ prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), connection: prTarget.connection }).strict();
export type PrReviewSettingsQuery = z.output<typeof prReviewSettingsQuerySchema>;
export const prReviewSettingsItemSchema = z.object({
  connectionId: z.string(), label: z.string(), platform: z.string(),
  /** Off when null: the model by id and label, and the reviews a day at most. */
  autoReview: z.object({ profileId: z.string(), model: z.string(), dailyReviews: z.number().int().positive() }).nullable(),
  /** Reviews it started today, by the App's clock. */
  usedToday: z.number().int().nonnegative(),
});
export type PrReviewSettingsItem = z.infer<typeof prReviewSettingsItemSchema>;
export const prReviewSettingsResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["ok", "connection_not_found"]),
  connections: connectionsListed,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  settings: z.array(prReviewSettingsItemSchema),
});
export type PrReviewSettingsResult = z.infer<typeof prReviewSettingsResultSchema>;
/** update_pr_review_settings: 自动预评审 on (a model, a daily limit) or off, for one link. */
export const prReviewSettingsUpdateSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), connection: prTarget.connection,
  autoReview: z.boolean(),
  model: z.string().trim().min(1).max(200).optional(),
  dailyReviews: z.number().int().min(1).max(50).optional(),
}).strict();
export type PrReviewSettingsUpdate = z.output<typeof prReviewSettingsUpdateSchema>;
export const prReviewSettingsUpdateResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["updated", "connection_not_found", "connection_needed", "model_not_found", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  settings: prReviewSettingsItemSchema.nullable(),
});
export type PrReviewSettingsUpdateResult = z.infer<typeof prReviewSettingsUpdateResultSchema>;
