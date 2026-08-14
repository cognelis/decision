import type {
  RationaleCandidate,
  RationaleSubmission,
} from "@cognelis/decision-core";
import { RATIONALE_FACTORS } from "@cognelis/decision-core/rationale-factors";
import { useEffect, useState } from "react";

import type {
  DecisionPrincipleSuggestion,
  DecisionPrincipleSuggestionInput,
} from "../../shared/renderer-api.js";

import { DecisionContext } from "./DecisionContext.js";

interface RationaleStepProps {
  candidate: RationaleCandidate;
  busy: boolean;
  getPrincipleSuggestions(
    input: DecisionPrincipleSuggestionInput,
  ): Promise<DecisionPrincipleSuggestion[]>;
  onSubmit(input: RationaleSubmission): Promise<void>;
}

export const selectedAnswerLabel = (
  candidate: RationaleCandidate,
): string => candidate.question.answer.values.join("、");

export const RationaleStep = ({
  candidate,
  busy,
  getPrincipleSuggestions,
  onSubmit,
}: RationaleStepProps) => {
  const [rationale, setRationale] = useState("");
  const [reasonFactors, setReasonFactors] = useState<string[]>([]);
  const [doNotRecord, setDoNotRecord] = useState(false);
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
  const selected = selectedAnswerLabel(candidate);

  useEffect(() => {
    let active = true;
    const context = [
      candidate.event.context?.taskBackground,
      candidate.event.context?.decisionFraming,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n");

    setRationale("");
    setReasonFactors([]);
    setDoNotRecord(false);
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

  const appliedPrinciples =
    selectedPrincipleIds.length === 0
      ? {}
      : { appliedPrincipleIds: selectedPrincipleIds };

  return (
    <section
      className="rationale-step"
      aria-labelledby="rationale-title"
    >
      <p className="eyebrow">原生答案 · {selected}</p>
      <h2 id="rationale-title">为什么这样选？</h2>
      <p className="supporting-copy">
        原生选择不会被改变；这里只记录你的判断依据。
      </p>

      <DecisionContext context={candidate.event.context} />

      {!doNotRecord ? (
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
                        <small>
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
      ) : null}

      <label className="record-toggle">
        <input
          type="checkbox"
          checked={doNotRecord}
          disabled={busy}
          onChange={(event) => {
            setDoNotRecord(event.target.checked);
          }}
        />
        <span>不记录此次决策</span>
      </label>

      {doNotRecord ? (
        <div className="rationale-actions no-record-actions">
          <button
            className="primary-button"
            disabled={busy}
            onClick={() =>
              void onSubmit({ status: "not_recorded" })
            }
          >
            不记录
          </button>
        </div>
      ) : (
        <>
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
            autoFocus
            rows={6}
            value={rationale}
            disabled={busy}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="也可以只选择上面的判断依据"
          />

          <div className="rationale-actions">
            <div className="rationale-submit-actions">
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void onSubmit({ status: "skipped", ...appliedPrinciples })
                }
              >
                跳过理由
              </button>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void onSubmit({ status: "deferred", ...appliedPrinciples })
                }
              >
                稍后处理
              </button>
              <button
                className="primary-button"
                disabled={busy || !canComplete}
                onClick={() =>
                  void onSubmit({
                    status: "captured",
                    ...(rationale.trim().length === 0
                      ? {}
                      : { rationale }),
                    ...(reasonFactors.length === 0
                      ? {}
                      : { reasonFactors }),
                    ...appliedPrinciples,
                  })
                }
              >
                完成
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
};
