import type {
  RationaleCandidate,
  RationaleSubmission,
} from "@cognelis/decision-core";
import { RATIONALE_FACTORS } from "@cognelis/decision-core/rationale-factors";
import { useEffect, useRef, useState } from "react";

import type {
  DecisionApi,
  DecisionPrincipleSuggestion,
  DecisionPrincipleSuggestionInput,
} from "../../shared/renderer-api.js";
import {
  isSubmitShortcut,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";

import {
  DecisionAnswerSummary,
  partitionDecisionAnswers,
} from "./DecisionAnswerSummary.js";
import { DecisionContext } from "./DecisionContext.js";
import { keepDeferredRationale } from "./deferred-rationale-draft.js";
import { PastAnswers } from "./PastAnswers.js";

interface RationaleStepProps {
  candidate: RationaleCandidate;
  busy: boolean;
  getPrincipleSuggestions(
    input: DecisionPrincipleSuggestionInput,
  ): Promise<DecisionPrincipleSuggestion[]>;
  listDecisions: DecisionApi["listDecisions"];
  onSubmit(input: RationaleSubmission): Promise<void>;
}

export const selectedAnswerLabel = (
  candidate: RationaleCandidate,
): string => candidate.question.answer.values.join("、");

export const RationaleStep = ({
  candidate,
  busy,
  getPrincipleSuggestions,
  listDecisions,
  onSubmit,
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

  const submitCaptured = (allowEmpty = false): void => {
    if (busy || (!canComplete && !allowEmpty)) return;
    void onSubmit({
      status: canComplete ? "captured" : "skipped",
      ...(rationale.trim().length === 0 ? {} : { rationale }),
      ...(reasonFactors.length === 0 ? {} : { reasonFactors }),
      ...kept,
    });
  };
  const submitCapturedRef = useRef(submitCaptured);
  useEffect(() => {
    submitCapturedRef.current = submitCaptured;
  });

  // Cmd/Ctrl+Enter completes from anywhere in the rationale surface, so the
  // textarea, a factor chip or a principle can all be the last thing focused.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isSubmitShortcut(event)) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]') !== null
      ) {
        return;
      }
      event.preventDefault();
      submitCapturedRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <section
      className="rationale-step"
      aria-labelledby="rationale-title"
      aria-describedby="decision-answer-note"
    >
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

      <header className="rationale-guidance">
        <h2>补充判断依据</h2>
        <p>记录促成这次选择的因素，便于以后复盘。</p>
      </header>

      <section
        className="rationale-principle-recall"
        aria-labelledby="rationale-principles-title"
      >
        <div className="rationale-principle-heading">
          <div>
            <span className="rationale-principle-kicker">本地匹配</span>
            <h3 id="rationale-principles-title">核对相关原则</h3>
          </div>
          <small>选择已完成，仅用于核对依据</small>
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
        rows={6}
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

      <div className="rationale-actions">
        <button
          type="button"
          className="text-button rationale-discard"
          disabled={busy}
          onClick={() => void onSubmit({ status: "not_recorded" })}
        >
          不保留
        </button>
        <div className="rationale-submit-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void onSubmit({ status: "local_only", ...kept,
              ...(rationale.trim() ? { rationale } : {}), ...(reasonFactors.length ? { reasonFactors } : {}) })}
          >
            仅本机保留
          </button>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              // What was written so far waits with it, for 补充理由 on the home page, under the id that page lists
              // it by: under this run's queue id, it was never found there again.
              keepDeferredRationale(`decision-${candidate.candidateKey}`, { rationale, reasonFactors });
              void onSubmit({ status: "deferred", ...kept });
            }}
          >
            稍后处理
          </button>
          <button
            className="primary-button"
            disabled={busy}
            aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
            title={`${submitShortcutLabel()} 完成`}
            onClick={() => submitCaptured(true)}
          >
            记录到知识库
            <kbd className="shortcut-hint" aria-hidden="true">
              {submitShortcutLabel()}
            </kbd>
          </button>
        </div>
      </div>
    </section>
  );
};
