import type { JournalEntry, JournalEntryDraft } from "@cognelis/decision-core";
import { languageLabel } from "@cognelis/decision-core/journal-entry";
import { useEffect, useId, useRef, useState } from "react";

import { journalEntryBasis } from "../../../../shared/journal-basis.js";
import type { DecisionApi, JournalEntryListQuery } from "../../../../shared/renderer-api.js";
import { zonedFormatter } from "../../../calendar-date.js";
import { useSearchHighlight } from "../../../use-search-highlight.js";
import { useSlashToFocus } from "../../../use-slash-focus.js";
import { ModalDialog } from "../../ModalDialog.js";
import { Chevron } from "./DecisionFeedbackPanel.js";
import type { AmendmentRecordView } from "../../../../shared/renderer-api.js";
import { AmendmentHistory, AmendmentList, OriginalWords, Rewritten } from "./AmendmentBlocks.js";
import type { AmendmentFields, AmendmentState } from "@cognelis/decision-protocol";
import { type HistoryRow, amendmentKey, clientLabel, fieldLabels, ignoreStale, isStaleIgnored, monthDayLabel, READER, restoreRequest, rewriteInForce, staleIgnored } from "./amendment-view.js";
import { localDay } from "../todos/todo-dates.js";

interface JournalEntryViewProps {
  api: DecisionApi;
  refreshRevision: number;
  /** An entry quick jump sent the reader to; the list has no detail pane. */
  highlightId?: string | null;
  /** Notes that could not be read, and so are missing from the list: said where they would be. */
  unreadableNotice?: string | null;
}

const draftFrom = (
  entry: JournalEntry,
  overrides: Partial<Pick<JournalEntryDraft, "title" | "content" | "knowledgeStatus">> & { appliesWhen?: string | null; exceptions?: string | null } = {},
): JournalEntryDraft =>
  entry.kind === "preference"
    ? {
        kind: "preference",
        title: overrides.title ?? entry.title,
        content: overrides.content ?? entry.content,
        knowledgeStatus: overrides.knowledgeStatus ?? entry.knowledgeStatus,
        context: entry.context,
        rationale: entry.rationale,
        tags: [...entry.tags],
        languages: [...entry.languages],
        appliesWhen: overrides.appliesWhen === undefined ? entry.appliesWhen : overrides.appliesWhen,
        exceptions: overrides.exceptions === undefined ? entry.exceptions : overrides.exceptions,
        strength: entry.strength,
        evidenceMaturity: entry.evidenceMaturity,
      }
    : {
        kind: "idea",
        title: overrides.title ?? entry.title,
        content: overrides.content ?? entry.content,
        knowledgeStatus: overrides.knowledgeStatus ?? entry.knowledgeStatus,
        context: entry.context,
        rationale: entry.rationale,
        tags: [...entry.tags],
        languages: [...entry.languages],
        ideaForm: entry.ideaForm,
        whyInteresting: entry.whyInteresting,
        openQuestions: [...entry.openQuestions],
        nextTest: entry.nextTest,
        incubateUntil: entry.incubateUntil,
      };

const statusLabel = {
  inbox: "待澄清",
  active: "有效",
  archived: "已归档",
} as const;

/** The languages an entry is kept for, as people write them; none: it holds whatever the code is written in. */
export const languagesShown = (languages: readonly string[]): string[] =>
  languages.length === 0 ? ["通用"] : languages.map(languageLabel);

/**
 * Languages as typed: separated by commas, 顿号 or semicolons; the names are made one each where they are kept. Not
 * by spaces: "Objective C" was two languages, "objective" and "c", the second recalled in every C repository.
 */
export const languagesTyped = (text: string): string[] =>
  [...new Set(text.split(/[,，、;；]+/u).map((part) => part.trim().replace(/\s+/gu, " ")).filter((part) => part.length > 0))];

/** What keeps typed languages from being saved, in the reader's words; null when they can be. */
export const languagesProblem = (languages: readonly string[]): string | null =>
  languages.length > 8 ? "适用语言最多 8 项，请删去一些再保存。"
    : languages.some((language) => language.length > 40) ? "每个适用语言最多 40 个字符，请缩短后再保存。" : null;

