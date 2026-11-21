import { z } from "zod";

import { prDescriptionSections, PR_BUILD_LABELS, type PrReviewStatus } from "./pr-review-approval.js";
import type { PrReviewHistoryEntry } from "./pr-review-history.js";
import { PR_RISK_LABELS, type PrRisk } from "./pr-review-risk.js";

/**
 * PR 描述三段（docs/review-collaboration-design.md「送审前自评审」：验证、风险、撤回）：Paraself 起草，作者确认后写回。
 * 已有的描述原样保留，只补上缺的段落；写回前核对描述在起草之后没被改过。
 */

/** A description as it stood when read, to tell whether it moved before it is written over (not a security hash). */
export const prDescriptionVersion = (text: string | null | undefined): string => {
  // cyrb53: two 32-bit FNV-like lanes, mixed; plenty to tell one edit from another.
  let first = 0xdeadbeef, second = 0x41c6ce57;
  for (const char of text ?? "") {
    const code = char.codePointAt(0)!;
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
};

/** What a PR overview says about undoing the change, if it says anything: the model's draft of the third part. */
export const prOverviewRollback = (overview: string): string | null => {
  const found = /(?:^|\n)\*\*撤回\*\*\n/u.exec(overview);
  if (!found) return null;
  const rest = overview.slice(found.index + found[0].length);
  const end = rest.search(/\n\n\*\*[^*\n]+\*\*\n/u);
  return (end < 0 ? rest : rest.slice(0, end)).trim() || null;
};

export interface PrDescriptionFacts {
  /** The PR's level by the files it changes; null when not read yet. */
  risk: PrRisk | null | undefined;
  /** Its platform status as last read: the build goes into 验证. */
  status: PrReviewStatus | null | undefined;
  /** The PR's latest review here: how many findings, posted, and those turned down with why. */
  review: { round: number; findings: number; published: number; dismissed: Array<{ title: string; reason: string }> } | null;
  /** The latest PR overview's rollback note. */
  rollback: string | null;
  /** The changed files, for the modules 风险 names. */
  files: readonly string[];
}

/** The modules a change touches, by their first two path segments, the most changed first. */
const modulesOf = (files: readonly string[]): string[] => {
  const counts = new Map<string, number>();
  for (const path of files) {
    const parts = path.split("/");
    const module = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0]! : "根目录";
    counts.set(module, (counts.get(module) ?? 0) + 1);
  }
  return [...counts].sort((first, second) => second[1] - first[1]).map(([module]) => module);
};

/** Each part as drafted: facts Paraself has, and what only the author can say left as a prompt in brackets. */
export const prDescriptionParts = (facts: PrDescriptionFacts): Record<"verification" | "risk" | "rollback", string> => {
  const build = facts.status && facts.status.build !== "unknown" ? `${PR_BUILD_LABELS[facts.status.build]}。` : "";
  const review = facts.review ? `Paraself 预评审${facts.review.round > 1 ? `第 ${facts.review.round} 轮` : ""}发现 ${facts.review.findings} 个问题${facts.review.published ? `，${facts.review.published} 条已发到 PR` : ""}${facts.review.dismissed.length
    ? `，${facts.review.dismissed.length} 条不采纳：${facts.review.dismissed.slice(0, 5).map((item) => `${item.title}（${item.reason}）`).join("；")}` : ""}。` : "";
  const risk = facts.risk;
  const reasons = risk ? risk.reasons.filter((reason) => reason.level === risk.level).slice(0, 3).map((reason) => `${reason.reason}（${reason.paths[0] ?? ""}${reason.paths.length + reason.more > 1 ? ` 等 ${reason.paths.length + reason.more} 个文件` : ""}）`) : [];
  const modules = modulesOf(facts.files);
  return {
    verification: `${build}${review}（补上跑了哪些检查：单元测试、lint、手工验证……）`,
    risk: risk ? `${PR_RISK_LABELS[risk.level]}${reasons.length ? `：${reasons.join("；")}` : ""}${risk.table === "default" ? "（目标分支没有 REVIEW.md 风险路径表，按默认规则判定）" : ""}。${modules.length ? `影响 ${modules.slice(0, 5).join("、")}${modules.length > 5 ? ` 等 ${modules.length} 处` : ""}。` : ""}`
      : "（写明风险等级、依据和影响到的模块）",
    rollback: facts.rollback ?? "（写明怎么撤回，以及哪些撤不掉：数据迁移、已发出的消息、对外接口等）",
  };
};

