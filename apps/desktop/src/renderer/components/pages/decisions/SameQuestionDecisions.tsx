import { zonedFormatter } from "../../../calendar-date.js";
import { clipText } from "@cognelis/decision-protocol";
import { useEffect, useState } from "react";

import type {
  DecisionApi,
  DecisionLibraryItem,
} from "../../../../shared/renderer-api.js";

import { verdictLabels } from "./decision-markdown.js";

/**
 * Same normalization as the retrospective's repeated questions in the main
 * process: width, case, spacing and closing punctuation do not make a
 * different question.
 */
export const questionKey = (question: string): string =>
  question
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[?!.。]+$/u, "");

/**
 * The words to search with: the question without its closing punctuation, and no longer than the 200
 * characters a search takes. Longer, the search was refused, and a long question showed no history.
 */
export const questionSearchText = (question: string): string =>
  clipText(
    question
      .trim()
      .replace(/[?？!！.。\s]+$/u, "")
      // Writings of one question differ in the space between Chinese and
      // Latin words; searched apart, the words find every writing.
      .replace(/(?<=\p{Script=Han})(?=[A-Za-z0-9])|(?<=[A-Za-z0-9])(?=\p{Script=Han})/gu, " "),
    200,
  ).trimEnd();

/**
 * The other decisions of the same question among search results, newest first: the search ranks
 * by relevance, which among answers to one question says nothing, and "latest" is what is shown.
 */
export const sameQuestionAnswers = (
  items: readonly DecisionLibraryItem[],
  question: string,
  excludeId: string,
): DecisionLibraryItem[] => {
  const key = questionKey(question);
  return items
    .filter((item) => item.id !== excludeId && questionKey(item.question) === key)
    .sort((left, right) => right.created.localeCompare(left.created));
};

const dayFormatter = zonedFormatter({
  month: "short",
  day: "numeric",
});

const yearDayFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
});

// Side columns and panels are narrow: the year only when it is not this one.
export const shortDate = (created: string): string => {
  const date = new Date(created);
  return date.getFullYear() === new Date().getFullYear()
    ? dayFormatter.format(date)
    : yearDayFormatter.format(date);
};

/**
 * Other times this exact question was decided. Seeing an earlier answer next
 * to this one is how a changed mind, or a principle still missing, shows up.
 */
export const SameQuestionDecisions = ({
  api,
  decision,
  onOpen,
}: {
  api: Pick<DecisionApi, "listDecisions">;
  decision: DecisionLibraryItem;
  onOpen(item: DecisionLibraryItem): void;
}) => {
  const [others, setOthers] = useState<DecisionLibraryItem[]>([]);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let active = true;
    const query = questionSearchText(decision.question);
    setAll(false);
    // Stepped to another decision, the last one's are not its own: kept until the new read landed, they were listed
    // under this one, compared with its answer, and a click opened the last decision's sibling.
    setOthers([]);
    if (query.length === 0) return;
    void api
      .listDecisions({ query, limit: 50 })
      .then((items) => {
        if (!active) return;
        setOthers(sameQuestionAnswers(items, decision.question, decision.id));
      })
      .catch(() => {
        if (active) setOthers([]);
      });
    return () => {
      active = false;
    };
  }, [api, decision.id, decision.question]);

  if (others.length === 0) return null;
  return (
    <section
      className="decision-same-question"
      aria-labelledby="decision-same-question-title"
    >
      <h4 id="decision-same-question-title">同一问题的其它决定 · {others.length}</h4>
      <ol>
        {(all ? others : others.slice(0, 3)).map((item) => (
          <li key={item.id}>
            <button type="button" onClick={() => onOpen(item)}>
              <strong>{item.selectedAnswer}</strong>
              <small>
                {item.project} · {shortDate(item.created)}
                {item.selectedAnswer.trim() === decision.selectedAnswer.trim()
                  ? " · 答案相同"
                  : " · 答案不同"}
                {item.outcomeReview === null ? null : (
                  <>
                    {" · "}
                    <em className={item.outcomeReview.verdict}>
                      {verdictLabels[item.outcomeReview.verdict]}
                    </em>
                  </>
                )}
              </small>
            </button>
          </li>
        ))}
      </ol>
      {others.length > 3 ? (
        <button type="button" className="decision-same-question-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "收起" : `另有 ${others.length - 3} 次，全部显示`}
        </button>
      ) : null}
    </section>
  );
};
