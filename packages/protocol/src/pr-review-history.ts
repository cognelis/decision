import { z } from "zod";

import { prReviewProgressSchema, prReviewReportSchema, prReviewSnapshotSchema, prReviewUsageSchema, prReviewVerdictSchema, type PrReviewDismissed, type PrReviewPublished } from "./pr-review.js";
import { prPublishedOutcomeSchema } from "./pr-review-responses.js";
import { clipText } from "./text.js";

/**
 * 评审历史：一次评审或一次问答，连同它的快照、过程、结果、复评、不采纳和发布记录。App 在主进程里按条保存
 * （pr-review-history-store.ts），评审页读写它，MCP 读它；以前存在评审页的 localStorage 里，上限 2 MiB，读一次搬过来。
 */
export const PR_REVIEW_HISTORY_LIMITS = {
  /** Records kept; past it, the least recently changed give way. */
  entries: 500,
  /** One record as saved; past it, its process log is left out, and past that it is not saved. */
  entryBytes: 8 * 1024 * 1024,
} as const;

/**
 * A failure's message, read back as much of it as a record holds: one past that, written by any version, left the
 * whole history unreadable, the reviewer's own 不采纳 with it, and saving stopped so it stayed so.
 */
const failureText = z.string().transform((value) => clipText(value, 2_000));

export const prReviewHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  // "chat": a PR asked about without a review (an overview or suggestions straight away); it has no report.
  kind: z.enum(["review", "chat"]).default("review"),
  at: z.string().datetime(), model: z.string().max(500), focus: z.string().max(2000),
  snapshot: prReviewSnapshotSchema, events: z.array(prReviewProgressSchema).max(2000),
  connectionId: z.string().uuid().optional(),
  profileId: z.string().max(200).optional(),
  draft: z.string().max(2000).default(""),
  turns: z.array(z.object({ id: z.string().uuid(), at: z.string().datetime(), model: z.string().max(500),
    question: z.string().min(1).max(2000), answer: z.string().max(8000).default(""),
    state: z.enum(["pending", "done", "failed", "cancelled", "interrupted"]),
    // Why an answer failed, as a review's failure says it: "请重试" alone sent the reader back to a quota that was spent.
    error: failureText.optional(),
    // When the answer was posted to the PR as a comment, so it is not posted twice.
    publishedAt: z.string().datetime().optional(),
    usage: prReviewUsageSchema.optional(),
  })).default([]),
  report: prReviewReportSchema.nullable(), state: z.enum(["running", "finished", "interrupted", "failed"]),
  /** Started by 自动预评审, not by the user or an agent they asked. */
  auto: z.literal(true).optional(),
  error: failureText.default(""),
  // Findings (by index in the report) already posted to the PR, so a finding is not posted twice; `blocking` when posted as one.
  /** Posted to the PR: the comment's id there, and what became of it as last read (发布后跟踪结果). */
  published: z.array(z.object({ finding: z.number().int().nonnegative(), at: z.string().datetime(), blocking: z.literal(true).optional(),
    comment: z.string().max(200).optional(), outcome: prPublishedOutcomeSchema.optional() })).max(200).default([]),
  // The PR's comments as the platform's list counted them when this was made, and those posted from the review page
  // since: a new comment does not move Bitbucket's update time, so more than this is how the list tells the PR moved.
  listedComments: z.number().int().nonnegative().optional(),
  // Latest re-evaluation per finding (code-meeseeks' keep / replace / drop). One "by" the reviewer is their own drop, a
  // finding not taken: later reviews of the repository are told of it and its reason.
  verdicts: z.array(prReviewVerdictSchema.extend({ finding: z.number().int().nonnegative(), at: z.string().datetime(), model: z.string().max(500), by: z.literal("reviewer").optional() })).max(200).default([]),
  // Findings of the PR's previous review (run id, index there), judged again on this review's commits.
  rechecks: z.array(prReviewVerdictSchema.extend({ run: z.string().uuid(), finding: z.number().int().nonnegative(), at: z.string().datetime(), model: z.string().max(500) })).max(200).default([]),
});
export type PrReviewHistoryEntry = z.infer<typeof prReviewHistoryEntrySchema>;

/** What the review page changed since it last saved: those records whole, and the ids of those it deleted. */
export const prReviewHistorySaveSchema = z.object({
  entries: z.array(prReviewHistoryEntrySchema).max(PR_REVIEW_HISTORY_LIMITS.entries),
  removed: z.array(z.string().uuid()).max(10_000),
}).strict();
export type PrReviewHistorySave = z.input<typeof prReviewHistorySaveSchema>;

