// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionLibraryItem } from "../src/shared/renderer-api.js";
import { dateAfter } from "../src/renderer/calendar-date.js";
import { DashboardReviewInbox } from "../src/renderer/components/DashboardReviewInbox.js";

/**
 * The review loop is what the app is for, and it used to be the one dashboard
 * todo you had to leave the page to finish. These cases hold the two halves of
 * finishing it here: the right step is offered, and a failed save says so
 * instead of quietly dropping what was typed.
 */

const decision = (
  overrides: Partial<DecisionLibraryItem> = {},
): DecisionLibraryItem => ({
  id: "decision-1",
  created: "2026-09-01T10:00:00.000Z",
  sourceClient: "codex",
  project: "decision",
  question: "缓存层放在哪一侧？",
  selectedAnswer: "先放在读取端，可回退",
  rationaleStatus: "captured",
  rationale: "可回退。",
  context: null,
  outcome: null,
  outcomeReview: null,
  reviewDueDate: "2026-09-10",
  appliedPrincipleIds: [],
  appliedPrinciples: [],
  ...overrides,
});

const renderInbox = (
  decisions: DecisionLibraryItem[],
  overrides: {
    onSaveOutcome?: (id: string, outcome: string) => Promise<void>;
    onSaveReview?: (id: string, input: unknown) => Promise<void>;
    onPostponeReview?: (id: string, reviewDueDate: string) => Promise<void>;
  } = {},
) => {
  const onSaveOutcome = vi.fn(overrides.onSaveOutcome ?? (async () => undefined));
  const onSaveReview = vi.fn(overrides.onSaveReview ?? (async () => undefined));
  const onPostponeReview = vi.fn(
    overrides.onPostponeReview ?? (async () => undefined),
  );
  const onOpenDecision = vi.fn();
  const onOpenReviewInbox = vi.fn();
  render(
    <DashboardReviewInbox
      decisions={decisions}
      unscheduled={[]}
      loading={false}
      failed={false}
      onRetry={vi.fn()}
      onOpenDecision={onOpenDecision}
      onOpenReviewInbox={onOpenReviewInbox}
      onSaveOutcome={onSaveOutcome}
      onSaveReview={onSaveReview}
      onPostponeReview={onPostponeReview}
      remindersEnabled
    />,
  );
  return {
    onSaveOutcome,
    onSaveReview,
    onPostponeReview,
    onOpenDecision,
    onOpenReviewInbox,
  };
};

afterEach(cleanup);

