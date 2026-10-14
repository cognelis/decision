import { z } from "zod";
import { clipText, prReviewProgressSchema, prReviewReportSchema, prReviewSnapshotSchema, prReviewUsageSchema, prReviewVerdictSchema, type PrReviewDismissed, type PrReviewProgress, type PrReviewPublished } from "@cognelis/decision-protocol";

const KEY = "decision.pr-review.history.v1";
/**
 * A failure's message, read back as much of it as a record holds: one past that, written by any version, left the
 * whole history unreadable, the reviewer's own 不采纳 with it, and saving stopped so it stayed so.
 */
const failureText = z.string().transform((value) => clipText(value, 2_000));
const entrySchema = z.object({
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
  error: failureText.default(""),
  // Findings (by index in the report) already posted to the PR, so a finding is not posted twice.
  published: z.array(z.object({ finding: z.number().int().nonnegative(), at: z.string().datetime() })).max(200).default([]),
  // Latest re-evaluation per finding (code-meeseeks' keep / replace / drop). One "by" the reviewer is their own drop, a
  // finding not taken: later reviews of the repository are told of it and its reason.
  verdicts: z.array(prReviewVerdictSchema.extend({ finding: z.number().int().nonnegative(), at: z.string().datetime(), model: z.string().max(500), by: z.literal("reviewer").optional() })).max(200).default([]),
  // Findings of the PR's previous review (run id, index there), judged again on this review's commits.
  rechecks: z.array(prReviewVerdictSchema.extend({ run: z.string().uuid(), finding: z.number().int().nonnegative(), at: z.string().datetime(), model: z.string().max(500) })).max(200).default([]),
});
export type ReviewHistoryEntry = z.infer<typeof entrySchema>;

/** The reviews of a repository ("owner/name", a reference without its "#number") on one connection. */
const inRepository = (history: ReviewHistoryEntry[], connectionId: string | undefined, reference: string) => {
  const repository = (item: string) => item.replace(/#\d+$/u, "");
  return history.filter(item => item.connectionId === connectionId && repository(item.snapshot.reference) === repository(reference));
};

/** A finding the reviewer turned down, as the reviews of its repository are told of it, and each review it was turned down in. */
export interface Dismissal extends PrReviewDismissed { at: string; reference: string; sources: Array<{ run: string; finding: number }> }

/**
 * What the reviewer did not take in a repository's reviews on this connection, newest first and once per file and title
 * (the newest reason stands), with every review it was turned down in; with `before`, only what was turned down by then.
 */
export function dismissalsIn(history: ReviewHistoryEntry[], connectionId: string | undefined, reference: string, before?: string): Dismissal[] {
  const byKey = new Map<string, Dismissal>();
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
export const dismissedIn = (history: ReviewHistoryEntry[], connectionId: string | undefined, reference: string): PrReviewDismissed[] =>
  dismissalsIn(history, connectionId, reference).slice(0, 20).map(({ title, body, path, reason }) => ({ title, body, path, reason }));

/**
 * What the reviewer put on a repository's PRs as comments, newest first and once per file and title (as posted, after a
 * re-evaluation that replaced it), the newest twenty: a new review of the repository is told the team cares about their
 * like. What they turned down in any of its reviews does not count, so a review is never told both; taking the no back
 * counts it again.
 */
export const publishedIn = (history: ReviewHistoryEntry[], connectionId: string | undefined, reference: string): PrReviewPublished[] => {
  const declined = new Set(dismissalsIn(history, connectionId, reference).map(item => `${item.path}\n${item.title}`));
  const all = inRepository(history, connectionId, reference)
    .flatMap(item => item.published.flatMap(({ finding, at }) => {
      const found = item.report?.findings[finding];
      const posted = found && { ...found, ...(item.verdicts.find(verdict => verdict.finding === finding)?.replacement ?? {}) };
      return posted && !declined.has(`${posted.path}\n${posted.title}`) ? [{ at, title: posted.title, path: posted.path }] : [];
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  return [...new Map(all.map(({ title, path }) => [`${path}\n${title}`, { title, path }])).values()].slice(0, 20);
};

// Same action ID updates its message in place; identical text in different actions is meaningful.
export const mergeReviewEvents = (previous: PrReviewProgress[], incoming: PrReviewProgress[]): PrReviewProgress[] =>
  [...new Map([...previous, ...incoming].map(event => [`${event.runId}:${event.id}`, event])).values()].slice(-2000);

export function loadReviewHistory(): { entries: ReviewHistoryEntry[]; error: string } {
  try {
    const entries = z.array(entrySchema).parse(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
    return { entries: entries.map(entry => ({ ...entry, state: entry.state === "running" ? "interrupted" : entry.state, turns: entry.turns.map(turn => turn.state === "pending" ? { ...turn, state: "interrupted" } : turn) })), error: "" };
  } catch {
    return { entries: [], error: "评审历史无法读取，原数据已保留；本次记录暂不自动保存。" };
  }
}

/**
 * Saves newest first. When storage is full the oldest records give way, a fifth at a
 * time, rather than the whole history failing to save; `dropped` says how many were left out.
 */
export function saveReviewHistory(entries: ReviewHistoryEntry[]): { saved: boolean; dropped: number; logDropped?: boolean } {
  // The oldest go first when the store is full, never all of them: a newest record too large on its
  // own would otherwise leave "[]" where the whole history was, the reviewer's own "no"s with it.
  const attempt = (list: ReviewHistoryEntry[]): { saved: boolean; dropped: number } => {
    for (let keep = list.length; keep > 0 || list.length === 0; keep = Math.floor(keep * 0.8)) {
      try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, keep)));
        return { saved: true, dropped: list.length - keep };
      } catch {
        if (keep === 0) break;
      }
    }
    return { saved: false, dropped: 0 };
  };
  const saved = attempt(entries);
  const [newest, ...rest] = entries;
  if (saved.saved || newest === undefined || newest.events.length === 0) return saved;
  // What makes one record that large is mostly its process log: kept without it rather than not at all, and said, or
  // the review came back after a restart with its steps gone and nothing to say why.
  const trimmed = attempt([{ ...newest, events: [] }, ...rest]);
  return trimmed.saved ? { ...trimmed, logDropped: true } : trimmed;
}