export const prReviewHistorySaveResultSchema = z.object({
  /** The least recently changed records let go to keep within the limit. */
  dropped: z.number().int().nonnegative(),
  /** Records saved without their process log, to keep within a record's size. */
  logDropped: z.array(z.string().uuid()),
  /** Records too large to save even so. */
  refused: z.array(z.string().uuid()),
});
export type PrReviewHistorySaveResult = z.infer<typeof prReviewHistorySaveResultSchema>;

/** Records an agent changed through the App (update_pr_review_finding, record_pr_comments): the review page reads them again. */
export const prReviewHistoryChangedSchema = z.object({ ids: z.array(z.string().uuid()).max(PR_REVIEW_HISTORY_LIMITS.entries) }).strict();
export type PrReviewHistoryChanged = z.infer<typeof prReviewHistoryChangedSchema>;

export const prReviewHistoryListSchema = z.object({
  /** Newest first. */
  entries: z.array(prReviewHistoryEntrySchema),
  /** Record files that could not be read, left where they are. */
  unreadable: z.number().int().nonnegative(),
  /**
   * The reviews the App runs on its own (an agent started them), under way now: their records say running and they are.
   * Any other record left running is over, its window gone with it.
   */
  running: z.array(z.string().uuid()).max(20).optional(),
});
export type PrReviewHistoryList = z.infer<typeof prReviewHistoryListSchema>;

/** The reviews of a repository ("owner/name", a reference without its "#number") on one connection. */
const inRepository = (history: readonly PrReviewHistoryEntry[], connectionId: string | undefined, reference: string) => {
  const repository = (item: string) => item.replace(/#\d+$/u, "");
  return history.filter(item => item.connectionId === connectionId && repository(item.snapshot.reference) === repository(reference));
};

/** A finding the reviewer turned down, as the reviews of its repository are told of it, and each review it was turned down in. */
export interface PrReviewDismissal extends PrReviewDismissed { at: string; reference: string; sources: Array<{ run: string; finding: number }> }

/**
 * What the reviewer did not take in a repository's reviews on this connection, newest first and once per file and title
 * (the newest reason stands), with every review it was turned down in; with `before`, only what was turned down by then.
 */
export function prReviewDismissalsIn(history: readonly PrReviewHistoryEntry[], connectionId: string | undefined, reference: string, before?: string): PrReviewDismissal[] {
  const byKey = new Map<string, PrReviewDismissal>();
  const all = inRepository(history, connectionId, reference)
    .flatMap(item => item.verdicts.flatMap(verdict => {
      const finding = verdict.by === "reviewer" && (before === undefined || verdict.at < before) ? item.report?.findings[verdict.finding] : undefined;
      return finding ? [{ at: verdict.at, reference: item.snapshot.reference, run: item.id, index: verdict.finding,
        title: finding.title, body: finding.body, path: finding.path, reason: verdict.reason.slice(0, 500) }] : [];
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  for (const { run, index, ...dismissal } of all) {
    const key = `${dismissal.path}\n${dismissal.title}`;
    const known = byKey.get(key);
    if (known) known.sources.push({ run, finding: index });
    else byKey.set(key, { ...dismissal, sources: [{ run, finding: index }] });
  }
  return [...byKey.values()];
}

/** What a new review of the repository is told: the newest twenty, with the reasons. */
export const prReviewDismissedIn = (history: readonly PrReviewHistoryEntry[], connectionId: string | undefined, reference: string): PrReviewDismissed[] =>
  prReviewDismissalsIn(history, connectionId, reference).slice(0, 20).map(({ title, body, path, reason }) => ({ title, body, path, reason }));

/**
 * What the reviewer put on a repository's PRs as comments, newest first and once per file and title (as posted, after a
 * re-evaluation that replaced it), the newest twenty: a new review of the repository is told the team cares about their
 * like. What they turned down in any of its reviews does not count, so a review is never told both; taking the no back
 * counts it again.
 */
export const prReviewPublishedIn = (history: readonly PrReviewHistoryEntry[], connectionId: string | undefined, reference: string): PrReviewPublished[] => {
  const declined = new Set(prReviewDismissalsIn(history, connectionId, reference).map(item => `${item.path}\n${item.title}`));
  const all = inRepository(history, connectionId, reference)
    .flatMap(item => item.published.flatMap(({ finding, at }) => {
      const found = item.report?.findings[finding];
      const posted = found && { ...found, ...(item.verdicts.find(verdict => verdict.finding === finding)?.replacement ?? {}) };
      return posted && !declined.has(`${posted.path}\n${posted.title}`) ? [{ at, title: posted.title, path: posted.path }] : [];
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  return [...new Map(all.map(({ title, path }) => [`${path}\n${title}`, { title, path }])).values()].slice(0, 20);
};
