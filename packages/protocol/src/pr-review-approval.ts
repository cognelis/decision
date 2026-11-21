import { z } from "zod";

import { prFindingBasis } from "./pr-review-basis.js";
import type { PrRiskLevel } from "./pr-review-risk.js";

/**
 * 批准条件（docs/review-collaboration-design.md「批准」）：风险等级要几个人批准、已批准几人、构建状态、未完成的阻塞项、
 * PR 描述三段；低风险 PR 满足全部条件时可以快速批准。AI 的批准不算人：这里只读平台上的人工批准。
 */

/** How the head commit's checks stand, combined: failed if any failed, running if any still runs, passed if all passed. */
export const prBuildStateSchema = z.enum(["passed", "failed", "running", "none", "unknown"]);
export type PrBuildState = z.infer<typeof prBuildStateSchema>;
export const PR_BUILD_LABELS: Record<PrBuildState, string> = { passed: "构建通过", failed: "构建失败", running: "构建中", none: "没有构建", unknown: "构建状态未知" };

export const prReviewStatusSchema = z.object({
  /** The head commit it was read for. */
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  build: prBuildStateSchema,
  /**
   * People whose latest review approves this head commit (`users` as shown, `logins` as the platform names them, to
   * match code owners by); `stale`, those who approved an earlier commit and have not looked again since. Null when the
   * platform would not say.
   */
  approvals: z.object({ count: z.number().int().nonnegative(), users: z.array(z.string().max(200)).max(50),
    logins: z.array(z.string().max(200)).max(50).default([]), stale: z.array(z.string().max(200)).max(50).default([]) }).nullable(),
  /** Open blocking items (Bitbucket's open tasks, unresolved threads elsewhere); null when the platform would not say. */
  blockers: z.number().int().nonnegative().nullable(),
  /** How the platform blocks a merge on them: open tasks, or discussions that must be resolved (a repository setting). */
  blocking: z.enum(["tasks", "discussions"]),
  /** Whether that setting is on (Bitbucket's "no incomplete tasks" merge check, the others' "resolve discussions first"); null when it could not be read. */
  blockersHold: z.boolean().nullable().default(null),
  /** Which of the template's three parts the PR's description has now (prDescriptionSections); null when not read with it. */
  sections: z.object({ verification: z.boolean(), risk: z.boolean(), rollback: z.boolean() }).nullable().default(null),
  /** What could not be read, said rather than shown as nothing. */
  problems: z.array(z.string().max(300)).max(10),
});
export type PrReviewStatus = z.infer<typeof prReviewStatusSchema>;

/** Some PRs of one link, each read for its status (the list's page at most). */
export const prReviewStatusRequestSchema = z.object({
  connectionId: z.string().uuid(),
  references: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
}).strict();
export type PrReviewStatusRequest = z.infer<typeof prReviewStatusRequestSchema>;
/** Each asked for, in order: its status, or why it could not be read. */
export const prReviewStatusListSchema = z.object({
  statuses: z.array(z.object({ reference: z.string().max(2_000), status: prReviewStatusSchema.nullable(), error: z.string().max(500).optional() })).max(30),
});
export type PrReviewStatusList = z.infer<typeof prReviewStatusListSchema>;

/** People who must approve, by the PR's level: a high-risk change gets two pairs of eyes. */
export const PR_REQUIRED_APPROVALS: Record<PrRiskLevel, number> = { low: 1, medium: 1, high: 2 };

// A heading or a bold label opening a line; the word not the start of a longer English one ("Riskless" is no 风险).
const section = (words: string) => new RegExp(`^(?:#{1,6}\\s*|\\*\\*|[-*]\\s*\\*\\*)?\\s*(?:${words})(?![a-z])`, "imu");
const SECTIONS = {
  verification: section("验证|测试|verification|testing|tests"),
  risk: section("风险|risks?"),
  rollback: section("撤回|回滚|rollback|revert"),
};
/** Which of the PR template's three parts the description has, each as a heading or a bold label opening a line. */
export const prDescriptionSections = (description: string): Record<keyof typeof SECTIONS, boolean> => ({
  verification: SECTIONS.verification.test(description),
  risk: SECTIONS.risk.test(description),
  rollback: SECTIONS.rollback.test(description),
});
export const PR_DESCRIPTION_SECTION_LABELS = { verification: "验证", risk: "风险", rollback: "撤回" } as const;

/**
 * A finding may be posted as blocking unless it stands only on the reviewer's own decisions or rules; a P1 on a local
 * rule they marked `enforcement: blocking` may, its comment quoting the rule.
 */
export const prFindingCanBlock = (finding: { priority: string; body: string; decisionIndexes: readonly number[] }, guides: readonly string[] | undefined, rules?: Parameters<typeof prFindingBasis>[2]): boolean => {
  const basis = prFindingBasis(finding, guides, rules);
  return basis.tier !== "personal" || (finding.priority === "P1" && basis.blocking.length > 0);
};
/** Posted as blocking unless the reviewer says otherwise: a P1 that may be (the design's 成立的 P1 发布时设为阻塞). */
export const prFindingBlocksByDefault = (finding: { priority: string; body: string; decisionIndexes: readonly number[] }, guides: readonly string[] | undefined, rules?: Parameters<typeof prFindingBasis>[2]): boolean =>
  finding.priority === "P1" && prFindingCanBlock(finding, guides, rules);

/**
 * Quick approval, for a low-risk PR only: every check holds. What the checks cannot catch is the reviewer's to say (the
 * design's: one who cannot say what they would miss should review properly instead).
 */
export const prQuickApprovalChecks = (input: { risk: PrRiskLevel | undefined; status: PrReviewStatus | null | undefined;
  /** Findings of a finished review still standing; null without one. */
  openFindings: number | null; description: string }) => {
  // The description as the platform has it now, else as the review read it.
  const sections = input.status?.sections ?? prDescriptionSections(input.description);
  const checks = [
    { label: "构建通过", ok: input.status?.build === "passed" },
    { label: "没有未完成的阻塞项", ok: input.status?.blockers === 0 },
    { label: "预评审没有成立的问题", ok: input.openFindings === 0 },
    { label: "PR 描述三段齐全", ok: sections.verification && sections.risk && sections.rollback },
  ];
  return { eligible: input.risk === "low" && checks.every((check) => check.ok), checks };
};
