import { zonedFormatter } from "../calendar-date.js";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  DecisionApi,
  MethodologyItem,
} from "../../shared/renderer-api.js";
import { isComposing } from "../keyboard.js";
import { useSearchHighlight } from "../use-search-highlight.js";
import { ModalDialog } from "./ModalDialog.js";
import { loadReviewHistory } from "./pages/pr-review/review-history.js";
import { byRecency, conversationTitle, loadSessions } from "./pages/assistant/assistant-session.js";

/**
 * Every page in this app searches its own contents and nothing else, so
 * "where did I write that down" means first guessing which page owns it.
 * This asks every store at once and jumps to the answer.
 */
export type QuickJumpApi = Pick<
  DecisionApi,
  | "listDecisions"
  | "listJournalEntries"
  | "searchObsidian"
  | "listMethodologies"
  | "openObsidianNote"
>;

export type QuickJumpKind = "page" | "decision" | "journal" | "note" | "principle" | "conversation" | "review";

/** Places rather than records: lists worth working through, one jump away. */
export type QuickJumpPage = "retrospective" | "review-attention" | "rationale-deferred" | "expectation-missing";

const PAGES: ReadonlyArray<{
  page: QuickJumpPage;
  title: string;
  detail: string;
  words: readonly string[];
}> = [
  { page: "retrospective", title: "周期回顾", detail: "方法论 · 分析 · 近 7 天 / 近 30 天", words: ["回顾", "周报"] },
  // The dashboard's word for it; "复盘" alone is too common in records to name the place.
  { page: "review-attention", title: "需复盘", detail: "知识页 · 回填结果或完成复盘", words: ["待复盘", "复盘收件箱"] },
  { page: "rationale-deferred", title: "待补理由", detail: "知识页 · 逐条补完", words: ["补理由"] },
  { page: "expectation-missing", title: "待写预期", detail: "知识页 · 结果出来之前写下", words: ["写预期", "补预期"] },
];

/**
 * Only a query that names the place: a page listed first takes Enter, so a
 * common word searched for in records ("理由", "预期") must not bring one up.
 */
const matchPages = (query: string): QuickJumpEntry[] =>
  PAGES.filter(
    ({ title, words }) =>
      (query.length >= 2 && title.startsWith(query)) || words.includes(query),
  ).map(({ page, title, detail }) => ({ kind: "page", target: page, title, detail }));

export interface QuickJumpEntry {
  kind: QuickJumpKind;
  /**
   * What identifies the record to its own page: a decision id, a journal entry
   * id, a principle id, or — for a note, which has no page here — its path
   * relative to the vault.
   */
  target: string;
  title: string;
  detail: string;
  /** Says how a result was reached when it was not by its words. */
  badge?: string;
}

interface QuickJumpDialogProps {
  api: QuickJumpApi;
  onClose(): void;
  onOpenDecision(id: string): void;
  onOpenJournalEntry(id: string): void;
  onOpenPrinciple(id: string): void;
  /** Offered only where the host can take the reader there. */
  onOpenPage?(page: QuickJumpPage): void;
  /** A PR review or answer kept on this machine, opened on the review page. */
  onOpenReview?(id: string): void;
  /** A Q&A conversation kept on this machine, opened on the assistant page. */
  onOpenConversation?(id: string): void;
  /** The vault open now, whose conversations are the ones listed. */
  vault?: string | null;
}

const GROUP_LABELS: Record<QuickJumpKind, string> = {
  page: "页面",
  decision: "决策",
  journal: "偏好与想法",
  note: "笔记",
  principle: "原则",
  conversation: "问答",
  review: "评审",
};

/**
 * With nothing typed the lists are the newest records rather than matches, and
 * a heading that says only "决策" reads as a search that found them.
 */
const groupLabel = (kind: QuickJumpKind, searched: boolean): string =>
  searched ? GROUP_LABELS[kind] : `最近${GROUP_LABELS[kind]}`;

const GROUP_ORDER: readonly QuickJumpKind[] = [
  "page",
  "decision",
  "journal",
  "note",
  "principle",
  "conversation",
  "review",
];

/** Few enough that all four groups fit without scrolling on a laptop. */
const PER_KIND = 5;

/**
 * A candidate is not a rule yet and a retired one is no longer one, so the row
 * has to say which before the reader acts on it.
 */
