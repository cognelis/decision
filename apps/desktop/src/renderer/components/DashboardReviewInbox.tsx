import type { OutcomeVerdict } from "@cognelis/decision-core";
import { useEffect, useId, useRef, useState } from "react";

import type {
  DecisionLibraryItem,
  DecisionOutcomeReviewInput,
} from "../../shared/renderer-api.js";
import { dateAfter, dueLabel } from "../calendar-date.js";
import {
  isSubmitShortcut,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";
import { ModalDialog } from "./ModalDialog.js";

/**
 * The other dashboard todo — 待补理由 — is finished where it is listed. This
 * one used to be a link into the library, so closing the loop the app is built
 * around was the only todo that made you leave the page to do it.
 */
/**
 * What was being written in the dialog, and for which decision: kept by the app while the home page
 * is away. The decision itself is not kept: it is looked up again as it is now.
 */
export interface ReviewInboxDraft {
  id: string;
  outcome: string;
  lesson: string;
  verdict: OutcomeVerdict;
}

interface DashboardReviewInboxProps {
  decisions: DecisionLibraryItem[];
  unscheduled: DecisionLibraryItem[];
  loading: boolean;
  /** The list could not be read: not the same as nothing to review. */
  failed: boolean;
  onRetry(): void;
  onOpenDecision(id: string): void;
  onOpenReviewInbox(): void;
  /** `basis`: the note's hash when the review was opened; changed since (in Obsidian), the save is refused. */
  onSaveOutcome(id: string, outcome: string, basis?: string): Promise<void>;
  onSaveReview(
    id: string,
    input: DecisionOutcomeReviewInput,
    basis?: string,
  ): Promise<void>;
  onPostponeReview(id: string, reviewDueDate: string): Promise<void>;
  /** Whether a due review also sends a system notification (the "复盘提醒" setting). */
  remindersEnabled: boolean;
  /**
   * Where the dialog's draft is kept outside the page. A capture arriving takes the window over and
   * unmounts the home page; back on it, the dialog opens again as it was left.
   */
  drafts?: { inbox?: ReviewInboxDraft | undefined };
}

/**
 * A result that is not in yet is the commonest reason a due review sits here.
 * Without a way to say "not yet", the inbox only grows until it is ignored.
 */
const postponeOptions = [
  [7, "一周后"],
  [14, "两周后"],
  [30, "一个月后"],
] as const;

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const verdictOptions = Object.entries(verdictLabels) as Array<
  [OutcomeVerdict, string]
>;

const MAX_TEXT = 8_000;

/** What the next step on this decision is, which is also what it is listed as. */
const pendingStep = (decision: DecisionLibraryItem): "outcome" | "review" =>
  decision.outcome === null ? "outcome" : "review";

export const DashboardReviewInbox = ({
  decisions,
  unscheduled,
  loading,
  failed,
  onRetry,
  onOpenDecision,
  onOpenReviewInbox,
  onSaveOutcome,
  onSaveReview,
  onPostponeReview,
  remindersEnabled,
  drafts,
}: DashboardReviewInboxProps) => {
  const restored = drafts?.inbox;
  // Each row's 回填结果 / 完成复盘 says which decision it is for.
  const idPrefix = useId();
  const [active, setActive] = useState<DecisionLibraryItem | null>(null);
  const [outcome, setOutcome] = useState(restored?.outcome ?? "");
  const [verdict, setVerdict] = useState<OutcomeVerdict>(restored?.verdict ?? "as_expected");
  const [lesson, setLesson] = useState(restored?.lesson ?? "");
  // Reopened once the list is read, with the decision as it is now, and only while it still waits
  // here: what was done to it meanwhile, elsewhere, is not written over from an old copy.
  const reopening = useRef(restored?.id ?? null);
  useEffect(() => {
    // A list that could not be read says nothing of whether it still waits: kept for a read that can.
    // Taken as "no longer waiting", one busy read threw the outcome being written away.
    if (reopening.current === null || loading || failed) return;
    const waiting = decisions.find((decision) => decision.id === reopening.current);
    reopening.current = null;
    if (waiting !== undefined) {
      setActive(waiting);
      return;
    }
    setOutcome("");
    setLesson("");
    setVerdict("as_expected");
    if (drafts !== undefined) drafts.inbox = undefined;
  }, [decisions, drafts, failed, loading]);
  useEffect(() => {
    if (drafts === undefined || reopening.current !== null) return;
    drafts.inbox = active === null ? undefined : { id: active.id, outcome, lesson, verdict };
  }, [drafts, active, outcome, lesson, verdict]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The postponed item leaves the list, so say where it went.
  // Kept with the date it replaced, so a mistaken postpone is one click to undo.
  const [notice, setNotice] = useState<{ text: string; id: string; previous: string | null } | null>(null);
  const step = active === null ? null : pendingStep(active);

  const close = (): void => {
    setActive(null);
    setOutcome("");
    setLesson("");
    setVerdict("as_expected");
    setError(null);
  };

  const open = (decision: DecisionLibraryItem): void => {
    close();
    setNotice(null);
    setActive(decision);
  };

  const postpone = async (days: number): Promise<void> => {
    if (active === null || saving) return;
    const reviewDueDate = dateAfter(days);
    setSaving(true);
    setError(null);
    try {
      await onPostponeReview(active.id, reviewDueDate);
      close();
      // The date leads: a long question is what gets cut off, not when it comes back.
      setNotice({ text: `推迟到${dueLabel(reviewDueDate)}复盘：「${active.question}」`, id: active.id, previous: active.reviewDueDate });
    } catch (caught) {
      setError(
        `复盘日期暂时无法保存：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const save = async (continueReview = false): Promise<void> => {
    if (active === null || step === null || saving) return;
    if (step === "outcome" && outcome.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      if (step === "outcome") {
        await onSaveOutcome(active.id, outcome, ...(active.contentHash ? [active.contentHash] as const : [] as const));
      } else {
        await onSaveReview(active.id, {
          verdict,
          lesson: lesson.trim().length === 0 ? null : lesson,
        }, ...(active.contentHash ? [active.contentHash] as const : [] as const));
      }
      if (step === "outcome" && continueReview) {
        // Written, the note is a version this dialog has not read: its review is not checked against the old one.
        setActive({ ...active, outcome: outcome.trim(), contentHash: null });
      } else {
        close();
      }
    } catch (caught) {
      setError(
        `${step === "outcome" ? "结果" : "复盘"}暂时无法保存：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const canSave = step !== "outcome" || outcome.trim().length > 0;

  return (
    <>
      <section
        className="dashboard-card dashboard-review-inbox"
        aria-labelledby="dashboard-review-inbox-title"
      >
        <header className="dashboard-card-header">
          <div>
            <span>结果闭环</span>
            <h2 id="dashboard-review-inbox-title">复盘收件箱</h2>
          </div>
          <strong className={decisions.length === 0 ? "idle" : undefined}>
            {decisions.length}
          </strong>
        </header>
        {notice === null ? null : (
          <p className="dashboard-review-notice" role="status">
            <span>{notice.text}</span>
            {notice.previous === null ? null : (
              <button
                type="button"
                className="text-button"
                disabled={saving}
                onClick={() => {
                  const { id, previous } = notice;
                  setSaving(true);
                  void onPostponeReview(id, previous!)
                    .then(() => setNotice(null))
                    .catch(() =>
                      setNotice({ ...notice, text: `${notice.text}；撤销没有成功，请在决策详情里调整日期` }),
                    )
                    .finally(() => setSaving(false));
                }}
              >
                撤销
              </button>
            )}
          </p>
        )}
        {loading ? (
          <p className="dashboard-empty-copy">正在读取复盘计划…</p>
        ) : failed && decisions.length === 0 ? (
          <p className="dashboard-empty-copy" role="alert">
            复盘计划暂时无法读取。
            <button type="button" className="text-button" onClick={onRetry}>
              重试
            </button>
          </p>
        ) : decisions.length > 0 ? (
          <ol className="dashboard-review-list">
            {decisions.slice(0, 2).map((decision) => (
              <li key={decision.id}>
                <button
                  type="button"
                  className="dashboard-review-open"
                  onClick={() => onOpenDecision(decision.id)}
                >
                  <span>
                    <strong id={`${idPrefix}-${decision.id}`}>{decision.question}</strong>
                    <small>{decision.project}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
                <button
                  type="button"
                  className="text-button dashboard-review-act"
                  aria-haspopup="dialog"
                  aria-describedby={`${idPrefix}-${decision.id}`}
                  disabled={saving}
                  onClick={() => open(decision)}
                >
                  {pendingStep(decision) === "outcome"
                    ? "回填结果"
                    : "完成复盘"}
                </button>
              </li>
            ))}
          </ol>
        ) : unscheduled.length > 0 ? (
          <div className="dashboard-review-empty">
            <div>
              <strong>还没有安排复盘日期</strong>
              <span>
                先为最近的决策设定验证时间，避免记录停留在“做过选择”。
              </span>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={() => onOpenDecision(unscheduled[0]!.id)}
            >
              安排第一条
            </button>
          </div>
        ) : (
          <p className="dashboard-empty-copy">目前没有需要处理的复盘。</p>
        )}
        {decisions.length === 0 ? null : (
          <footer className="dashboard-review-footer">
            <span>
              {remindersEnabled
                ? "到期后，应用运行时会发一条系统通知，不会弹出窗口；可在设置里关闭。"
                : "复盘提醒已关闭，到期事项只在这里出现。"}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={onOpenReviewInbox}
            >
              查看全部
            </button>
          </footer>
        )}
      </section>

      {active === null || step === null ? null : (
        <ModalDialog
          title={step === "outcome" ? "回填实际结果" : "完成复盘"}
          description={
            step === "outcome"
              ? "保存实际结果后，可继续对照当初的选择完成复盘。"
              : "对照当初的选择给出结论"
          }
          // Something written is let go of only by 取消: a stray Escape or click outside threw it away.
          dismissible={!saving && outcome.trim().length === 0 && lesson.trim().length === 0}
          size="wide"
          onClose={close}
        >
          <form
            className="dashboard-review-dialog-form"
            aria-label={step === "outcome" ? "回填实际结果表单" : "完成复盘表单"}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            onKeyDown={(event) => {
              if (!isSubmitShortcut(event)) return;
              event.preventDefault();
              void save();
            }}
          >
            <header className="dashboard-rationale-question">
              <span>原问题</span>
              <h3>{active.question}</h3>
            </header>
            <div className="modal-decision-summary">
              <span>当初选择：{active.selectedAnswer}</span>
            </div>
            {active.expectedOutcome ? (
              <div className="modal-decision-summary">
                <span>预期结果：{active.expectedOutcome}</span>
              </div>
            ) : null}
            {step === "outcome" ? (
              <>
                <label htmlFor={`review-outcome-${active.id}`}>结果说明</label>
                <textarea
                  autoFocus
                  className="glass-input"
                  id={`review-outcome-${active.id}`}
                  maxLength={MAX_TEXT}
                  rows={5}
                  value={outcome}
                  disabled={saving}
                  placeholder="记录实施后的实际效果、偏差或新的结论。"
                  onChange={(event) => setOutcome(event.currentTarget.value)}
                />
                <span className="dashboard-review-counter">
                  {outcome.length} / {MAX_TEXT}
                </span>
                <div
                  className="dashboard-review-postpone"
                  role="group"
                  aria-label="还没有结果时推迟复盘"
                >
                  <span>还没有结果？推迟到</span>
                  {postponeOptions.map(([days, label]) => (
                    <button
                      key={days}
                      type="button"
                      className="text-button"
                      // Typed text means there is a result to save instead.
                      disabled={saving || outcome.trim().length > 0}
                      onClick={() => void postpone(days)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="modal-decision-summary">
                  <span>实际结果：{active.outcome}</span>
                </div>
                <fieldset className="decision-verdict-fieldset">
                  <legend>实际结果与当初选择相比</legend>
                  <div className="decision-verdict-options">
                    {verdictOptions.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={value}
                        aria-pressed={verdict === value}
                        disabled={saving}
                        onClick={() => setVerdict(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label htmlFor={`review-lesson-${active.id}`}>
                  复盘经验（可选）
                </label>
                <textarea
                  autoFocus
                  className="glass-input"
                  id={`review-lesson-${active.id}`}
                  maxLength={MAX_TEXT}
                  rows={5}
                  value={lesson}
                  disabled={saving}
                  placeholder="哪些判断有效、哪里出现偏差、下次应如何调整。"
                  onChange={(event) => setLesson(event.currentTarget.value)}
                />
                <span className="dashboard-review-counter">
                  {lesson.length} / {MAX_TEXT}
                </span>
              </>
            )}
            {error === null ? null : (
              <p className="dashboard-rationale-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-form-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={close}
              >
                取消
              </button>
              {step === "outcome" ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={saving || !canSave}
                  onClick={() => void save(true)}
                >
                  保存并继续复盘
                </button>
              ) : null}
              <button
                className={step === "outcome" ? "secondary-button" : "primary-button"}
                type="submit"
                disabled={saving || !canSave}
                aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
                title={`${submitShortcutLabel()} 保存`}
              >
                {step === "outcome" ? "保存结果" : "保存复盘"}
                <kbd className="shortcut-hint" aria-hidden="true">
                  {submitShortcutLabel()}
                </kbd>
              </button>
            </div>
          </form>
        </ModalDialog>
      )}
    </>
  );
};
