// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionLibraryPanel } from "../src/renderer/components/pages/decisions/DecisionLibraryPanel.js";
import { SameQuestionDecisions } from "../src/renderer/components/pages/decisions/SameQuestionDecisions.js";
import type { DecisionLibraryItem } from "../src/shared/renderer-api.js";
import {
  acceptedMethodologyFixture,
  apiFixture,
  candidate,
  rationaleSnapshot,
  renderDecisionLibrary,
} from "./app-fixtures.js";

/**
 * The knowledge page: searching the decision history, filtering it, and
 * reaching a record from the keyboard alone.
 */

afterEach(cleanup);


describe("knowledge page", () => {
  it("searches, filters, and opens decisions from the decision library", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "decisions",
        dashboard: {
          totalDecisions: 28,
          recorded7d: 7,
          reviewAttention: 0,
          recentDecisions: [],
        },
      }),
    );
    const libraryDecision: DecisionLibraryItem = {
      id: "decision-library-1",
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "缓存策略应该如何调整？",
      selectedAnswer: "使用可清理的本地缓存",
      rationaleStatus: "captured",
      rationale: "便于恢复，也不会锁死实现。",
      context: "正在收敛本地持久化方案。",
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) => [
      {
        ...libraryDecision,
        ...(query.query.trim().length === 0
          ? {}
          : query.searchMode === "semantic"
            ? { searchMatch: "hybrid" as const }
            : {}),
      },
    ]);
    const acceptedPrinciple = acceptedMethodologyFixture();
    vi.mocked(api.listMethodologies).mockResolvedValue([acceptedPrinciple]);
    vi.mocked(api.updateDecisionAppliedPrinciples).mockResolvedValue([
      {
        id: acceptedPrinciple.id,
        title: acceptedPrinciple.title,
        status: "accepted",
      },
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);

    const page = await screen.findByRole("region", { name: "知识" });
    expect(
      await within(page).findByText("缓存策略应该如何调整？"),
    ).toBeVisible();
    expect(within(page).getByText("28")).toBeVisible();
    const searchbox = within(page).getByRole("searchbox", {
      name: "搜索决策与笔记",
    });
    expect(searchbox).toHaveAttribute(
      "placeholder",
      "按关键词搜索决策与笔记",
    );
    const semanticMode = within(page).getByRole("switch", {
      name: "决策使用语义检索",
    });
    expect(semanticMode).toBeVisible();
    expect(semanticMode).not.toBeChecked();
    expect(searchbox.closest(".decision-search-field")).not.toContainElement(
      semanticMode,
    );
    await user.type(searchbox, "缓存");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith({
        query: "缓存",
        searchMode: "keyword",
        limit: 200,
      }),
    );
    expect(within(page).getByText(/关键词匹配/u)).toBeVisible();
    expect(within(page).queryByText("综合命中")).toBeNull();
    await user.click(within(page).getByRole("button", { name: "清空搜索" }));
    await waitFor(() => expect(searchbox).toHaveValue(""));
    await user.type(searchbox, "缓存");
    await user.click(semanticMode);
    expect(semanticMode).toBeChecked();
    expect(semanticMode).toHaveAccessibleName("决策使用语义检索");
    expect(searchbox).toHaveAttribute(
      "placeholder",
      "按关键词或含义搜索决策与笔记",
    );
    await user.click(within(page).getByRole("button", { name: "未补理由" }));
    await user.selectOptions(
      within(page).getByRole("combobox", { name: "按来源筛选" }),
      "codex",
    );
    await user.selectOptions(
      within(page).getByRole("combobox", { name: "按复盘进度或结论筛选" }),
      "pending_review",
    );

    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith({
        query: "缓存",
        rationaleStatus: "skipped",
        sourceClient: "codex",
        reviewState: "pending_review",
        searchMode: "semantic",
        limit: 200,
      }),
    );
    expect(await within(page).findByText("综合命中")).toBeVisible();
    expect(within(page).getByText(/语义参与排序/u)).toBeVisible();

    await user.click(within(page).getByText("缓存策略应该如何调整？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByText("使用可清理的本地缓存")).toBeVisible();
    expect(details.getByText("便于恢复，也不会锁死实现。")).toBeVisible();
    expect(details.getByText("正在收敛本地持久化方案。")).toBeVisible();
    expect(details.getByText("尚未记录实际结果。")).toBeVisible();
    expect(
      details.getByText("尚未记录这次决策实际采用了哪些原则。"),
    ).toBeVisible();

    await user.click(details.getByRole("button", { name: "关联原则" }));
    expect(details.getByText(/不会由模型自动判断/u)).toBeVisible();
    await user.click(
      details.getByRole("checkbox", { name: acceptedPrinciple.title }),
    );
    await user.click(details.getByRole("button", { name: "保存关联" }));
    expect(api.updateDecisionAppliedPrinciples).toHaveBeenCalledWith(
      "decision-library-1",
      [acceptedPrinciple.id],
    );
    expect(await details.findByText(acceptedPrinciple.title)).toBeVisible();

    await user.click(details.getByRole("button", { name: "安排日期" }));
    fireEvent.change(details.getByLabelText("复盘日期"), {
      target: { value: "2099-12-31" },
    });
    expect(
      details.getByText("到期后只进入首页收件箱，不会自动弹出窗口。"),
    ).toBeVisible();
    await user.click(details.getByRole("button", { name: "保存日期" }));
    expect(api.updateDecisionReviewDueDate).toHaveBeenCalledWith(
      "decision-library-1",
      "2099-12-31",
    );
    expect(await details.findByText(/12月31日复盘/u)).toBeVisible();

    await user.click(details.getByRole("button", { name: "记录结果" }));
    await user.type(
      details.getByRole("textbox", { name: "结果说明" }),
      "上线一周后运行稳定。",
    );
    await user.click(details.getByRole("button", { name: "保存结果" }));

    expect(api.updateDecisionOutcome).toHaveBeenCalledWith(
      "decision-library-1",
      "上线一周后运行稳定。",
    );
    expect(await details.findByText("上线一周后运行稳定。")).toBeVisible();

    await user.click(details.getByRole("button", { name: "开始复盘" }));
    await user.click(details.getByRole("button", { name: "部分符合" }));
    await user.type(
      details.getByRole("textbox", { name: "复盘经验（可选）" }),
      "方向正确，但低估了迁移成本。",
    );
    await user.click(details.getByRole("button", { name: "保存复盘" }));

    expect(api.updateDecisionReview).toHaveBeenCalledWith(
      "decision-library-1",
      {
        verdict: "mixed",
        lesson: "方向正确，但低估了迁移成本。",
      },
    );
    expect(await details.findByText("部分符合")).toBeVisible();
    expect(details.getByText("方向正确，但低估了迁移成本。")).toBeVisible();
    expect(details.getByText("这条决策现在可作为方法论证据")).toBeVisible();
    await user.click(details.getByRole("button", { name: "用于提炼原则" }));
    expect(api.openSurface).toHaveBeenCalledWith("methodology");
  });

  it("completes a deferred rationale from the decision detail", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    vi.mocked(api.listDecisions).mockResolvedValue([
      {
        id: "decision-deferred",
        created: "2026-07-30T03:04:00.000Z",
        sourceClient: "claude-code",
        project: "decision",
        question: "日志要不要落盘？",
        selectedAnswer: "只在出错时落盘",
        rationaleStatus: "deferred",
        rationale: null,
        context: "排查线上问题需要现场。",
        outcome: null,
        outcomeReview: null,
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("日志要不要落盘？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByText("没有补充理由。")).toBeVisible();
    expect(details.getByText("待补")).toBeVisible();

    await user.click(details.getByRole("button", { name: "补充理由" }));
    // Recalling why is easier with the context in view; the rest waits.
    expect(details.getByText("排查线上问题需要现场。")).toBeVisible();
    expect(details.queryByRole("button", { name: "记录结果" })).toBeNull();
    const save = details.getByRole("button", { name: "保存理由" });
    expect(save).toBeDisabled();
    await user.type(
      details.getByRole("textbox", { name: "理由原文" }),
      "全量落盘太占空间，出错现场已经够用。",
    );
    await user.click(save);

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-deferred",
      status: "captured",
      rationale: "全量落盘太占空间，出错现场已经够用。",
    });
    expect(
      await details.findByText("全量落盘太占空间，出错现场已经够用。"),
    ).toBeVisible();
    expect(details.getByText("理由完整")).toBeVisible();
    expect(details.getByText("已补充")).toBeVisible();
    expect(details.queryByRole("button", { name: "补充理由" })).toBeNull();
  });

  it("steps through the listed decisions without leaving the detail", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const decision = (id: string, question: string): DecisionLibraryItem => ({
      id,
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question,
      selectedAnswer: `${question}的答案`,
      rationaleStatus: "captured",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([
      decision("first", "第一个问题？"),
      decision("second", "第二个问题？"),
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByText("1 / 2")).toBeVisible();
    expect(details.getByRole("button", { name: "上一条决策" })).toBeDisabled();
    // Opening a record starts on it, not on the control that leaves it.
    await waitFor(() =>
      expect(details.getByRole("button", { name: "关闭决策详情" })).toHaveFocus(),
    );

    await user.click(details.getByRole("button", { name: "下一条决策" }));
    expect(details.getByText("第二个问题？的答案")).toBeVisible();
    expect(details.getByText("2 / 2")).toBeVisible();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await user.click(details.getByRole("button", { name: "复制为 Markdown" }));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^### 第二个问题？\n\n- 选择：第二个问题？的答案/u),
    );
    expect(details.getAllByRole("status").map((node) => node.textContent)).toContain("已复制为 Markdown");

    await user.keyboard("{ArrowLeft}");
    expect(details.getByText("第一个问题？的答案")).toBeVisible();
    // Coming back is not copying again: the earlier notice does not replay.
    await user.keyboard("{ArrowRight}");
    expect(details.getByText("第二个问题？的答案")).toBeVisible();
    expect(details.queryByText("已复制为 Markdown")).toBeNull();
    await user.keyboard("{ArrowLeft}");

    // An open editor holds the record in place: a draft is never dropped.
    await user.click(details.getByRole("button", { name: "记录结果" }));
    expect(details.getByRole("button", { name: "下一条决策" })).toBeDisabled();
    await user.type(details.getByRole("textbox", { name: "结果说明" }), "{ArrowRight}");
    expect(details.getByText("第一个问题？的答案")).toBeVisible();
  });

  it("gives focus back to the button that opened an editor in the detail, and says what was saved", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "first", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision",
      question: "还没有结果的问题？", selectedAnswer: "先灰度", rationaleStatus: "captured", rationale: null, context: null,
      expectedOutcome: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("还没有结果的问题？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));

    details.getByRole("button", { name: "补写预期" }).focus();
    await user.keyboard("{Enter}");
    await user.type(details.getByRole("textbox", { name: "预期结果" }), "一周内不再回滚。");
    details.getByRole("button", { name: "保存预期" }).focus();
    await user.keyboard("{Enter}");

    // Closed on 保存, the editor left focus to the dialog itself, Tab starting over at its top, and said nothing.
    expect(await details.findByRole("button", { name: "修改预期" })).toHaveFocus();
    expect(details.getAllByRole("status").map((node) => node.textContent)).toContain("预期结果已保存");

    // Let go with 取消, the same.
    await user.keyboard("{Enter}");
    // Opened again, the last word goes: the next save's same words would otherwise change nothing to be said.
    expect(details.getAllByRole("status").map((node) => node.textContent)).not.toContain("预期结果已保存");
    details.getByRole("button", { name: "取消" }).focus();
    await user.keyboard("{Enter}");
    expect(details.getByRole("button", { name: "修改预期" })).toHaveFocus();
  });

  it("keeps an outcome being written in the detail while a captured decision has the window", async () => {
    const onKnowledge = rationaleSnapshot({ current: null, primarySurface: "decisions" });
    const { api, emit } = apiFixture(onKnowledge);
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "first", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision",
      question: "第一个问题？", selectedAnswer: "答案", rationaleStatus: "captured", rationale: null, context: null,
      outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    const dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    await user.type(within(dialog).getByRole("textbox", { name: "结果说明" }), "上线一周稳定，命中率 92%");

    // A native question answered in the terminal: its rationale panel takes the window, the detail out of sight.
    act(() => emit({ ...onKnowledge, current: candidate() }));
    await screen.findByRole("region", { name: "待补充决策理由" });
    expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull();
    act(() => emit(onKnowledge));
    await screen.findByRole("region", { name: "知识" });

    expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();
    expect(screen.getByDisplayValue("上线一周稳定，命中率 92%")).toBeVisible();
  });

  it("keeps a draft in the detail when Escape or a click outside would have closed it", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "first", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "第一个问题？", selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    const dialog = screen.getByRole("dialog", { name: "决策详情" });
    // Not writing: an input method's Escape only ends its composition; a plain one closes.
    fireEvent.keyDown(dialog, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    const outcome = within(dialog).getByRole("textbox", { name: "结果说明" });
    await user.type(outcome, "上线一周稳定");
    await user.keyboard("{Escape}");
    // A click outside neither closes it nor takes focus off it, where the app's shortcuts could leave with the draft.
    expect(fireEvent.mouseDown(document.querySelector(".modal-backdrop")!)).toBe(false);
    expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: "结果说明" })).toHaveValue("上线一周稳定");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull());
  });

  it("keeps a usage-feedback draft in the detail as it does the detail's other drafts", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (id: string, question: string): DecisionLibraryItem => ({
      id, created: "2026-09-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question, selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([item("A", "第一条决策"), item("B", "第二条决策")]);
    await renderDecisionLibrary(api);
    fireEvent.click(await screen.findByText("第一条决策"));
    const dialog = await screen.findByRole("dialog", { name: "决策详情" });
    await within(dialog).findByRole("button", { name: "打开原文" });
    fireEvent.click(within(dialog).getByText("使用反馈"));
    fireEvent.click(await within(dialog).findByRole("button", { name: "记录使用反馈" }));
    const task = within(dialog).getByLabelText("使用时的任务");
    fireEvent.change(task, { target: { value: "迁移列表编号时参考了它" } });

    fireEvent.keyDown(task, { key: "Escape" });

    // Escape closed the detail, and the step to the next decision dropped the draft with it.
    expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "下一条决策" })).toBeDisabled();
    expect(task).toHaveValue("迁移列表编号时参考了它");
  });

  it("lets a detail close while its save finishes, and does not reopen it when the save lands", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "first", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "第一个问题？", selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    let finish!: () => void;
    vi.mocked(api.updateDecisionOutcome).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    const dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    await user.type(within(dialog).getByRole("textbox", { name: "结果说明" }), "上线一周稳定");
    await user.click(within(dialog).getByRole("button", { name: "保存结果" }));
    await user.click(within(dialog).getByRole("button", { name: "关闭决策详情" }));
    expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull();
    await act(async () => finish());
    expect(api.updateDecisionOutcome).toHaveBeenCalledWith("first", "上线一周稳定");
    expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull();
  });

  it("keeps a save left to finish to its own record: another record's editor is neither 保存中 nor let go on Escape", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (id: string, question: string): DecisionLibraryItem => ({
      id, created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision", question, selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([item("first", "第一个问题？"), item("second", "第二个问题？")]);
    let finish!: () => void;
    vi.mocked(api.updateDecisionOutcome).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    let dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    await user.type(within(dialog).getByRole("textbox", { name: "结果说明" }), "上线一周稳定");
    await user.click(within(dialog).getByRole("button", { name: "保存结果" }));
    await user.click(within(dialog).getByRole("button", { name: "关闭决策详情" }));

    await user.click(screen.getByText("第二个问题？"));
    dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    const draft = within(dialog).getByRole("textbox", { name: "结果说明" });
    await user.type(draft, "写了一半");
    // The first record's save said 保存中 here and held 保存 and 取消; the dialog counted as one left to close, and
    // a stray Escape took this draft with it.
    expect(within(dialog).getByRole("button", { name: "保存结果" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeEnabled();
    fireEvent.keyDown(draft, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();
    expect(draft).toHaveValue("写了一半");
    await act(async () => finish());
    expect(draft).toHaveValue("写了一半");
  });

  it("says when a save left to finish fails, and gives back what was written when the record is opened again", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "first", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "第一个问题？", selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    let fail!: (error: Error) => void;
    vi.mocked(api.updateDecisionOutcome).mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    let dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    await user.type(within(dialog).getByRole("textbox", { name: "结果说明" }), "上线一周稳定");
    await user.click(within(dialog).getByRole("button", { name: "保存结果" }));
    await user.click(within(dialog).getByRole("button", { name: "关闭决策详情" }));

    await act(async () => fail(new Error("这条决策的笔记刚被改过，请重新打开后再保存。")));

    expect(screen.getByRole("alert")).toHaveTextContent("「第一个问题？」的实际结果没能保存：这条决策的笔记刚被改过，请重新打开后再保存。重新打开这条决策，写下的内容还在。");
    await user.click(screen.getByText("第一个问题？"));
    dialog = screen.getByRole("dialog", { name: "决策详情" });
    expect(within(dialog).getByRole("textbox", { name: "结果说明" })).toHaveValue("上线一周稳定");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("刚被改过");
    expect(screen.queryByText(/的实际结果没能保存/u)).toBeNull();
  });

  it("tells a record closed and opened again from one never left, whichever way its earlier save lands", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "first", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "第一个问题？", selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    const settle: Array<{ resolve(): void; reject(error: Error): void }> = [];
    vi.mocked(api.updateDecisionOutcome).mockImplementation(() => new Promise<void>((resolve, reject) => { settle.push({ resolve, reject }); }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    const saveAndLeave = async (text: string) => {
      await user.click(await screen.findByText("第一个问题？"));
      const dialog = screen.getByRole("dialog", { name: "决策详情" });
      await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
      await user.type(within(dialog).getByRole("textbox", { name: "结果说明" }), text);
      await user.click(within(dialog).getByRole("button", { name: "保存结果" }));
      await user.click(within(dialog).getByRole("button", { name: "关闭决策详情" }));
    };

    // Opened again before the save failed: by its id it looked never left, and the failure went unsaid.
    await saveAndLeave("上线一周稳定");
    await user.click(screen.getByText("第一个问题？"));
    await act(async () => settle[0]!.reject(new Error("这条决策的笔记刚被改过，请重新打开后再保存。")));
    let dialog = screen.getByRole("dialog", { name: "决策详情" });
    expect(within(dialog).getByRole("textbox", { name: "结果说明" })).toHaveValue("上线一周稳定");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("刚被改过");

    // Saved again and left; opened again, and written in anew: the earlier save landing does not close that.
    await user.click(within(dialog).getByRole("button", { name: "保存结果" }));
    await user.click(within(dialog).getByRole("button", { name: "关闭决策详情" }));
    await user.click(screen.getByText("第一个问题？"));
    dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    await user.type(within(dialog).getByRole("textbox", { name: "结果说明" }), "另写的一段");
    await act(async () => settle[1]!.resolve());
    expect(within(dialog).getByRole("textbox", { name: "结果说明" })).toHaveValue("另写的一段");
  });

  it("says in the preferences and ideas which notes could not be read", async () => {
    const { api } = apiFixture(rationaleSnapshot({
      current: null,
      primarySurface: "decisions",
      health: { index: "healthy", recovery: "healthy", journalMessage: "1 篇偏好或想法笔记读不出来，没有出现在列表里：手改坏的偏好.md。" },
    }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.click(await screen.findByRole("tab", { name: "偏好与想法" }));
    expect(await screen.findByText(/1 篇偏好或想法笔记读不出来/u)).toBeVisible();
  });

  it("focuses the search field of the tab in view on /", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByRole("tab", { name: "偏好与想法" }));
    await user.click(document.body);
    await user.keyboard("/");
    // Bound only to the decisions' field, kept hidden behind this tab, the key did nothing here.
    expect(screen.getByRole("searchbox", { name: "搜索偏好与想法" })).toHaveFocus();
  });

  it("switches between the decisions and the preferences with the arrow keys, as tabs do", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    const decisions = await screen.findByRole("tab", { name: "决策" });
    decisions.focus();
    await user.keyboard("{ArrowRight}");
    const journal = screen.getByRole("tab", { name: "偏好与想法" });
    expect(journal).toHaveAttribute("aria-selected", "true");
    expect(journal).toHaveFocus();
    await user.keyboard("{Home}");
    expect(decisions).toHaveAttribute("aria-selected", "true");
    expect(decisions).toHaveFocus();
  });

  it("filters by any project, not only one reached from the retrospective", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    vi.mocked(api.listDecisionProjects).mockResolvedValue([
      { project: "decision", count: 3 },
      { project: "local-tools", count: 1 },
    ]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    const project = await screen.findByRole("combobox", { name: "按项目筛选" });
    expect(screen.getByRole("option", { name: "decision（3）" })).toBeInTheDocument();
    await user.selectOptions(project, "local-tools");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.objectContaining({ project: "local-tools" }),
      ),
    );
    await user.selectOptions(project, "");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ project: expect.anything() }),
      ),
    );
  });

  it("offers no project choice when everything is one project", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    vi.mocked(api.listDecisionProjects).mockResolvedValue([{ project: "decision", count: 3 }]);
    await renderDecisionLibrary(api);

    await screen.findByRole("combobox", { name: "按记录时间筛选" });
    await waitFor(() => expect(api.listDecisionProjects).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "按项目筛选" })).toBeNull();
  });

  it("reads the project choices again with the list, a project renamed in Obsidian among them", async () => {
    const dashboard = { totalDecisions: 4, recorded7d: 0, reviewAttention: 0, recentDecisions: [], revision: 1 };
    const { api, emit } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions", dashboard }));
    vi.mocked(api.listDecisionProjects).mockResolvedValue([{ project: "alpha", count: 3 }, { project: "beta", count: 1 }]);
    await renderDecisionLibrary(api);
    expect(await screen.findByRole("option", { name: "alpha（3）" })).toBeInTheDocument();

    // One decision's project changed to gamma in Obsidian: no decision added, the index moved on.
    vi.mocked(api.listDecisionProjects).mockResolvedValue([
      { project: "alpha", count: 2 }, { project: "beta", count: 1 }, { project: "gamma", count: 1 },
    ]);
    await act(async () => {
      emit(rationaleSnapshot({ current: null, primarySurface: "decisions", dashboard: { ...dashboard, revision: 2 } }));
    });

    // Read only when the count moved, alpha still said 3 and gamma could not be chosen.
    expect(await screen.findByRole("option", { name: "gamma（1）" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "alpha（2）" })).toBeInTheDocument();
  });

  it("narrows the library to the week the dashboard counted", async () => {
    const { api, emit } = apiFixture(
      // The week's decisions exist, so the dashboard shows its counts, not the first-run steps.
      rationaleSnapshot({ current: null, primarySurface: "dashboard", dashboard: { totalDecisions: 2, recorded7d: 2, reviewAttention: 0, recentDecisions: [] } }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.click(await screen.findByRole("button", { name: /^近 7 天记录/u }));
    emit(rationaleSnapshot({ current: null, primarySurface: "decisions" }));

    // Today and the six calendar days before it, as the dashboard counts.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    const period = await screen.findByRole("combobox", { name: "按记录时间筛选" });
    expect(period).toHaveValue("7");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdSince: start.toISOString() }),
      ),
    );

    await user.selectOptions(period, "all");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ createdSince: expect.anything() }),
      ),
    );
  });

  it("asks for the week again from the new day when one turns over with the page open", async () => {
    const { api, emit } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "dashboard", dashboard: { totalDecisions: 2, recorded7d: 2, reviewAttention: 0, recentDecisions: [] } }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    // Set once the page is up: rendering takes the fixture's own fake timers down again, clock and all, and set
    // before it the 5th held only on the day this was written.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 9, 5, 23, 59));
      await user.click(await screen.findByRole("button", { name: /^近 7 天记录/u }));
      emit(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
      await waitFor(() =>
        expect(api.listDecisions).toHaveBeenLastCalledWith(expect.objectContaining({ createdSince: new Date(2026, 8, 29).toISOString() })),
      );

      // Midnight passes with the app in the tray: the snapshot published for the new day.
      vi.setSystemTime(new Date(2026, 9, 6, 0, 1));
      await act(async () => {
        emit(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
      });
      // Read on the 5th, the week still began on 29 September.
      await waitFor(() =>
        expect(api.listDecisions).toHaveBeenLastCalledWith(expect.objectContaining({ createdSince: new Date(2026, 8, 30).toISOString() })),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an expectation be written down until the outcome is known", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const decision = (
      id: string,
      question: string,
      outcome: string | null,
    ): DecisionLibraryItem => ({
      id,
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question,
      selectedAnswer: `${question}的答案`,
      rationaleStatus: "captured",
      rationale: null,
      context: null,
      expectedOutcome: null,
      outcome,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([
      decision("open", "还没有结果的问题？", null),
      decision("known", "已经有结果的问题？", "结果已经出来。"),
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("还没有结果的问题？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByText("结果出来之前写下预期，复盘时才有对照。")).toBeVisible();
    await user.click(details.getByRole("button", { name: "补写预期" }));
    // Writing it holds the record in place, like any other editor.
    expect(details.getByRole("button", { name: "下一条决策" })).toBeDisabled();
    await user.type(details.getByRole("textbox", { name: "预期结果" }), " 一周内不再回滚。 ");
    await user.click(details.getByRole("button", { name: "保存预期" }));
    expect(api.updateDecisionExpectedOutcome).toHaveBeenCalledWith(
      "open",
      "一周内不再回滚。",
    );
    expect(await details.findByText("一周内不再回滚。")).toBeVisible();
    expect(details.getByRole("button", { name: "修改预期" })).toBeVisible();

    // With the outcome in, an expectation would only restate it.
    await user.click(details.getByRole("button", { name: "下一条决策" }));
    expect(details.getByText("结果已经出来。")).toBeVisible();
    expect(details.queryByRole("button", { name: /预期$/u })).toBeNull();
  });

  it("holds the ways to 方法论 while something is being written in the detail, as it holds stepping", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "decision-applied",
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "缓存层放在哪一侧？",
      selectedAnswer: "先放在读取端",
      rationaleStatus: "captured",
      rationale: "可回退。",
      context: null,
      outcome: "上线后命中率 80%",
      outcomeReview: { verdict: "as_expected", lesson: null, reviewedAt: "2026-08-01T10:00:00.000Z" },
      reviewDueDate: null,
      appliedPrincipleIds: ["principle-1"],
      appliedPrinciples: [{ id: "principle-1", title: "先验证边界再扩大投入", status: "accepted" }],
    }]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByRole("button", { name: /缓存层放在哪一侧/u }));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByRole("button", { name: "先验证边界再扩大投入" })).toBeEnabled();

    await user.click(details.getByRole("button", { name: "更新结果" }));
    // Clicked, either left for 方法论 and the outcome being written went with the page.
    expect(details.getByRole("button", { name: "先验证边界再扩大投入" })).toBeDisabled();
    expect(details.getByRole("button", { name: "用于提炼原则" })).toBeDisabled();
  });

  it("saves an outcome with the version of the note its editor opened at", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "decision-versioned", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision",
      question: "缓存层放在哪一侧？", selectedAnswer: "先放在读取端", rationaleStatus: "captured", rationale: "可回退。",
      context: null, outcome: "上线后命中率 80%", outcomeReview: null, reviewDueDate: null,
      appliedPrincipleIds: [], appliedPrinciples: [], contentHash: "hash-opened",
    }]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByRole("button", { name: /缓存层放在哪一侧/u }));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    await user.click(details.getByRole("button", { name: "更新结果" }));
    await user.type(details.getByRole("textbox", { name: "结果说明" }), "，一周后回落到 60%");
    await user.click(details.getByRole("button", { name: "保存结果" }));

    // Saved without it, what was written into the note in Obsidian meanwhile was written over without a word.
    await waitFor(() => expect(api.updateDecisionOutcome).toHaveBeenCalledWith(
      "decision-versioned", "上线后命中率 80%，一周后回落到 60%", "hash-opened",
    ));
  });

  it("copies the list as filtered as Markdown under one heading", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const decision = (id: string, question: string): DecisionLibraryItem => ({
      id,
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question,
      selectedAnswer: `${question}的答案`,
      rationaleStatus: "captured",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([
      decision("first", "第一个问题？"),
      decision("second", "第二个问题？"),
    ]);
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await renderDecisionLibrary(api);
    await user.click(
      await screen.findByRole("button", { name: "把这 2 条决策复制为 Markdown" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^## 决策记录（2 条）\n\n### 第一个问题？\n[\s\S]*\n### 第二个问题？\n/u),
    );
    expect(await screen.findByText("已复制 2 条为 Markdown")).toBeVisible();
  });

  it("filters by how a review turned out, in place of a progress state", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    const review = await screen.findByRole("combobox", {
      name: "按复盘进度或结论筛选",
    });
    await user.selectOptions(review, "reviewed");
    await user.selectOptions(review, "verdict:worse");
    expect(review).toHaveValue("verdict:worse");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.objectContaining({ outcomeVerdict: "worse" }),
      ),
    );
    expect(api.listDecisions).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ reviewState: expect.anything() }),
    );

    await user.selectOptions(review, "due");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.objectContaining({ reviewState: "due" }),
      ),
    );
    expect(api.listDecisions).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ outcomeVerdict: expect.anything() }),
    );

    // The batch of expectations still worth writing, one after another.
    await user.selectOptions(review, "expectation_missing");
    await waitFor(() =>
      expect(api.listDecisions).toHaveBeenLastCalledWith(
        expect.objectContaining({ reviewState: "expectation_missing" }),
      ),
    );
  });

  it("lists the locally matched principles first without checking them", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    vi.mocked(api.listDecisions).mockResolvedValue([
      {
        id: "decision-plain",
        created: "2026-07-30T03:04:00.000Z",
        sourceClient: "codex",
        project: "decision",
        question: "发布前要不要先灰度？",
        selectedAnswer: "先灰度一周",
        rationaleStatus: "captured",
        rationale: "回退成本高。",
        context: null,
        outcome: null,
        outcomeReview: null,
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
    ]);
    vi.mocked(api.listMethodologies).mockResolvedValue([
      acceptedMethodologyFixture({ id: "principle-a", title: "先稳定骨架" }),
      acceptedMethodologyFixture({ id: "principle-b", title: "先验证回退路径" }),
    ]);
    vi.mocked(api.getDecisionPrincipleSuggestions).mockResolvedValue([
      {
        id: "principle-b",
        title: "先验证回退路径",
        principle: "先确认能回退。",
        appliesWhen: "改动难以撤回时。",
        caution: "",
        score: 38,
        strength: "strong",
        reason: "适用条件与当前决策存在文本重合。",
        matchedTerms: ["回退"],
      },
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("发布前要不要先灰度？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    await user.click(details.getByRole("button", { name: "关联原则" }));

    const boxes = await details.findAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
      "先验证回退路径强相关 · 适用条件与当前决策存在文本重合。",
      "先稳定骨架",
    ]);
    expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    expect(api.getDecisionPrincipleSuggestions).toHaveBeenCalledWith({
      question: "发布前要不要先灰度？",
      selectedAnswer: "先灰度一周",
      optionLabels: [],
      context: null,
    });
  });

  it("says when the decision it was asked to open is no longer there", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockImplementation(async (query) => (query.decisionId === undefined ? [{
      id: "decision-1", created: "2026-09-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "缓存策略应该如何调整？", selectedAnswer: "本地缓存",
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }] : []));
    const consumed = vi.fn();
    render(<DecisionLibraryPanel api={api} totalDecisions={1} initialDecisionId="decision-deleted" onInitialNavigationConsumed={consumed} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);

    await waitFor(() => expect(consumed).toHaveBeenCalled());
    expect(await screen.findByText("要打开的决策已不在知识库里，笔记可能已被删除或移动")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();

    // Opening one since: the notice was of the arrival, and stood beside the record opened.
    await userEvent.setup().click(await screen.findByText("缓存策略应该如何调整？"));
    await screen.findByRole("dialog", { name: "决策详情" });
    expect(screen.queryByText("要打开的决策已不在知识库里，笔记可能已被删除或移动")).toBeNull();
  });

  it("keeps 记录已保存 while the decision just recorded is shown, and lets it go with the next record", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (id: string, question: string): DecisionLibraryItem => ({
      id, created: "2026-09-01T03:04:00.000Z", sourceClient: "manual", project: "decision", question, selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null,
      appliedPrincipleIds: [], appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.decisionId === undefined ? [item("A", "问题 A")] : [item(query.decisionId, "新记录")]);
    vi.mocked(api.createProactiveRecord).mockResolvedValue({
      recordVersion: 1, status: "created", recordKind: "decision", recordId: "new-1",
      knowledgeStatus: "active", sensitivity: "private", storedTranscript: false,
    });
    // As App does on onRecorded: the recorded decision opened through the panel's arrival, the panel kept mounted.
    const Page = () => {
      const [arriving, setArriving] = useState<string | null>(null);
      return <DecisionLibraryPanel api={api} totalDecisions={1} initialDecisionId={arriving} onInitialNavigationConsumed={() => setArriving(null)}
        onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={(result) => setArriving(result.recordId)} />;
    };
    render(<Page />);
    await screen.findByText("问题 A");
    fireEvent.click(screen.getByRole("button", { name: "主动记录" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "列表分页用游标还是偏移？" } });
    fireEvent.change(screen.getByLabelText("最终选择"), { target: { value: "统一用游标分页" } });
    fireEvent.change(screen.getByLabelText("项目"), { target: { value: "mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));

    await waitFor(() => expect(api.listDecisions).toHaveBeenCalledWith(expect.objectContaining({ decisionId: "new-1" })));
    await screen.findByRole("dialog", { name: "决策详情" });
    // Cleared by the arrival it set off itself, then by the record it opened: never shown.
    expect(screen.getByText("记录已保存")).toBeInTheDocument();

    // Another record opened: it was said of the one recorded.
    fireEvent.click(screen.getByRole("button", { name: "关闭决策详情" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull());
    fireEvent.click(await screen.findByText("问题 A"));
    await screen.findByRole("dialog", { name: "决策详情" });
    expect(screen.queryByText("记录已保存")).toBeNull();
  });

  it("leaves the record the reader opened while the one it was asked to open was still being read", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (id: string, question: string): DecisionLibraryItem => ({
      id, created: "2026-09-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question, selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    let land!: (items: DecisionLibraryItem[]) => void;
    vi.mocked(api.listDecisions).mockImplementation((query) =>
      query.decisionId === undefined ? Promise.resolve([item("A", "问题 A"), item("B", "问题 B")]) : new Promise((resolve) => { land = resolve; }));
    render(<DecisionLibraryPanel api={api} totalDecisions={2} initialDecisionId="A" onInitialNavigationConsumed={vi.fn()} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);

    await userEvent.setup().click(await screen.findByText("问题 B"));
    await act(async () => land([item("A", "问题 A")]));
    // Landing after, it put A over the B just opened.
    expect(within(screen.getByRole("dialog", { name: "决策详情" })).getByRole("heading", { name: "问题 B" })).toBeVisible();
  });

  it("says a list at its limit shows the newest so many, not all of them", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (index: number): DecisionLibraryItem => ({
      id: `decision-${index}`, created: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(), sourceClient: "codex", project: "decision",
      question: `问题 ${index}`, selectedAnswer: "答案", rationaleStatus: "captured", rationale: "理由", context: null,
      outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    // 350 recorded; a list query returns at most 200.
    vi.mocked(api.listDecisions).mockImplementation(async (query) => Array.from({ length: Math.min(query.limit ?? 100, 350) }, (_, index) => item(index)));
    await renderDecisionLibrary(api);

    expect(await screen.findByText("最近 200 条")).toBeVisible();
    expect(screen.queryByText("200 条结果")).toBeNull();
  });

  it("calls a searched list at its limit the best matching only where it was ranked so", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (index: number): DecisionLibraryItem => ({
      id: `decision-${index}`, created: new Date(Date.UTC(2026, 0, 1) + index * 3_600_000).toISOString(), sourceClient: "codex", project: "decision",
      question: `问题 ${index}`, selectedAnswer: "答案", rationaleStatus: "captured", rationale: "理由", context: null,
      outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockImplementation(async (query) => Array.from({ length: Math.min(query.limit ?? 100, 350) }, (_, index) => item(index)));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.type(await screen.findByRole("searchbox", { name: "搜索决策与笔记" }), "问题");

    // Matched by keywords alone (a two-character word is listed newest first): not "最相关".
    expect(await screen.findByText("前 200 条 · 关键词匹配")).toBeVisible();
    expect(screen.queryByText(/最相关的 200 条/u)).toBeNull();
  });

  it("keeps a slow principle ranking for the record left behind out of the editor opened on the next", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const item = (id: string, question: string): DecisionLibraryItem => ({
      id, created: "2026-09-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question, selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([item("A", "缓存问题"), item("B", "协议问题")]);
    vi.mocked(api.listMethodologies).mockResolvedValue([
      acceptedMethodologyFixture({ id: "p1", title: "先验证边界" }),
      acceptedMethodologyFixture({ id: "p2", title: "协议向后兼容" }),
    ]);
    const suggestion = (id: string, title: string, reason: string) => ({
      id, title, principle: "", appliesWhen: "", caution: "", score: 30, strength: "strong" as const, reason, matchedTerms: [],
    });
    let answerA!: (value: Array<ReturnType<typeof suggestion>>) => void;
    vi.mocked(api.getDecisionPrincipleSuggestions).mockImplementation((input) =>
      input.question === "缓存问题"
        ? new Promise((resolve) => { answerA = resolve; })
        : Promise.resolve([suggestion("p2", "协议向后兼容", "B：协议字段变更")]));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("缓存问题"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    await user.click(details.getByRole("button", { name: "关联原则" }));
    // Not waited for: on to the next record, and the same editor there.
    await user.click(details.getByRole("button", { name: "取消" }));
    await user.click(details.getByRole("button", { name: "下一条决策" }));
    await details.findByText("协议问题", { selector: "h3" });
    await user.click(details.getByRole("button", { name: "关联原则" }));
    expect(await details.findByText(/B：协议字段变更/u)).toBeVisible();

    await act(async () => answerA([suggestion("p1", "先验证边界", "A：缓存失效")]));

    expect(details.getByText(/B：协议字段变更/u)).toBeVisible();
    expect(details.queryByText(/A：缓存失效/u)).toBeNull();
  });

  it("shows the other times the same question was decided", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const decision = (
      id: string,
      question: string,
      selectedAnswer: string,
    ): DecisionLibraryItem => ({
      id,
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question,
      selectedAnswer,
      rationaleStatus: "captured",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([
      decision("now", "发布窗口放在周几？", "周二"),
      {
        ...decision("before", "发布窗口 放在周几?", "周四"),
        outcome: "周四发布赶上了周末值班空档。",
        outcomeReview: {
          verdict: "worse",
          lesson: null,
          reviewedAt: "2026-08-02T03:04:00.000Z",
        },
      },
      decision("unrelated", "发布前要不要灰度？", "要"),
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("发布窗口放在周几？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    const same = await details.findByRole("region", { name: "同一问题的其它决定 · 1" });
    expect(api.listDecisions).toHaveBeenCalledWith({ query: "发布窗口放在周几", limit: 50 });
    expect(within(same).getByText(/答案不同/u)).toBeVisible();
    // How the earlier answer turned out is what makes it worth a look.
    expect(within(same).getByText("低于预期")).toBeVisible();
    expect(within(same).queryByText("要")).toBeNull();

    await user.click(within(same).getByRole("button", { name: /周四/u }));
    expect(details.getByText("周四")).toBeVisible();
  });

  it("looks up a long question's other decisions with no more than a search takes", async () => {
    const question = `离线优先的桌面客户端里，${"缓存与同步要兼顾冲突解决、回滚和索引重建，".repeat(12)}应该怎么取舍？`;
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([
      { id: "now", created: "2026-07-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question, selectedAnswer: "本地优先", rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [] },
    ]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText(question));

    // Longer than 200, the search was refused at the boundary and the history quietly left out.
    await waitFor(() => expect(api.listDecisions).toHaveBeenCalledWith({ query: question.slice(0, 200), limit: 50 }));
  });

  it("shows every other decision on the same question when asked", async () => {
    const same = (id: string, day: number): DecisionLibraryItem => ({
      id,
      created: `2026-07-0${day}T03:04:00.000Z`,
      sourceClient: "codex",
      project: "decision",
      question: "发布窗口放在周几？",
      selectedAnswer: `周${day}`,
      rationaleStatus: "captured",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.listDecisions).mockResolvedValue([same("a", 1), same("b", 2), same("c", 3), same("d", 4), same("e", 5), same("f", 6)]);
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click((await screen.findAllByText("发布窗口放在周几？"))[0]!);
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    const region = await details.findByRole("region", { name: "同一问题的其它决定 · 5" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    await user.click(within(region).getByRole("button", { name: "另有 2 次，全部显示" }));
    expect(within(region).getAllByRole("listitem")).toHaveLength(5);
    // The button stays, as the way back: focus is not dropped out of the dialog.
    const fold = within(region).getByRole("button", { name: "收起" });
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(fold).toHaveFocus();
    await user.click(fold);
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
  });

  it("keeps its place when a completed record leaves the filtered list", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const pending = (id: string, question: string): DecisionLibraryItem => ({
      id,
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question,
      selectedAnswer: `${question}的答案`,
      rationaleStatus: "deferred",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    let completed = 0;
    vi.mocked(api.listDecisions).mockImplementation(async () =>
      [pending("first", "第一个问题？"), pending("second", "第二个问题？")].slice(
        completed,
      ),
    );
    vi.mocked(api.submitRationale).mockImplementation(async () => {
      completed += 1;
    });
    const user = userEvent.setup();

    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("第一个问题？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    await user.click(details.getByRole("button", { name: "补充理由" }));
    await user.type(details.getByRole("textbox", { name: "理由原文" }), "已经想清楚了。");
    await user.click(details.getByRole("button", { name: "保存理由" }));

    expect(await details.findByText("– / 1")).toBeVisible();
    await user.click(details.getByRole("button", { name: "下一条决策" }));
    expect(details.getByText("第二个问题？的答案")).toBeVisible();
    // One record left: nothing to step to, so the control goes away.
    expect(details.queryByRole("group", { name: "逐条查看" })).toBeNull();

    // Finishing the last one empties the list; no "– / 0" to step through.
    await user.click(details.getByRole("button", { name: "补充理由" }));
    await user.type(details.getByRole("textbox", { name: "理由原文" }), "也想清楚了。");
    await user.click(details.getByRole("button", { name: "保存理由" }));
    await waitFor(() => expect(api.submitRationale).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(details.queryByText("– / 0")).toBeNull());
    expect(details.queryByRole("group", { name: "逐条查看" })).toBeNull();
  });

  it("lists a decision saved from elsewhere as soon as the count includes it", async () => {
    const { api, emit } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const fresh: DecisionLibraryItem = {
      id: "new-decision",
      created: "2026-09-30T03:04:00.000Z",
      sourceClient: "manual",
      project: "decision",
      question: "新保存的决定",
      selectedAnswer: "先灰度",
      rationaleStatus: "deferred",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    let stored = false;
    vi.mocked(api.listDecisions).mockImplementation(async () => (stored ? [fresh] : []));
    await renderDecisionLibrary(api);

    // Saved with ⌘N, which tells the page nothing: only the snapshot's count moves.
    stored = true;
    act(() => emit(rationaleSnapshot({
      current: null,
      primarySurface: "decisions",
      dashboard: { totalDecisions: 1, recorded7d: 1, reviewAttention: 0, recentDecisions: [] },
    })));

    expect(await within(screen.getByRole("region", { name: "知识" })).findByRole("button", { name: /新保存的决定/u })).toBeVisible();
  });

  it("focuses the decision search with the slash key", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    const search = await screen.findByRole("searchbox", { name: "搜索决策与笔记" });
    expect(search).not.toHaveFocus();
    await user.keyboard("/");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");

    await user.keyboard("a/b");
    expect(search).toHaveValue("a/b");
  });

  it("says a rationale put off waits on the home page, rather than that all are written", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "decisions",
        dashboard: { totalDecisions: 3, recorded7d: 0, reviewAttention: 0, recentDecisions: [] },
        // Put off in the rationale panel: in the app's own queue, not yet in the library.
        pendingRationales: [{
          id: "decision-local", question: "缓存层放在哪一侧？", created: "2026-09-28T00:00:00.000Z", project: "decision",
          sourceClient: "codex", selectedAnswer: "读取端", contextSummary: null, capturedQuestion: null,
        }],
      }),
    );
    vi.mocked(api.listDecisions).mockResolvedValue([]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.click(await screen.findByRole("button", { name: "待补理由" }));
    expect(await screen.findByText("还有 1 条理由待补，在首页")).toBeVisible();
    expect(screen.queryByText("待补的理由都补完了")).toBeNull();
    await user.click(screen.getByRole("button", { name: "去首页补充" }));
    expect(api.openSurface).toHaveBeenLastCalledWith("dashboard");
  });

  it("calls an emptied to-do list finished rather than a miss", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "decisions",
        dashboard: {
          totalDecisions: 3,
          recorded7d: 0,
          reviewAttention: 0,
          recentDecisions: [],
        },
      }),
    );
    vi.mocked(api.listDecisions).mockResolvedValue([]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.click(await screen.findByRole("button", { name: "待补理由" }));
    expect(await screen.findByText("待补的理由都补完了")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "全部" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "按复盘进度或结论筛选" }),
      "expectation_missing",
    );
    expect(await screen.findByText("该写的预期都写好了")).toBeVisible();
    // Another filter still hides the rest: only this slice is done.
    await user.selectOptions(
      screen.getByRole("combobox", { name: "按记录时间筛选" }),
      "7",
    );
    expect(await screen.findByText("当前筛选下，该写的预期都写好了")).toBeVisible();
    // A search that finds nothing is still a miss.
    await user.type(screen.getByRole("searchbox", { name: "搜索决策与笔记" }), "缓存");
    expect(await screen.findByText("没有匹配结果")).toBeVisible();
  });

  it("explains filtered empty results and clears filters in one click", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    vi.mocked(api.listDecisions).mockResolvedValue([]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    expect(await screen.findByText("还没有决策")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "清除关键词与筛选" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "待补理由" }));
    expect(await screen.findByText("没有匹配结果")).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "搜索决策与笔记" }), "缓存");

    await user.click(screen.getByRole("button", { name: "清除关键词与筛选" }));
    expect(await screen.findByText("还没有决策")).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "搜索决策与笔记" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "待补理由" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("browses decision rows from the search box with the keyboard", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const decisionRow = (id: string, question: string): DecisionLibraryItem => ({
      id,
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question,
      selectedAnswer: "使用可清理的本地缓存",
      rationaleStatus: "captured",
      rationale: "便于恢复。",
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([
      decisionRow("decision-a", "缓存策略应该如何调整？"),
      decisionRow("decision-b", "是否引入第二份数据库？"),
    ]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    const search = await screen.findByRole("searchbox", { name: "搜索决策与笔记" });
    const first = await screen.findByRole("button", {
      name: /缓存策略应该如何调整/u,
    });
    const second = screen.getByRole("button", { name: /是否引入第二份数据库/u });

    await user.keyboard("/");
    expect(search).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
    await user.keyboard("{End}");
    expect(second).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(search).toHaveFocus();

    await user.keyboard("{ArrowDown}{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "决策详情" });
    expect(within(dialog).getByText("缓存策略应该如何调整？")).toBeVisible();
  });

  it("clears the decision search with Escape", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    const search = await screen.findByRole("searchbox", { name: "搜索决策与笔记" });
    await user.type(search, "缓存");
    expect(screen.getByRole("button", { name: "清空搜索" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("button", { name: "清空搜索" })).toBeNull();
  });

  it("says which decision the detail stepped to, and only when it is stepped", async () => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "decisions" });
    const { api, emit } = apiFixture(snapshot);
    const item = (id: string, question: string): DecisionLibraryItem => ({
      id, created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision", question, selectedAnswer: `${question}的答案`,
      rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null,
      appliedPrincipleIds: [], appliedPrinciples: [],
    });
    vi.mocked(api.listDecisions).mockResolvedValue([item("a", "缓存放在哪一层？"), item("b", "协议用哪个版本？")]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.click(await screen.findByText("缓存放在哪一层？"));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    const said = (): string => details.getAllByRole("status").map((node) => node.textContent).join("|");

    details.getByRole("button", { name: "下一条决策" }).focus();
    await user.keyboard("{Enter}");

    // The whole record swapped under the button, and nothing a screen reader hears said which one it is now.
    expect(said()).toContain("第 2 / 2 条：协议用哪个版本？");

    // An agent records a decision meanwhile: the list read again moves the open record, and nobody stepped.
    vi.mocked(api.listDecisions).mockResolvedValue([item("c", "新的决策？"), item("a", "缓存放在哪一层？"), item("b", "协议用哪个版本？")]);
    await act(async () => {
      emit({ ...snapshot, dashboard: { ...snapshot.dashboard, revision: 1, totalDecisions: 3 } });
    });
    await waitFor(() => expect(details.getByText("3 / 3")).toBeVisible());
    // As a live counter, the move spoke over whatever the reader was doing.
    expect(said()).not.toContain("3 / 3");
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')).toBeNull();

    // Closed, then the same decision opened again from the list: nothing stepped, and nothing says it was.
    await user.click(details.getByRole("button", { name: "关闭决策详情" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull());
    await user.click(await screen.findByText("协议用哪个版本？"));
    const reopened = within(await screen.findByRole("dialog", { name: "决策详情" }));
    expect(reopened.getAllByRole("status").map((node) => node.textContent).join("|")).not.toMatch(/第 \d+ \/ \d+ 条/u);
  });

  it("does not list the last decision's same-question answers under the next one while its own are read", async () => {
    const item = (id: string, question: string, selectedAnswer: string, created = "2026-09-01T03:04:00.000Z"): DecisionLibraryItem => ({
      id, created, sourceClient: "codex", project: "decision", question, selectedAnswer,
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    });
    const cache = item("A", "缓存放哪一侧", "读取端");
    const earlier = item("A0", "缓存放哪一侧", "写入端", "2026-08-01T03:04:00.000Z");
    const listDecisions = vi.fn((query: { query: string }) =>
      query.query.startsWith("缓存") ? Promise.resolve([cache, earlier]) : new Promise<DecisionLibraryItem[]>(() => undefined));
    const { rerender } = render(<SameQuestionDecisions api={{ listDecisions } as never} decision={cache} onOpen={vi.fn()} />);
    expect(await screen.findByText("同一问题的其它决定 · 1")).toBeInTheDocument();

    // Stepped to another decision, whose own read is slow: A's earlier answer was listed under it, set against its answer.
    await act(async () => {
      rerender(<SameQuestionDecisions api={{ listDecisions } as never} decision={item("B", "协议要不要版本号", "要")} onOpen={vi.fn()} />);
    });
    expect(screen.queryByText("同一问题的其它决定 · 1")).toBeNull();
    expect(screen.queryByText("写入端")).toBeNull();
  });
});
