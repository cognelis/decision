import type { CapturedDecisionCandidate } from "@cognelis/decision-protocol";
import { useEffect } from "react";

import { DecisionContext } from "./DecisionContext.js";
import { SourceBadge } from "./SourceBadge.js";

interface CandidateReviewProps {
  candidate: CapturedDecisionCandidate;
  position: number;
  total: number;
  busy: boolean;
  persistenceStatus: "saving" | "failed" | undefined;
  error: string | null;
  onClose(): void;
  onConfirm(): Promise<void>;
  onIgnore(): Promise<void>;
  onRetry(): Promise<void>;
}

export const CandidateReview = ({
  candidate,
  position,
  total,
  busy,
  persistenceStatus,
  error,
  onClose,
  onConfirm,
  onIgnore,
  onRetry,
}: CandidateReviewProps) => {
  const question = candidate.event.questions[0]!;
  const saving = busy || persistenceStatus === "saving";
  const decisionActionUnavailable = saving || persistenceStatus === "failed";
  const context = candidate.event.context;
  const taskContext =
    context?.taskBackground === undefined
      ? undefined
      : {
          taskBackground: context.taskBackground,
          ...(context.truncated === undefined
            ? {}
            : { truncated: context.truncated }),
        };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  return (
    <section
      className="desktop-view candidate-review"
      role="region"
      aria-label="待处理决策"
    >
      <header className="candidate-review-toolbar drag-region">
        <div className="origin-line">
          <SourceBadge source={candidate.event.sourceClient} />
          <span className="project-name">
            {candidate.event.project}
          </span>
          <span className="waiting-count">
            待处理 {position} / {total}
          </span>
        </div>
        <button
          type="button"
          className="text-button no-drag"
          disabled={saving}
          onClick={onClose}
        >
          稍后
        </button>
      </header>

      <section className="candidate-review-content">
        <section
          className="candidate-question"
          aria-labelledby="candidate-question"
        >
          <span>需要判断</span>
          <h1 id="candidate-question">{question.question}</h1>
        </section>

        {context?.decisionFraming === undefined ? null : (
          <section
            className="candidate-source"
            aria-labelledby="candidate-source-title"
          >
            <h2 id="candidate-source-title">原文</h2>
            <p>{context.decisionFraming}</p>
          </section>
        )}

        <section
          className="candidate-answer"
          aria-label="你的回答"
        >
          <span>你的回答</span>
          <strong>{question.answer.values.join("、")}</strong>
        </section>

        {question.options.length === 0 ? null : (
          <ul className="candidate-options" aria-label="相关选项">
            {question.options.map((option) => (
              <li key={option.id}>
                <strong>{option.label}</strong>
                {option.description === undefined ? null : (
                  <span>{option.description}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <DecisionContext context={taskContext} />

        {persistenceStatus === "failed" ? (
          <div className="candidate-persistence-error" role="alert">
            <p>
              候选状态暂时无法保存。可以重试，或点“稍后”退出，内容仍会保留。
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => void onRetry()}
            >
              重试
            </button>
          </div>
        ) : null}
        {error === null ? null : (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
      </section>

      <footer className="candidate-review-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={decisionActionUnavailable}
          onClick={() => void onIgnore()}
        >
          忽略
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={decisionActionUnavailable}
          onClick={() => void onConfirm()}
        >
          记录并补充理由
        </button>
      </footer>
    </section>
  );
};