// As every other time on the knowledge page reads (2026年10月5日 08:30), not "2026/10/5 08:30:00".
const revisionTimeFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const JournalEntryView = ({
  api,
  refreshRevision,
  highlightId = null,
  unreadableNotice = null,
}: JournalEntryViewProps) => {
  // Each card's 修订 and 归档 say which entry they act on.
  const idPrefix = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "preference" | "idea">("all");
  const [status, setStatus] = useState<"all" | "inbox" | "active" | "archived" | "withdrawn">("all");
  // What agents added to, rewrote in or withdrew from the entries, by record; none read is none shown (said below).
  const [amendments, setAmendments] = useState<Map<string, AmendmentRecordView>>(new Map());
  const [amendmentsUnread, setAmendmentsUnread] = useState(false);
  const [ignored, setIgnored] = useState<Set<string>>(() => staleIgnored());
  const [shownRewrites, setShownRewrites] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<JournalEntry | null>(null);
  const [withdrawing, setWithdrawing] = useState<JournalEntry | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [restoring, setRestoring] = useState<{ entry: JournalEntry; row: HistoryRow; to: AmendmentFields } | null>(null);
  // A revision begun from a rewrite that did not take: once saved, that rewrite is dealt with.
  const rewriteFlow = useRef<string | null>(null);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const listRef = useRef<HTMLOListElement>(null);
  // "/ 知识：聚焦搜索框" is the shortcut on this tab too: bound only to the decisions' field, it did nothing here.
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashToFocus(searchRef);
  useSearchHighlight(
    listRef,
    ".journal-entry-card-copy > strong, .journal-entry-card-copy > p",
    query,
    "journal-search",
    entries,
  );
  const [loading, setLoading] = useState(true);
  // Why a revision or an archive failed, kept apart from why the list could not be read: cleared by the list's
  // own reload, a refusal showed for a tenth of a second.
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  // The entry as read again after a revision it refused, shown beside the reader's draft to merge by hand.
  const [latest, setLatest] = useState<JournalEntry | null>(null);
  const rebasing = useRef(false);
  const [draft, setDraft] = useState<JournalEntryDraft | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [saving, setSaving] = useState(false);
  const mutationPending = useRef(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // Arriving at an entry clears what would hide it, once: a later refresh keeps
  // what the reader has typed and picked since.
  useEffect(() => {
    if (highlightId === null) return;
    setQuery("");
    setKind("all");
    setStatus("all");
  }, [highlightId]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      const input: JournalEntryListQuery = {
        ...(query.trim().length === 0 ? {} : { query: query.trim() }),
        ...(kind === "all" ? {} : { kind }),
        ...(status === "all" || status === "withdrawn" ? {} : { knowledgeStatus: status }),
        limit: 200,
      };
      setLoading(true);
      setListError(null);
      // A failure to read what agents added never takes the list with it: said above the list, the entries as written.
      void Promise.resolve().then(() => api.listDecisionAmendments())
        .then((overview) => {
          if (!active) return;
          setAmendments(new Map(overview.records.map((record) => [amendmentKey(record.source, record.recordId), record])));
          setAmendmentsUnread(overview.unavailable);
        })
        .catch(() => { if (active) setAmendmentsUnread(true); });
      void api.listJournalEntries(input)
        .then(async (items) => {
          if (!active) return;
          if (highlightId !== null && query.trim() === "" && kind === "all" && status === "all" &&
            !items.some((entry) => entry.id === highlightId)) {
            const matches = await api.listJournalEntries({ query: highlightId, limit: 200 });
            const target = matches.find((entry) => entry.id === highlightId);
            if (target !== undefined) items = [target, ...items];
          }
          if (active) setEntries(items);
        })
        .catch((caught) => {
          if (active) setListError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, kind, query, refreshRevision, status, revision, highlightId]);

  // A revision refused because the entry moved on is checked next against the entry as read again, the draft
  // kept: checked against the copy opened, every later save was refused too, and only 取消 was left.
  useEffect(() => {
    if (!rebasing.current || editing === null) return;
    const rebase = (fresh: JournalEntry): void => {
      rebasing.current = false;
      if (journalEntryBasis(fresh) === journalEntryBasis(editing)) return;
      setEditing(fresh);
      setLatest(fresh);
    };
    const listed = entries.find((entry) => entry.id === editing.id);
    if (listed !== undefined) {
      rebase(listed);
      return;
    }
    // Taken out of the list as searched or filtered by the very change that refused it (clarified out of 待澄清, the
    // searched words edited away): read by itself, as an arrival is, or it was never rebased and each save refused.
    let active = true;
    void api.listJournalEntries({ query: editing.id, limit: 200 })
      .then((matches) => {
        const fresh = matches.find((entry) => entry.id === editing.id);
        if (active && fresh !== undefined) rebase(fresh);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, entries, editing]);

  // Archived, an entry loses its own 归档 and focus went with it to the top of the window: it goes to the entry's
  // 修订, or, once a status filter that leaves archived entries out has taken it away, to the entry in its place.
  const refocusAfterArchive = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const pending = refocusAfterArchive.current;
    // Left alone while the archive is under way: a re-read meanwhile is not the one it waits for.
    if (pending === null || mutationPending.current) return;
    // Taken once: kept after focus had moved on, or after an archive that was refused, it pulled focus to that entry
    // (and the list with it) at a later re-read, the watcher's, with nothing pressed.
    if (document.activeElement !== null && document.activeElement !== document.body) {
      refocusAfterArchive.current = null;
      return;
    }
    const listed = entries.find((entry) => entry.id === pending.id);
    // Kept while it is still to go: archived under a filter that leaves archived entries out, the list is read
    // again, and that read takes it out.
    if (listed?.knowledgeStatus !== "archived" || status === "all" || status === "archived") refocusAfterArchive.current = null;
    const rows = listRef.current?.querySelectorAll<HTMLElement>(".journal-entry-card") ?? [];
    const row = listed !== undefined ? document.getElementById(`journal-entry-${pending.id}`) : rows[Math.min(pending.index, rows.length - 1)];
    (row?.querySelector<HTMLElement>(".journal-entry-actions button[data-revise]") ?? searchRef.current)?.focus();
  }, [entries, status]);

  // Arriving at a flat list is arriving nowhere unless the list says which one
  // was meant, so the card is marked and brought into view once it has loaded.
  useEffect(() => {
    if (highlightId === null || loading) return;
    document
      .getElementById(`journal-entry-${highlightId}`)
      ?.scrollIntoView?.({ block: "center" });
  }, [highlightId, loading]);

  // A revision given up takes its failure with it: kept, it stood over the list as 处理失败 for nothing done there,
  // through every filter change, until the next revision or 归档 began.
  const closeRevision = (): void => {
    setEditing(null);
    setError(null);
  };

  const sourceOf = (entry: JournalEntry) => (entry.kind === "preference" ? "preferences" : "ideas") as "preferences" | "ideas";
  const viewOf = (entry: JournalEntry): AmendmentRecordView | undefined => amendments.get(amendmentKey(sourceOf(entry), entry.id));
  const isWithdrawn = (entry: JournalEntry): boolean => viewOf(entry)?.state.withdrawn != null;
  const today = localDay(new Date());

  // What the page lists under the chosen status: a withdrawn entry only under 全部 and 已撤回, the others as they were.
  const shownEntries = entries.filter((entry) => status === "withdrawn" ? isWithdrawn(entry) : status === "all" || !isWithdrawn(entry));

  const beginRevision = (entry: JournalEntry, fromRewrite: Record<string, string | null | undefined> | null = null): void => {
    rewriteFlow.current = fromRewrite === null ? null : amendmentKey(sourceOf(entry), entry.id);
    setEditing(entry);
    setDraft(draftFrom(entry, fromRewrite === null ? {} : {
      ...(typeof fromRewrite.summary === "string" ? { content: fromRewrite.summary } : {}),
      ...(entry.kind === "preference" && "appliesWhen" in fromRewrite ? { appliesWhen: fromRewrite.appliesWhen ?? null } : {}),
      ...(entry.kind === "preference" && "caution" in fromRewrite ? { exceptions: fromRewrite.caution ?? null } : {}),
    }));
    setChangeNote("");
    setError(null);
    setNotice(null);
    setLatest(null);
    rebasing.current = false;
  };

  const incomplete = draft?.knowledgeStatus === "active" && (
    draft.kind === "preference"
      ? !draft.appliesWhen?.trim() || !draft.exceptions?.trim()
      : !draft.whyInteresting?.trim()
  );
  // Past the limits the record takes: said here, where the 主动记录 dialog says it too, not as the IPC's English refusal.
  const languageProblem = languagesProblem(draft?.languages ?? []);
  const canSave = draft !== null && draft.title.trim().length > 0 &&
    draft.content.trim().length > 0 && changeNote.trim().length > 0 && !incomplete && languageProblem === null;
  // Each field the 有效 status still asks for is marked and points at why, as the record dialog's are: said once in
  // passing, the reason was gone by the time the reader reached the field.
  const askedFor = (value: string | null | undefined) =>
    incomplete && !value?.trim() ? { "aria-invalid": true, "aria-describedby": `${idPrefix}-incomplete` } : {};

  const saveRevision = async (): Promise<void> => {
    if (
      editing === null || draft === null || !canSave || mutationPending.current
    ) return;
    mutationPending.current = true;
    setSaving(true);
    setError(null);
    try {
      const revised = await api.reviseJournalEntry(editing.id, {
        draft: { ...draft, title: draft.title.trim(), content: draft.content.trim() },
        change: {
          changeNote: changeNote.trim(),
          sourceKind: "app_manual",
          sourceForm: "user_original",
        },
        basis: journalEntryBasis(editing),
      });
      setEntries((current) => current.map((entry) => entry.id === revised.id ? revised : entry));
      // The rewrite it was begun from is carried into the note now: not told of as lost again.
      const fromRewrite = rewriteFlow.current;
      if (fromRewrite !== null) {
        const stale = amendments.get(fromRewrite);
        if (stale !== undefined) { ignoreStale(fromRewrite, stale.state.revision); setIgnored(staleIgnored()); }
        rewriteFlow.current = null;
      }
      setEditing(null);
      setDraft(null);
      setLatest(null);
      setNotice(`已保存修订 · ${statusLabel[revised.knowledgeStatus]}`);
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      // Refused because the entry moved on, or failed for another reason: what the list shows is read again,
      // and the revision rests on that.
      rebasing.current = true;
      setRevision((value) => value + 1);
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  /** The reader's own change to an amendment, through the same service and checks agents use; a refusal is read again. */
  const amend = async (request: Parameters<DecisionApi["updateDecisionAmendment"]>[0], done: string): Promise<boolean> => {
    if (mutationPending.current) return false;
    mutationPending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateDecisionAmendment(request);
      if (result.status === "saved" || result.status === "unchanged") {
        setNotice(done);
        return true;
      }
      setError(({
        source_changed: "这条记录在你打开之后改过，已重新读取，请核对后再试。",
        revision_conflict: "这条记录的增补刚刚又有更新，已重新读取，请核对后再试。",
        not_found: "找不到这条记录，列表已重新读取。",
        source_unavailable: "来源或增补笔记没能完整读取，请检查笔记。",
        not_allowed: "这条记录不能这样改。",
        limit_reached: "这条记录的修订记录已满，不能再增加；请在 Obsidian 里整理旁路笔记。",
        basis_required: "需要写明依据。",
      } as Record<string, string>)[result.status] ?? "没有保存。");
      return false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      mutationPending.current = false;
      setSaving(false);
      setRevision((value) => value + 1);
    }
  };

  const restore = (entry: JournalEntry): Promise<boolean> => {
    const view = viewOf(entry);
    return amend({ amendVersion: 1, source: sourceOf(entry), recordId: entry.id, sourceClient: READER, action: "restore", basis: "user_said",
      expectedRevision: view?.state.revision ?? 0, reason: "在页面上恢复" }, "已恢复。");
  };

  const withdraw = async (entry: JournalEntry): Promise<void> => {
    const view = viewOf(entry);
    const saved = await amend({ amendVersion: 1, source: sourceOf(entry), recordId: entry.id, sourceClient: READER, action: "withdraw", basis: "user_said",
      expectedRevision: view?.state.revision ?? 0, reason: withdrawReason.trim() }, "已撤回，可在「已撤回」里恢复。");
    if (saved) { setWithdrawing(null); setWithdrawReason(""); }
  };

  const archive = async (entry: JournalEntry): Promise<void> => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    refocusAfterArchive.current = { id: entry.id, index: entries.findIndex((item) => item.id === entry.id) };
    setSaving(true);
    setError(null);
    try {
      const revised = await api.reviseJournalEntry(entry.id, {
        draft: draftFrom(entry, { knowledgeStatus: "archived" }),
        change: {
          changeNote: "归档记录",
          sourceKind: "app_manual",
          sourceForm: "user_original",
        },
        basis: journalEntryBasis(entry),
      });
      setEntries((current) => current.map((item) => item.id === revised.id ? revised : item));
      setNotice("记录已归档，可通过修订恢复。");
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      // Refused, its 归档 is still there with focus on it: nothing to take focus back to. Left for a later re-read to
      // find not archived, that read (the watcher's, landing first) pulled focus to the entry.
      refocusAfterArchive.current = null;
      // Refused because the entry moved on, or failed for another reason: what the list shows is read again.
      setRevision((value) => value + 1);
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="journal-entry-view" aria-label="偏好与想法">
      <div className="journal-entry-toolbar">
        <input
          ref={searchRef}
          type="search"
          aria-label="搜索偏好与想法"
          placeholder="搜索偏好与想法（也搜增补内容）"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <select aria-label="记录类型筛选" value={kind} onChange={(event) => setKind(event.currentTarget.value as typeof kind)}>
          <option value="all">偏好与想法</option>
          <option value="preference">偏好</option>
          <option value="idea">想法</option>
        </select>
        <select aria-label="记录状态筛选" value={status} onChange={(event) => setStatus(event.currentTarget.value as typeof status)}>
          <option value="all">全部状态</option>
          <option value="inbox">待澄清</option>
          <option value="active">有效</option>
          <option value="archived">已归档</option>
          <option value="withdrawn">已撤回</option>
        </select>
      </div>
      {amendmentsUnread ? <p className="journal-entry-unreadable">增补与撤回记录这次没能读取：下面可能缺少 agent 的增补，也可能仍显示已撤回的条目。</p> : null}

      {/* A read that failed is not an empty list: said in its place, with a way to read again. */}
      {listError === null ? null : (
        <p className="load-failure" role="alert">
          读取失败：{listError}
          <button type="button" className="secondary-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>重试</button>
        </p>
      )}
      {unreadableNotice === null ? null : <p className="journal-entry-unreadable">{unreadableNotice}</p>}
      {/* Cut at 200 without a word, an older standing preference looked gone to anyone browsing. */}
      {loading || entries.length < 200 ? null : (
        <p className="decision-library-message">
          {query.trim().length > 0 ? "只显示最相关的 200 条；换个更具体的关键词可以缩小范围。" : "只显示最近更新的 200 条；更早的记录请用关键词或筛选查找。"}
        </p>
      )}
      {/* Read again (shown again, after a save), the list stays as it is meanwhile: swapped for this, it closed the
          revision history being read. */}
      {loading && entries.length === 0 ? (
        <p className="decision-library-message">正在读取记录…</p>
      ) : listError !== null && entries.length === 0 ? null : shownEntries.length === 0 ? (
        <div className="decision-library-empty">
          <strong>{query || kind !== "all" || status !== "all" ? "没有符合条件的记录" : "还没有偏好或想法"}</strong>
          {query || kind !== "all" || status !== "all" ? (
            <button type="button" className="text-button" onClick={() => { setQuery(""); setKind("all"); setStatus("all"); }}>清除关键词与筛选</button>
          ) : <span>点击“主动记录”开始沉淀。</span>}
        </div>
      ) : (
        <ol className="journal-entry-list" ref={listRef}>
          {shownEntries.map((entry) => {
            const view = viewOf(entry);
            const state = view?.state;
            const withdrawnState = state?.withdrawn ?? null;
            const rewrite = rewriteInForce(state);
            const labels = fieldLabels(sourceOf(entry));
            const key = amendmentKey(sourceOf(entry), entry.id);
            const staleRewrite = state?.revised?.stale === true && !isStaleIgnored(ignored, key, state.revision);
            // The entry as it reads now: a rewrite in force in place of the words the reader wrote.
            const nowContent = typeof rewrite?.summary === "string" ? rewrite.summary : entry.content;
            const nowApplies = entry.kind === "preference" && rewrite !== null && "appliesWhen" in rewrite ? rewrite.appliesWhen ?? null : entry.kind === "preference" ? entry.appliesWhen : null;
            const nowExceptions = entry.kind === "preference" && rewrite !== null && "caution" in rewrite ? rewrite.caution ?? null : entry.kind === "preference" ? entry.exceptions : null;
            const originalLines = [
              ...(typeof rewrite?.summary === "string" ? [{ name: labels.summary, text: entry.content }] : []),
              ...(entry.kind === "preference" && rewrite !== null && "appliesWhen" in rewrite ? [{ name: labels.appliesWhen, text: entry.appliesWhen ?? "" }] : []),
              ...(entry.kind === "preference" && rewrite !== null && "caution" in rewrite ? [{ name: labels.caution, text: entry.exceptions ?? "" }] : []),
            ];
            return withdrawnState !== null ? (
              <li key={entry.id} id={`journal-entry-${entry.id}`} className={`journal-entry-card withdrawn ${entry.kind}`}>
                <div className="journal-entry-card-copy">
                  <span className="journal-entry-type">{entry.kind === "preference" ? "偏好" : "想法"} · 已撤回</span>
                  <strong id={`${idPrefix}-${entry.id}`}>{entry.title}</strong>
                  <small>{clientLabel(withdrawnState.client)} · {monthDayLabel(withdrawnState.at)} · 原因：{withdrawnState.reason}</small>
                </div>
                <div className="journal-entry-actions">
                  <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} onClick={() => setHistoryFor(entry)}>修订记录</button>
                  <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} disabled={saving} onClick={() => void restore(entry)}>恢复</button>
                </div>
              </li>
            ) : (
            <li
              key={entry.id}
              id={`journal-entry-${entry.id}`}
              className={`journal-entry-card ${entry.kind}${
                entry.id === highlightId ? " highlighted" : ""
              }`}
              {...(entry.id === highlightId ? { "aria-current": "true" } : {})}
            >
              <div className="journal-entry-card-copy">
                <span className="journal-entry-type">{entry.kind === "preference" ? "偏好" : "想法"} · <em className={`journal-entry-status ${entry.knowledgeStatus}`}>{statusLabel[entry.knowledgeStatus]}</em>
                  {rewrite !== null && state?.revised != null ? <span className="amendment-tag rewritten">已被 {clientLabel(state.revised.client)} 改写 · {monthDayLabel(state.revised.at)}</span> : null}
                  {staleRewrite ? <span className="amendment-tag stale">改写未生效</span> : null}
                  {state !== undefined && state.amendments.length > 0 ? <span className="amendment-tag count">增补 {state.amendments.length}</span> : null}
                </span>
                <strong id={`${idPrefix}-${entry.id}`}>{entry.title}</strong>
                <p>{typeof rewrite?.summary === "string" ? <Rewritten before={entry.content} after={nowContent} /> : entry.content}</p>
                {originalLines.length === 0 ? null : <OriginalWords label={`原话（你写的 v${entry.revision}）`} lines={originalLines} />}
                {staleRewrite && state?.revised != null ? (
                  <div className="amendment-stale" role="note">
                    <p>{clientLabel(state.revised.client)} {monthDayLabel(state.revised.at)}的改写基于旧版原文，这条之后又改过，所以那次改写没有应用。</p>
                    {shownRewrites.has(key) ? (
                      <OriginalWords open label="当时的改写文字" lines={(["summary", "appliesWhen", "caution"] as const).filter((field) => field in state.revised!.values).map((field) => ({ name: labels[field], text: state.revised!.values[field] ?? "" }))} />
                    ) : null}
                    <div className="amendment-stale-actions">
                      <button type="button" className="text-button" aria-expanded={shownRewrites.has(key)} onClick={() => setShownRewrites((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next; })}>查看当时的改写文字</button>
                      <button type="button" className="text-button" disabled={saving} onClick={() => beginRevision(entry, state.revised!.values)}>按新原文重新改写</button>
                      <button type="button" className="text-button" onClick={() => { ignoreStale(key, state.revision); setIgnored(staleIgnored()); }}>忽略</button>
                    </div>
                  </div>
                ) : null}
                <ul className="journal-entry-languages" aria-label="适用语言">
                  {languagesShown(entry.languages).map((language) => <li key={language}>{language}</li>)}
                </ul>
                {/* What the entry says now, under the labels its history uses for what it said before: the card showed
                    some of it, so a strength, a context or an open question was seen only by opening 修订. */}
                {entry.kind === "preference" ? (
                  <>
                    {entry.strength !== "default" && <p>偏好强度：{entry.strength === "hard_constraint" ? "硬约束" : "弱信号"}</p>}
                    {nowApplies && <p>适用条件：{rewrite !== null && "appliesWhen" in rewrite ? <Rewritten before={entry.appliesWhen} after={nowApplies} /> : nowApplies}</p>}
                    {nowExceptions && <p>例外与边界：{rewrite !== null && "caution" in rewrite ? <Rewritten before={entry.exceptions} after={nowExceptions} /> : nowExceptions}</p>}
                  </>
                ) : (
                  <>
                    {entry.whyInteresting && <p>保留理由：{entry.whyInteresting}</p>}
                    {entry.nextTest && <p>下一步验证：{entry.nextTest}</p>}
                    {entry.openQuestions.length > 0 && <p>未决问题：{entry.openQuestions.join("\n")}</p>}
                    {entry.incubateUntil && <p>孵化日期：{entry.incubateUntil}</p>}
                  </>
                )}
                {entry.context && <p>背景：{entry.context}</p>}
                {entry.rationale && <p>补充说明：{entry.rationale}</p>}
                {entry.tags.length > 0 && <p>标签：{entry.tags.join("、")}</p>}
                {state === undefined ? null : <AmendmentList state={state} title="增补" />}
                <small>v{entry.revision} · {entry.sourceForm === "machine_summary" ? "机器归纳" : entry.sourceForm === "user_paraphrase" ? "用户转述" : "用户原文"}{state === undefined ? "" : ` · 修订 ${state.revision}`}</small>
                {entry.revisionEvents.length === 0 ? null : (
                  <details className="journal-entry-history">
                    <summary><Chevron />修订历史 · {entry.revisionEvents.length}</summary>
                    <ol>
                      {[...entry.revisionEvents].reverse().map((event) => (
                        <li key={event.revision}>
                          <span className="journal-entry-version">
                            <strong>v{event.revision - 1} → v{event.revision}</strong>
                            <time dateTime={event.changedAt}>{revisionTimeFormatter.format(new Date(event.changedAt))}</time>
                          </span>
                          <p>变更原因：{event.changeNote}</p>
                          {/* What it said before, set apart from what it says now by a rule down its side. */}
                          <details className="journal-entry-previous">
                            <summary><Chevron />查看修订前内容（v{event.revision - 1}）</summary>
                            <strong>{event.previous.title}</strong>
                            <p>{event.previous.content}</p>
                            <p>状态：{statusLabel[event.previous.knowledgeStatus]}</p>
                            {event.previous.kind === "preference" ? (
                              <>
                                <p>适用条件：{event.previous.appliesWhen ?? "未填写"}</p>
                                <p>例外与边界：{event.previous.exceptions ?? "未填写"}</p>
                                <p>偏好强度：{event.previous.strength === "hard_constraint" ? "硬约束" : event.previous.strength === "default" ? "默认偏好" : "弱信号"}</p>
                              </>
                            ) : (
                              <>
                                <p>保留理由：{event.previous.whyInteresting ?? "未填写"}</p>
                                <p>下一步验证：{event.previous.nextTest ?? "未填写"}</p>
                                {event.previous.openQuestions.length > 0 && <p>未决问题：{event.previous.openQuestions.join("\n")}</p>}
                                {event.previous.incubateUntil && <p>孵化日期：{event.previous.incubateUntil}</p>}
                              </>
                            )}
                            {event.previous.context && <p>背景：{event.previous.context}</p>}
                            {event.previous.rationale && <p>补充说明：{event.previous.rationale}</p>}
                            {event.previous.tags.length > 0 && <p>标签：{event.previous.tags.join("、")}</p>}
                          </details>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
              <div className="journal-entry-actions">
                <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} onClick={() => setHistoryFor(entry)}>修订记录</button>
                <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} disabled={saving} data-revise onClick={() => beginRevision(entry)}>修订</button>
                <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} disabled={saving} onClick={() => { setWithdrawing(entry); setWithdrawReason(""); setError(null); }}>撤回</button>
                {entry.knowledgeStatus === "archived" ? null : (
                  <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} disabled={saving} onClick={() => void archive(entry)}>归档</button>
                )}
              </div>
            </li>
            );
          })}
        </ol>
      )}
      {/* What was done to an entry, said at the bottom of the card it was done in. */}
      {error !== null && editing === null ? (
        <p className="settings-status error" role="alert">处理失败：{error}</p>
      ) : notice === null ? null : (
        <p className="settings-status" role="status">{notice}</p>
      )}

      {historyFor === null ? null : (() => {
        const view = viewOf(historyFor);
        const state: AmendmentState = view?.state ?? { revision: 0, relativePath: "", amendments: [], revised: null, withdrawn: null, history: [] };
        const own = historyFor.revisionEvents.map((event) => ({ at: event.changedAt, what: `修订 v${event.revision}`, reason: event.changeNote }));
        return (
          <ModalDialog title="修订记录" description={historyFor.title} size="wide" onClose={() => setHistoryFor(null)}
            footer={<button type="button" className="secondary-button" onClick={() => setHistoryFor(null)}>关闭</button>}>
            <AmendmentHistory source={sourceOf(historyFor)} state={state} today={today} own={own} busy={saving}
              onRestore={view?.contentHash == null ? undefined : (row, to) => setRestoring({ entry: historyFor, row, to })} />
          </ModalDialog>
        );
      })()}
      {restoring === null ? null : (
        <ModalDialog title="恢复为这一版之前？" description="这会再写一次改写，把改动前的文字放回去；现在的改写留在修订记录里。" onClose={() => setRestoring(null)}
          footer={<>
            <button type="button" className="secondary-button" onClick={() => setRestoring(null)}>取消</button>
            <button type="button" className="primary-button" disabled={saving} onClick={() => {
              const view = viewOf(restoring.entry);
              if (view?.contentHash == null) return;
              void amend(restoreRequest(sourceOf(restoring.entry), restoring.entry.id, view.contentHash, view.state.revision, restoring.row.revision, restoring.row.time), "已恢复为那次改写之前。").then((saved) => { if (saved) { setRestoring(null); setHistoryFor(null); } });
            }}>恢复</button>
          </>}>
          {Object.entries(restoring.to).map(([name, value]) => <p key={name}>{fieldLabels(sourceOf(restoring.entry))[name as keyof AmendmentFields]}：{value ?? "（空）"}</p>)}
          {restoring.row.truncated ? <p className="amendment-stale" role="note">…（已截断，恢复会用完整原文）</p> : null}
          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        </ModalDialog>
      )}
      {withdrawing === null ? null : (
        <ModalDialog title="撤回这条？" description="撤回后默认不出现在「有效」里，agent 检索和请教原则也不再返回它；可以在「已撤回」里恢复。" onClose={() => setWithdrawing(null)} dismissible={!saving}
          unsaved={withdrawReason.trim().length > 0}
          footer={<>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => setWithdrawing(null)}>取消</button>
            <button type="submit" form={`${idPrefix}-withdraw`} className="primary-button" disabled={saving || withdrawReason.trim().length === 0}>{saving ? "撤回中…" : "撤回"}</button>
          </>}>
          <form id={`${idPrefix}-withdraw`} onSubmit={(event) => { event.preventDefault(); void withdraw(withdrawing); }}>
            <p><strong>{withdrawing.title}</strong></p>
            <div className="form-field">
              <label htmlFor={`${idPrefix}-withdraw-reason`}>撤回原因</label>
              <textarea id={`${idPrefix}-withdraw-reason`} rows={2} maxLength={2000} required value={withdrawReason} onChange={(event) => setWithdrawReason(event.currentTarget.value)} />
            </div>
            {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          </form>
        </ModalDialog>
      )}
      {editing === null || draft === null ? null : (
        // Only 取消 throws a revision away: a stray Escape or click outside took everything written in it.
        <ModalDialog title="修订记录" description={`当前版本 v${editing.revision}；保存后保留上一版快照。`} size="wide"
          dismissible={!saving}
          unsaved={changeNote.trim().length > 0 || JSON.stringify(draft) !== JSON.stringify(draftFrom(editing))}
          onClose={closeRevision}
          footer={<>
            <button type="button" className="secondary-button" disabled={saving} onClick={closeRevision}>取消</button>
            <button type="submit" form={`${idPrefix}-revision`} className="primary-button" disabled={saving || !canSave}>{saving ? "保存中…" : "保存修订"}</button>
          </>}>
          <form id={`${idPrefix}-revision`} className="journal-revision-form" onSubmit={(event) => { event.preventDefault(); void saveRevision(); }}>
            {latest === null ? null : (
              <div className="journal-entry-latest" role="note" aria-label="最新内容">
                <p>它在你打开之后又被更新过，下面是最新内容；你的修订还在表单里，保存会以它替换最新内容。</p>
                <strong>{latest.title}</strong>
                <p>{latest.content}</p>
              </div>
            )}
            <fieldset className="form-fields" disabled={saving}>
              <div className="form-field">
                <label htmlFor={`${idPrefix}-title`}>标题</label>
                <input id={`${idPrefix}-title`} aria-label="修订标题" maxLength={500} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
              </div>
              <div className="form-field">
                <label htmlFor={`${idPrefix}-content`}>内容</label>
                <textarea id={`${idPrefix}-content`} aria-label="修订内容" rows={3} maxLength={8000} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.currentTarget.value })} />
              </div>
              <div className="form-field">
                <label htmlFor={`${idPrefix}-languages`}>适用语言</label>
                {/* Left as typed (separators and all) while it is edited; the draft keeps the names it reads as. */}
                <input id={`${idPrefix}-languages`} maxLength={400} placeholder="如 Go、TypeScript；留空表示各语言通用" defaultValue={(draft.languages ?? []).map(languageLabel).join("、")}
                  aria-invalid={languageProblem === null ? undefined : true} aria-describedby={languageProblem === null ? undefined : `${idPrefix}-languages-error`}
                  onChange={(event) => setDraft({ ...draft, languages: languagesTyped(event.currentTarget.value) })} />
                {languageProblem === null ? null : <p className="form-field-error" role="alert" id={`${idPrefix}-languages-error`}>{languageProblem}</p>}
              </div>
              {draft.kind === "preference" ? (
                <>
                  <div className="form-field">
                    <label htmlFor={`${idPrefix}-applies`}>适用条件</label>
                    <textarea id={`${idPrefix}-applies`} {...askedFor(draft.appliesWhen)} rows={2} maxLength={4000} value={draft.appliesWhen ?? ""} onChange={(event) => setDraft({ ...draft, appliesWhen: event.currentTarget.value.trim() ? event.currentTarget.value : null })} />
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${idPrefix}-exceptions`}>例外与边界</label>
                    <textarea id={`${idPrefix}-exceptions`} {...askedFor(draft.exceptions)} rows={2} maxLength={4000} value={draft.exceptions ?? ""} onChange={(event) => setDraft({ ...draft, exceptions: event.currentTarget.value.trim() ? event.currentTarget.value : null })} />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-field">
                    <label htmlFor={`${idPrefix}-why`}>为什么值得保留</label>
                    <textarea id={`${idPrefix}-why`} {...askedFor(draft.whyInteresting)} rows={2} maxLength={4000} value={draft.whyInteresting ?? ""} onChange={(event) => setDraft({ ...draft, whyInteresting: event.currentTarget.value.trim() ? event.currentTarget.value : null })} />
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${idPrefix}-next`}>下一步验证</label>
                    <textarea id={`${idPrefix}-next`} rows={2} maxLength={4000} value={draft.nextTest ?? ""} onChange={(event) => setDraft({ ...draft, nextTest: event.currentTarget.value.trim() ? event.currentTarget.value : null })} />
                  </div>
                </>
              )}
              <div className="form-fields-row">
                {draft.kind === "preference" ? (
                  <div className="form-field">
                    <label htmlFor={`${idPrefix}-strength`}>偏好强度</label>
                    <select id={`${idPrefix}-strength`} value={draft.strength ?? "default"} onChange={(event) => setDraft({ ...draft, strength: event.currentTarget.value as "hard_constraint" | "default" | "weak_signal" })}><option value="hard_constraint">硬约束</option><option value="default">默认偏好</option><option value="weak_signal">弱信号</option></select>
                  </div>
                ) : null}
                <div className="form-field">
                  <label htmlFor={`${idPrefix}-status`}>记录状态</label>
                  <select id={`${idPrefix}-status`} value={draft.knowledgeStatus ?? "inbox"} onChange={(event) => setDraft({ ...draft, knowledgeStatus: event.currentTarget.value as "inbox" | "active" | "archived" })}><option value="inbox">待澄清</option><option value="active">有效</option><option value="archived">已归档</option></select>
                  {incomplete && <p className="form-field-error" role="status" id={`${idPrefix}-incomplete`}>{draft.kind === "preference" ? "设为有效前，请填写适用条件和例外与边界。" : "设为有效前，请说明为什么值得保留。"}</p>}
                </div>
              </div>
              <hr className="form-fields-divider" />
              <div className="form-field">
                <label htmlFor={`${idPrefix}-change`}>变更原因</label>
                <textarea id={`${idPrefix}-change`} rows={2} maxLength={1000} required value={changeNote} onChange={(event) => setChangeNote(event.currentTarget.value)} />
              </div>
            </fieldset>
            {error === null ? null : <p className="form-error" role="alert">保存失败：{error}</p>}
          </form>
        </ModalDialog>
      )}
    </section>
  );
};
