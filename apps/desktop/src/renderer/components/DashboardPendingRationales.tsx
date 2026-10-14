import { zonedFormatter } from "../calendar-date.js";
import { RATIONALE_FACTORS } from "@cognelis/decision-core/rationale-factors";
import { useEffect, useId, useRef, useState } from "react";

import type {
  DecisionApi,
  PendingRationaleSummary,
} from "../../shared/renderer-api.js";
import {
  isSubmitShortcut,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";
import { DecisionAnswerSummary } from "./DecisionAnswerSummary.js";
import { deferredRationale, dropDeferredRationale, forgetUnfiledDeferredRationales, keepDeferredRationale } from "./deferred-rationale-draft.js";
import { ActionIcon, IconButton } from "./IconButton.js";
import { ModalDialog } from "./ModalDialog.js";
import { PastAnswers } from "./PastAnswers.js";

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
  /**
   * Where the dialog's draft is kept outside the page. A capture arriving takes the window over and
   * unmounts the home page; back on it, the dialog opens again as it was left.
   */
  drafts?: { pending?: PendingRationaleDraft | undefined };
}

const HISTORICAL_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const sourceLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  manual: "手动记录",
  "pr-comment": "PR 评论",
  test: "Test",
};

const isHistorical = (created: string): boolean =>
  Date.now() - new Date(created).getTime() >= HISTORICAL_AGE_MS;

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
    try {
      for (const decision of selectedDecisions) {
        await (batchAction === "skip" ? onSkip(decision.id) : batchAction === "local" ? onKeepLocal(decision.id, {}) : onDiscard(decision.id));
        // Done with, as one at a time: kept, the words written before 稍后处理 outlived a decision not recorded.
        dropDeferredRationale(decision.id);
        completed += 1;
        setProcessedIds((ids) => [...ids, decision.id]);
        setSelectedIds((ids) => ids.filter((id) => id !== decision.id));
      }
      setBatchAction(null);
      setBatchOpen(false);
    } catch (caught) {
      // The main process refuses in whole sentences: their own 。 left "。。".
      const reason = (caught instanceof Error ? caught.message : String(caught)).replace(/[。.]$/u, "");
      setError(`已处理 ${completed} 条，其余尚未处理：${reason}。可重试剩余项。`);
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
            <span>待办</span>
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
                      <strong id={`${idPrefix}-question-${decision.id}`}>{decision.question}</strong>
                      {isHistorical(decision.created) ? (
                        <span className="dashboard-history-badge">历史</span>
                      ) : null}
                    </div>
                    <div className="dashboard-rationale-meta">
                      <span
                        className="dashboard-rationale-answer"
                        title={decision.selectedAnswer}
                      >
                        选择：{decision.selectedAnswer}
                      </span>
                      <span className="dashboard-rationale-project">
                        {decision.project}
                      </span>
                    </div>
                    <p className="dashboard-rationale-context">
                      <span className="dashboard-rationale-origin">
                        <span>
                          {sourceLabels[decision.sourceClient] ??
                            decision.sourceClient}
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
          dismissible={!saving && rationale.trim().length === 0 && reasonFactors.length === 0}
          size="wide"
          onClose={() => {
            setActiveId(null);
            setRationale("");
            setReasonFactors([]);
            setError(null);
          }}
        >
          <form
            className={`dashboard-rationale-dialog-form${continuous ? " is-continuous" : ""}`}
            aria-label="补充决策理由表单"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            onKeyDown={(event) => {
              if (!isSubmitShortcut(event)) return;
              event.preventDefault();
              // With factors alone ⌘↩ did nothing and said nothing, its button disabled out of the Tab order.
              if (!canSave) {
                setError("理由原文必填：写下当时为什么这样选，再保存。");
                rationaleInput.current?.focus();
                return;
              }
              void save();
            }}
          >
            {continuous ? (
              <div className="rationale-session-progress">
                <span role="status">已处理 <strong>{processedIds.length}</strong> 条{postponedIds.length ? ` · 稍后 ${postponedIds.length} 条` : ""}</span>
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
                  <span>{sourceLabels[activeDecision.sourceClient] ?? activeDecision.sourceClient}</span>
                  <time dateTime={activeDecision.created}>{shortDate(activeDecision.created)}</time>
                </div>
                <header className="dashboard-rationale-question">
                  <h3 id={`${idPrefix}-active-question`}>{activeDecision.question}</h3>
                </header>
                {activeDecision.capturedQuestion === null ? (
                  <DecisionAnswerSummary
                    key={activeDecision.id}
                    selectedAnswer={activeDecision.selectedAnswer}
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
                  <p>
                    {activeDecision.contextSummary ?? "当时未保存上下文"}
                  </p>
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
                  className="glass-input"
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
                  <p className="dashboard-rationale-error" role="alert">
                    {error}
                  </p>
                )}
              </section>
            </div>
            <div className="modal-form-actions rationale-workspace-actions">
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
              <div className="rationale-submit-actions" role="group" aria-label="处理当前决策">
                {continuous ? <button className="secondary-button" type="button" disabled={saving} onClick={postpone}>稍后</button> : null}
                <button className="secondary-button" type="button" disabled={saving} onClick={() => void keepLocal(activeDecision.id)}>仅本机保留</button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving}
                  onClick={() => { setSkipId(activeDecision.id); setError(null); }}
                >
                  不保留
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={saving || !canSave}
                  aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
                  title={`${submitShortcutLabel()} 保存`}
                >
                  {nextDecision !== undefined ? "记录到知识库并下一条" : "记录到知识库"}
                  <kbd className="shortcut-hint" aria-hidden="true">
                    {submitShortcutLabel()}
                  </kbd>
                </button>
              </div>
            </div>
          </form>
        </ModalDialog>
      )}

      {batchOpen ? (
        <ModalDialog
          title={batchAction === null ? "批量处理待补理由" : batchAction === "local" ? "仅本机保留所选决策？" : batchAction === "skip" ? "保留所选决策但不补理由？" : "不保留所选决策？"}
          description={batchAction === "discard" ? discardedWhere(selectedDecisions) : batchAction === "local" ? "保存在本机供集中整理；已在知识库的会转出 Obsidian。" : "保留在知识库，仅结束补理由待办"}
          dismissible={!saving}
          onClose={() => { setBatchOpen(false); setError(null); }}
          size="wide"
        >
          {batchAction === null ? (
            <label className="dashboard-rationale-batch-select">
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
                    aria-label={`选择${decision.question}`}
                    onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, decision.id] : ids.filter((id) => id !== decision.id))} /> : null}
                  <span><strong>{decision.question}</strong><span>选择：{decision.selectedAnswer} · {decision.project}</span></span>
                </label>
              </li>
            ))}
          </ul>
          {error === null ? null : <p className="dashboard-rationale-error" role="alert">{error}</p>}
          {saving ? <p role="status">正在处理，请稍候…</p> : null}
          <div className="modal-form-actions">
            <button className="secondary-button" type="button" disabled={saving} onClick={() => {
              if (batchAction === null) setBatchOpen(false);
              else setBatchAction(null);
              setError(null);
            }}>{batchAction === null ? "取消" : "返回选择"}</button>
            {batchAction === null ? <>
              <button className="secondary-button" type="button" disabled={selectedDecisions.length === 0} onClick={() => setBatchAction("local")}>仅本机保留</button>
              <button className="secondary-button" type="button" disabled={selectedDecisions.length === 0} onClick={() => setBatchAction("skip")}>记录到知识库（不补理由）</button>
              <button className="secondary-button" type="button" disabled={selectedDecisions.length === 0} onClick={() => setBatchAction("discard")}>不保留</button>
            </> : (
              // In the place of the button pressed, which went with the step: left there, focus fell to the dialog itself.
              <button className="primary-button" type="button" autoFocus disabled={saving || selectedDecisions.length === 0} onClick={() => void runBatch()}>
                {batchAction === "skip" ? "确认记录到知识库（不补理由）" : batchAction === "local" ? "确认仅本机保留" : "确认不保留"}（{selectedDecisions.length} 条）
              </button>
            )}
          </div>
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
          size="compact"
        >
          <div className="modal-decision-summary">
            <strong>{skipDecision.question}</strong>
            <span>选择：{skipDecision.selectedAnswer}</span>
          </div>
          <p className="dashboard-rationale-confirm-copy">
            如果只是无需补充理由，也可以保留决策并结束这项待办。
          </p>
          {error === null ? null : (
            <p className="dashboard-rationale-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-form-actions">
            <button className="secondary-button" type="button" disabled={saving} onClick={() => void keepLocal(skipDecision.id)}>仅本机保留</button>
            <button
              className="secondary-button"
              type="button"
              aria-label="取消不保留决策"
              disabled={saving}
              onClick={() => {
                setSkipId(null);
                setError(null);
              }}
            >
              取消
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => void skip(skipDecision.id)}
            >
              记录到知识库（不补理由）
            </button>
            <button
              className="primary-button dashboard-rationale-discard-confirm"
              type="button"
              disabled={saving}
              onClick={() => void discard(skipDecision.id)}
            >
              确认不保留
            </button>
          </div>
        </ModalDialog>
      )}
    </>
  );
};