const PRINCIPLE_STATUS: Record<MethodologyItem["status"], string> = {
  candidate: "待确认",
  accepted: "已采纳",
  retired: "已归档",
  dismissed: "已忽略",
};
const DEBOUNCE_MS = 160;

const collapse = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

const dayFormatter = zonedFormatter({
  month: "short",
  day: "numeric",
});

const day = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : dayFormatter.format(at);
};

/**
 * Principles are a small set that changes only when the reader accepts one, so
 * they load once per open and match here rather than over IPC per keystroke.
 * Substring is deliberate: the corpus is Chinese, where token boundaries a
 * word matcher would need do not exist in the text.
 */
/**
 * Every word of the query somewhere in the text, as the decision and journal searches match them: two
 * words typed find what has both, apart or not, in every group alike.
 */
const matchesWords = (text: string, query: string): boolean => {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .every((word) => haystack.includes(word));
};

export const matchPrinciples = (
  items: readonly MethodologyItem[],
  query: string,
): MethodologyItem[] =>
  items
    .filter((item) =>
      matchesWords([item.title, item.principle, item.appliesWhen].join("\n"), query),
    )
    .slice(0, PER_KIND);

export const QuickJumpDialog = ({
  api,
  onClose,
  onOpenDecision,
  onOpenJournalEntry,
  onOpenPrinciple,
  onOpenPage,
  onOpenReview,
  onOpenConversation,
  vault = null,
}: QuickJumpDialogProps) => {
  const offerPages = onOpenPage !== undefined;
  // Kept in this window's storage, so read once per open rather than per keystroke.
  const [reviews] = useState(() => (onOpenReview === undefined ? [] : loadReviewHistory().entries));
  const [conversations] = useState(() => {
    if (onOpenConversation === undefined) return [];
    // Unreadable history is the assistant page's to report; here it only means no results.
    try {
      return byRecency(loadSessions(vault).conversations).filter((item) => item.messages.length > 0);
    } catch {
      return [];
    }
  });
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<QuickJumpEntry[]>([]);
  // The words the list on screen answers, which are not those typed until their results are in.
  const [entriesFor, setEntriesFor] = useState<string | null>(null);
  // Enter pressed before then: the first result of what was typed opens once it is in.
  const pendingEnter = useRef(false);
  const noteOpening = useRef(false);
  const [unavailable, setUnavailable] = useState<readonly QuickJumpKind[]>([]);
  const [searching, setSearching] = useState(true);
  const [active, setActive] = useState(0);
  const [principles, setPrinciples] = useState<readonly MethodologyItem[]>([]);
  const [principlesFailed, setPrinciplesFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Before the modal's own focus pass, which would otherwise land on the
  // close button and make the first keystroke go nowhere.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .listMethodologies()
      .then((items) => {
        if (alive) setPrinciples(items);
      })
      .catch(() => {
        if (alive) setPrinciplesFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    const trimmed = collapse(query);
    let alive = true;
    setActive(0);
    setSearching(true);
    const timer = setTimeout(() => {
      // Settled, not all: a vault that cannot answer must not take the
      // decisions down with it — the reader still gets the other groups.
      void Promise.allSettled([
        api.listDecisions({ query: trimmed, limit: PER_KIND }),
        api.listJournalEntries({
          ...(trimmed.length === 0 ? {} : { query: trimmed }),
          limit: PER_KIND,
        }),
        trimmed.length === 0
          ? Promise.resolve(null)
          : api.searchObsidian({ query: trimmed, limit: PER_KIND }),
      ])
        .then(async ([decisions, journal, notes]) => {
          // Notes already answer with meaning as well as words. Decisions are
          // keyword-first, so an empty list here is "not these words", not
          // "not recorded" — ask the other way before saying nothing.
          const semantic =
            decisions.status === "fulfilled" &&
            decisions.value.length === 0 &&
            trimmed.length >= 2
              ? await api
                  .listDecisions({
                    query: trimmed,
                    limit: PER_KIND,
                    searchMode: "semantic",
                  })
                  .catch(() => [])
              : [];
          return { decisions, journal, notes, semantic };
        })
        .then(({ decisions, journal, notes, semantic }) => {
          if (!alive) return;
          const missing: QuickJumpKind[] = [];
          const found: QuickJumpEntry[] =
            !offerPages || trimmed.length === 0 ? [] : matchPages(trimmed);
          if (decisions.status === "fulfilled") {
            found.push(
              ...[...decisions.value, ...semantic].map((decision) => ({
                kind: "decision" as const,
                target: decision.id,
                title: collapse(decision.question),
                // The same question gets asked again, in another project or
                // just on another day, and the answer is often the same words
                // too. What tells the rows apart goes first, where the line is
                // not yet cut off.
                detail: [
                  collapse(decision.project),
                  day(decision.created),
                  collapse(decision.selectedAnswer),
                ]
                  .filter((part) => part.length > 0)
                  .join(" · "),
                ...(decision.searchMatch === "semantic" ||
                decision.searchMatch === "hybrid"
                  ? { badge: "语义命中" }
                  : {}),
              })),
            );
          } else {
            missing.push("decision");
          }
          if (journal.status === "fulfilled") {
            found.push(
              ...journal.value.map((entry) => ({
                kind: "journal" as const,
                target: entry.id,
                title: collapse(entry.title),
                detail: `${entry.kind === "preference" ? "偏好" : "想法"} · ${collapse(entry.content)}`,
              })),
            );
          } else {
            missing.push("journal");
          }
          if (notes.status === "fulfilled") {
            for (const result of notes.value?.results ?? []) {
              found.push({
                kind: "note",
                target: result.relativePath,
                title: collapse(result.title),
                detail: collapse(result.heading ?? result.snippet),
                ...(result.matchKind === "semantic" ||
                result.matchKind === "hybrid"
                  ? { badge: "语义命中" }
                  : {}),
              });
            }
          } else {
            missing.push("note");
          }
          if (trimmed.length > 0) {
            if (principlesFailed) missing.push("principle");
            else {
              found.push(
                ...matchPrinciples(principles, trimmed).map((item) => ({
                  kind: "principle" as const,
                  target: item.id,
                  title: collapse(item.title),
                  detail: `${PRINCIPLE_STATUS[item.status]} · ${collapse(item.principle)}`,
                })),
              );
            }
          }
          found.push(
            ...reviews
              .filter((item) => matchesWords(`${item.snapshot.title} ${item.snapshot.reference}`, trimmed))
              .slice(0, PER_KIND)
              .map((item) => ({
                kind: "review" as const,
                target: item.id,
                title: collapse(item.snapshot.title),
                detail: [item.snapshot.reference, item.kind === "chat" ? "问答" : "评审", day(item.at)].filter(Boolean).join(" · "),
              })),
          );
          // By its name and by any question asked in it: the name is only the opening question, cut short.
          found.push(
            ...conversations
              .map((item) => ({ item, questions: item.messages.flatMap((message) => (message.role === "user" ? [message.content] : [])) }))
              .filter(({ item, questions }) => matchesWords([conversationTitle(item), ...questions].join("\n"), trimmed))
              .slice(0, PER_KIND)
              .map(({ item, questions }) => ({
                kind: "conversation" as const,
                target: item.id,
                title: collapse(conversationTitle(item)),
                detail: [`${questions.length} 个问题`, day(new Date(item.updatedAt).toJSON() ?? "")].filter(Boolean).join(" · "),
              })),
          );
          // Pushed per source; shown per group. Sorted once, the highlight, arrows and Enter follow the screen.
          found.sort((left, right) => GROUP_ORDER.indexOf(left.kind) - GROUP_ORDER.indexOf(right.kind));
          setEntries(found);
          setEntriesFor(trimmed);
          setUnavailable(missing);
          setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, conversations, offerPages, principles, principlesFailed, query, reviews]);

  // The options are not focusable — the input keeps focus and points at the
  // active one — so nothing scrolls them into view on its own.
  useEffect(() => {
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const open = async (entry: QuickJumpEntry): Promise<void> => {
    if (entry.kind === "page") {
      onOpenPage?.(entry.target as QuickJumpPage);
      onClose();
      return;
    }
    if (entry.kind === "decision") {
      onOpenDecision(entry.target);
      onClose();
      return;
    }
    if (entry.kind === "journal") {
      onOpenJournalEntry(entry.target);
      onClose();
      return;
    }
    if (entry.kind === "principle") {
      onOpenPrinciple(entry.target);
      onClose();
      return;
    }
    if (entry.kind === "review") {
      onOpenReview?.(entry.target);
      onClose();
      return;
    }
    if (entry.kind === "conversation") {
      onOpenConversation?.(entry.target);
      onClose();
      return;
    }
    // One at a time: Enter held repeats while Obsidian is still being asked, and each repeat opened the note again.
    if (noteOpening.current) return;
    noteOpening.current = true;
    setOpenError(null);
    try {
      await api.openObsidianNote(entry.target);
      onClose();
    } catch {
      // Closing here would hide the only place the failure could be said.
      setOpenError("暂时无法在 Obsidian 中打开这篇笔记。");
    } finally {
      noteOpening.current = false;
    }
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (isComposing(event)) return;
    // The rows still showing answer the words before: opening the first of them would be a guess at
    // what was meant, made to look like an answer.
    if (event.key === "Enter" && entriesFor !== collapse(query)) {
      event.preventDefault();
      pendingEnter.current = true;
      return;
    }
    if (entries.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(entries.length - 1, index + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === "Enter") {
      const entry = entries[active];
      if (entry === undefined) return;
      event.preventDefault();
      void open(entry);
    }
  };

  useEffect(() => {
    if (!pendingEnter.current || entriesFor !== collapse(query)) return;
    pendingEnter.current = false;
    const entry = entries[active];
    if (entry !== undefined) void open(entry);
  }, [entries, entriesFor]);

  // Rendered by group but numbered across all of them, so the arrow keys walk
  // one list while the reader sees four. Headed as what they answer: recent
  // ones stay "recent" until the results for what was typed are in.
  const searched = (entriesFor ?? collapse(query)).length > 0;
  useSearchHighlight(
    resultsRef,
    ".quick-jump-result-title, .quick-jump-result-detail",
    query,
    "jump-search",
    entries,
  );
  const groups = GROUP_ORDER.map((kind) => ({
    kind,
    rows: entries
      .map((entry, index) => ({ entry, index }))
      .filter((row) => row.entry.kind === kind),
  })).filter((group) => group.rows.length > 0);

  return (
    <ModalDialog
      title="快速跳转"
      description="同时搜索决策、偏好想法、笔记、原则、问答与评审记录；↑ ↓ 选择，↩ 打开。"
      onClose={onClose}
    >
      <div className="quick-jump">
        <input
          ref={inputRef}
          type="search"
          className="quick-jump-input"
          // What the decision and journal searches take. A longer paste was refused there, and shown as
          // those records being unavailable.
          maxLength={200}
          role="combobox"
          aria-label="搜索决策、想法、笔记、原则、问答与评审"
          aria-expanded={entries.length > 0}
          aria-controls={listId}
          aria-activedescendant={
            entries[active] === undefined ? undefined : `${listId}-${active}`
          }
          autoComplete="off"
          placeholder="搜索决策、想法、笔记、原则、问答与评审"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {unavailable.length === 0 ? null : (
          <p className="quick-jump-notice" role="status">
            {unavailable.map((kind) => GROUP_LABELS[kind]).join("、")}
            暂时无法检索，结果不完整。
          </p>
        )}
        {openError === null ? null : (
          <p className="quick-jump-notice" role="alert">
            {openError}
          </p>
        )}
        <ul
          ref={resultsRef}
          className="quick-jump-results"
          id={listId}
          role="listbox"
        >
          {groups.map((group) => (
            <li key={group.kind} className="quick-jump-group" role="presentation">
              <p className="quick-jump-group-label" role="presentation">
                {groupLabel(group.kind, searched)}
              </p>
              <ul role="group" aria-label={groupLabel(group.kind, searched)}>
                {group.rows.map(({ entry, index }) => (
                  <li
                    key={`${entry.kind}-${entry.target}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    className={`quick-jump-result${index === active ? " active" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void open(entry)}
                  >
                    <span className="quick-jump-result-title">
                      <span>{entry.title}</span>
                      {entry.badge === undefined ? null : (
                        <small className="quick-jump-result-badge">
                          {entry.badge}
                        </small>
                      )}
                    </span>
                    <span className="quick-jump-result-detail">
                      {entry.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        {entries.length > 0 ? null : (
          // The keyword pass is debounced and the semantic one only starts
          // after it comes back empty, so there is a stretch with nothing on
          // screen. Saying "none" during it would be wrong twice over.
          <p className="quick-jump-empty" role="status">
            {searching
              ? "正在检索…"
              : searched
                ? "没有匹配的记录。"
                : "还没有可以跳转的记录。"}
          </p>
        )}
      </div>
    </ModalDialog>
  );
};
