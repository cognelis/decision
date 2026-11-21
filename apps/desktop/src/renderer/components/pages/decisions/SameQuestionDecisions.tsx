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

export const answerKey = (decision: Pick<DecisionLibraryItem, "selectedAnswer" | "answer">): string =>
  questionKey(decision.answer?.values.join("、") ?? decision.selectedAnswer);

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
 * The search for a question's other writings: each Chinese character a word of its own. Words are found as written,
 * and "部署前要不要先跑全量回归" never found "部署前 要不要先跑全量回归", one question all the same (questionKey);
 * sameQuestionAnswers keeps only that question of what this finds.
 */
export const sameQuestionSearchText = (question: string): string =>
  clipText(
    questionSearchText(question).replace(/(?<=\p{Script=Han})(?=\S)|(?<=\S)(?=\p{Script=Han})/gu, " "),
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

/**
 * The other decisions of the same question, newest first, as the rationale and the decision's details list them. Looked
 * for as written too: by character alone, newer questions holding the same characters rank as high as the very question,
 * and fifty of them left its earlier writing out of the fifty listed.
 */
export const listSameQuestionAnswers = async (
  listDecisions: DecisionApi["listDecisions"],
  question: string,
  excludeId: string,
): Promise<DecisionLibraryItem[]> => {
  const queries = [...new Set([questionSearchText(question), sameQuestionSearchText(question)])].filter((query) => query.length > 0);
  const found = (await Promise.all(queries.map((query) => listDecisions({ query, limit: 50 })))).flat();
  return sameQuestionAnswers([...new Map(found.map((item) => [item.id, item])).values()], question, excludeId);
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
    setAll(false);
    // Stepped to another decision, the last one's are not its own: kept until the new read landed, they were listed
    // under this one, compared with its answer, and a click opened the last decision's sibling.
    setOthers([]);
    void listSameQuestionAnswers(api.listDecisions, decision.question, decision.id)
      .then((items) => {
        if (active) setOthers(items);
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
              <span className="decision-same-question-answer">
                <strong>{item.selectedAnswer}</strong>
                {/* How the earlier answer turned out is what makes it worth a look. */}
                {item.outcomeReview === null ? null : (
                  <em className={`decision-review-verdict ${item.outcomeReview.verdict}`}>
                    {verdictLabels[item.outcomeReview.verdict]}
                  </em>
                )}
              </span>
              <small>
                {item.project} · {shortDate(item.created)}
                {/* Compared as the retrospective compares answers: "loopback http" is the answer "Loopback HTTP". */}
                {answerKey(item) === answerKey(decision)
                  ? " · 答案相同"
                  : " · 答案不同"}
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
