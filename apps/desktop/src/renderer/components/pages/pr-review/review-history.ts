import { z } from "zod";
import {
  PR_REVIEW_HISTORY_LIMITS,
  prReviewHistoryEntrySchema,
  prReviewHistorySaveSchema,
  type PrReviewHistoryEntry,
  type PrReviewHistoryList,
  type PrReviewHistorySave,
  type PrReviewHistorySaveResult,
  type PrReviewProgress,
} from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";

/**
 * Where the review page kept its history before the App kept it (pr-review-history-store.ts). Read once more to move it
 * there (moveReviewHistory), and still the preview's own store, which has no App behind it.
 */
const KEY = "decision.pr-review.history.v1";
const entrySchema = prReviewHistoryEntrySchema;
export type ReviewHistoryEntry = PrReviewHistoryEntry;

// What a repository's reviews were told not to raise and what they posted: shared with the App's own runs (run_pr_review).
export { prReviewDismissalsIn as dismissalsIn, prReviewDismissedIn as dismissedIn, prReviewPublishedIn as publishedIn } from "@cognelis/decision-protocol";
export type { PrReviewDismissal as Dismissal } from "@cognelis/decision-protocol";

// Same action ID updates its message in place; identical text in different actions is meaningful.
export const mergeReviewEvents = (previous: PrReviewProgress[], incoming: PrReviewProgress[]): PrReviewProgress[] =>
  [...new Map([...previous, ...incoming].map(event => [`${event.runId}:${event.id}`, event])).values()].slice(-2000);

/**
 * One left running or waiting when the window went away is over: said as interrupted, not as still under way. A review
 * the App runs on its own (an agent's, `running`) is under way.
 */
const settled = (entry: ReviewHistoryEntry, running: readonly string[] = []): ReviewHistoryEntry => running.includes(entry.id) ? entry :
  ({ ...entry, state: entry.state === "running" ? "interrupted" : entry.state, turns: entry.turns.map(turn => turn.state === "pending" ? { ...turn, state: "interrupted" } : turn) });

/** The history in this window's storage: the preview's, or one from before the App kept it. */
export function loadReviewHistory(): { entries: ReviewHistoryEntry[]; error: string } {
  try {
    const entries = z.array(entrySchema).parse(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
    return { entries: entries.map(entry => settled(entry)), error: "" };
  } catch {
    return { entries: [], error: "评审历史无法读取，原数据已保留；本次记录暂不自动保存。" };
  }
}

let moving: Promise<string> | undefined;
/**
 * The history this window's storage held before the App kept it, moved into the App once and then cleared, so it no longer
 * crowds out the drafts kept there. One that cannot be read stays where it is; one that could not be saved is tried again
 * the next time. Resolves to what to tell the reader, "" when there is nothing to.
 */
export const moveReviewHistory = (api: Pick<DecisionApi, "savePrReviewHistory">): Promise<string> => moving ??= (async (): Promise<string> => {
  try {
    if (localStorage.getItem(KEY) === null) return "";
  } catch {
    return "";
  }
  const { entries, error } = loadReviewHistory();
  if (error) return "旧版评审历史无法读取，原数据仍保留在本机。";
  try {
    for (let start = 0; start < entries.length; start += PR_REVIEW_HISTORY_LIMITS.entries) {
      await api.savePrReviewHistory({ entries: entries.slice(start, start + PR_REVIEW_HISTORY_LIMITS.entries), removed: [] });
    }
    localStorage.removeItem(KEY);
    return "";
  } catch {
    return "旧版评审历史没能移到 App 里，原数据仍保留在本机，下次打开评审页会再试。";
  }
})().finally(() => {
  // Shared while under way (the App's start and the review page may both ask); after, the next asks the storage again.
  moving = undefined;
});

/**
 * The history as the review page and the quick jump read it: from the App, newest first, once what this window's storage
 * held was moved there (`moveLegacy`: the App's own api, not the preview's, whose store that storage is).
 */
export const readReviewHistory = async (api: Pick<DecisionApi, "listPrReviewHistory" | "savePrReviewHistory">, moveLegacy: boolean): Promise<{ entries: ReviewHistoryEntry[]; error: string }> => {
  // Not moving it here, still wait for a move under way (the App's start): read before it ends, the history looked empty.
  const moved = moveLegacy ? await moveReviewHistory(api) : await (moving ?? Promise.resolve(""));
  try {
    const { entries, unreadable, running } = await api.listPrReviewHistory();
    return { entries: entries.map(entry => settled(entry, running)), error: `${moved}${unreadable ? `有 ${unreadable} 条评审记录无法读取，原数据已保留。` : ""}` };
  } catch {
    return { entries: [], error: `${moved}评审历史读取失败；新的评审仍会保存。` };
  }
};

/** The preview's history store: this window's storage, as the review page kept it before the App did. */
export const previewReviewHistory: Pick<DecisionApi, "listPrReviewHistory" | "savePrReviewHistory"> = {
  listPrReviewHistory: async (): Promise<PrReviewHistoryList> => {
    const { entries, error } = loadReviewHistory();
    return { entries, unreadable: error ? 1 : 0 };
  },
  savePrReviewHistory: async (input: PrReviewHistorySave): Promise<PrReviewHistorySaveResult> => {
    const { entries, removed } = prReviewHistorySaveSchema.parse(input);
    const stored = loadReviewHistory();
    if (stored.error) throw new Error(stored.error);
    const changed = new Map(entries.map(entry => [entry.id, entry]));
    const kept = stored.entries.filter(entry => !removed.includes(entry.id)).map(entry => changed.get(entry.id) ?? entry);
    const added = entries.filter(entry => !stored.entries.some(item => item.id === entry.id));
    const list = [...added, ...kept];
    const result = saveReviewHistory(list);
    if (!result.saved) throw new Error("评审历史保存失败（本机存储可能已满）");
    return { dropped: result.dropped, logDropped: result.logDropped && list[0] ? [list[0].id] : [], refused: [] };
  },
};

/**
 * The history's share of the store, in characters as saved: some five million is all an origin gets. Written to all the
 * room there was, its oldest let go only once a write failed, a long history left none for the drafts kept there too,
 * and a rationale put off with 稍后处理, or a record being written, could not be kept.
 */
const HISTORY_SHARE = 2 * 1024 * 1024;

/**
 * Saves newest first. When storage is full, or the history outgrows its share of it, the oldest records give way, a
 * fifth at a time, rather than the whole history failing to save; `dropped` says how many were left out.
 */
export function saveReviewHistory(entries: ReviewHistoryEntry[]): { saved: boolean; dropped: number; logDropped?: boolean } {
  // The oldest go first when the store is full, never all of them: a newest record too large on its
  // own would otherwise leave "[]" where the whole history was, the reviewer's own "no"s with it.
  const attempt = (list: ReviewHistoryEntry[]): { saved: boolean; dropped: number } => {
    for (let keep = list.length; keep > 0 || list.length === 0; keep = Math.floor(keep * 0.8)) {
      try {
        const value = JSON.stringify(list.slice(0, keep));
        if (value.length > HISTORY_SHARE) continue;
        localStorage.setItem(KEY, value);
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
