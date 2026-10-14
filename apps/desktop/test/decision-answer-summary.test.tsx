// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapturedQuestion } from "@cognelis/decision-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  answerOptionIndex,
  DecisionAnswerSummary,
  partitionDecisionAnswers,
} from "../src/renderer/components/DecisionAnswerSummary.js";

const question = (
  overrides: Partial<CapturedQuestion> = {},
): CapturedQuestion => ({
  questionIndex: 0,
  question: "本轮要同步到其它配置吗？",
  options: [
    {
      label: "先只留测试环境（推荐）",
      description: "先保证 dev 完整可验。",
    },
    {
      label: "一并同步 production",
      description: "一步到位但带入未开放规则。",
    },
    {
      label: "只同步 CI",
      description: "先覆盖持续集成。",
    },
    {
      label: "只同步 conf.d",
      description: "先补齐配置模板。",
    },
    {
      label: "本轮不处理",
      description: "保持现状。",
    },
  ],
  answer: {
    kind: "preset",
    values: ["先只留测试环境（推荐）"],
  },
  multiSelect: false,
  ...overrides,
});

afterEach(cleanup);

describe("DecisionAnswerSummary", () => {
  it("makes the selected answer and description primary", () => {
    render(<DecisionAnswerSummary question={question()} />);

    const selected = screen.getByRole("list", {
      name: "已选答案",
    });
    expect(within(selected).getByText("先只留测试环境（推荐）")).toBeVisible();
    expect(within(selected).getByText("先保证 dev 完整可验。")).toBeVisible();
    expect(screen.queryByText("为什么这样选？")).toBeNull();
  });

  it("excludes the selection and expands alternatives beyond three", async () => {
    const user = userEvent.setup();
    render(<DecisionAnswerSummary question={question()} />);

    const alternatives = screen.getByRole("list", {
      name: "当时的其它候选",
    });
    expect(within(alternatives).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(alternatives).queryByText("先只留测试环境（推荐）"),
    ).toBeNull();
    expect(
      within(alternatives).getByText("一步到位但带入未开放规则。"),
    ).toBeVisible();

    const toggle = screen.getByRole("button", {
      name: "展开其余 1 项",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(within(alternatives).getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.getByRole("button", {
        name: "收起其它候选",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps multiple and custom answers honest", () => {
    const summary = partitionDecisionAnswers(
      question({
        answer: {
          kind: "multiple",
          values: ["只同步 CI", "自定义补充"],
        },
        multiSelect: true,
      }),
    );

    expect(summary.selected[0]).toMatchObject({
      label: "只同步 CI",
      description: "先覆盖持续集成。",
    });
    expect(summary.selected[1]).toMatchObject({
      label: "自定义补充",
    });
    expect(summary.selected[1]).not.toHaveProperty("description");
    expect(summary.alternatives.map((item) => item.label)).not.toContain(
      "只同步 CI",
    );
  });

  it("names the one option an answer points at, and none when a label repeats", () => {
    const indexOf = answerOptionIndex(
      question({
        options: [
          { label: "保留", description: "第一种保留。" },
          { label: "保留", description: "第二种保留。" },
          { label: "删除" },
        ],
      }),
    );
    expect(indexOf("删除")).toBe(2);
    expect(indexOf("保留")).toBeUndefined();
    expect(indexOf("自定义回答")).toBeUndefined();
  });

  it("does not guess which description belongs to duplicate labels", () => {
    const summary = partitionDecisionAnswers(
      question({
        options: [
          {
            id: "duplicate",
            label: "保持现状",
            description: "保留测试环境配置。",
          },
          {
            id: "duplicate",
            label: "保持现状",
            description: "保留生产环境配置。",
          },
        ],
        answer: {
          kind: "preset",
          values: ["保持现状"],
        },
      }),
    );

    expect(summary.selected).toEqual([
      expect.objectContaining({ label: "保持现状" }),
    ]);
    expect(summary.selected[0]).not.toHaveProperty("description");
    expect(summary.alternatives).toEqual([
      expect.objectContaining({ description: "保留测试环境配置。" }),
      expect.objectContaining({ description: "保留生产环境配置。" }),
    ]);
    expect(new Set(summary.alternatives.map((item) => item.key)).size).toBe(2);
  });

  it("renders no empty alternatives or description placeholders", () => {
    render(
      <DecisionAnswerSummary
        question={question({
          options: [{ label: "自定义答案" }],
          answer: {
            kind: "custom",
            values: ["自定义答案"],
          },
        })}
      />,
    );

    expect(
      screen.queryByRole("list", {
        name: "当时的其它候选",
      }),
    ).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
});
