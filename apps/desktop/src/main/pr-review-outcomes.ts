import { prOutcomeSettled, prResponseOf, prReviewMarkOf, type PrPublishedOutcome, type PrReviewHistoryEntry } from "@cognelis/decision-protocol";

import type { PrDetails, PrThread } from "./pr-platform-client.js";
import { parseReviewDiff } from "./pr-review-diff.js";
import type { PrHistoryStore } from "./pr-review-records.js";

/**
 * 发布后跟踪结果 (docs/review-collaboration-design.md「跟踪每条已发布意见的结果」): what became of each finding a review
 * posted, read from its PR's threads. The author's standard reply under it says it; with none, a change at its place in a
 * later commit is 可能修了, kept apart; otherwise 未回应. One answered is read no more. What is read goes into the record,
 * for the review page, get_pr_review and, later, the statistics.
 */
export interface PrOutcomeSources {
  client(connectionId: string): Promise<{
    threads(reference: string, signal?: AbortSignal): Promise<{ threads: PrThread[] }>;
    get(reference: string, signal?: AbortSignal): Promise<PrDetails>;
    rangeDiff?(pr: PrDetails, from: string, to: string, signal?: AbortSignal): Promise<string>;
  }>;
  store: PrHistoryStore;
  changed(ids: string[]): void;
  now?(): number;
}

/** Where a change of `from`..`to` touched each file, by its line numbers in `from`: an insertion counts at the line it went before. */
const touchedLines = (diff: string): Map<string, Set<number>> => {
  const touched = new Map<string, Set<number>>();
  for (const [path, lines] of parseReviewDiff(diff)) {
    const at = new Set<number>();
    lines.forEach((line, index) => {
      if (!line.changed) return;
      const old = line.old ?? lines.slice(index + 1).find((next) => next.old !== null)?.old ?? lines.slice(0, index).reverse().find((before) => before.old !== null)?.old;
      if (old) at.add(old);
    });
    if (at.size) touched.set(path, at);
  }
  return touched;
};

/** The thread a posted finding opened: by the comment's id, or (posted before ids were kept) at its place, saying its title. */
const threadOf = (threads: readonly PrThread[], comment: string | undefined, finding: { path: string; line: number; title: string }) =>
  comment !== undefined ? threads.find((thread) => thread.id === comment)
    : threads.find((thread) => thread.path === finding.path && thread.line !== null && Math.abs(thread.line - finding.line) <= 3 && thread.body.includes(finding.title) && prReviewMarkOf(thread.body) !== null);

/** The record with each posted finding's outcome read from its PR; null when nothing changed. */
export const readOutcomes = async (entry: PrReviewHistoryEntry, sources: Pick<PrOutcomeSources, "client" | "now">, signal?: AbortSignal): Promise<PrReviewHistoryEntry | null> => {
  const report = entry.report;
  if (!entry.connectionId || !report || !entry.published.some((item) => !item.outcome || !prOutcomeSettled(item.outcome.kind))) return null;
  const client = await sources.client(entry.connectionId);
  const [{ threads }, details] = await Promise.all([client.threads(entry.snapshot.reference, signal), client.get(entry.snapshot.reference, signal)]);
  // What the commits after the reviewed one changed, where it can be read: a place changed since is 可能修了.
  let touched: Map<string, Set<number>> | null = null;
  if (details.source.commit !== entry.snapshot.sourceCommit && client.rangeDiff) {
    touched = await client.rangeDiff(details, entry.snapshot.sourceCommit, details.source.commit, signal).then(touchedLines, () => null);
  }
  const at = new Date(sources.now?.() ?? Date.now()).toISOString();
  let moved = false;
  const published = entry.published.map((item) => {
    if (item.outcome && prOutcomeSettled(item.outcome.kind)) return item;
    const finding = report.findings[item.finding];
    if (!finding) return item;
    const thread = threadOf(threads, item.comment, finding);
    // The latest standard reply in its thread: the author's answer, whoever posted it there for them.
    const answer = thread?.replies.flatMap((reply) => { const said = prResponseOf(reply.body); return said ? [said] : []; }).at(-1);
    const near = finding.side === "new" && [...(touched?.get(finding.path) ?? [])].some((line) => Math.abs(line - finding.line) <= 3);
    const outcome: PrPublishedOutcome = answer ? { kind: answer.kind, ...(answer.words ? { words: answer.words.slice(0, 2_000) } : {}), at } : { kind: near ? "maybe_fixed" : "none", at };
    const comment = item.comment ?? thread?.id;
    if (item.outcome?.kind === outcome.kind && item.outcome.words === outcome.words && item.comment === comment) return item;
    moved = true;
    return { ...item, ...(comment ? { comment } : {}), outcome };
  });
  return moved ? { ...entry, published } : null;
};

/** Records worth reading again: a finding posted within the last month and not yet answered. */
const FOLLOW_DAYS = 30;
/**
 * Read, newest first, up to `limit` records whose posted findings are not all answered yet, each saved and the page told
 * when its outcomes moved. Resolves to the records changed. A PR that cannot be read is left for the next pass.
 */
export const followOutcomes = async (sources: PrOutcomeSources, limit = 10): Promise<string[]> => {
  const since = (sources.now?.() ?? Date.now()) - FOLLOW_DAYS * 86_400_000;
  const { entries } = await sources.store.list();
  const due = entries.filter((entry) => entry.kind === "review" && entry.connectionId && entry.report
    && entry.published.some((item) => Date.parse(item.at) >= since && (!item.outcome || !prOutcomeSettled(item.outcome.kind)))).slice(0, limit);
  const changed: string[] = [];
  for (const entry of due) {
    const next = await readOutcomes(entry, sources).catch(() => null);
    if (!next) continue;
    await sources.store.save({ entries: [next], removed: [] });
    changed.push(entry.id);
  }
  if (changed.length) sources.changed(changed);
  return changed;
};
