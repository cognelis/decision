import { zonedFormatter } from "../../../calendar-date.js";
import type { OutcomeVerdict } from "@cognelis/decision-core";

import type { DecisionLibraryItem } from "../../../../shared/renderer-api.js";

export const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const dayFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
});

const section = (title: string, text: string | null | undefined): string[] =>
  text === null || text === undefined || text.trim().length === 0
    ? []
    : ["", `**${title}**`, "", text.trim()];

/**
 * One decision as Markdown for a PR description or a message: what was asked,
 * what was chosen and why, and what came of it. Only what the record holds.
 */
export const decisionMarkdown = (decision: DecisionLibraryItem): string =>
  [
    `### ${decision.question.replace(/\s+/gu, " ").trim()}`,
    "",
    `- 选择：${decision.selectedAnswer.replace(/\s+/gu, " ").trim()}`,
    `- 项目：${decision.project} · ${dayFormatter.format(new Date(decision.created))}`,
    ...section("理由", decision.rationale),
    ...section("当时上下文", decision.context),
    ...section("预期结果", decision.expectedOutcome),
    ...section("实际结果", decision.outcome),
    ...(decision.outcomeReview === null
      ? []
      : section(
          `复盘 · ${verdictLabels[decision.outcomeReview.verdict]}`,
          decision.outcomeReview.lesson ?? "没有写下经验。",
        )),
    "",
  ].join("\n");

/** The list as filtered, under one heading: the choices behind a PR, say. */
export const decisionsMarkdown = (decisions: DecisionLibraryItem[]): string =>
  [`## 决策记录（${decisions.length} 条）`, "", ...decisions.map(decisionMarkdown)].join(
    "\n",
  );
