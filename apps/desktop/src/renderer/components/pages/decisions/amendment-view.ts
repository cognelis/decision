import type { AmendableSource, AmendmentFields, AmendmentState, DecisionAmendmentRequest } from "@cognelis/decision-protocol";

import { sourceLabel } from "../../../client-labels.js";
import { clockLabel, historyByDay } from "../todos/todo-text.js";

/** The reader, as the page records them: an agent's name stands for the agent, 「我」 for the one at the page. */
export const READER = "我";

/**
 * A client as the pages name it (the registry's own name: Claude Code, Codex); the reader stays 「我」. One the registry
 * does not list keeps its id, set as words (claude-code → Claude Code), never the bare id.
 */
export const clientLabel = (client: string): string => {
  if (client === READER) return client;
  const named = sourceLabel(client);
  return named !== client ? named : client.split(/[-_]/u).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
};

export const amendmentKey = (source: AmendableSource, recordId: string): string => `${source}:${recordId}`;

export const BASIS_LABELS: Readonly<Record<string, string>> = { user_said: "用户原话", user_confirmed: "用户认可" };

/** The three fields a rewrite may change, by the words the page uses for them. */
const DECISION_WORDS = { question: "问题", choice: "最终选择", rationale: "决策理由", context: "当时上下文", expectedOutcome: "预期结果" } as const;
export const fieldLabels = (source: AmendableSource): Record<keyof AmendmentFields, string> =>
  source === "preferences"
    ? { summary: "偏好内容", appliesWhen: "适用条件", caution: "例外与边界", ...DECISION_WORDS }
    : source === "ideas"
      ? { summary: "想法内容", appliesWhen: "适用条件", caution: "注意事项", ...DECISION_WORDS }
      : { summary: "摘要", appliesWhen: "适用条件", caution: "注意事项", ...DECISION_WORDS };

/** The fields in the order a rewrite lists them. */
export const FIELD_ORDER = ["question", "choice", "rationale", "context", "expectedOutcome", "summary", "appliesWhen", "caution"] as const;

const has = (fields: AmendmentFields, name: keyof AmendmentFields) => Object.prototype.hasOwnProperty.call(fields, name);

/** What is the same at both ends of two texts, and what differs between: the part a rewrite changed, to be marked. */
export const changedPart = (before: string, after: string): { prefix: string; changed: string; suffix: string } => {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end += 1;
  return { prefix: after.slice(0, start), changed: after.slice(start, after.length - end), suffix: after.slice(after.length - end) };
};

/** A rewrite's values in force: none when its original has changed since (`stale`), as agents are told. */
export const rewriteInForce = (state: AmendmentState | undefined): AmendmentFields | null =>
  state?.revised == null || state.revised.stale ? null : state.revised.values;

/** A date as 11 月 11 日, with the year when it is not this one. */
export const monthDayLabel = (at: string, now = new Date()): string => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const base = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return date.getFullYear() === now.getFullYear() ? base : `${date.getFullYear()} 年 ${base}`;
};

const two = (value: number) => String(value).padStart(2, "0");
/** MM-DD HH:mm, an addition's time in its list. */
export const stampLabel = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

export interface HistoryRow {
  key: string;
  at: string;
  time: string;
  who: string;
  what: string;
  reason: string | null;
  basis: string | null;
  /** A rewrite's fields, as they read before and after it. */
  diff: Array<{ label: string; before: string; after: string }>;
  /** What a rewrite replaced (a cut of it, when long), and its revision: the main process puts the whole back by that number. */
  restoreTo: AmendmentFields | null;
  revision: number;
  truncated: boolean;
}

