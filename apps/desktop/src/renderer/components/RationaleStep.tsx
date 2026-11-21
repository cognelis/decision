import type {
  RationaleCandidate,
  RationaleSubmission,
} from "@cognelis/decision-core";
import { RATIONALE_FACTORS } from "@cognelis/decision-core/rationale-factors";
import { useEffect, useState } from "react";

import type {
  DecisionApi,
  DecisionPrincipleSuggestion,
  DecisionPrincipleSuggestionInput,
} from "../../shared/renderer-api.js";
import {
  DEFER_SHORTCUT_KEYS,
  deferShortcutLabel,
  PREFERENCE_SHORTCUT_KEYS,
  preferenceShortcutLabel,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";

import {
  DecisionAnswerSummary,
  partitionDecisionAnswers,
} from "./DecisionAnswerSummary.js";
import { DecisionContext } from "./DecisionContext.js";
import { keepDeferredRationale } from "./deferred-rationale-draft.js";
import { ActionIcon } from "./IconButton.js";
import { PastAnswers } from "./PastAnswers.js";
import { renderMarkdown } from "./pages/assistant/markdown.js";
import { ActiveRecordDialog, type ActiveRecordApi } from "./pages/decisions/ActiveRecordDialog.js";
import { HISTORICAL_TRIAGE_TITLE, historicalDraft, preferenceDraft, TaskAction, TaskActionBar, TaskDismissAction, TaskDismissDialog, useTaskShortcuts } from "./TaskActions.js";

interface RationaleStepProps {
  candidate: RationaleCandidate;
  busy: boolean;
  /** Why the last action on it failed: said above the action bar, where it was pressed. */
  error?: string | null;
  /** The page title cut the question short, or flattened its lists: it is given whole, as written, first. */
  getPrincipleSuggestions(
    input: DecisionPrincipleSuggestionInput,
  ): Promise<DecisionPrincipleSuggestion[]>;
  listDecisions: DecisionApi["listDecisions"];
  recordApi: ActiveRecordApi;
  onSubmit(input: RationaleSubmission): Promise<void>;
  /**
   * Taken by one of the bar's actions and being carried out: what was written stays in sight, its fields and actions
   * still (what is only read, the full context or the other options, still opens), the bar saying what is under way.
   */
  saving?: boolean;
}

const savingLines: Record<RationaleSubmission["status"], string> = {
  captured: "正在写入 Obsidian…",
  skipped: "正在写入 Obsidian…",
  local_only: "正在保存到本机…",
  deferred: "正在留到稍后处理…",
  not_recorded: "正在处理…",
};

export const selectedAnswerLabel = (
  candidate: RationaleCandidate,
): string => candidate.question.answer.values.join("、");

export const RationaleStep = ({
  candidate,
  busy,
  error = null,
  getPrincipleSuggestions,
  listDecisions,
  recordApi,
  onSubmit,
  saving = false,
}: RationaleStepProps) => {
  const [rationale, setRationale] = useState("");
  const [expectedOutcome, setExpectedOutcome] = useState("");
  const [reasonFactors, setReasonFactors] = useState<string[]>([]);
  const [principleSuggestions, setPrincipleSuggestions] = useState<
    DecisionPrincipleSuggestion[]
  >([]);
  const [selectedPrincipleIds, setSelectedPrincipleIds] = useState<string[]>(
    [],
  );
  const [principlesLoading, setPrinciplesLoading] = useState(true);
  const [principlesUnavailable, setPrinciplesUnavailable] = useState(false);
  const [deferError, setDeferError] = useState<string | null>(null);
  const canComplete =
    rationale.trim().length > 0 ||
    reasonFactors.length > 0 ||
    selectedPrincipleIds.length > 0;
  useEffect(() => {
    let active = true;
    const context = [
      candidate.event.context?.taskBackground,
      candidate.event.context?.decisionFraming,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n");

    setRationale("");
    setExpectedOutcome("");
    setReasonFactors([]);
    setPrincipleSuggestions([]);
    setSelectedPrincipleIds([]);
    setPrinciplesLoading(true);
    setPrinciplesUnavailable(false);
    setDeferError(null);
    void getPrincipleSuggestions({
      question: candidate.question.question,
      selectedAnswer: selectedAnswerLabel(candidate),
      optionLabels: candidate.question.options.map((option) => option.label),
      context: context.length === 0 ? null : context,
    })
      .then((suggestions) => {
        if (active) setPrincipleSuggestions(suggestions);
      })
      .catch(() => {
        if (active) setPrinciplesUnavailable(true);
      })
      .finally(() => {
        if (active) setPrinciplesLoading(false);
      });

    return () => {
      active = false;
    };
  }, [candidate.candidateId, getPrincipleSuggestions]);

  const toggleFactor = (factor: string): void => {
    setReasonFactors((current) =>
      current.includes(factor)
        ? current.filter((item) => item !== factor)
        : [...current, factor],
    );
  };

  const togglePrinciple = (principleId: string): void => {
    setSelectedPrincipleIds((current) =>
      current.includes(principleId)
        ? current.filter((id) => id !== principleId)
        : [...current, principleId],
    );
  };

  // A single chosen option's own description often says what it should achieve:
  // a starting point for the expectation, never filled in without asking.
  const selectedAnswers = partitionDecisionAnswers(candidate.question).selected;
  const optionDraft =
    selectedAnswers.length === 1
      ? selectedAnswers[0]?.description?.trim() || undefined
      : undefined;

  // What is kept however the rationale goes: the principles marked, and an
  // expectation already written, which is only as good as it is early.
  const kept = {
    ...(selectedPrincipleIds.length === 0
      ? {}
      : { appliedPrincipleIds: selectedPrincipleIds }),
    ...(expectedOutcome.trim().length === 0
      ? {}
      : { expectedOutcome: expectedOutcome.trim() }),
  };

  // Which of the bar's actions was taken: said while it is carried out, not "written to Obsidian" for every one of them.
  const [submitted, setSubmitted] = useState<RationaleSubmission["status"] | null>(null);
  // Whatever is tried next, what 稍后处理 could not do is no longer the news: left up, it hid why this one failed.
  const submit = (input: RationaleSubmission): Promise<void> => {
    setDeferError(null);
    setSubmitted(input.status);
    return onSubmit(input);
  };
  const submitCaptured = (allowEmpty = false): void => {
    if (busy || (!canComplete && !allowEmpty)) return;
    void submit({
      status: canComplete ? "captured" : "skipped",
      ...(rationale.trim().length === 0 ? {} : { rationale }),
      ...(reasonFactors.length === 0 ? {} : { reasonFactors }),
      ...kept,
    });
  };
  const deferRationale = (): void => {
    if (busy) return;
    // What was written so far waits with it, for 补充理由 on the home page, under the id that page lists
    // it by: under this run's queue id, it was never found there again. Kept nowhere else, it is not put off
    // without it: storage full, it was put off all the same and gone, and that dialog opened blank.
    if (!keepDeferredRationale(`decision-${candidate.candidateKey}`, { rationale, reasonFactors })) {
      setDeferError("已写的理由暂时无法保存在本机，这一条没有推迟；请重试，或直接记录到知识库。");
      return;
    }
    void submit({ status: "deferred", ...kept });
  };
  // Which record this choice is being written as instead of a decision: a preference, or a 历史决定.
  const [recordingPreference, setRecordingPreference] = useState<false | "preference" | "historical">(false);
  const recordPreference = (): void => {
    if (!busy) setRecordingPreference("preference");
  };

  const [askingToDiscard, setAskingToDiscard] = useState(false);
  const askToDiscard = (): void => {
    if (!busy) setAskingToDiscard(true);
  };

  // From anywhere in the rationale surface, so the textarea, a factor chip or a principle can all be the last thing focused.
  useTaskShortcuts({ submit: submitCaptured, skip: deferRationale, preference: recordPreference, dismiss: askToDiscard });

  return (
    <section
      className="rationale-step"
      aria-labelledby="rationale-title"
      aria-describedby="decision-answer-note"
    >
      {/* What was chosen and why it came up on one side, the basis to add on the other; one column when narrow. */}
      <div className="rationale-columns">
        <div className="rationale-reference-column">
          <section className="candidate-question rationale-full-question" aria-labelledby="rationale-question-title">
            <h2 id="rationale-question-title">问题</h2>
            <div className="assistant-answer" id="rationale-question-text">{renderMarkdown(candidate.question.question)}</div>
          </section>
          <DecisionAnswerSummary
            key={candidate.candidateId}
            question={candidate.question}
          />

          <DecisionContext context={candidate.event.context} />

          <PastAnswers
            question={candidate.question.question}
            answer={selectedAnswerLabel(candidate)}
            excludeId={candidate.candidateId}
            listDecisions={listDecisions}
          />
        </div>

        <section
          className="rationale-basis"
          aria-labelledby="rationale-basis-title"
        >
          <header className="rationale-guidance">
            <h2 id="rationale-basis-title">补充判断依据</h2>
            <p>记录促成这次选择的因素，便于以后复盘。</p>
          </header>

          <section
            className="rationale-principle-recall"
            aria-labelledby="rationale-principles-title"
          >
            <div className="rationale-principle-heading">
              <h3 id="rationale-principles-title">核对相关原则</h3>
              <small>
                <span>本地匹配</span>
                <span>选择已完成，仅用于核对依据</span>
              </small>
            </div>

            {principlesLoading ? (
              <p className="rationale-principle-status" role="status">
                正在核对已采纳原则…
              </p>
            ) : principlesUnavailable ? (
              <p className="rationale-principle-status warning" role="status">
                相关原则暂时无法读取，不影响记录理由。
              </p>
            ) : principleSuggestions.length === 0 ? (
              <p className="rationale-principle-status">
                没有足够明确的相关原则，不会强行推荐。
              </p>
            ) : (
              <>
                <div className="rationale-principle-list">
                  {principleSuggestions.map((suggestion) => {
                    const principleSelected = selectedPrincipleIds.includes(
                      suggestion.id,
                    );
                    return (
                      <button
                        key={suggestion.id}
                        type="button"
                        className={`rationale-principle-option${
                          principleSelected ? " selected" : ""
                        }`}
                        aria-pressed={principleSelected}
                        disabled={busy}
                        onClick={() => togglePrinciple(suggestion.id)}
                      >
                        <span className="rationale-principle-option-topline">
                          <strong>{suggestion.title}</strong>
                          <small className={suggestion.strength}>
                            {suggestion.strength === "strong"
                              ? "较相关"
                              : "可核对"}
                          </small>
                        </span>
                        <span>{suggestion.principle}</span>
                        <em>{suggestion.reason}</em>
                      </button>
                    );
                  })}
                </div>
                <p className="rationale-principle-note">
                  {selectedPrincipleIds.length === 0
                    ? "只有你明确标记的原则才会随决策保存。"
                    : `已标记 ${selectedPrincipleIds.length} 条，将随决策保存。`}
                </p>
                {selectedPrincipleIds.length > 0 ? (
                  <details className="rationale-principle-boundaries">
                    <summary>核对适用条件与边界</summary>
                    {principleSuggestions
                      .filter((suggestion) =>
                        selectedPrincipleIds.includes(suggestion.id),
                      )
                      .map((suggestion) => (
                        <div key={suggestion.id}>
                          <strong>{suggestion.title}</strong>
                          <span>适用：{suggestion.appliesWhen}</span>
                          <span>注意：{suggestion.caution}</span>
                        </div>
                      ))}
                  </details>
                ) : null}
              </>
            )}
          </section>

          <fieldset className="factor-list">
            <legend>判断依据（可多选）</legend>
            {RATIONALE_FACTORS.map(([id, label]) => {
              const selectedFactor = reasonFactors.includes(id);
              return (
                <button
                  type="button"
                  className={`factor-button${
                    selectedFactor ? " selected" : ""
                  }`}
                  key={id}
                  aria-pressed={selectedFactor}
                  disabled={busy}
                  onClick={() => toggleFactor(id)}
                >
                  {label}
                </button>
              );
            })}
          </fieldset>

          <label className="rationale-label" htmlFor="rationale">
            补充说明（可选）
          </label>
          <textarea
            className="glass-input"
            id="rationale"
            rows={4}
            value={rationale}
            disabled={busy}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="也可以只选择上面的判断依据"
          />

          {/* Now, not after the fact: an expectation written later is coloured by what happened. */}
          <div className="rationale-expected-heading">
            <label className="rationale-label" htmlFor="rationale-expected">
              预期结果（可选）
            </label>
            {optionDraft === undefined || expectedOutcome.trim().length > 0 ? null : (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setExpectedOutcome(optionDraft)}
              >
                <ActionIcon name="edit" />
                用所选方案的说明起稿
              </button>
            )}
          </div>
          <textarea
            className="glass-input"
            id="rationale-expected"
            rows={2}
            maxLength={4_000}
            value={expectedOutcome}
            disabled={busy}
            onChange={(event) => setExpectedOutcome(event.target.value)}
            placeholder="做完之后预期会看到什么；复盘时拿它对照实际结果"
          />
        </section>
      </div>

      {/* Said right above the bar its action was pressed in, not under it on the window's last line. */}
      {deferError === null && error === null ? null : (
        <p className="form-error rationale-step-error" role="alert">
          {deferError ?? error}
        </p>
      )}
      {/* Every answer to the page in one bar, the main one first and not keeping it last, as on 待处理. */}
      <TaskActionBar>
        <TaskAction
          primary
          label="记录到知识库"
          disabled={busy}
          title={`${submitShortcutLabel()} 完成`}
          shortcut={{ keys: SUBMIT_SHORTCUT_KEYS, label: submitShortcutLabel() }}
          onAct={() => submitCaptured(true)}
        />
        {recordApi.recordHistoricalDecision === undefined ? null : (
          <TaskAction
            label="记为历史决定"
            icon="history"
            disabled={busy}
            title={HISTORICAL_TRIAGE_TITLE}
            onAct={() => { if (!busy) setRecordingPreference("historical"); }}
          />
        )}
        <TaskAction
          label="记为偏好"
          disabled={busy}
          title="这不是一次决策，而是你的偏好：确认内容后保存为偏好记录"
          shortcut={{ keys: PREFERENCE_SHORTCUT_KEYS, label: preferenceShortcutLabel() }}
          onAct={recordPreference}
        />
        <TaskAction
          label="跳过"
          disabled={busy}
          title="先看下一条，这条留在首页待补理由"
          shortcut={{ keys: DEFER_SHORTCUT_KEYS, label: deferShortcutLabel() }}
          onAct={deferRationale}
        />
        <TaskAction
          label="仅本机保留"
          disabled={busy}
          onAct={() => void submit({ status: "local_only", ...kept,
            ...(rationale.trim() ? { rationale } : {}), ...(reasonFactors.length ? { reasonFactors } : {}) })}
        />
        {saving ? (
          <p className="status-line" role="status">{submitted === null ? "正在保存…" : savingLines[submitted]}</p>
        ) : (
          <TaskDismissAction label="不保留" disabled={busy} onAct={askToDiscard} />
        )}
      </TaskActionBar>
      {askingToDiscard ? (
        <TaskDismissDialog
          title="不保留这条决策？"
          description="这条决策和这里写下的内容都不会保留。"
          question={candidate.question.question}
          confirmLabel="不保留"
          onCancel={() => setAskingToDiscard(false)}
          onConfirm={() => {
            setAskingToDiscard(false);
            void submit({ status: "not_recorded" });
          }}
        />
      ) : null}
      {recordingPreference ? (
        <ActiveRecordDialog
          api={recordApi}
          draft={recordingPreference === "historical"
            ? historicalDraft({
              question: candidate.question.question,
              answer: selectedAnswerLabel(candidate),
              alternatives: partitionDecisionAnswers(candidate.question).alternatives.map((option) => option.label),
              project: candidate.event.project,
              context: candidate.event.context?.decisionFraming ?? candidate.event.context?.taskBackground,
            })
            : preferenceDraft({
              question: candidate.question.question,
              answer: selectedAnswerLabel(candidate),
              rationale,
              project: candidate.event.project,
              context: candidate.event.context?.decisionFraming ?? candidate.event.context?.taskBackground,
            })}
          onClose={() => setRecordingPreference(false)}
          onSaved={() => {
            setRecordingPreference(false);
            // Written as a preference or a 历史决定, it is no decision to keep.
            void submit({ status: "not_recorded" });
          }}
        />
      ) : null}
    </section>
  );
};