describe("DashboardReviewInbox", () => {
  it("continues from a saved result to review and retries only the failed review", async () => {
    const user = userEvent.setup();
    const { onSaveOutcome, onSaveReview } = renderInbox([decision({ expectedOutcome: "读取命中率达到目标" })]);
    onSaveReview.mockRejectedValueOnce(new Error("暂时无法写入"));
    await user.click(screen.getByRole("button", { name: "回填结果" }));
    expect(screen.getByText("预期结果：读取命中率达到目标")).toBeVisible();
    await user.type(screen.getByLabelText("结果说明"), "命中率达标。");
    await user.click(screen.getByRole("button", { name: "保存并继续复盘" }));
    const form = await screen.findByRole("form", { name: "完成复盘表单" });
    expect(within(form).getByText("预期结果：读取命中率达到目标")).toBeVisible();
    expect(within(form).getByText("实际结果：命中率达标。")).toBeVisible();
    await user.click(within(form).getByRole("button", { name: "优于预期" }));
    await user.type(within(form).getByLabelText("复盘经验（可选）"), "先验证再推广。");
    await user.click(within(form).getByRole("button", { name: /保存复盘/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法写入");
    expect(within(form).getByLabelText("复盘经验（可选）")).toHaveValue("先验证再推广。");
    await user.click(within(form).getByRole("button", { name: /保存复盘/u }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSaveOutcome).toHaveBeenCalledTimes(1);
    expect(onSaveReview).toHaveBeenLastCalledWith("decision-1", { verdict: "better", lesson: "先验证再推广。" });
  });

  it("offers the step this decision is actually waiting on", () => {
    renderInbox([
      decision(),
      decision({
        id: "decision-2",
        question: "索引重建应该自动还是手动？",
        outcome: "手动重建够用，没有出现遗漏。",
      }),
    ]);

    // Same list, two different next steps: filling in the result is not the
    // same todo as judging it against what was expected.
    expect(screen.getByRole("button", { name: "回填结果" })).toBeVisible();
    expect(screen.getByRole("button", { name: "完成复盘" })).toBeVisible();
  });

  it("writes the result back without leaving the dashboard", async () => {
    const user = userEvent.setup();
    const { onSaveOutcome } = renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    const form = screen.getByRole("form", { name: "回填实际结果表单" });
    await user.type(
      within(form).getByLabelText("结果说明"),
      "读取端缓存命中率达标，没有回退。",
    );
    await user.click(within(form).getByRole("button", { name: /保存结果/u }));

    expect(onSaveOutcome).toHaveBeenCalledWith(
      "decision-1",
      "读取端缓存命中率达标，没有回退。",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "回填实际结果表单" }),
      ).toBeNull(),
    );
  });

  it("records the verdict the reader picked, not the default", async () => {
    const user = userEvent.setup();
    const { onSaveReview } = renderInbox([
      decision({ outcome: "命中率没有达到预期，回退了一次。" }),
    ]);

    await user.click(screen.getByRole("button", { name: "完成复盘" }));
    const form = screen.getByRole("form", { name: "完成复盘表单" });
    await user.click(within(form).getByRole("button", { name: "低于预期" }));
    await user.type(
      within(form).getByLabelText("复盘经验（可选）"),
      "读取端的命中率假设没有验证过。",
    );
    await user.click(within(form).getByRole("button", { name: /保存复盘/u }));

    expect(onSaveReview).toHaveBeenCalledWith("decision-1", {
      verdict: "worse",
      lesson: "读取端的命中率假设没有验证过。",
    });
  });

  it("treats a blank lesson as no lesson rather than an empty one", async () => {
    const user = userEvent.setup();
    const { onSaveReview } = renderInbox([
      decision({ outcome: "按预期运行。" }),
    ]);

    await user.click(screen.getByRole("button", { name: "完成复盘" }));
    const form = screen.getByRole("form", { name: "完成复盘表单" });
    await user.type(within(form).getByLabelText("复盘经验（可选）"), "   ");
    await user.click(within(form).getByRole("button", { name: /保存复盘/u }));

    expect(onSaveReview).toHaveBeenCalledWith("decision-1", {
      verdict: "as_expected",
      lesson: null,
    });
  });

  it("will not save an empty result", async () => {
    const user = userEvent.setup();
    const { onSaveOutcome } = renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    const form = screen.getByRole("form", { name: "回填实际结果表单" });
    // A blank result would close the todo while recording nothing.
    expect(within(form).getByRole("button", { name: /保存结果/u })).toBeDisabled();
  });

  it("keeps the typing when the save fails", async () => {
    const user = userEvent.setup();
    renderInbox([decision()], {
      onSaveOutcome: async () => {
        throw new Error("Obsidian 暂时无法写入");
      },
    });

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    const form = screen.getByRole("form", { name: "回填实际结果表单" });
    await user.type(within(form).getByLabelText("结果说明"), "命中率达标。");
    await user.click(within(form).getByRole("button", { name: /保存结果/u }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "结果暂时无法保存：Obsidian 暂时无法写入",
      ),
    );
    expect(within(form).getByLabelText("结果说明")).toHaveValue("命中率达标。");
  });

  it("keeps a typed result through a stray Escape or click outside, and lets 取消 let it go", async () => {
    const user = userEvent.setup();
    renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    // Nothing typed yet: Escape closes as it always has.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "回填结果" }));
    await user.type(screen.getByLabelText("结果说明"), "命中率达标。");
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);

    expect(screen.getByLabelText("结果说明")).toHaveValue("命中率达标。");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves on the same shortcut as every other dashboard form", async () => {
    const user = userEvent.setup();
    const { onSaveOutcome } = renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    await user.type(
      within(screen.getByRole("form", { name: "回填实际结果表单" })).getByLabelText(
        "结果说明",
      ),
      "命中率达标。",
    );
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onSaveOutcome).toHaveBeenCalledWith("decision-1", "命中率达标。");
  });

  it("postpones a review whose result is not in yet and says where it went", async () => {
    const user = userEvent.setup();
    const { onPostponeReview, onSaveOutcome } = renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    const postpone = screen.getByRole("group", { name: "还没有结果时推迟复盘" });
    await user.click(within(postpone).getByRole("button", { name: "两周后" }));

    expect(onPostponeReview).toHaveBeenCalledWith("decision-1", dateAfter(14));
    expect(onSaveOutcome).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent(
      /推迟到.+复盘：「缓存层放在哪一侧？」/u,
    );

    // A mistaken postpone goes back to the date it replaced.
    await user.click(within(screen.getByRole("status")).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(onPostponeReview).toHaveBeenLastCalledWith("decision-1", "2026-09-10");
  });

  it("stops offering to postpone once a result is typed", async () => {
    const user = userEvent.setup();
    renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    await user.type(screen.getByLabelText("结果说明"), "命中率达标。");

    const postpone = screen.getByRole("group", { name: "还没有结果时推迟复盘" });
    for (const button of within(postpone).getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("keeps the dialog open when the new date cannot be saved", async () => {
    const user = userEvent.setup();
    renderInbox([decision()], {
      onPostponeReview: async () => {
        throw new Error("索引暂时不可用");
      },
    });

    await user.click(screen.getByRole("button", { name: "回填结果" }));
    await user.click(screen.getByRole("button", { name: "一周后" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "复盘日期暂时无法保存：索引暂时不可用",
    );
    expect(screen.getByRole("form", { name: "回填实际结果表单" })).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not offer to postpone judging a result that is already in", async () => {
    const user = userEvent.setup();
    renderInbox([decision({ outcome: "命中率达标。" })]);

    await user.click(screen.getByRole("button", { name: "完成复盘" }));

    expect(
      screen.queryByRole("group", { name: "还没有结果时推迟复盘" }),
    ).toBeNull();
  });

  it("still opens the decision itself", async () => {
    const user = userEvent.setup();
    const { onOpenDecision } = renderInbox([decision()]);

    await user.click(screen.getByRole("button", { name: /缓存层放在哪一侧/u }));

    expect(onOpenDecision).toHaveBeenCalledWith("decision-1");
  });
});
