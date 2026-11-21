import { zonedFormatter } from "../calendar-date.js";
import { sourceLabel } from "../client-labels.js";
import { RATIONALE_FACTORS } from "@cognelis/decision-core/rationale-factors";
import { Fragment, useEffect, useId, useRef, useState } from "react";

import type {
  DecisionApi,
  PendingRationaleSummary,
} from "../../shared/renderer-api.js";
import {
  DEFER_SHORTCUT_KEYS,
  deferShortcutLabel,
  DISMISS_SHORTCUT_KEYS,
  dismissShortcutLabel,
  isDeferShortcut,
  isDismissShortcut,
  isPreferenceShortcut,
  isSubmitShortcut,
  PREFERENCE_SHORTCUT_KEYS,
  preferenceShortcutLabel,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";
import { DecisionAnswerSummary, partitionDecisionAnswers } from "./DecisionAnswerSummary.js";
import { CapturedText } from "./DecisionContext.js";
import { deferredRationale, dropDeferredRationale, forgetUnfiledDeferredRationales, keepDeferredRationale } from "./deferred-rationale-draft.js";
import { ActionIcon, IconButton } from "./IconButton.js";
import { ModalDialog } from "./ModalDialog.js";
import { PastAnswers } from "./PastAnswers.js";
import { renderMarkdown } from "./pages/assistant/markdown.js";
import { ActiveRecordDialog, type ActiveRecordApi } from "./pages/decisions/ActiveRecordDialog.js";
import { plainHeadline, useClampedTitle } from "./question-title.js";
import { HISTORICAL_TRIAGE_TITLE, historicalDraft, preferenceDraft } from "./TaskActions.js";

/** What the user supplied when completing a deferred rationale. */
export interface PendingRationaleCompletion {
  rationale?: string;
  reasonFactors?: string[];
}

/** What was being written in the dialog: kept by the app while the home page is away. */
export interface PendingRationaleDraft {
  activeId: string;
  /** The decision itself: one no longer listed (more put off since) is still being written for. */
  decision?: PendingRationaleSummary;
  rationale: string;
  reasonFactors: string[];
  continuous: boolean;
  postponedIds?: string[];
}

interface DashboardPendingRationalesProps {
  /** Those put off in a capture and the vault's newest: a backlog of thousands, every push carried and drew. */
  decisions: PendingRationaleSummary[];
  /** How many wait in all, when more than are listed. */
  total?: number;
  /** The rest, on the knowledge page. */
  onBrowseAll?(): void;
  listDecisions: DecisionApi["listDecisions"];
  onComplete(id: string, completion: PendingRationaleCompletion): Promise<void>;
  onSkip(id: string): Promise<void>;
  onDiscard(id: string): Promise<void>;
  onKeepLocal(id: string, completion: PendingRationaleCompletion): Promise<void>;
  /** Given, one that turns out to be where the user stands can be written as a preference instead. */
  recordApi?: ActiveRecordApi;
  /**
   * Where the dialog's draft is kept outside the page. A capture arriving takes the window over and
   * unmounts the home page; back on it, the dialog opens again as it was left.
   */
  drafts?: { pending?: PendingRationaleDraft | undefined };
}

const STALE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;


const isStale = (created: string): boolean =>
  Date.now() - new Date(created).getTime() >= STALE_AGE_MS;

const fullDateFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// The row is a third of the dashboard wide: a year and a clock time crowd out
// the answer, which is the part a rationale is written about.
const dayFormatter = zonedFormatter({
  month: "short",
  day: "numeric",
});

const yearDayFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
});

const shortDate = (created: string): string => {
  const date = new Date(created);
  return date.getFullYear() === new Date().getFullYear()
    ? dayFormatter.format(date)
    : yearDayFormatter.format(date);
};

/**
 * What 不保留 does to these: a note is taken out of the vault, one put off in a capture (held in the recovery queue
 * alone) is never written. Said of every one as taken out of Obsidian, where it had never been.
 */
