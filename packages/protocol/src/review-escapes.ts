import { z } from "zod";

import { PR_REVIEW_TOOLS_VERSION } from "./pr-review-tools.js";

/**
 * 漏网复盘 (docs/review-collaboration-design.md「漏网复盘」): a merged PR that was later reverted, or that a later PR
 * fixed, is a problem review let through. Four lines are written for it: what the problem was, which layer should have
 * stopped it, why it did not, and where the change goes. With where the problem sat, it becomes a defect benchmark case.
 */
export const REVIEW_ESCAPE_LAYERS = { self_review: "作者自评审", pre_review: "Paraself 预评审", human_review: "人工评审", ci: "CI 与测试", other: "其他" } as const;
export const REVIEW_ESCAPE_CHANGES = { rule: "规则", prompt: "提示", check: "检查", norm: "团队规范" } as const;
export const REVIEW_ESCAPE_KINDS = { revert: "回滚", fix: "修复", reported: "用户说的" } as const;
const layers = Object.keys(REVIEW_ESCAPE_LAYERS) as [keyof typeof REVIEW_ESCAPE_LAYERS, ...Array<keyof typeof REVIEW_ESCAPE_LAYERS>];
const changes = Object.keys(REVIEW_ESCAPE_CHANGES) as [keyof typeof REVIEW_ESCAPE_CHANGES, ...Array<keyof typeof REVIEW_ESCAPE_CHANGES>];

export const reviewEscapeWriteupSchema = z.object({
  problem: z.string().trim().min(1).max(300),
  layer: z.enum(layers),
  why: z.string().trim().min(1).max(600),
  change: z.enum(changes),
  /** What to change there, in a line. */
  changeText: z.string().trim().max(600).default(""),
}).strict();
export type ReviewEscapeWriteup = z.output<typeof reviewEscapeWriteupSchema>;

/** Where the problem sat in the escaped PR, as the PR left the file; what makes it a defect case. */
export const reviewEscapeLocationSchema = z.object({
  path: z.string().trim().min(1).max(1_000),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
}).strict();

export const reviewEscapeSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string(),
  /** The PR that let it through, and its title. */
  reference: z.string().max(2_000), title: z.string().max(2_000),
  mergedAt: z.string().nullable(),
  /** What showed it: a revert or a fixing PR found among the merged ones, or what the user said (a PR or a commit). */
  by: z.object({ kind: z.enum(["revert", "fix", "reported"]), reference: z.string().max(2_000), title: z.string().max(2_000) }).strict(),
  foundAt: z.string(),
  state: z.enum(["open", "written", "dismissed"]),
  writeup: reviewEscapeWriteupSchema.nullable(),
  /** Why it is not one, when dismissed. */
  dismissed: z.string().max(600).nullable(),
  /** The defect benchmark case it became, if it did. */
  benchmarkCase: z.string().max(100).nullable(),
}).strict();
export type ReviewEscape = z.infer<typeof reviewEscapeSchema>;

const connectionsListed = z.array(z.object({ id: z.string(), label: z.string(), platform: z.string() }));
const connection = z.string().trim().min(1).max(200).optional();

/** record_review_escape: one the user names (a PR fixed later by a PR or a commit), with its four lines if they gave them. */
export const reviewEscapeRecordSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), connection,
  reference: z.string().trim().min(1).max(2_000),
  by: z.string().trim().min(1).max(2_000),
  kind: z.enum(["revert", "fix"]).default("fix"),
  writeup: reviewEscapeWriteupSchema.optional(),
}).strict();
export type ReviewEscapeRecord = z.output<typeof reviewEscapeRecordSchema>;
export const reviewEscapeRecordResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["recorded", "exists", "connection_not_found", "connection_needed", "failed"]),
  reason: z.string().max(1_000).nullable(),
  connections: connectionsListed,
  escape: reviewEscapeSchema.nullable(),
}).strict();
export type ReviewEscapeRecordResult = z.infer<typeof reviewEscapeRecordResultSchema>;

/** list_review_escapes, and the quality page's list. */
export const reviewEscapesQuerySchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION), connection,
  state: z.enum(["open", "written", "dismissed"]).optional(),
}).strict();
export type ReviewEscapesQuery = z.output<typeof reviewEscapesQuerySchema>;
export const reviewEscapesResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["ok", "connection_not_found", "connection_needed"]),
  connections: connectionsListed,
  escapes: z.array(reviewEscapeSchema).max(200),
}).strict();
export type ReviewEscapesResult = z.infer<typeof reviewEscapesResultSchema>;

/**
 * update_review_escape: its four lines written (or rewritten), dismissed as no escape with why, opened again, or made a
 * defect benchmark candidate from where the problem sat.
 */
export const reviewEscapeUpdateSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  id: z.string().uuid(),
  action: z.enum(["write", "dismiss", "reopen", "add_to_benchmark"]),
  writeup: reviewEscapeWriteupSchema.optional(),
  reason: z.string().trim().max(600).optional(),
  location: reviewEscapeLocationSchema.optional(),
  priority: z.enum(["P1", "P2", "P3"]).default("P2"),
}).strict()
  .refine((request) => request.action !== "write" || request.writeup !== undefined, { message: "写复盘要给四行。", path: ["writeup"] })
  .refine((request) => request.action !== "dismiss" || Boolean(request.reason), { message: "不是漏网要写明理由。", path: ["reason"] })
  .refine((request) => request.action !== "add_to_benchmark" || request.location !== undefined, { message: "加入评测集要给问题所在的位置。", path: ["location"] });
export type ReviewEscapeUpdate = z.output<typeof reviewEscapeUpdateSchema>;
/** As the review page sends it. */
export type ReviewEscapeUpdateInput = Omit<z.input<typeof reviewEscapeUpdateSchema>, "prReviewToolsVersion">;
export const reviewEscapeUpdateResultSchema = z.object({
  prReviewToolsVersion: z.literal(PR_REVIEW_TOOLS_VERSION),
  status: z.enum(["updated", "not_found", "refused", "failed"]),
  reason: z.string().max(1_000).nullable(),
  escape: reviewEscapeSchema.nullable(),
}).strict();
export type ReviewEscapeUpdateResult = z.infer<typeof reviewEscapeUpdateResultSchema>;
