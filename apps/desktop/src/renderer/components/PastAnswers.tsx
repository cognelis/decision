import { useEffect, useState } from "react";

import type {
  DecisionApi,
  DecisionLibraryItem,
} from "../../shared/renderer-api.js";

import { verdictLabels } from "./pages/decisions/decision-markdown.js";
import {
  questionSearchText,
  sameQuestionAnswers,
  shortDate,
} from "./pages/decisions/SameQuestionDecisions.js";

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
  const [past, setPast] = useState<DecisionLibraryItem[]>([]);

  useEffect(() => {
    let active = true;
    setPast([]);
    const query = questionSearchText(question);
    if (query.length === 0) return;
    void listDecisions({ query, limit: 50 })
      .then((items) => {
        if (active) setPast(sameQuestionAnswers(items, question, excludeId));
      })
      .catch(() => {
        if (active) setPast([]);
      });
    return () => {
      active = false;
    };
  }, [excludeId, listDecisions, question]);

  if (past.length === 0) return null;
  // The one case worth saying outright: the last time this very answer was
  // reviewed, it went worse. An older miss since done better is not "last time".
  const lastReviewed = past.find(
    (item) =>
      item.selectedAnswer.trim() === answer.trim() && item.outcomeReview !== null,
  );
  const missed =
    lastReviewed?.outcomeReview?.verdict === "worse" ? lastReviewed : undefined;
  return (
    <section
      className="rationale-principle-recall rationale-past"
      aria-labelledby="rationale-past-title"
    >
      <div className="rationale-principle-heading">
        <div>
          <span className="rationale-principle-kicker">本地记录</span>
          <h3 id="rationale-past-title">以前也回答过这个问题</h3>
        </div>
        <small>{past.length} 次</small>
      </div>
      {missed === undefined ? null : (
        <p className="rationale-past-warning">
          上次同样选了「{missed.selectedAnswer}」，复盘结果低于预期。
        </p>
      )}
      <ol>
        {past.slice(0, 3).map((item) => (
          <li key={item.id}>
            <div>
              <time dateTime={item.created}>
                {shortDate(item.created)}
              </time>
              <strong>{item.selectedAnswer}</strong>
              <small>
                {item.selectedAnswer.trim() === answer.trim() ? "答案相同" : "答案不同"}
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
