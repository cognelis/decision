import type { JournalEntry, JournalEntryDraft } from "@cognelis/decision-core";
import { languageLabel } from "@cognelis/decision-core/journal-entry";
import { useEffect, useId, useRef, useState } from "react";

import { journalEntryBasis } from "../../../../shared/journal-basis.js";
import type { DecisionApi, JournalEntryListQuery } from "../../../../shared/renderer-api.js";
import { zonedFormatter } from "../../../calendar-date.js";
import { useSearchHighlight } from "../../../use-search-highlight.js";
import { useSlashToFocus } from "../../../use-slash-focus.js";
import { ModalDialog } from "../../ModalDialog.js";

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
  overrides: Partial<Pick<JournalEntryDraft, "title" | "content" | "knowledgeStatus">> = {},
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
        appliesWhen: entry.appliesWhen,
        exceptions: entry.exceptions,
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
  const [status, setStatus] = useState<"all" | "inbox" | "active" | "archived">("all");
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
        ...(status === "all" ? {} : { knowledgeStatus: status }),
        limit: 200,
      };
      setLoading(true);
      setListError(null);
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
    (row?.querySelector<HTMLElement>(".journal-entry-actions button") ?? searchRef.current)?.focus();
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

  const beginRevision = (entry: JournalEntry): void => {
    setEditing(entry);
    setDraft(draftFrom(entry));
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
          placeholder="搜索偏好与想法"
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
        </select>
      </div>

      {error === null || editing !== null ? null : <p className="error-message" role="alert">处理失败：{error}</p>}
      {listError === null ? null : <p className="error-message" role="alert">读取失败：{listError}</p>}
      {notice === null ? null : <p role="status">{notice}</p>}
      {unreadableNotice === null ? null : <p className="error-message">{unreadableNotice}</p>}
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
      ) : entries.length === 0 ? (
        <div className="decision-library-empty">
          <strong>{query || kind !== "all" || status !== "all" ? "没有符合条件的记录" : "还没有偏好或想法"}</strong>
          {query || kind !== "all" || status !== "all" ? (
            <button type="button" className="text-button" onClick={() => { setQuery(""); setKind("all"); setStatus("all"); }}>清除关键词与筛选</button>
          ) : <span>点击“主动记录”开始沉淀。</span>}
        </div>
      ) : (
        <ol className="journal-entry-list" ref={listRef}>
          {entries.map((entry) => (
            <li
              key={entry.id}
              id={`journal-entry-${entry.id}`}
              className={`journal-entry-card ${entry.kind}${
                entry.id === highlightId ? " highlighted" : ""
              }`}
              {...(entry.id === highlightId ? { "aria-current": "true" } : {})}
            >
              <div className="journal-entry-card-copy">
                <span className="journal-entry-type">{entry.kind === "preference" ? "偏好" : "想法"} · <em className={`journal-entry-status ${entry.knowledgeStatus}`}>{statusLabel[entry.knowledgeStatus]}</em></span>
                <strong id={`${idPrefix}-${entry.id}`}>{entry.title}</strong>
                <p>{entry.content}</p>
                <ul className="journal-entry-languages" aria-label="适用语言">
                  {languagesShown(entry.languages).map((language) => <li key={language}>{language}</li>)}
                </ul>
                {entry.kind === "preference" ? (
                  <>
                    {entry.appliesWhen && <p>适用条件：{entry.appliesWhen}</p>}
                    {entry.exceptions && <p>例外与边界：{entry.exceptions}</p>}
                  </>
                ) : (
                  <>
                    {entry.whyInteresting && <p>保留理由：{entry.whyInteresting}</p>}
                    {entry.nextTest && <p>下一步验证：{entry.nextTest}</p>}
                  </>
                )}
                <small>v{entry.revision} · {entry.sourceForm === "machine_summary" ? "机器归纳" : entry.sourceForm === "user_paraphrase" ? "用户转述" : "用户原文"}</small>
                {entry.revisionEvents.length === 0 ? null : (
                  <details className="journal-entry-history">
                    <summary>修订历史 · {entry.revisionEvents.length}</summary>
                    <ol>
                      {[...entry.revisionEvents].reverse().map((event) => (
                        <li key={event.revision}>
                          <strong>v{event.revision - 1} → v{event.revision}</strong>
                          <time dateTime={event.changedAt}>{revisionTimeFormatter.format(new Date(event.changedAt))}</time>
                          <p>变更原因：{event.changeNote}</p>
                          <details>
                            <summary>查看修订前内容（v{event.revision - 1}）</summary>
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
                <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} disabled={saving} onClick={() => beginRevision(entry)}>修订</button>
                {entry.knowledgeStatus === "archived" ? null : (
                  <button type="button" className="text-button" aria-describedby={`${idPrefix}-${entry.id}`} disabled={saving} onClick={() => void archive(entry)}>归档</button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {editing === null || draft === null ? null : (
        // Only 取消 throws a revision away: a stray Escape or click outside took everything written in it.
        <ModalDialog title="修订记录" description={`当前版本 v${editing.revision}；保存后保留上一版快照。`} size="wide"
          dismissible={!saving && changeNote.trim().length === 0 && JSON.stringify(draft) === JSON.stringify(draftFrom(editing))}
          onClose={closeRevision}>
          <form className="journal-revision-form" onSubmit={(event) => { event.preventDefault(); void saveRevision(); }}>
            {latest === null ? null : (
              <div className="journal-entry-latest" role="note" aria-label="最新内容">
                <p>它在你打开之后又被更新过，下面是最新内容；你的修订还在表单里，保存会以它替换最新内容。</p>
                <strong>{latest.title}</strong>
                <p>{latest.content}</p>
              </div>
            )}
            <label><span>标题</span><input aria-label="修订标题" maxLength={500} disabled={saving} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} /></label>
            <label><span>内容</span><textarea aria-label="修订内容" rows={3} maxLength={8000} disabled={saving} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.currentTarget.value })} /></label>
            {/* Left as typed (separators and all) while it is edited; the draft keeps the names it reads as. */}
            <label><span>适用语言</span><input aria-label="适用语言" maxLength={400} disabled={saving} placeholder="如 Go、TypeScript；留空表示各语言通用" defaultValue={(draft.languages ?? []).map(languageLabel).join("、")} onChange={(event) => setDraft({ ...draft, languages: languagesTyped(event.currentTarget.value) })} /></label>
            {languageProblem === null ? null : <p className="error-message" role="alert">{languageProblem}</p>}
            {draft.kind === "preference" ? (
              <>
                <label><span>适用条件</span><textarea aria-label="适用条件" {...askedFor(draft.appliesWhen)} rows={2} maxLength={4000} disabled={saving} value={draft.appliesWhen ?? ""} onChange={(event) => setDraft({ ...draft, appliesWhen: event.currentTarget.value.trim() ? event.currentTarget.value : null })} /></label>
                <label><span>例外与边界</span><textarea aria-label="例外与边界" {...askedFor(draft.exceptions)} rows={2} maxLength={4000} disabled={saving} value={draft.exceptions ?? ""} onChange={(event) => setDraft({ ...draft, exceptions: event.currentTarget.value.trim() ? event.currentTarget.value : null })} /></label>
                <label><span>偏好强度</span><select aria-label="偏好强度" disabled={saving} value={draft.strength ?? "default"} onChange={(event) => setDraft({ ...draft, strength: event.currentTarget.value as "hard_constraint" | "default" | "weak_signal" })}><option value="hard_constraint">硬约束</option><option value="default">默认偏好</option><option value="weak_signal">弱信号</option></select></label>
              </>
            ) : (
              <>
                <label><span>为什么值得保留</span><textarea aria-label="为什么值得保留" {...askedFor(draft.whyInteresting)} rows={2} maxLength={4000} disabled={saving} value={draft.whyInteresting ?? ""} onChange={(event) => setDraft({ ...draft, whyInteresting: event.currentTarget.value.trim() ? event.currentTarget.value : null })} /></label>
                <label><span>下一步验证</span><textarea aria-label="下一步验证" rows={2} maxLength={4000} disabled={saving} value={draft.nextTest ?? ""} onChange={(event) => setDraft({ ...draft, nextTest: event.currentTarget.value.trim() ? event.currentTarget.value : null })} /></label>
              </>
            )}
            <label><span>记录状态</span><select aria-label="记录状态" disabled={saving} value={draft.knowledgeStatus ?? "inbox"} onChange={(event) => setDraft({ ...draft, knowledgeStatus: event.currentTarget.value as "inbox" | "active" | "archived" })}><option value="inbox">待澄清</option><option value="active">有效</option><option value="archived">已归档</option></select></label>
            {incomplete && <p role="status" id={`${idPrefix}-incomplete`}>{draft.kind === "preference" ? "设为有效前，请填写适用条件和例外与边界。" : "设为有效前，请说明为什么值得保留。"}</p>}
            <label><span>变更原因</span><textarea aria-label="变更原因" rows={2} maxLength={1000} disabled={saving} required value={changeNote} onChange={(event) => setChangeNote(event.currentTarget.value)} /></label>
            {error === null ? null : <p className="error-message" role="alert">保存失败：{error}</p>}
            <footer className="active-record-actions">
              <button type="button" className="text-button" disabled={saving} onClick={closeRevision}>取消</button>
              <button type="submit" className="primary-button" disabled={saving || !canSave}>{saving ? "保存中…" : "保存修订"}</button>
            </footer>
          </form>
        </ModalDialog>
      )}
    </section>
  );
};
