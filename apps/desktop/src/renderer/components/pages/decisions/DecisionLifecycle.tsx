import type { OutcomeVerdict } from "@cognelis/decision-core";

import type { DecisionLibraryItem } from "../../../../shared/renderer-api.js";

/**
 * done: finished. attention: the next step is the reader's and it is due —
 * the only state drawn in the action color. waiting: owed but not blocking
 * (a deferred rationale). pending: not reached yet.
 */
export type DecisionLifecycleState = "done" | "attention" | "waiting" | "pending";

export interface DecisionLifecycleStep {
  label: string;
  value: string;
  state: DecisionLifecycleState;
}

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const dayLabel = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getMonth() + 1}.${date.getDate()}`;
};

/** A YYYY-MM-DD calendar date, read without a time zone shift. */
const calendarDayLabel = (date: string): string => {
  const [, month = "", day = ""] = date.split("-");
  return `${Number(month)}.${Number(day)}`;
};

const localCalendarDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;

export const decisionLifecycleSteps = (
  decision: Pick<
    DecisionLibraryItem,
    | "created"
    | "rationaleStatus"
    | "expectedOutcome"
    | "outcome"
    | "outcomeReview"
    | "reviewDueDate"
  >,
  distilledCount: number,
  today: string,
): DecisionLifecycleStep[] => {
  const due = decision.reviewDueDate !== null && decision.reviewDueDate <= today;
  return [
    { label: "记录", value: dayLabel(decision.created), state: "done" },
    decision.rationaleStatus === "captured"
      ? { label: "理由", value: "已补充", state: "done" }
      : decision.rationaleStatus === "deferred"
        ? { label: "理由", value: "待补", state: "waiting" }
        : { label: "理由", value: "未补", state: "pending" },
    // Optional, and only worth writing before the outcome is known.
    decision.expectedOutcome
      ? { label: "预期", value: "已写下", state: "done" }
      : { label: "预期", value: decision.outcome === null ? "可补写" : "未写", state: "pending" },
    decision.outcome !== null
      ? { label: "实际结果", value: "已记录", state: "done" }
      : decision.reviewDueDate === null
        ? { label: "实际结果", value: "未安排复盘", state: "pending" }
        : {
            label: "实际结果",
            value: `${calendarDayLabel(decision.reviewDueDate)} ${due ? "到期" : "复盘"}`,
            state: due ? "attention" : "pending",
          },
    decision.outcomeReview !== null
      ? {
          label: "复盘",
          value: `${verdictLabels[decision.outcomeReview.verdict]} · ${dayLabel(
            decision.outcomeReview.reviewedAt,
          )}`,
          state: "done",
        }
      : decision.outcome !== null
        ? { label: "复盘", value: "待复盘", state: "attention" }
        : { label: "复盘", value: "—", state: "pending" },
    distilledCount > 0
      ? { label: "沉淀原则", value: `${distilledCount} 条`, state: "done" }
      : {
          label: "沉淀原则",
          value: decision.outcomeReview === null ? "—" : "可提炼",
          state: "pending",
        },
  ];
};

export const DecisionLifecycle = ({
  decision,
  distilledCount,
}: {
  decision: DecisionLibraryItem;
  distilledCount: number;
}) => (
  <section className="decision-lifecycle" aria-labelledby="decision-lifecycle-title">
    <h4 id="decision-lifecycle-title">进度</h4>
    <ol>
      {decisionLifecycleSteps(
        decision,
        distilledCount,
        localCalendarDate(new Date()),
      ).map((step) => (
        <li
          key={step.label}
          className={step.state}
          aria-current={step.state === "attention" ? "step" : undefined}
        >
          <i aria-hidden="true" />
          <span>{step.label}</span>
          <small>{step.value}</small>
        </li>
      ))}
    </ol>
  </section>
);
