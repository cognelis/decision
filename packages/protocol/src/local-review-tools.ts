import { z } from "zod";

import { localReviewPathSchema } from "./local-review.js";

/**
 * 本地审阅给 agent 的工具（docs/review-collaboration-design.md「MCP 工具」）：record_local_review_job 交一批意见（本地工程改动上的，
 * 或用户自己 PR 上的）；list_local_review_jobs、get_local_review_job 读任务；update_local_review_job 取消或重试。推送到 PR 分支、
 * 高风险改动的授权都只在 App 里由用户确认，不在这里。
 */
export const LOCAL_REVIEW_TOOLS_VERSION = 1 as const;
const version = z.literal(LOCAL_REVIEW_TOOLS_VERSION);
const uuid = z.string().uuid();
const listed = {
  repositories: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  connections: z.array(z.object({ id: z.string(), label: z.string(), platform: z.string() })),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
};

export const localReviewJobRecordSchema = z.object({
  localReviewToolsVersion: version,
  /** A local repository added in 本地审阅: its id, name or path. With a PR: left out, the one pushing to its branch. */
  repository: z.string().trim().min(1).max(2_000).optional(),
  /** Comments on lines of the repository's changes (its HEAD against the base branch), each with what to change. */
  annotations: z.array(z.object({
    path: localReviewPathSchema, line: z.number().int().positive(), endLine: z.number().int().positive().optional(),
    side: z.enum(["old", "new"]).default("new"), body: z.string().trim().min(1).max(4_000),
  }).strict()).min(1).max(50).optional(),
  /** Or comments on the user's own PR (修): its link, the PR, and the comments' ids as list_pr_comments gives them. */
  connection: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().min(1).max(2_000).optional(),
  comments: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
  /** The model profile, by id or label. Left out: the first that fits. */
  model: z.string().trim().min(1).max(200).optional(),
}).strict()
  .refine((request) => (request.annotations ? 1 : 0) + (request.reference ? 1 : 0) === 1, { message: "annotations 和 reference 二选一。" })
  .refine((request) => !request.reference || request.comments, { message: "从 PR 交意见要给 comments。" })
  .refine((request) => request.reference || request.repository, { message: "本地改动上的意见要指明 repository。" });
export type LocalReviewJobRecord = z.output<typeof localReviewJobRecordSchema>;
/** refused: the local review would not take it, and said why in `reason` (a line out of range, the PR's head not fetched…). */
export const localReviewJobRecordResultSchema = z.object({
  localReviewToolsVersion: version,
  status: z.enum(["submitted", "repository_not_found", "connection_not_found", "connection_needed", "model_not_found", "refused"]),
  reason: z.string().max(2_000).nullable(),
  ...listed,
  jobId: uuid.nullable(),
});
export type LocalReviewJobRecordResult = z.infer<typeof localReviewJobRecordResultSchema>;

const groupSummary = z.object({
  ordinal: z.number().int().positive(), title: z.string(), state: z.string(), branch: z.string(),
  /** The PR it opened, or (a PR's comments) the PR its fix went to. */
  pr: z.string().nullable(),
  pushed: z.boolean(),
});
export const localReviewJobSummarySchema = z.object({
  id: uuid, repository: z.string(), state: z.string(), createdAt: z.string(), comments: z.number().int().nonnegative(),
  pr: z.object({ reference: z.string(), sourceBranch: z.string() }).nullable(),
  groups: z.array(groupSummary),
  /** Groups and comments waiting on the user: a failure, a push to confirm, a question. */
  needsAttention: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type LocalReviewJobSummary = z.infer<typeof localReviewJobSummarySchema>;

export const localReviewJobsQuerySchema = z.object({
  localReviewToolsVersion: version,
  repository: z.string().trim().min(1).max(2_000).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export type LocalReviewJobsQuery = z.output<typeof localReviewJobsQuerySchema>;
export const localReviewJobsResultSchema = z.object({ localReviewToolsVersion: version, jobs: z.array(localReviewJobSummarySchema), total: z.number().int().nonnegative() });
export type LocalReviewJobsResult = z.infer<typeof localReviewJobsResultSchema>;

export const localReviewJobRequestSchema = z.object({ localReviewToolsVersion: version, id: uuid }).strict();
export type LocalReviewJobRequest = z.output<typeof localReviewJobRequestSchema>;
export const localReviewJobViewSchema = localReviewJobSummarySchema.extend({
  worker: z.string(), model: z.string(),
  annotations: z.array(z.object({
    path: z.string(), line: z.number().int(), body: z.string(),
    /** The local review's word on it (accept, reject, needs_input), and what its fix did. */
    verdict: z.string().nullable(), reason: z.string().nullable(), outcome: z.string().nullable(), summary: z.string().nullable(),
  })),
  details: z.array(z.object({
    ordinal: z.number().int().positive(), commit: z.string().nullable(), changedFiles: z.array(z.string()), risks: z.array(z.string()),
    verification: z.string().nullable(), error: z.string().nullable(),
  })),
  followUp: z.object({ replied: z.number().int().nonnegative(), described: z.boolean(), error: z.string().nullable() }).nullable(),
});
export type LocalReviewJobView = z.infer<typeof localReviewJobViewSchema>;
export const localReviewJobResultSchema = z.object({ localReviewToolsVersion: version, job: localReviewJobViewSchema.nullable() });
export type LocalReviewJobResult = z.infer<typeof localReviewJobResultSchema>;

/** Cancel the task, or retry one of its groups (by number) or its evaluation; a push is the user's alone, in the App. */
export const localReviewJobUpdateSchema = z.object({
  localReviewToolsVersion: version, id: uuid, action: z.enum(["cancel", "retry"]),
  group: z.number().int().positive().optional(),
}).strict();
export type LocalReviewJobUpdate = z.output<typeof localReviewJobUpdateSchema>;
export const localReviewJobUpdateResultSchema = z.object({
  localReviewToolsVersion: version,
  status: z.enum(["done", "not_found", "refused"]),
  reason: z.string().max(2_000).nullable(),
  job: localReviewJobSummarySchema.nullable(),
});
export type LocalReviewJobUpdateResult = z.infer<typeof localReviewJobUpdateResultSchema>;