/** The record's history, newest first by day (the todo timeline's grouping), a rewrite with what it replaced and what replaced it. */
export const historyDays = (
  source: AmendableSource,
  state: AmendmentState,
  today: string,
  /** The note's own revisions, for a preference or idea the reader changed. */
  own: ReadonlyArray<{ at: string; what: string; reason: string | null }> = [],
) => {
  const labels = fieldLabels(source);
  const order = FIELD_ORDER;
  // After a rewrite: the next one's `before` for the field, the words a later one found stale and replaced, or what stands now.
  const afterOf = (index: number, field: keyof AmendmentFields): string => {
    for (let next = index + 1; next < state.history.length; next += 1) {
      const entry = state.history[next]!;
      if (entry.action !== "revise") continue;
      if (entry.replacedOverride != null && has(entry.replacedOverride, field)) return entry.replacedOverride[field] ?? "";
      if (entry.before != null && has(entry.before, field)) return entry.before[field] ?? "";
    }
    return state.revised?.values[field] ?? "";
  };
  const rows: HistoryRow[] = [
    ...state.history.map((item, index): HistoryRow => ({
      key: `${item.revision}`,
      at: item.at,
      time: clockLabel(item.at),
      who: clientLabel(item.client),
      what: item.action === "append" ? `增补一段${item.basis == null ? "" : `（${BASIS_LABELS[item.basis] ?? item.basis}）`}`
        : item.action === "withdraw" ? "撤回"
        : item.action === "restore" ? "恢复"
        : `改写「${order.filter((field) => item.before != null && has(item.before, field)).map((field) => labels[field]).join("」「")}」`,
      reason: item.reason,
      basis: item.basis == null ? null : BASIS_LABELS[item.basis] ?? item.basis,
      diff: item.action !== "revise" || item.before == null ? [] : order.filter((field) => has(item.before!, field)).map((field) => ({
        label: labels[field], before: item.before![field] ?? "（空）", after: afterOf(index, field) || "（空）",
      })),
      restoreTo: item.action === "revise" && item.before != null ? item.before : null,
      revision: item.revision,
      truncated: item.beforeTruncated === true,
    })),
    ...own.map((item, index): HistoryRow => ({
      key: `own-${index}`, at: item.at, time: clockLabel(item.at), who: READER, what: item.what, reason: item.reason, basis: null, diff: [], restoreTo: null, revision: 0, truncated: false,
    })),
  ];
  return historyByDay(rows, today);
};

/** The request that puts a rewrite's replaced values back: the main process restores the whole text of that revision. */
export const restoreRequest = (
  source: AmendableSource, recordId: string, contentHash: string, revision: number, toRevision: number, when: string,
): DecisionAmendmentRequest => ({
  amendVersion: 1, source, recordId, sourceClient: READER, action: "revert", basis: "user_said", toRevision,
  expectedContentHash: contentHash, expectedRevision: revision, reason: `在页面上恢复为 ${when} 这次改写之前的内容`,
});

const IGNORED = "paraself.amendments.ignored";
/** Stale rewrites the reader chose not to be told of again, kept on this machine by record and revision. */
export const staleIgnored = (): Set<string> => {
  try {
    return new Set(JSON.parse(globalThis.localStorage?.getItem(IGNORED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
export const ignoreStale = (key: string, revision: number): void => {
  try {
    globalThis.localStorage?.setItem(IGNORED, JSON.stringify([...staleIgnored(), `${key}#${revision}`].slice(-500)));
  } catch {
    // Not kept: the notice shows again, which is all that happens.
  }
};
export const isStaleIgnored = (ignored: ReadonlySet<string>, key: string, revision: number): boolean => ignored.has(`${key}#${revision}`);

/** The rewrites that touched one field, oldest first: who, when, and what it said before. */
export const fieldHistory = (state: AmendmentState | undefined, field: keyof AmendmentFields) =>
  (state?.history ?? []).filter((item) => item.action === "revise" && item.before != null && has(item.before, field));

/** A decision's question and choice as they read now: a rewrite in force in place of the note's words (a list row, the dashboard). */
export const decisionWordsNow = <T extends { question: string; selectedAnswer: string }>(item: T, state: AmendmentState | undefined): T => {
  const rewrite = rewriteInForce(state);
  return rewrite === null ? item : { ...item, question: rewrite.question ?? item.question, selectedAnswer: rewrite.choice ?? item.selectedAnswer };
};