const discardedWhere = (decisions: readonly PendingRationaleSummary[]): string => {
  const held = decisions.filter((decision) => decision.inVault === false).length;
  return held === 0
    ? "确认后会从决策库与 Obsidian 中移除"
    : held === decisions.length
      ? "确认后不会写入 Obsidian"
      : "确认后不再记录：已写入的会从决策库与 Obsidian 中移除，其余不会写入";
};

export const DashboardPendingRationales = ({
  decisions,
  total,
  onBrowseAll,
  listDecisions,
  onComplete,
  onSkip,
  onDiscard,
  onKeepLocal,
  recordApi,
  drafts,
}: DashboardPendingRationalesProps) => {
  const busy = useRef(false);
  const waiting = Math.max(total ?? 0, decisions.length);
  const restored = drafts?.pending;
  // Each row's actions say which decision they are for, and the rationale field which decision it explains.
  const idPrefix = useId();
  const rationaleInput = useRef<HTMLTextAreaElement>(null);
  const [continuous, setContinuous] = useState(restored?.continuous ?? false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<"skip" | "local" | "discard" | null>(null);
  const [processedIds, setProcessedIds] = useState<string[]>([]);
  const [postponedIds, setPostponedIds] = useState<string[]>(restored?.postponedIds ?? []);
  const [activeId, setActiveId] = useState<string | null>(restored?.activeId ?? null);
  const [skipId, setSkipId] = useState<string | null>(null);
  const [preferenceId, setPreferenceId] = useState<string | null>(null);
  // The same form, opened to keep it only on record (历史决定) rather than as a preference.
  const [asHistorical, setAsHistorical] = useState(false);
  const [rationale, setRationale] = useState(restored?.rationale ?? "");
  const [reasonFactors, setReasonFactors] = useState<string[]>(restored?.reasonFactors ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(forgetUnfiledDeferredRationales, []);
  const listed = decisions.find((decision) => decision.id === activeId);
  // Kept once opened: pushed out of a list cut short by more put off since, the dialog closed and what was
  // being written went with it. Gone from a list that holds them all, it was done elsewhere, and goes.
  const [held, setHeld] = useState<PendingRationaleSummary | null>(restored?.decision ?? null);
  useEffect(() => {
    if (listed !== undefined) setHeld(listed);
  }, [listed]);
  const activeDecision = listed ?? (held?.id === activeId && waiting > decisions.length ? held : undefined);
  useEffect(() => {
    if (drafts !== undefined) {
      drafts.pending = activeDecision === undefined
        ? undefined
        : { activeId: activeDecision.id, decision: activeDecision, rationale, reasonFactors, continuous, postponedIds };
    }
  }, [drafts, activeDecision, rationale, reasonFactors, continuous, postponedIds]);
  // The question heads the dialog in two lines of plain text; cut short there, or flattened from lists, it is given
  // whole under it, as written.
  const [questionTitleRef, questionCut] = useClampedTitle<HTMLHeadingElement>(activeDecision?.question ?? "");
  const skipDecision = decisions.find((decision) => decision.id === skipId)
    ?? (activeDecision?.id === skipId ? activeDecision : undefined);
  // Pushed out of a list cut short, its confirmation went: forgotten with it, or it came back by itself, unasked, when
  // the list held it again.
  useEffect(() => {
    if (skipId !== null && skipDecision === undefined) setSkipId(null);
  }, [skipId, skipDecision]);

  const batchDecisions = decisions.filter(
    (decision) => !processedIds.includes(decision.id),
  );
  const selectedDecisions = batchDecisions.filter(
    (decision) => selectedIds.includes(decision.id),
  );
  const nextDecision = continuous
    ? batchDecisions.find((decision) => decision.id !== activeId && !postponedIds.includes(decision.id))
    : undefined;

  const advance = (): void => {
    const nextId = nextDecision?.id ?? null;
    setActiveId(nextId);
    setRationale(nextId === null ? "" : deferredRationale(nextId)?.rationale ?? "");
    setReasonFactors(nextId === null ? [] : deferredRationale(nextId)?.reasonFactors ?? []);
    setError(null);
  };

  const finishActive = (id: string): void => {
    dropDeferredRationale(id);
    setProcessedIds((ids) => [...ids, id]);
    advance();
  };

  const postpone = (): void => {
    if (busy.current || activeId === null || !continuous) return;
    if (!dropDeferredRationale(activeId) || !keepDeferredRationale(activeId, { rationale, reasonFactors })) {
      setError("草稿暂时无法保存在本机，当前条目没有跳过，请重试。");
      return;
    }
    setPostponedIds((ids) => [...ids, activeId]);
    advance();
  };

  const runBatch = async (): Promise<void> => {
    if (busy.current || batchAction === null || selectedDecisions.length === 0) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    let completed = 0;
    // Each one tried, and what was refused said once: stopped at the first refused, it came first again at every retry
    // and was refused again, and those after it never had their turn. Those not done stay chosen, to be tried again.
    const reasons = new Set<string>();
    try {
      for (const decision of selectedDecisions) {
        try {
          await (batchAction === "skip" ? onSkip(decision.id) : batchAction === "local" ? onKeepLocal(decision.id, {}) : onDiscard(decision.id));
        } catch (caught) {
          // The main process refuses in whole sentences: their own 。 left "。。".
          reasons.add((caught instanceof Error ? caught.message : String(caught)).replace(/[。.]$/u, ""));
          continue;
        }
        // Done with, as one at a time: kept, the words written before 稍后处理 outlived a decision not recorded.
        dropDeferredRationale(decision.id);
        completed += 1;
        setProcessedIds((ids) => [...ids, decision.id]);
        setSelectedIds((ids) => ids.filter((id) => id !== decision.id));
      }
      const failed = selectedDecisions.length - completed;
      if (failed === 0) {
        setBatchAction(null);
        setBatchOpen(false);
      } else {
        setError(`已处理 ${completed} 条，${failed} 条没有处理：${[...reasons].join("；")}。可重试这 ${failed} 条。`);
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  // A deferred rationale is completed in the note as the user's own words;
  // factors alone would leave the note claiming an original that was never
  // written, and the main process refuses such a completion.
  const canSave = rationale.trim().length > 0;

  const toggleFactor = (factor: string): void => {
    setReasonFactors((current) =>
      current.includes(factor)
        ? current.filter((item) => item !== factor)
        : [...current, factor],
    );
  };

  const save = async (): Promise<void> => {
    if (busy.current || activeId === null || !canSave) {
      return;
    }
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await onComplete(activeId, {
        ...(rationale.trim().length === 0 ? {} : { rationale }),
        ...(reasonFactors.length === 0 ? {} : { reasonFactors }),
      });
      finishActive(activeId);
    } catch (caught) {
      setError(
        `理由暂时无法保存：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const skip = async (id: string): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSkip(id);
      if (id === activeId) finishActive(id);
      else dropDeferredRationale(id);
      setSkipId(null);
    } catch (caught) {
      setError(
        `暂时无法标记为未补理由：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const keepLocal = async (id: string): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await onKeepLocal(id, id === activeId ? {
        ...(rationale.trim() ? { rationale } : {}), ...(reasonFactors.length ? { reasonFactors } : {}),
      } : {});
      if (id === activeId) finishActive(id);
      else dropDeferredRationale(id);
      setSkipId(null);
    } catch (caught) { setError(`暂时无法转为本机记录：${caught instanceof Error ? caught.message : String(caught)}`); }
    finally { busy.current = false; setSaving(false); }
  };

  const discard = async (id: string): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await onDiscard(id);
      if (id === activeId) finishActive(id);
      else dropDeferredRationale(id);
      setSkipId(null);
    } catch (caught) {
      setError(
        `暂时无法移除这条决策：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <>
      <section
        className="dashboard-card dashboard-rationale-card"
        aria-labelledby="dashboard-rationale-title"
      >
        <header className="dashboard-card-header">
          <div>
            <span>待处理</span>
            <h2 id="dashboard-rationale-title">待补理由</h2>
            <p className="dashboard-rationale-description">
              {/* True of both kinds: one put off in a capture is held here, not yet in Obsidian ("决策已记录" it was not). */}
              选择已保存
            </p>
          </div>
          {decisions.length > 1 ? (
            <div className="dashboard-rationale-toolbar">
              <IconButton aria-label="连续补充" aria-haspopup="dialog" disabled={saving} onClick={() => {
                setProcessedIds([]);
                setPostponedIds([]);
                setContinuous(true);
                setActiveId(decisions[0]!.id);
                setRationale(deferredRationale(decisions[0]!.id)?.rationale ?? "");
                setReasonFactors(deferredRationale(decisions[0]!.id)?.reasonFactors ?? []);
                setError(null);
              }}><ActionIcon name="next" /></IconButton>
              <IconButton aria-label="批量处理" aria-haspopup="dialog" disabled={saving} onClick={() => {
                setBatchOpen(true);
                setBatchAction(null);
                setSelectedIds([]);
                setProcessedIds([]);
                setError(null);
              }}><ActionIcon name="principles" /></IconButton>
            </div>
          ) : null}
          <strong className={waiting === 0 ? "idle" : undefined}>
            {waiting}
          </strong>
        </header>
        {decisions.length === 0 ? (
          <p className="dashboard-empty-copy">目前没有待补充的决策。</p>
        ) : (
          <ul className="dashboard-rationale-list">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <div className="dashboard-rationale-row">
                  <div className="dashboard-rationale-copy">
                    <div className="dashboard-rationale-title-line">
                      <strong id={`${idPrefix}-question-${decision.id}`}>{plainHeadline(decision.question)}</strong>
                      {isStale(decision.created) ? (
                        <span className="dashboard-stale-badge">超过 30 天</span>
                      ) : null}
                    </div>
                    <div className="dashboard-rationale-meta">
                      <span
                        className="dashboard-rationale-answer"
                        title={decision.selectedAnswer}
                      >
                        选择：{plainHeadline(decision.selectedAnswer)}
                      </span>
                      <span className="dashboard-rationale-project">
                        {decision.project}
                      </span>
                    </div>
                    <p className="dashboard-rationale-context">
                      <span className="dashboard-rationale-origin">
                        <span>
                          {sourceLabel(decision.sourceClient)}
                        </span>{" "}
                        ·{" "}
                        <time
                          dateTime={decision.created}
                          title={fullDateFormatter.format(new Date(decision.created))}
                        >
                          {shortDate(decision.created)}
                        </time>
                      </span>
                      {decision.contextSummary === null ? null : (
                        <>
                          {" "}
                          <span>{decision.contextSummary}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="dashboard-rationale-actions">
                    <button
                      className="text-button"
                      type="button"
                      aria-haspopup="dialog"
                      aria-describedby={`${idPrefix}-question-${decision.id}`}
                      disabled={saving}
                      onClick={() => {
                        setContinuous(false);
                        setActiveId(decision.id);
                        setSkipId(null);
                        // Begun on the capture panel and put off there, it opens as it was left.
                        setRationale(deferredRationale(decision.id)?.rationale ?? "");
                        setReasonFactors(deferredRationale(decision.id)?.reasonFactors ?? []);
                        setError(null);
                      }}
                    >
                      补充理由
                    </button>
                    <button
                      className="text-button dashboard-rationale-discard"
                      type="button"
                      aria-haspopup="dialog"
                      aria-describedby={`${idPrefix}-question-${decision.id}`}
                      disabled={saving}
                      onClick={() => {
                        setActiveId(null);
                        setSkipId(decision.id);
                        setRationale("");
                        setReasonFactors([]);
                        setError(null);
                      }}
                    >
                      不保留
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {waiting > decisions.length ? (
          <p className="dashboard-rationale-more">
            {/* Held in the capture spool alone and listed first: a list full of them, the rest may be more of the same,
                found nowhere else until these are handled. */}
            {decisions.at(-1)?.inVault === false
              ? `这里列出 ${decisions.length} 条，其余 ${waiting - decisions.length} 条等这些处理后再列出。`
              : `这里列出 ${decisions.length} 条，另外 ${waiting - decisions.length} 条在知识里。`}
            {onBrowseAll === undefined ? null : (
              <button className="text-button" type="button" onClick={onBrowseAll}>
                在知识中查看全部
              </button>
            )}
          </p>
        ) : null}
      </section>

      {activeDecision === undefined ? null : (
        <ModalDialog
          title="补充决策理由"
          description={activeDecision.inVault === false ? "记录到知识库会写入 Obsidian；仅本机保留可稍后集中整理。" : "当前已在知识库；仅本机保留会转出 Obsidian，保存到本机。"}
          // Something written is let go of only by 取消: a stray Escape or click outside threw it away.
          dismissible={!saving}
          unsaved={rationale.trim().length > 0 || reasonFactors.length > 0}
          size="wide"
          // On the dialog, not its form: the footer's buttons sit outside the form, and ⌘↩ must work from them too.
          onKeyDown={(event) => {
            if (isPreferenceShortcut(event) && recordApi !== undefined) {
              event.preventDefault();
              if (!event.repeat && !saving) { setAsHistorical(false); setPreferenceId(activeDecision.id); }
              return;
            }
            if (isDismissShortcut(event)) {
              event.preventDefault();
              if (!event.repeat && !saving) { setSkipId(activeDecision.id); setError(null); }
              return;
            }
            if (isDeferShortcut(event) && continuous) {
              event.preventDefault();
              if (!event.repeat) postpone();
              return;
            }
            if (!isSubmitShortcut(event)) return;
            event.preventDefault();
            // Held down, the key comes again and again: the next one, opened by the first and its draft already in
            // it, was saved unread.
            if (event.repeat) return;
            // With factors alone ⌘↩ did nothing and said nothing, its button disabled out of the Tab order.
            if (!canSave) {
              setError("理由原文必填：写下当时为什么这样选，再保存。");
              rationaleInput.current?.focus();
              return;
            }
            void save();
          }}
          onClose={() => {
            setActiveId(null);
            setRationale("");
            setReasonFactors([]);
            setError(null);
          }}
          footer={
            <>
              {/* Not keeping it is apart, at the start, as in the rationale panel: not one in a row of buttons beside the
                  one that records it. */}
              <div className="modal-dialog-footer-start">
                <button
                  className="text-button danger-button"
                  type="button"
                  disabled={saving}
                  aria-haspopup="dialog"
                  aria-keyshortcuts={DISMISS_SHORTCUT_KEYS}
                  onClick={() => { setSkipId(activeDecision.id); setError(null); }}
                >
                  不保留
                  <kbd className="shortcut-hint" aria-hidden="true">{dismissShortcutLabel()}</kbd>
                </button>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  setActiveId(null);
                  setRationale("");
                  setReasonFactors([]);
                  setError(null);
                }}
              >
                {continuous ? "结束本轮" : "取消"}
              </button>
              {/* In a round the next decision takes this one's place, these buttons where they were: the second click
                  of a double-click acted on one shown a moment and never read, moving it out of Obsidian. Only a click
                  of its own acts. */}
              <div className="rationale-submit-actions" role="group" aria-label="处理当前决策">
                {recordApi === undefined ? null : (
                  <button className="secondary-button" type="button" disabled={saving} aria-keyshortcuts={PREFERENCE_SHORTCUT_KEYS} title="这不是一次决策，而是你的偏好：确认内容后保存为偏好记录" onClick={(event) => { if (event.detail > 1) return; setAsHistorical(false); setPreferenceId(activeDecision.id); }}>
                    记为偏好
                    <kbd className="shortcut-hint" aria-hidden="true">{preferenceShortcutLabel()}</kbd>
                  </button>
                )}
                {recordApi?.recordHistoricalDecision === undefined ? null : (
                  <button className="secondary-button" type="button" disabled={saving} title={HISTORICAL_TRIAGE_TITLE} onClick={(event) => { if (event.detail > 1) return; setAsHistorical(true); setPreferenceId(activeDecision.id); }}>
                    <ActionIcon name="history" />
                    记为历史决定
                  </button>
                )}
                {continuous ? (
                  <button className="secondary-button" type="button" disabled={saving} aria-keyshortcuts={DEFER_SHORTCUT_KEYS} title="先看下一条，这条仍留在待补理由" onClick={(event) => { if (event.detail > 1) return; postpone(); }}>
                    跳过
                    <kbd className="shortcut-hint" aria-hidden="true">{deferShortcutLabel()}</kbd>
                  </button>
                ) : null}
                <button className="secondary-button" type="button" disabled={saving} onClick={(event) => { if (event.detail > 1) return; void keepLocal(activeDecision.id); }}>仅本机保留</button>
                <button
                  className="primary-button"
                  type="submit"
                  form={`${idPrefix}-rationale-form`}
                  disabled={saving || !canSave}
                  aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
                  title={`${submitShortcutLabel()} 保存`}
                  // As beside it, not the second click of a double-click: cancelled, it does not submit the form.
                  onClick={(event) => { if (event.detail > 1) event.preventDefault(); }}
                >
                  {nextDecision !== undefined ? "记录到知识库并下一条" : "记录到知识库"}
                  <kbd className="shortcut-hint" aria-hidden="true">
                    {submitShortcutLabel()}
                  </kbd>
                </button>
              </div>
            </>
          }
        >
          <form
            id={`${idPrefix}-rationale-form`}
            className={`dashboard-rationale-dialog-form${continuous ? " is-continuous" : ""}`}
            aria-label="补充决策理由表单"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {continuous ? (
              <div className="rationale-session-progress">
                <span role="status">已处理 <strong>{processedIds.length}</strong> 条{postponedIds.length ? ` · 跳过 ${postponedIds.length} 条` : ""}</span>
                <progress
                  aria-label="本轮补充进度"
                  value={processedIds.length + postponedIds.length}
                  max={processedIds.length + batchDecisions.length}
                />
                <span>剩余 {batchDecisions.filter((decision) => !postponedIds.includes(decision.id)).length} 条</span>
              </div>
            ) : null}
            <div className="rationale-workspace">
              <section className="rationale-reference" aria-label="决策回顾">
                <div className="rationale-reference-meta">
                  <span>{activeDecision.project}</span>
                  <span>{sourceLabel(activeDecision.sourceClient)}</span>
                  <time dateTime={activeDecision.created}>{shortDate(activeDecision.created)}</time>
                </div>
                <header className="dashboard-rationale-question">
                  <h3 id={`${idPrefix}-active-question`} ref={questionTitleRef}>{plainHeadline(activeDecision.question)}</h3>
                </header>
                {questionCut ? (
                  <section className="dashboard-rationale-full-question" aria-labelledby={`${idPrefix}-full-question`}>
                    <h4 id={`${idPrefix}-full-question`}>问题</h4>
                    <div className="assistant-answer">{renderMarkdown(activeDecision.question)}</div>
                  </section>
                ) : null}
                {activeDecision.capturedQuestion === null ? (
                  <DecisionAnswerSummary
                    key={activeDecision.id}
                    selectedAnswer={activeDecision.selectedAnswer}
                    followedRecommendation={activeDecision.followedRecommendation === true}
                  />
                ) : (
                  <DecisionAnswerSummary
                    key={activeDecision.id}
                    question={activeDecision.capturedQuestion}
                  />
                )}
                <section
                  className="dashboard-rationale-context-detail"
                  aria-labelledby="dashboard-rationale-context-title"
                >
                  <h3 id="dashboard-rationale-context-title">当时上下文</h3>
                  {activeDecision.contextSummary === null ? <p>当时未保存上下文</p> : <CapturedText text={activeDecision.contextSummary} />}
                </section>
                <PastAnswers
                  question={activeDecision.question}
                  answer={activeDecision.selectedAnswer}
                  excludeId={activeDecision.id}
                  listDecisions={listDecisions}
                />
              </section>
              <section className="rationale-composer" aria-label="填写理由">
                <header className="dashboard-rationale-guidance">
                  <h3>补充判断依据</h3>
                  <p>写下当时的取舍，给未来的自己一个解释。理由原文必填，只选判断依据不能保存。</p>
                </header>
                <label htmlFor={`pending-${activeDecision.id}`}>
                  理由原文
                </label>
                <textarea
                  key={activeDecision.id}
                  ref={rationaleInput}
                  disabled={saving}
                  autoFocus
                  aria-required="true"
                  aria-describedby={`${idPrefix}-active-question`}
                  id={`pending-${activeDecision.id}`}
                  rows={5}
                  value={rationale}
                  placeholder="为什么选这个方案？当时最看重什么，又放弃了什么？"
                  onChange={(event) => setRationale(event.currentTarget.value)}
                />
                <fieldset className="factor-list">
                  <legend>判断依据（可多选）</legend>
                  {RATIONALE_FACTORS.map(([id, label]) => {
                    const selectedFactor = reasonFactors.includes(id);
                    return (
                      <button
                        type="button"
                        className={`factor-button${selectedFactor ? " selected" : ""}`}
                        key={id}
                        aria-pressed={selectedFactor}
                        disabled={saving}
                        onClick={() => toggleFactor(id)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </fieldset>
                {error === null ? null : (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
              </section>
            </div>
          </form>
        </ModalDialog>
      )}

      {recordApi !== undefined && activeDecision !== undefined && preferenceId === activeDecision.id ? (
        <ActiveRecordDialog
          api={recordApi}
          draft={asHistorical
            ? historicalDraft({
              question: activeDecision.question,
              answer: activeDecision.selectedAnswer,
              alternatives: activeDecision.capturedQuestion === null ? [] : partitionDecisionAnswers(activeDecision.capturedQuestion).alternatives.map((option) => option.label),
              project: activeDecision.project,
              context: activeDecision.contextSummary,
            })
            : preferenceDraft({
              question: activeDecision.question,
              answer: activeDecision.selectedAnswer,
              rationale,
              project: activeDecision.project,
              context: activeDecision.contextSummary,
            })}
          onClose={() => setPreferenceId(null)}
          onSaved={() => {
            setPreferenceId(null);
            // Written as a preference or a 历史决定, it is no decision to keep.
            void discard(activeDecision.id);
          }}
        />
      ) : null}

      {batchOpen ? (
        <ModalDialog
          title={batchAction === null ? "批量处理待补理由" : batchAction === "local" ? "仅本机保留所选决策？" : batchAction === "skip" ? "保留所选决策但不补理由？" : "不保留所选决策？"}
          description={batchAction === "discard" ? discardedWhere(selectedDecisions) : batchAction === "local" ? "保存在本机供集中整理；已在知识库的会转出 Obsidian。" : batchAction === "skip" ? "保留在知识库，不再为它补理由。" : "勾选要处理的决策，再选择处理方式。"}
          dismissible={!saving}
          onClose={() => { setBatchOpen(false); setError(null); }}
          size="wide"
          // Each step's buttons its own (keyed): kept and only relabelled, the one that steps in front took no focus.
          footer={batchAction === null ? (
            <Fragment key="choose">
              {/* Not keeping them is apart, at the start; the commonest way out, keeping them without a rationale, is the
                  one solid button. */}
              <div className="modal-dialog-footer-start">
                <button className="text-button danger-button" type="button" disabled={selectedDecisions.length === 0} onClick={() => setBatchAction("discard")}>不保留</button>
              </div>
              <button className="secondary-button" type="button" onClick={() => { setBatchOpen(false); setError(null); }}>取消</button>
              <button className="secondary-button" type="button" disabled={selectedDecisions.length === 0} onClick={() => setBatchAction("local")}>仅本机保留</button>
              <button className="primary-button" type="button" disabled={selectedDecisions.length === 0} onClick={() => setBatchAction("skip")}>记录到知识库（不补理由）</button>
            </Fragment>
          ) : (
            <Fragment key="confirm">
              {/* Going on to a deletion starts on the way back from it; the others on what was chosen. */}
              <button className="secondary-button" type="button" autoFocus={batchAction === "discard"} disabled={saving} onClick={() => { setBatchAction(null); setError(null); }}>返回选择</button>
              {/* In the place of the button pressed, which went with the step: left there, focus fell to the dialog itself.
                  There too the second click of a double-click on it landed, and confirmed what it asked about: only a
                  click of its own confirms. */}
              <button className={batchAction === "discard" ? "primary-button danger-button" : "primary-button"} type="button" autoFocus={batchAction !== "discard"} disabled={saving || selectedDecisions.length === 0} onClick={(event) => { if (event.detail > 1) return; void runBatch(); }}>
                {saving ? "正在处理…" : batchAction === "skip" ? `记录 ${selectedDecisions.length} 条到知识库` : batchAction === "local" ? `仅本机保留 ${selectedDecisions.length} 条` : `不保留 ${selectedDecisions.length} 条`}
              </button>
            </Fragment>
          )}
        >
          {batchAction === null ? (
            <label className="dashboard-rationale-batch-select dashboard-rationale-batch-all">
              <input type="checkbox" checked={batchDecisions.length > 0 && selectedDecisions.length === batchDecisions.length}
                onChange={(event) => setSelectedIds(event.target.checked ? batchDecisions.map((decision) => decision.id) : [])} />
              全选（已选 {selectedDecisions.length} / {batchDecisions.length}）
            </label>
          ) : null}
          <ul className="dashboard-rationale-batch-list">
            {(batchAction === null ? batchDecisions : selectedDecisions).map((decision) => (
              <li key={decision.id}>
                <label className="dashboard-rationale-batch-select">
                  {batchAction === null ? <input type="checkbox" checked={selectedIds.includes(decision.id)}
                    aria-label={`选择${plainHeadline(decision.question)}`}
                    onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, decision.id] : ids.filter((id) => id !== decision.id))} /> : null}
                  <span><strong>{plainHeadline(decision.question)}</strong><span>选择：{plainHeadline(decision.selectedAnswer)} · {decision.project}</span></span>
                </label>
              </li>
            ))}
          </ul>
          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          {saving ? <p className="dashboard-rationale-batch-progress" role="status">正在处理，请稍候…</p> : null}
        </ModalDialog>
      ) : null}

      {skipDecision === undefined ? null : (
        <ModalDialog
          title="不保留这条决策？"
          description={discardedWhere([skipDecision])}
          dismissible={!saving}
          onClose={() => {
            setSkipId(null);
            setError(null);
          }}
          // Held down from the dialog before it, the key is not this one's answer.
          onKeyDown={(event) => {
            if (!isSubmitShortcut(event)) return;
            event.preventDefault();
            if (!event.repeat && !saving) void discard(skipDecision.id);
          }}
          size="compact"
          // 取消 first and focused; the ways to keep it between; not keeping it, the one solid button, at the end
          // (画板「二级页面 · 确认与危险操作」).
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                aria-label="取消不保留决策"
                autoFocus
                disabled={saving}
                onClick={() => {
                  setSkipId(null);
                  setError(null);
                }}
              >
                取消
              </button>
              <button className="secondary-button" type="button" disabled={saving} onClick={() => void keepLocal(skipDecision.id)}>仅本机保留</button>
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={() => void skip(skipDecision.id)}
              >
                记录到知识库（不补理由）
              </button>
              <button
                className="primary-button danger-button"
                type="button"
                disabled={saving}
                // Only a click of its own confirms, not the second of a double-click on the 不保留 that asked.
                aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
                onClick={(event) => { if (event.detail > 1) return; void discard(skipDecision.id); }}
              >
                不保留
                <kbd className="shortcut-hint" aria-hidden="true">{submitShortcutLabel()}</kbd>
              </button>
            </>
          }
        >
          <p>如果只是无需补充理由，也可以保留决策，不再为它补理由。</p>
          <div className="modal-decision-summary">
            <strong>{plainHeadline(skipDecision.question)}</strong>
            <span>选择：{plainHeadline(skipDecision.selectedAnswer)}</span>
          </div>
          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </ModalDialog>
      )}
    </>
  );
};
