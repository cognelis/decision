import type { CapturedQuestion } from "@cognelis/decision-protocol";
import { recommendationFollow } from "@cognelis/decision-core/recommendation";
import { useState } from "react";

import { renderInlineMarkdown, renderMarkdown } from "./pages/assistant/markdown.js";

const DEFAULT_ALTERNATIVE_LIMIT = 3;

/** An option's or answer's label as the assistant wrote it: emphasis and code, no blocks. */
export const AnswerLabel = ({ text }: { text: string }) => (
  <span className="inline-markdown">{renderInlineMarkdown(text)}</span>
);

/** An option's description as the assistant wrote it, which can run to a list. */
export const OptionDescription = ({ text }: { text: string }) => (
  <div className="assistant-answer option-description">{renderMarkdown(text)}</div>
);

export interface DecisionAnswerItem {
  key: string;
  label: string;
  description?: string;
}

/**
 * The one option an answer label names. A label two options share names
 * neither: marking the wrong one would mislead more than marking none.
 */
export const answerOptionIndex = (
  question: CapturedQuestion,
): ((label: string) => number | undefined) => {
  const optionIndexesByLabel = new Map<string, number[]>();
  question.options.forEach((option, index) => {
    const indexes = optionIndexesByLabel.get(option.label) ?? [];
    indexes.push(index);
    optionIndexesByLabel.set(option.label, indexes);
  });
  return (label) => {
    const matchingIndexes = optionIndexesByLabel.get(label) ?? [];
    return matchingIndexes.length === 1 ? matchingIndexes[0] : undefined;
  };
};

/** The reader's own words beside a picked option; a custom answer is those words already. */
export const answerReply = (question: CapturedQuestion): string | undefined =>
  question.answer.kind === "custom" ? undefined : question.answer.reply;

export const partitionDecisionAnswers = (
  question: CapturedQuestion,
): {
  selected: DecisionAnswerItem[];
  alternatives: DecisionAnswerItem[];
} => {
  const indexOf = answerOptionIndex(question);
  const matchedOptionIndexes = new Set<number>();
  const selected = question.answer.values.map(
    (label, index): DecisionAnswerItem => {
      const matchedIndex = indexOf(label);
      if (matchedIndex !== undefined) matchedOptionIndexes.add(matchedIndex);
      const option =
        matchedIndex === undefined ? undefined : question.options[matchedIndex];
      return {
        key: `selected-${index}-${option?.id ?? label}`,
        label,
        ...(option?.description === undefined
          ? {}
          : { description: option.description }),
      };
    },
  );
  const alternatives = question.options.flatMap(
    (option, index): DecisionAnswerItem[] =>
      matchedOptionIndexes.has(index)
        ? []
        : [
            {
              key: `alternative-${index}-${option.id ?? option.label}`,
              label: option.label,
              ...(option.description === undefined
                ? {}
                : { description: option.description }),
            },
          ],
  );
  return { selected, alternatives };
};

type DecisionAnswerSummaryProps =
  | { question: CapturedQuestion; selectedAnswer?: never }
  | { question?: never; selectedAnswer: string; followedRecommendation?: boolean };

export const DecisionAnswerSummary = (
  props: DecisionAnswerSummaryProps,
) => {
  const [expanded, setExpanded] = useState(false);
  const { selected, alternatives } =
    props.question === undefined
      ? {
          selected: [
            {
              key: "selected-fallback",
              label: props.selectedAnswer,
            },
          ],
          alternatives: [],
        }
      : partitionDecisionAnswers(props.question);
  const visibleAlternatives = expanded
    ? alternatives
    : alternatives.slice(0, DEFAULT_ALTERNATIVE_LIMIT);
  const hiddenCount = alternatives.length - DEFAULT_ALTERNATIVE_LIMIT;

  return (
    <div className="decision-answer-summary">
      <h2 className="decision-answer-title" id="rationale-title">
        已选答案
      </h2>
      <ul
        className="decision-answer-list"
        aria-label="已选答案"
        aria-describedby="decision-answer-note"
      >
        {selected.map((answer) => (
          <li className="decision-answer-item" key={answer.key}>
            <strong><AnswerLabel text={answer.label} /></strong>
            {answer.description === undefined ? null : (
              <OptionDescription text={answer.description} />
            )}
          </li>
        ))}
      </ul>
      {props.question === undefined || answerReply(props.question) === undefined ? null : (
        <p className="decision-answer-reply">
          原话：{answerReply(props.question)}
        </p>
      )}
      <p className="decision-answer-note" id="decision-answer-note">
        原生选择不会被改变；这里只补充判断依据。
      </p>
      {(props.question === undefined
        ? props.followedRecommendation === true
        : recommendationFollow(props.question.options, props.question.answer) ===
          "followed") ? (
        <p className="decision-answer-followed" id="decision-answer-followed">
          你选的是 agent 标为推荐的选项。理由写你自己的判断就好，不用转述 agent 的论证。
        </p>
      ) : null}

      {alternatives.length === 0 ? null : (
        <section
          className="decision-alternatives"
          aria-labelledby="decision-alternatives-title"
        >
          <h3 id="decision-alternatives-title">当时的其它候选</h3>
          <ul id="decision-alternatives-list" aria-label="当时的其它候选">
            {visibleAlternatives.map((option) => (
              <li key={option.key}>
                <strong><AnswerLabel text={option.label} /></strong>
                {option.description === undefined ? null : (
                  <OptionDescription text={option.description} />
                )}
              </li>
            ))}
          </ul>
          {hiddenCount <= 0 ? null : (
            <button
              type="button"
              className="text-button decision-alternatives-toggle"
              aria-controls="decision-alternatives-list"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "收起其它候选" : `展开其余 ${hiddenCount} 项`}
            </button>
          )}
        </section>
      )}
    </div>
  );
};