const HEADINGS = { verification: "验证", risk: "风险", rollback: "撤回" } as const;
/**
 * The description with the parts it lacks added at its end, each under its own heading; what the author wrote stays as
 * it is. Nothing lacking, it is returned unchanged.
 */
export const prDescriptionDraft = (description: string, facts: PrDescriptionFacts): { text: string; added: Array<keyof typeof HEADINGS> } => {
  const present = prDescriptionSections(description);
  const parts = prDescriptionParts(facts);
  const added = (Object.keys(HEADINGS) as Array<keyof typeof HEADINGS>).filter((part) => !present[part]);
  if (!added.length) return { text: description, added };
  const head = description.trimEnd();
  return { text: [head, ...added.map((part) => `## ${HEADINGS[part]}\n\n${parts[part]}`)].filter(Boolean).join("\n\n"), added };
};

/** A PR's description as its platform has it now, and the version to write over. */
export const prDescriptionReadSchema = z.object({ connectionId: z.string().uuid(), reference: z.string().trim().min(1).max(2_000) }).strict();
export type PrDescriptionRead = z.infer<typeof prDescriptionReadSchema>;
export const prDescriptionSchema = z.object({ title: z.string().max(2_000), description: z.string().max(65_536), version: z.string().regex(/^[0-9a-f]{16}$/u) }).strict();
export type PrDescription = z.infer<typeof prDescriptionSchema>;
/** Written back only over the version read: one changed since (the author, another reviewer) is not written over. */
export const prDescriptionUpdateSchema = prDescriptionReadSchema.extend({
  description: z.string().max(60_000),
  baseVersion: z.string().regex(/^[0-9a-f]{16}$/u),
}).strict();
export type PrDescriptionUpdate = z.infer<typeof prDescriptionUpdateSchema>;
export const prDescriptionUpdateResultSchema = z.object({ message: z.string().max(2_000) }).strict();
export type PrDescriptionUpdateResult = z.infer<typeof prDescriptionUpdateResultSchema>;

/**
 * What Paraself knows of a PR for its description, from the records it keeps: its latest review (round, findings, posted,
 * turned down) and its latest overview's rollback note, wherever it was asked (a record of its own, or a turn of a review).
 */
export const prDescriptionFactsFrom = (entries: readonly PrReviewHistoryEntry[], connectionId: string, reference: string,
  known: { risk: PrRisk | null | undefined; status: PrReviewStatus | null | undefined; files: readonly string[] }): PrDescriptionFacts => {
  const own = entries.filter((entry) => entry.connectionId === connectionId && entry.snapshot.reference === reference);
  const reviews = own.filter((entry) => entry.kind === "review" && entry.report);
  const latest = [...reviews].sort((first, second) => second.at.localeCompare(first.at))[0];
  const overview = own.flatMap((entry) => entry.turns.filter((turn) => turn.question === "/describe" && turn.state === "done" && turn.answer).map((turn) => turn))
    .sort((first, second) => second.at.localeCompare(first.at))[0];
  return {
    ...known,
    review: latest?.report ? {
      round: reviews.filter((entry) => entry.at <= latest.at).length, findings: latest.report.findings.length, published: latest.published.length,
      dismissed: latest.verdicts.flatMap((verdict) => {
        const finding = verdict.by === "reviewer" ? latest.report!.findings[verdict.finding] : undefined;
        return finding ? [{ title: finding.title, reason: verdict.reason }] : [];
      }),
    } : null,
    rollback: overview ? prOverviewRollback(overview.answer) : null,
  };
};
