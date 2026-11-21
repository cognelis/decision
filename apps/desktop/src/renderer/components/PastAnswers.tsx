import { useEffect, useState } from "react";

import type {
  DecisionApi,
  DecisionLibraryItem,
} from "../../shared/renderer-api.js";

import { ActionIcon } from "./IconButton.js";
import { verdictLabels } from "./pages/decisions/decision-markdown.js";
import {
  listSameQuestionAnswers,
  answerKey,
  questionKey,
  shortDate,
} from "./pages/decisions/SameQuestionDecisions.js";
import { plainHeadline } from "./question-title.js";

/**
 * The same question answered before, and how that turned out. Writing down
 * why is the last moment an earlier outcome can still change the reasoning.
 */
export const PastAnswers = ({
  question,
  answer,
  excludeId,
  listDecisions,
}: {
  question: string;
  answer: string;
  /** The decision being written about, if it is already recorded. */
  excludeId: string;
  listDecisions: DecisionApi["listDecisions"];
}) => {
  const [answers, setAnswers] = useState<DecisionLibraryItem[]>([]);

  useEffect(() => {
    let active = true;
    setAnswers([]);
    void listSameQuestionAnswers(listDecisions, question, "")
      .then((items) => {
        if (active) setAnswers(items);
      })
      .catch(() => {
        if (active) setAnswers([]);
      });
    return () => {
      active = false;
    };
  }, [excludeId, listDecisions, question]);

  const current = answers.find((item) => item.id === excludeId);
  const past = answers.filter((item) => item.id !== excludeId);
  if (past.length === 0) return null;
  // Compared as the retrospective compares answers: "loopback http" is the answer "Loopback HTTP".
  const sameAnswer = (item: DecisionLibraryItem): boolean => answerKey(item) === (current === undefined ? questionKey(answer) : answerKey(current));
  // The one case worth saying outright: the last time this very answer was
  // reviewed, it went worse. An older miss since done better is not "last time".
  const lastReviewed = past.find(
    (item) => sameAnswer(item) && item.outcomeReview !== null,
  );
  const missed =
    lastReviewed?.outcomeReview?.verdict === "worse" ? lastReviewed : undefined;
  return (
    <section
      className="rationale-principle-recall rationale-past"
      aria-labelledby="rationale-past-title"
    >
      <div className="rationale-principle-heading">
        <h2 id="rationale-past-title">以前也回答过这个问题</h2>
        <small>
          <span>本地记录</span>
          <span>{past.length} 次</span>
        </small>
      </div>
      {missed === undefined ? null : (
        <p className="rationale-past-warning">
          <ActionIcon name="warning" />
          上次同样选了「{plainHeadline(missed.selectedAnswer)}」，复盘结果低于预期。
        </p>
      )}
      <ol>
        {past.slice(0, 3).map((item) => (
          <li key={item.id}>
            <time dateTime={item.created}>
              {shortDate(item.created)}
            </time>
            <div>
              <strong>{plainHeadline(item.selectedAnswer)}</strong>
              <small>
                {sameAnswer(item) ? "答案相同" : "答案不同"}
              </small>
            </div>
            <p>
              {item.outcomeReview === null ? (
                <span>
                  {item.outcome === null ? "还没有实际结果" : "有结果，尚未复盘"}
                </span>
              ) : (
                <>
                  <em className={item.outcomeReview.verdict}>
                    {verdictLabels[item.outcomeReview.verdict]}
                  </em>
                  {item.outcomeReview.lesson === null ? null : (
                    <span>{item.outcomeReview.lesson}</span>
                  )}
                </>
              )}
            </p>
          </li>
        ))}
      </ol>
      {past.length > 3 ? (
        <small className="rationale-past-more">另有 {past.length - 3} 次</small>
      ) : null}
    </section>
  );
};
