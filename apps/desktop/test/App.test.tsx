// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelInvocationTrace } from "@cognelis/decision-protocol";
import type {
  MethodologyQualityAssessment,
  MethodologySuggestion,
} from "@cognelis/decision-core";
import type {
  AppSnapshot,
  DecisionLibraryItem,
  DecisionApi,
  MethodologyItem,
  MethodologyValidationItem,
  PracticeAssetItem,
} from "../src/shared/renderer-api.js";
import { pendingWorkTotal } from "../src/shared/renderer-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureTray } from "../src/main/tray.js";
import { App } from "../src/renderer/App.js";
import { serverCaptureFixture } from "./fixtures.js";
import {
  acceptedMethodologyFixture,
  apiFixture,
  candidate,
  contextualCandidate,
  methodologyQuality,
  modelTraceFixture,
  rationaleSnapshot,
  reviewCandidate,
} from "./app-fixtures.js";

afterEach(cleanup);


describe("App", () => {
  it("retains a captured choice locally with its rationale and expectation", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.type(await screen.findByRole("textbox", { name: "补充说明（可选）" }), "当前项目约束");
    await user.type(screen.getByRole("textbox", { name: "预期结果（可选）" }), "验证业务效果");
    await user.click(screen.getByRole("button", { name: "仅本机保留" }));
    expect(api.submitRationale).toHaveBeenCalledWith({ candidateId: "candidate-1", status: "local_only", rationale: "当前项目约束", expectedOutcome: "验证业务效果" });
  });

  it("retries a failed initial snapshot without reloading the window", async () => {
    const initial = rationaleSnapshot({
      current: null,
      primarySurface: "dashboard",
    });
    const { api } = apiFixture(initial);
    vi.mocked(api.getSnapshot)
      .mockRejectedValueOnce(new Error("private /vault path"))
      .mockResolvedValueOnce(initial);
    const user = userEvent.setup();

    render(<App api={api} />);

    const alert = await screen.findByRole("alert", {
      name: "应用状态加载失败",
    });
    expect(alert).toHaveTextContent("暂时无法读取应用状态，请重试。");
    expect(alert).not.toHaveTextContent("/vault");

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(
      await screen.findByRole("region", { name: "首页" }),
    ).toBeVisible();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.onSnapshot).toHaveBeenCalledOnce();
  });

  it("reviews a medium-confidence candidate without consuming it on close", async () => {
    const review = reviewCandidate();
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: {
          position: 1,
          total: 2,
        },
        decisionCandidates: {
          current: review,
          count: 2,
        },
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByRole("region", {
        name: "待处理决策",
      }),
    ).toBeVisible();
    expect(screen.getByText("待处理 1 / 2")).toBeVisible();
    expect(
      screen.queryByRole("heading", {
        name: "这是一个需要记录的决策吗？",
      }),
    ).toBeNull();
    expect(screen.queryByText("本地识别 · 尚未写入 Obsidian")).toBeNull();
    expect(screen.getByRole("heading", { name: "原文" })).toBeVisible();
    expect(screen.getByText("先规则后模型")).toBeVisible();
    expect(screen.getByText("继续开发 Decision。")).toBeVisible();
    expect(
      within(screen.getByLabelText("你的回答")).getByText("Loopback HTTP"),
    ).toBeVisible();
    // Among the options, the one answered is marked; the others are not.
    const options = within(screen.getByRole("list", { name: "相关选项" }));
    expect(options.getByText("已选").closest("li")).toHaveTextContent("Loopback HTTP");
    expect(options.getAllByText("已选")).toHaveLength(1);
    // An Escape that only ends an input method's composition (in the find bar, say) is not 稍后.
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(api.closeCandidateReview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "稍后" }));

    expect(api.closeCandidateReview).toHaveBeenCalledOnce();
    expect(api.confirmCandidate).not.toHaveBeenCalled();
    expect(api.ignoreCandidate).not.toHaveBeenCalled();
  });

  it("confirms or ignores the current review candidate", async () => {
    const firstCandidate = reviewCandidate();
    const first = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: {
          position: 1,
          total: 1,
        },
        decisionCandidates: {
          current: firstCandidate,
          count: 1,
        },
      }),
    );
    const user = userEvent.setup();
    const rendered = render(<App api={first.api} />);

    await user.click(
      await screen.findByRole("button", {
        name: "记录并补充理由",
      }),
    );
    expect(first.api.confirmCandidate).toHaveBeenCalledWith(
      firstCandidate.candidateId,
    );

    rendered.unmount();
    const secondCandidate = reviewCandidate();
    const second = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: {
          position: 1,
          total: 1,
        },
        decisionCandidates: {
          current: secondCandidate,
          count: 1,
        },
      }),
    );
    render(<App api={second.api} />);
    await user.click(
      await screen.findByRole("button", {
        name: "忽略",
      }),
    );
    expect(second.api.ignoreCandidate).toHaveBeenCalledWith(
      secondCandidate.candidateId,
    );
  });

  it("confirms the review candidate with Cmd/Ctrl+Enter", async () => {
    const candidate = reviewCandidate();
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: { position: 1, total: 1 },
        decisionCandidates: { current: candidate, count: 1 },
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    const confirm = await screen.findByRole("button", {
      name: "记录并补充理由",
    });
    expect(confirm).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Enter Control+Enter",
    );
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(api.confirmCandidate).toHaveBeenCalledWith(candidate.candidateId);
    expect(confirm).toBeDisabled();

    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(api.confirmCandidate).toHaveBeenCalledOnce();
  });

  it("does not resubmit a candidate while its failed action is waiting to retry", async () => {
    const review = reviewCandidate();
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: { position: 1, total: 1 },
        decisionCandidates: {
          current: review,
          count: 1,
          persistenceStatus: "failed",
        },
      }),
    );
    const user = userEvent.setup();
    vi.mocked(api.retryCandidate).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'decision:retry-candidate'",
      ),
    );

    render(<App api={api} />);

    const confirm = await screen.findByRole("button", {
      name: "记录并补充理由",
    });
    const ignore = screen.getByRole("button", { name: "忽略" });
    const retry = screen.getByRole("button", { name: "重试" });

    expect(confirm).toBeDisabled();
    expect(ignore).toBeDisabled();
    expect(retry).toBeEnabled();
    expect(
      screen.getByText(
        "候选状态暂时无法保存。可以重试，或点“稍后”退出，内容仍会保留。",
      ),
    ).toBeVisible();
    await user.click(confirm);
    expect(api.confirmCandidate).not.toHaveBeenCalled();
    await user.click(retry);
    expect(
      await screen.findByText("候选仍未保存，请重试或稍后处理。"),
    ).toBeVisible();
    expect(
      screen.queryByText(/Error invoking remote method/u),
    ).toBeNull();
  });

  it("submits a candidate action only once on rapid repeated activation", async () => {
    const review = reviewCandidate();
    let finishConfirm: (() => void) | undefined;
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        candidateReviewOpen: true,
        candidateReviewProgress: { position: 1, total: 1 },
        decisionCandidates: { current: review, count: 1 },
      }),
    );
    vi.mocked(api.confirmCandidate).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishConfirm = resolve;
        }),
    );

    render(<App api={api} />);

    const confirm = await screen.findByRole("button", {
      name: "记录并补充理由",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(api.confirmCandidate).toHaveBeenCalledTimes(1);
    finishConfirm?.();
  });

  it("shows captured context in a dialog without expanding the rationale surface", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: contextualCandidate(),
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(await screen.findByText("继续开发 Decision。")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "任务背景" })).toBeNull();
    expect(screen.getByText("上下文已截断")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "查看完整上下文" }));
    const contextDialog = within(
      screen.getByRole("dialog", { name: "当时上下文" }),
    );
    expect(
      contextDialog.getByRole("heading", { name: "任务背景" }),
    ).toBeVisible();
    expect(
      contextDialog.getByRole("heading", { name: "约束与考虑" }),
    ).toBeVisible();

    await user.click(
      contextDialog.getByRole("button", { name: "关闭当时上下文" }),
    );
    expect(screen.queryByRole("heading", { name: "任务背景" })).toBeNull();
  });

  it("renders no empty context disclosure", async () => {
    const { api } = apiFixture(rationaleSnapshot());

    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", {
        name: "已选答案",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看完整上下文" })).toBeNull();
  });

  it("shows the native answer and never renders choice controls", async () => {
    const { api } = apiFixture(rationaleSnapshot());

    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", {
        name: "已选答案",
      }),
    ).toBeVisible();
    expect(screen.getByText("选择本地服务协议")).toBeVisible();
    const selected = screen.getByRole("list", {
      name: "已选答案",
    });
    expect(
      within(selected).getByText("Loopback HTTP"),
    ).toBeVisible();
    expect(
      within(selected).getByText("跨平台且便于诊断"),
    ).toBeVisible();
    const alternatives = screen.getByRole("list", {
      name: "当时的其它候选",
    });
    expect(within(alternatives).getByText("Unix Socket")).toBeVisible();
    expect(
      within(alternatives).getByText("不占 TCP 端口"),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "补充判断依据",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", {
        name: "已选答案",
        description: "原生选择不会被改变；这里只补充判断依据。",
      }),
    ).toBeVisible();
    expect(screen.queryByText("为什么这样选？")).toBeNull();
    expect(screen.queryByLabelText("可选方案")).toBeNull();
    expect(screen.queryByText("返回")).toBeNull();
    expect(screen.getByTestId("decision-shell")).toHaveClass(
      "desktop-view",
      "decision-workspace",
    );
    expect(screen.getByTestId("decision-shell")).toHaveAttribute(
      "data-layout",
      "desktop",
    );
  });

  it("returns to the answer when the next rationale candidate opens", async () => {
    const { api, emit } = apiFixture(rationaleSnapshot());

    render(<App api={api} />);

    const firstWorkspace = await screen.findByTestId("decision-shell");
    firstWorkspace.scrollTop = 320;
    emit(
      rationaleSnapshot({
        current: {
          ...candidate(),
          candidateId: "candidate-2",
          candidateKey: "candidate-key-2",
        },
      }),
    );

    await waitFor(() => {
      const nextWorkspace = screen.getByTestId("decision-shell");
      expect(nextWorkspace).not.toBe(firstWorkspace);
      expect(nextWorkspace.scrollTop).toBe(0);
    });
  });

  it("lets the user explicitly attach a locally matched accepted principle", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const principle = acceptedMethodologyFixture();
    vi.mocked(api.getDecisionPrincipleSuggestions).mockResolvedValue([
      {
        id: principle.id,
        title: principle.title,
        principle: principle.principle,
        appliesWhen: principle.appliesWhen,
        caution: principle.caution,
        score: 31,
        strength: "strong",
        reason: "原则内容与当前决策存在文本重合。",
        matchedTerms: ["边界"],
      },
    ]);
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByRole("heading", { name: "核对相关原则" }),
    ).toBeVisible();
    expect(screen.getByText("选择已完成，仅用于核对依据")).toBeVisible();
    await waitFor(() =>
      expect(api.getDecisionPrincipleSuggestions).toHaveBeenCalledWith({
        question: "选择本地服务协议",
        selectedAnswer: "Loopback HTTP",
        optionLabels: ["Loopback HTTP", "Unix Socket"],
        context: null,
      }),
    );

    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(principle.title, "u"),
      }),
    );
    expect(screen.getByText("已标记 1 条，将随决策保存。")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "记录到知识库" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      appliedPrincipleIds: [principle.id],
    });
  });

  it("preserves typed rationale when factors are selected", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const rationale = await screen.findByRole("textbox", {
      name: "补充说明（可选）",
    });
    await user.type(rationale, "  更容易诊断，也便于跨平台。  ");
    await user.click(screen.getByRole("button", { name: "复用现有能力" }));
    await user.click(screen.getByRole("button", { name: "记录到知识库" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      rationale: "  更容易诊断，也便于跨平台。  ",
      reasonFactors: ["reuse"],
    });
  });

  it("records the expected outcome written while the choice is fresh", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const expected = await screen.findByRole("textbox", { name: "预期结果（可选）" });
    await user.type(expected, "  本地连接不再被代理拦截。 ");
    // With no rationale, knowledge recording marks it skipped rather than inventing a reason.
    expect(screen.getByRole("button", { name: "记录到知识库" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "复用现有能力" }));
    await user.click(screen.getByRole("button", { name: "记录到知识库" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      reasonFactors: ["reuse"],
      expectedOutcome: "本地连接不再被代理拦截。",
    });
  });

  it("drafts the expectation from the chosen option's description on request", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const expected = await screen.findByRole("textbox", { name: "预期结果（可选）" });
    expect(expected).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "用所选方案的说明起稿" }));
    expect(expected).toHaveValue("跨平台且便于诊断");
    // Once there is text, the offer steps aside rather than overwrite it.
    expect(screen.queryByRole("button", { name: "用所选方案的说明起稿" })).toBeNull();
    await user.type(expected, "，一周内没有端口冲突");
    await user.click(screen.getByRole("button", { name: "复用现有能力" }));
    await user.click(screen.getByRole("button", { name: "记录到知识库" }));
    expect(api.submitRationale).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOutcome: "跨平台且便于诊断，一周内没有端口冲突",
      }),
    );
  });

  it("keeps factor-only rationale separate from user-authored text", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", { name: "遵循现有约定" }),
    );
    await user.click(screen.getByRole("button", { name: "记录到知识库" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      reasonFactors: ["consistency"],
    });
  });

  it("offers judgment factors derived from accumulated decision summaries", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    render(<App api={api} />);

    for (const label of [
      "遵循现有约定",
      "清晰易懂",
      "简单直接",
      "复用现有能力",
      "职责边界清晰",
      "可验证可追溯",
    ]) {
      expect(
        await screen.findByRole("button", { name: label }),
      ).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "实现成本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "时间" })).toBeNull();
  });

  it("discards in one click without recording the entered rationale", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const discard = await screen.findByRole("button", {
      name: "不保留",
    });
    expect(
      screen.queryByRole("checkbox", { name: "不保留" }),
    ).toBeNull();
    await user.type(
      screen.getByRole("textbox", { name: "补充说明（可选）" }),
      "这段理由不应保存。",
    );
    await user.click(screen.getByRole("button", { name: "复用现有能力" }));
    await user.click(discard);

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "not_recorded",
    });
    expect(discard).toBeDisabled();
    await user.click(discard);
    expect(api.submitRationale).toHaveBeenCalledOnce();
  });

  it("completes the rationale with Cmd/Ctrl+Enter from anywhere in the surface", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);

    const textbox = await screen.findByRole("textbox", {
      name: "补充说明（可选）",
    });
    const complete = screen.getByRole("button", { name: "记录到知识库" });
    expect(complete).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Enter Control+Enter",
    );

    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(api.submitRationale).not.toHaveBeenCalled();

    await user.type(textbox, "先验证再推广。");
    await user.click(screen.getByRole("button", { name: "复用现有能力" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "captured",
      rationale: "先验证再推广。",
      reasonFactors: ["reuse"],
    });
    expect(textbox).toHaveValue("先验证再推广。");

    expect(complete).toBeDisabled();
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(api.submitRationale).toHaveBeenCalledOnce();
  });

  it("keeps the rationale form disabled while it is saved, through a snapshot pushed meanwhile", async () => {
    const initial = rationaleSnapshot();
    const { api, emit } = apiFixture(initial);
    let finish: () => void = () => undefined;
    vi.mocked(api.submitRationale).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "复用现有能力" }));
    await user.click(screen.getByRole("button", { name: "记录到知识库" }));
    expect(screen.getByRole("button", { name: "记录到知识库" })).toBeDisabled();

    // The vault watcher pushes while the save is still under way: the form opened again under it, and a press on
    // 直接记录到知识库 then went nowhere.
    await act(async () => { emit({ ...initial, dashboard: { ...initial.dashboard, revision: 1 } }); });
    expect(screen.getByRole("button", { name: "记录到知识库" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "补充说明（可选）" })).toBeDisabled();

    // Done, with no other snapshot to follow: the form is the reader's again.
    await act(async () => { finish(); });
    expect(screen.getByRole("button", { name: "记录到知识库" })).toBeEnabled();
  });

  it("looks a decision up once for an arrival, however many snapshots are pushed meanwhile", async () => {
    const recent = { id: "A", created: "2026-09-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "问题 A", selectedAnswer: "答案", rationaleStatus: "captured" as const };
    const on = (primarySurface: "dashboard" | "decisions", revision = 0) => rationaleSnapshot({
      current: null, primarySurface,
      dashboard: { totalDecisions: 1, recorded7d: 1, reviewAttention: 0, recentDecisions: [recent], revision },
    });
    const { api, emit } = apiFixture(on("dashboard"));
    const lookups: Array<(items: DecisionLibraryItem[]) => void> = [];
    vi.mocked(api.listDecisions).mockImplementation((query) =>
      query.decisionId === undefined ? Promise.resolve([]) : new Promise((resolve) => { lookups.push(resolve); }));
    await act(async () => { render(<App api={api} />); });

    fireEvent.click(screen.getByRole("button", { name: /问题 A/u }));
    await act(async () => { emit(on("decisions")); });
    // The vault watcher, an agent's write: pushes that change nothing the arrival depends on. Each threw the lookup
    // under way away and asked again, and the record opened only once the pushes paused.
    await act(async () => { emit(on("decisions", 1)); });
    await act(async () => { emit(on("decisions", 2)); });
    expect(lookups).toHaveLength(1);

    await act(async () => { lookups[0]!([{ ...recent, rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [] }]); });
    expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();
  });

  it("drops the page a jump left once the tray opens another page", async () => {
    const on = (primarySurface: "models" | "decisions" | "activity") => rationaleSnapshot({ current: null, primarySurface });
    const { api, emit } = apiFixture(on("models"));
    vi.mocked(api.createProactiveRecord).mockResolvedValue({
      recordVersion: 1, status: "created", recordKind: "idea", recordId: "idea-new",
      knowledgeStatus: "inbox", sensitivity: "personal", storedTranscript: false,
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    // The shell's shortcut is there once its page is: pressed before, under load, nothing opened.
    await screen.findByRole("button", { name: /主动记录/u });
    await user.keyboard("{Meta>}n{/Meta}");
    const dialog = within(await screen.findByRole("dialog", { name: /主动记录/u }));
    await user.click(dialog.getByRole("button", { name: "想法" }));
    await user.type(dialog.getByLabelText("标题"), "缓存失效用事件驱动");
    await user.type(dialog.getByLabelText("想法内容"), "让写入端发事件。");
    await user.click(dialog.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(api.openSurface).toHaveBeenLastCalledWith("decisions"));
    await act(async () => { emit(on("decisions")); });

    // The tray's 日志 (the main process's openSurface, not this window's sidebar): 设置 then led back to 模型, the
    // page of a jump the reader had left behind.
    await act(async () => { emit(on("activity")); });
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(api.openSurface).toHaveBeenLastCalledWith("settings");
  });

  it("gives focus back inside an open dialog once a capture that had the window is done", async () => {
    const page = rationaleSnapshot({ current: null, primarySurface: "decisions" });
    const { api, emit } = apiFixture(page);
    vi.mocked(api.listDecisions).mockResolvedValue([{
      id: "A", created: "2026-09-01T03:04:00.000Z", sourceClient: "codex", project: "decision", question: "问题 A", selectedAnswer: "答案",
      rationaleStatus: "captured", rationale: "理由", context: null, outcome: null, outcomeReview: null, reviewDueDate: null,
      appliedPrincipleIds: [], appliedPrinciples: [],
    }]);
    const user = userEvent.setup();
    await act(async () => { render(<App api={api} />); });
    await user.click(await screen.findByText("问题 A"));
    const dialog = screen.getByRole("dialog", { name: "决策详情" });
    await user.click(within(dialog).getByRole("button", { name: "记录结果" }));
    await user.type(within(dialog).getByLabelText("结果说明"), "写到一半");

    // A capture takes the window (the page and its dialog kept out of sight), and is then done with.
    await act(async () => { emit({ ...page, current: candidate() }); });
    await act(async () => { emit({ ...page, current: null }); });

    // Focus went to the page's title behind the modal, where Escape and the dialog's Tab did not reach.
    const back = screen.getByRole("dialog", { name: "决策详情" });
    expect(within(back).getByLabelText("结果说明")).toHaveValue("写到一半");
    expect(within(back).getByLabelText("结果说明")).toHaveFocus();
  });

  it("allows later processing or skipping rationale", async () => {
    const first = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    const rendered = render(<App api={first.api} />);

    await user.click(await screen.findByRole("button", { name: "稍后处理" }));
    expect(first.api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "deferred",
    });

    rendered.unmount();
    const second = apiFixture(rationaleSnapshot());
    render(<App api={second.api} />);
    await user.click(await screen.findByRole("button", { name: "记录到知识库" }));
    expect(second.api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "skipped",
    });
  });

  it("keeps an expected outcome already written when the rationale is put off", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.type(await screen.findByLabelText("预期结果（可选）"), " 发布后错误率不升 ");
    await user.click(screen.getByRole("button", { name: "稍后处理" }));
    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "candidate-1",
      status: "deferred",
      expectedOutcome: "发布后错误率不升",
    });
  });

  it("keeps a rationale written before 稍后处理 for 补充理由 on the home page, until it is done", async () => {
    localStorage.clear();
    // Filed under a capture panel's per-run id, as drafts were before: never found again, nor deleted.
    localStorage.setItem("decision.deferredRationaleDrafts.v1", JSON.stringify({
      "6f1c2a0e-8a3b-4c55-9d0e-2b7f4c1d9e88": { rationale: "下个月要离职", reasonFactors: [] },
    }));
    const { api, emit } = apiFixture(rationaleSnapshot({ primarySurface: "dashboard" }));
    const user = userEvent.setup();
    render(<App api={api} />);
    const panel = await screen.findByRole("region", { name: "待补充决策理由" });
    await user.type(within(panel).getByRole("textbox", { name: "补充说明（可选）" }), "本地回环够用");
    await user.click(within(panel).getByRole("button", { name: "简单直接" }));
    await user.click(within(panel).getByRole("button", { name: "稍后处理" }));

    act(() => emit(rationaleSnapshot({
      current: null,
      primarySurface: "dashboard",
      dashboard: { totalDecisions: 1, recorded7d: 1, reviewAttention: 0, recentDecisions: [] },
      // Listed by the decision's id, as the home page lists it, not by the capture panel's per-run one.
      pendingRationales: [{
        id: "decision-candidate-key-1", question: "选择本地服务协议", created: new Date().toISOString(), project: "decision",
        sourceClient: "codex", selectedAnswer: "Loopback HTTP", contextSummary: null, capturedQuestion: null,
      }, {
        id: "decision-candidate-key-2", question: "选择缓存策略", created: "2026-09-01T00:00:00.000Z", project: "decision",
        sourceClient: "codex", selectedAnswer: "LRU", contextSummary: null, capturedQuestion: null,
      }],
    })));
    const row = (await screen.findByText("选择本地服务协议")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "补充理由" }));
    // Put off, what was written was dropped, and this dialog opened blank.
    const dialog = screen.getByRole("dialog", { name: "补充决策理由" });
    expect(within(dialog).getByRole("textbox", { name: "理由原文", description: "选择本地服务协议" })).toHaveValue("本地回环够用");
    expect(within(dialog).getByRole("button", { name: "简单直接" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("decision.deferredRationaleDrafts.v1")).not.toContain("下个月要离职");

    // Not recorded after all, through 批量处理: what was written goes with it.
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "批量处理" }));
    const batch = within(screen.getByRole("dialog"));
    await user.click(batch.getByRole("checkbox", { name: "选择选择本地服务协议" }));
    await user.click(batch.getByRole("button", { name: "不保留" }));
    await user.click(screen.getByRole("button", { name: "确认不保留（1 条）" }));
    expect(localStorage.getItem("decision.deferredRationaleDrafts.v1")).toBe("{}");
    localStorage.clear();
  });

  it("gives the home page and the tray one 待办 total, the reviews named in it as the home page names them", async () => {
    const snapshot = rationaleSnapshot({
      current: null,
      primarySurface: "dashboard",
      decisionCandidates: { current: reviewCandidate(), count: 1 },
      pendingRationaleCount: 2,
      dashboard: { totalDecisions: 10, recorded7d: 3, reviewAttention: 2, recentDecisions: [] },
    });
    render(<App api={apiFixture(snapshot).api} />);
    expect((await screen.findByText("项待办")).parentElement).toHaveTextContent("5项待办");
    const tray = { setTitle: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn() };
    configureTray({
      tray, image: { setTemplateImage: vi.fn() }, buildMenu: (template) => template,
      pendingCount: pendingWorkTotal(snapshot), reviewDueCount: snapshot.dashboard.reviewAttention,
      openDashboard: vi.fn(), openSettings: vi.fn(), quit: vi.fn(),
    });

    // The tray said "3 项待办 · 2 条待复盘" of the moment the home page called 5 项待办, two of them 需复盘.
    expect(tray.setToolTip).toHaveBeenCalledWith("Decision · 5 项待办，其中 2 条需复盘");
    // The rationale asked for now and the two queued behind it are to do as well, on every surface.
    expect(pendingWorkTotal({ ...snapshot, current: candidate(), waitingCount: 2 })).toBe(8);
  });

  it("shows complete business overview and handles work in the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        dashboard: {
          totalDecisions: 28,
          recorded7d: 7,
          reviewAttention: 0,
          recentDecisions: [
            {
              id: "recent-1",
              created: "2026-07-30T08:30:00.000Z",
              sourceClient: "codex",
              project: "decision",
              question: "决策工作流应该从设置中拆出吗？",
              selectedAnswer: "建立独立决策中心",
              rationaleStatus: "captured",
            },
          ],
        },
        decisionCandidates: {
          current: reviewCandidate(),
          count: 3,
        },
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: "需要兼顾启动速度与数据可恢复性。",
            capturedQuestion: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByRole("region", {
        name: "首页",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("待确认")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "开始使用 Decision" })).toBeNull();
    expect(screen.getByRole("button", { name: /^首页/u })).toHaveAttribute(
      "aria-description",
      expect.stringContaining("4 项待办：待确认 3 · 待补理由 1 · 需复盘 0"),
    );
    expect(screen.getByText("待补理由")).toBeVisible();
    expect(screen.getByText("需复盘")).toBeVisible();
    expect(screen.getByText("近 7 天记录")).toBeVisible();
    expect(screen.getByText("全部决策")).toBeVisible();
    expect(screen.getByText("28")).toBeVisible();
    expect(screen.getByText("7")).toBeVisible();
    expect(screen.getByText("选择本地服务协议")).toBeVisible();
    expect(screen.getByText("决策工作流应该从设置中拆出吗？")).toBeVisible();
    expect(screen.getByText("建立独立决策中心")).toBeVisible();
    expect(
      screen.getByRole("list", { name: "已记录的最近决策" }),
    ).toHaveAttribute("tabindex", "0");
    expect(screen.queryByText("处理轮次")).not.toBeInTheDocument();
    expect(screen.queryByText("直接捕获")).not.toBeInTheDocument();
    expect(screen.queryByText("候选")).not.toBeInTheDocument();
    expect(screen.queryByText("失败")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始处理" }));
    expect(api.openCandidateReview).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /^待确认/u }));
    expect(api.openCandidateReview).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: /^需复盘/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^全部决策/u }));
    expect(api.openSurface).toHaveBeenLastCalledWith("decisions");
    await user.click(screen.getByRole("button", { name: /^近 7 天记录/u }));
    expect(api.openSurface).toHaveBeenCalledTimes(2);
    await user.click(
      screen.getByRole("button", { name: /决策工作流应该从设置中拆出吗/u }),
    );
    expect(api.openSurface).toHaveBeenCalledTimes(3);
    expect(api.openSurface).toHaveBeenLastCalledWith("decisions");
    await user.click(screen.getByRole("button", { name: "周期回顾 ›" }));
    expect(api.openSurface).toHaveBeenLastCalledWith("methodology");

    await user.click(screen.getByRole("button", { name: "补充理由" }));
    const rationaleDialog = within(
      screen.getByRole("dialog", { name: "补充决策理由" }),
    );
    expect(
      rationaleDialog.getByRole("heading", { name: "已选答案" }),
    ).toBeVisible();
    expect(
      rationaleDialog.getByText("使用可清理的本地缓存"),
    ).toBeVisible();
    expect(
      rationaleDialog.queryByRole("list", { name: "当时的其它候选" }),
    ).toBeNull();
    await user.type(
      rationaleDialog.getByRole("textbox", {
        name: "理由原文", description: "选择缓存策略",
      }),
      "因为缓存可以随时清除。",
    );
    await user.click(
      rationaleDialog.getByRole("button", { name: "记录到知识库" }),
    );

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "captured",
      rationale: "因为缓存可以随时清除。",
    });
    await waitFor(() => expect(api.onSnapshot).toHaveBeenCalledOnce());
  });

  it("recalls earlier answers to the same question while the rationale is written", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const earlier = {
      id: "earlier-same",
      created: new Date(2026, 6, 12, 12).toISOString(),
      sourceClient: "codex",
      project: "decision",
      // Closing punctuation and spacing do not make it another question.
      question: "选择本地 服务协议？",
      selectedAnswer: "Unix Socket",
      rationaleStatus: "captured" as const,
      rationale: null,
      context: null,
      expectedOutcome: null,
      outcome: "权限问题比预期多。",
      outcomeReview: {
        verdict: "worse" as const,
        lesson: "先确认沙箱能否访问套接字。",
        reviewedAt: new Date(2026, 6, 20, 12).toISOString(),
      },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockResolvedValue([
      earlier,
      { ...earlier, id: "earlier-pending", selectedAnswer: "Loopback HTTP", outcome: null, outcomeReview: null },
      { ...earlier, id: "longer-question", question: "选择本地服务协议的端口" },
    ]);
    render(<App api={api} />);

    const past = await screen.findByRole("region", { name: "以前也回答过这个问题" });
    expect(api.listDecisions).toHaveBeenCalledWith({ query: "选择本地服务协议", limit: 50 });
    expect(within(past).getByText("2 次")).toBeVisible();
    // Worse, but a different answer; the same answer, but not reviewed yet.
    expect(within(past).queryByText(/上次同样选了/u)).toBeNull();
    expect(within(past).getByText("答案不同")).toBeVisible();
    expect(within(past).getByText("低于预期")).toBeVisible();
    expect(within(past).getByText("先确认沙箱能否访问套接字。")).toBeVisible();
    expect(within(past).getByText("答案相同")).toBeVisible();
    expect(within(past).getByText("还没有实际结果")).toBeVisible();
  });

  it("says so outright when this very answer went worse before", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    vi.mocked(api.listDecisions).mockResolvedValue([
      {
        id: "earlier-worse",
        created: new Date(2026, 6, 12, 12).toISOString(),
        sourceClient: "codex",
        project: "decision",
        question: "选择本地服务协议",
        selectedAnswer: "Loopback HTTP",
        rationaleStatus: "captured",
        rationale: null,
        context: null,
        expectedOutcome: null,
        outcome: "端口被代理占用。",
        outcomeReview: {
          verdict: "worse",
          lesson: "先确认代理设置。",
          reviewedAt: new Date(2026, 6, 20, 12).toISOString(),
        },
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
    ]);
    render(<App api={api} />);

    const past = await screen.findByRole("region", { name: "以前也回答过这个问题" });
    expect(
      within(past).getByText("上次同样选了「Loopback HTTP」，复盘结果低于预期。"),
    ).toBeVisible();
    // A single earlier answer: nothing left unlisted.
    expect(within(past).queryByText(/另有/u)).toBeNull();
  });

  it("goes by date rather than the search's ranking, and warns only when the last review of this answer went worse", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const answered = (id: string, day: number, verdict: "as_expected" | "worse") => ({
      id,
      created: new Date(2026, 6, day, 12).toISOString(),
      sourceClient: "codex" as const,
      project: "decision",
      question: "选择本地服务协议",
      selectedAnswer: "Loopback HTTP",
      rationaleStatus: "captured" as const,
      rationale: null,
      context: null,
      expectedOutcome: null,
      outcome: "结果。",
      outcomeReview: { verdict, lesson: null, reviewedAt: new Date(2026, 6, day + 1, 12).toISOString() },
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    });
    // Ranked by relevance, the older miss comes first, though this answer has gone as expected since.
    vi.mocked(api.listDecisions).mockResolvedValue([answered("older-worse", 10, "worse"), answered("newer-fine", 20, "as_expected")]);
    render(<App api={api} />);

    const past = await screen.findByRole("region", { name: "以前也回答过这个问题" });
    expect(within(past).getAllByRole("listitem").map((item) => item.querySelector("time")?.getAttribute("dateTime"))).toEqual([
      new Date(2026, 6, 20, 12).toISOString(),
      new Date(2026, 6, 10, 12).toISOString(),
    ]);
    expect(within(past).queryByText(/上次同样选了/u)).toBeNull();
  });

  it("lists the latest three earlier answers and counts the rest", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    vi.mocked(api.listDecisions).mockResolvedValue(
      [1, 2, 3, 4, 5].map((day) => ({
        id: `earlier-${day}`,
        created: new Date(2026, 6, 10 + day, 12).toISOString(),
        sourceClient: "codex",
        project: "decision",
        question: "选择本地服务协议",
        selectedAnswer: "Unix Socket",
        rationaleStatus: "captured" as const,
        rationale: null,
        context: null,
        expectedOutcome: null,
        outcome: null,
        outcomeReview: null,
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      })),
    );
    render(<App api={api} />);

    const past = await screen.findByRole("region", { name: "以前也回答过这个问题" });
    expect(within(past).getByText("5 次")).toBeVisible();
    expect(within(past).getAllByRole("listitem")).toHaveLength(3);
    expect(within(past).getByText("另有 2 次")).toBeVisible();
  });

  it("recalls earlier answers when a deferred rationale is completed later", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: null,
            capturedQuestion: null,
          },
        ],
      }),
    );
    const recorded = {
      id: "decision-pending",
      created: "2026-07-24T01:00:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "选择缓存策略",
      selectedAnswer: "使用可清理的本地缓存",
      rationaleStatus: "deferred" as const,
      rationale: null,
      context: null,
      expectedOutcome: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.query === "选择缓存策略"
        ? [
            // The record being completed is not its own history.
            recorded,
            {
              ...recorded,
              id: "cache-earlier",
              created: "2026-06-02T01:00:00.000Z",
              rationaleStatus: "captured" as const,
              outcome: "清理后可立即恢复。",
              outcomeReview: {
                verdict: "better" as const,
                lesson: "可清理比持久更重要。",
                reviewedAt: "2026-06-20T01:00:00.000Z",
              },
            },
          ]
        : [],
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "补充理由" }));
    const dialog = screen.getByRole("dialog", { name: "补充决策理由" });
    const past = await within(dialog).findByRole("region", {
      name: "以前也回答过这个问题",
    });
    expect(within(past).getByText("1 次")).toBeVisible();
    expect(within(past).getByText("答案相同")).toBeVisible();
    expect(within(past).getByText("优于预期")).toBeVisible();
    expect(within(past).getByText("可清理比持久更重要。")).toBeVisible();
  });

  it("saves a pending rationale with Cmd/Ctrl+Enter", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: "需要兼顾启动速度与数据可恢复性。",
            capturedQuestion: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "补充理由" }));
    const dialog = within(screen.getByRole("dialog", { name: "补充决策理由" }));
    const textbox = dialog.getByRole("textbox", {
      name: "理由原文", description: "选择缓存策略",
    });
    expect(
      dialog.getByRole("button", { name: "记录到知识库" }),
    ).toHaveAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");

    await user.click(textbox);
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(api.submitRationale).not.toHaveBeenCalled();

    await user.type(textbox, "因为缓存可以随时清除。");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "captured",
      rationale: "因为缓存可以随时清除。",
    });
  });

  it("does not greet someone as new when the index could not be read", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        dashboard: {
          totalDecisions: 0,
          recorded7d: 0,
          reviewAttention: 0,
          recentDecisions: [],
          unavailable: true,
        },
        decisionCandidates: { current: null, count: 0 },
        pendingRationales: [],
      }),
    );
    render(<App api={api} />);

    expect(await screen.findByText(/决策索引暂时读不出来/u)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "开始使用 Decision" })).toBeNull();
  });

  it("guides a first run toward client setup", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        dashboard: {
          totalDecisions: 0,
          recorded7d: 0,
          reviewAttention: 0,
          recentDecisions: [],
        },
        decisionCandidates: { current: null, count: 0 },
        pendingRationales: [],
        integrationStatus: {
          claudeCode: "not-installed",
          codex: "not-installed",
        },
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    // Zeros and empty cards give way to how to begin.
    expect(await screen.findByRole("heading", { name: "开始使用 Decision" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "决策概览" })).toBeNull();
    const steps = screen.getByRole("list", { name: "开始使用的步骤" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("progressbar", { name: "开始使用进度" })).toHaveAttribute("aria-valuenow", "0");
    await user.click(within(steps).getByRole("button", { name: "前往接入" }));
    expect(api.openSurface).toHaveBeenLastCalledWith("clients");
    await user.click(within(steps).getByRole("button", { name: "添加链接" }));
    expect(api.openSurface).toHaveBeenLastCalledWith("connections");
    // The first decision can be written by hand right away, as ⌘N does.
    await user.click(within(steps).getByRole("button", { name: "主动记录" }));
    expect(await screen.findByRole("dialog", { name: "主动记录" })).toBeVisible();
  });

  it("marks a connected client as done while nothing is recorded yet", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        dashboard: { totalDecisions: 0, recorded7d: 0, reviewAttention: 0, recentDecisions: [] },
        decisionCandidates: { current: null, count: 0 },
        pendingRationales: [],
        integrationStatus: { claudeCode: "not-installed", codex: "installed" },
      }),
    );
    render(<App api={api} />);

    const steps = await screen.findByRole("list", { name: "开始使用的步骤" });
    expect(within(steps).getByText("已接入 Codex")).toBeVisible();
    expect(within(steps).getByRole("button", { name: "管理接入" })).toBeVisible();
    // The next required step carries the accent.
    expect(within(steps).getByRole("button", { name: "主动记录" })).toHaveClass("primary-button");
  });

  it("completes a pending rationale with judgment factors only", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: null,
            capturedQuestion: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "补充理由" }));
    const dialog = within(screen.getByRole("dialog", { name: "补充决策理由" }));
    const save = dialog.getByRole("button", { name: "记录到知识库" });
    expect(save).toBeDisabled();

    // Factors alone are not a rationale for a deferred note: the main process
    // refuses a completion without the user's own words.
    await user.click(dialog.getByRole("button", { name: "复用现有能力" }));
    expect(save).toBeDisabled();
    await user.click(dialog.getByRole("button", { name: "简单直接" }));
    await user.click(dialog.getByRole("button", { name: "简单直接" }));
    await user.type(
      dialog.getByRole("textbox", { name: "理由原文" }),
      "已有缓存层可以直接复用。",
    );
    expect(save).toBeEnabled();
    await user.click(save);

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "captured",
      rationale: "已有缓存层可以直接复用。",
      reasonFactors: ["reuse"],
    });
  });

  it("opens the review inbox from the dashboard summary tile", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        dashboard: {
          totalDecisions: 28,
          recorded7d: 7,
          reviewAttention: 2,
          recentDecisions: [],
        },
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", { name: /^需复盘/u }),
    );
    expect(api.openSurface).toHaveBeenCalledWith("decisions");
    expect(
      screen.queryByRole("button", { name: /^待确认/u }),
    ).toBeNull();
  });

  it("shows enough context to judge a historical pending rationale", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-historical",
            question: "旧缓存应该保留多久？",
            created: "2020-01-02T03:04:00.000Z",
            project: "legacy-project",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: "迁移完成前需要保留回滚能力。",
            capturedQuestion: null,
          },
        ],
      }),
    );

    render(<App api={api} />);

    expect(await screen.findByText("选择已保存")).toBeVisible();
    expect(screen.getByText(/保留 30 天/u)).toBeVisible();
    expect(screen.getByText("legacy-project")).toBeVisible();
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("迁移完成前需要保留回滚能力。")).toBeVisible();
    expect(screen.getByText("历史")).toBeVisible();
  });

  it("restores answer descriptions and alternatives in a deferred rationale", async () => {
    const capturedQuestion = serverCaptureFixture().questions[0]!;
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-with-options",
            question: capturedQuestion.question,
            created: "2026-08-20T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: capturedQuestion.answer.values.join("、"),
            contextSummary: "需要保留当时的协议选择边界。",
            capturedQuestion,
          },
        ],
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "补充理由" }));

    const dialog = within(
      screen.getByRole("dialog", { name: "补充决策理由" }),
    );
    expect(dialog.getByRole("heading", { name: "已选答案" })).toBeVisible();
    expect(dialog.getByText("Loopback HTTP")).toBeVisible();
    expect(dialog.getByText("跨平台且便于诊断")).toBeVisible();
    expect(dialog.getByText("Unix Socket")).toBeVisible();
    expect(dialog.getByText("不占 TCP 端口")).toBeVisible();
    expect(
      dialog.getByRole("heading", { name: "补充判断依据" }),
    ).toBeVisible();
  });

  it("can keep a pending decision while ending its rationale task", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "旧缓存应该保留多久？",
            created: "2026-07-30T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: null,
            capturedQuestion: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "不保留" }));
    expect(api.submitRationale).not.toHaveBeenCalled();
    expect(
      screen.getByText("如果只是无需补充理由，也可以保留决策并结束这项待办。"),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "取消不保留决策" }));
    expect(
      screen.queryByText("如果只是无需补充理由，也可以保留决策并结束这项待办。"),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "不保留" }));
    await user.click(screen.getByRole("button", { name: "记录到知识库（不补理由）" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "skipped",
    });
  });

  it("removes a pending decision only after explicit confirmation", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "旧缓存应该保留多久？",
            created: "2026-07-30T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: null,
            capturedQuestion: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "不保留" }));
    await user.click(screen.getByRole("button", { name: "确认不保留" }));

    expect(api.submitRationale).toHaveBeenCalledWith({
      candidateId: "decision-pending",
      status: "not_recorded",
    });
  });

  it("keeps discard confirmation visible when removing the decision fails", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "旧缓存应该保留多久？",
            created: "2026-07-30T03:04:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "保留 30 天",
            contextSummary: null,
            capturedQuestion: null,
          },
        ],
      }),
    );
    vi.mocked(api.submitRationale).mockRejectedValueOnce(
      new Error("write failed"),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "不保留" }));
    await user.click(screen.getByRole("button", { name: "确认不保留" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法移除这条决策：write failed",
    );
    expect(
      screen.getByText("如果只是无需补充理由，也可以保留决策并结束这项待办。"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "确认不保留" })).toBeEnabled();
  });

  it.each(["dashboard", "assistant", "settings"] as const)(
    "keeps an active rationale above the %s surface",
    async (primarySurface) => {
      const { api } = apiFixture(rationaleSnapshot({ primarySurface }));

      render(<App api={api} />);

      expect(
        await screen.findByRole("region", {
          name: "待补充决策理由",
        }),
      ).toBeVisible();
      expect(screen.queryByRole("region", { name: "首页" })).toBeNull();
      expect(screen.queryByRole("group", { name: "外观" })).toBeNull();
      const knowledgeNavigation = screen.getByRole("button", {
        name: "知识",
      });
      expect(knowledgeNavigation).toBeDisabled();
      fireEvent.click(knowledgeNavigation);
      expect(api.openSurface).not.toHaveBeenCalled();
    },
  );

  it("keeps a deferred rationale editable when saving fails", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        pendingRationales: [
          {
            id: "decision-pending",
            question: "选择缓存策略",
            created: "2026-07-24T01:00:00.000Z",
            project: "decision",
            sourceClient: "codex",
            selectedAnswer: "使用可清理的本地缓存",
            contextSummary: null,
            capturedQuestion: null,
          },
        ],
      }),
    );
    vi.mocked(api.submitRationale).mockRejectedValueOnce(
      new Error("write failed"),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "补充理由" }));
    const dialog = within(screen.getByRole("dialog", { name: "补充决策理由" }));
    const editor = dialog.getByRole("textbox", {
      name: "理由原文", description: "选择缓存策略",
    });
    await user.type(editor, "因为缓存可以随时清除。");
    await user.click(dialog.getByRole("button", { name: "记录到知识库" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "理由暂时无法保存：write failed",
    );
    expect(editor).toHaveValue("因为缓存可以随时清除。");
    expect(dialog.getByRole("button", { name: "记录到知识库" })).toBeEnabled();
  });

  it("manages capture clients on a dedicated page", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "clients",
        integrationStatus: {
          claudeCode: "installed",
          codex: "not-installed",
        },
      }),
    );
    vi.mocked(api.installIntegrations).mockResolvedValue({
      mode: "apply",
      targets: [],
      commands: [],
      restartRequired: false,
    });
    // Claude Code has brought a decision in; Codex has not.
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.sourceClient === "claude-code"
        ? [{ id: "decision-cc", created: "2026-07-30T08:30:00.000Z", sourceClient: "claude-code", project: "decision", question: "缓存放在哪一层？", selectedAnswer: "请求层", rationaleStatus: "captured" as const, rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [] }]
        : [],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "接入" });
    expect(await within(page).findByText(/最近一次记录：.* · 缓存放在哪一层？/u)).toBeVisible();
    expect(within(page).getByText("还没有记录到决策。")).toBeVisible();
    expect(api.listDecisions).toHaveBeenCalledWith({ query: "", sourceClient: "codex", limit: 1 });
    expect(
      within(page).getByRole("heading", { name: "Claude Code" }),
    ).toBeVisible();
    expect(within(page).getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(within(page).getByText("已连接")).toBeVisible();
    expect(within(page).getByText("未连接")).toBeVisible();
    expect(within(page).getAllByText("决策前核对")).toHaveLength(2);
    expect(within(page).getAllByText("只读 · 不替你选择")).toHaveLength(2);
    expect(within(page).getByText(/给出选项前读取相关原则/u)).toBeVisible();

    await user.click(within(page).getByRole("button", { name: "安装或修复" }));
    expect(api.installIntegrations).toHaveBeenCalledWith("apply");
    expect(await within(page).findByText("接入已安装或修复。")).toBeVisible();

    // One client connects while the other is not there to connect: said for each.
    vi.mocked(api.installIntegrations).mockResolvedValue({
      mode: "apply",
      targets: [
        { client: "claude-code", path: "/home/.claude/settings.json", changed: true, status: "installed" },
        { client: "codex", path: "/home/.codex/hooks.json", changed: false, status: "skipped", detail: "没有找到 codex 命令" },
      ],
      commands: [],
      restartRequired: true,
    });
    await user.click(within(page).getByRole("button", { name: "安装或修复" }));
    // And that a client already running takes it up only once restarted.
    expect(await within(page).findByText(
      "Claude Code 已接入；没有找到 codex 命令，跳过了 Codex。重启正在运行的 Claude Code 或 Codex 后生效。",
    )).toBeVisible();

    // Taken out again, each client said for, and what stays behind with it.
    vi.mocked(api.removeIntegrations).mockResolvedValue({
      mode: "apply",
      targets: [
        { client: "claude-code", path: "/home/.claude/settings.json", changed: true, status: "removed" },
        { client: "codex", path: "/home/.codex/hooks.json", changed: true, status: "removed", detail: "没有找到 codex 命令，没有删除它登记的 MCP 服务器" },
      ],
      commands: [],
      restartRequired: true,
      note: "已发布到客户端的技能和工作流没有删除，客户端仍会加载它们；不需要的可以在 Decision 里逐个回滚发布。",
    });
    await user.click(within(page).getByRole("button", { name: "断开" }));
    expect(api.removeIntegrations).toHaveBeenCalledOnce();
    expect(await within(page).findByText(
      "Claude Code 已断开；Codex 已断开（没有找到 codex 命令，没有删除它登记的 MCP 服务器）。重启正在运行的 Claude Code 或 Codex 后生效。" +
        "已发布到客户端的技能和工作流没有删除，客户端仍会加载它们；不需要的可以在 Decision 里逐个回滚发布。",
    )).toBeVisible();

    // Nothing taken out: no restart to ask for, and a client not there at all is said to be skipped.
    vi.mocked(api.removeIntegrations).mockResolvedValue({
      mode: "apply",
      targets: [
        { client: "claude-code", path: "/home/.claude/settings.json", changed: false, status: "failed", detail: "运行 claude mcp remove 没有成功（permission denied）" },
        { client: "codex", path: "/home/.codex/hooks.json", changed: false, status: "skipped", detail: "没有找到 codex 命令" },
      ],
      commands: [],
      restartRequired: true,
    });
    await user.click(within(page).getByRole("button", { name: "断开" }));
    expect(await within(page).findByText(
      "Claude Code 没有断开：运行 claude mcp remove 没有成功（permission denied）；没有找到 codex 命令，跳过了 Codex。",
    )).toBeVisible();
  });

  it("says when Claude Code's settings turn every hook off, and what Codex still asks once connected", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "clients",
        integrationStatus: { claudeCode: "disabled", codex: "not-installed" },
      }),
    );
    vi.mocked(api.installIntegrations).mockResolvedValue({
      mode: "apply",
      targets: [{ client: "codex", path: "/home/.codex/hooks.json", changed: true, status: "installed", detail: "Codex 只运行你信任过的 hook：打开 Codex 时若提示 Hooks need review，确认信任后才会开始自动记录" }],
      commands: [],
      restartRequired: false,
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const page = await screen.findByRole("region", { name: "接入" });
    expect(within(page).getByText("hook 已关闭")).toBeVisible();
    expect(within(page).getByText(/disableAllHooks/u)).toBeVisible();
    await user.click(within(page).getByRole("button", { name: "安装或修复" }));
    expect(await within(page).findByText(
      "Codex 已接入（Codex 只运行你信任过的 hook：打开 Codex 时若提示 Hooks need review，确认信任后才会开始自动记录）。",
    )).toBeVisible();
  });

  it("adds a remote model backend without retaining its one-time API key", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const savedProfile = {
      version: 1 as const,
      profileId: "remote-openai",
      kind: "openai" as const,
      label: "OpenAI",
      enabled: true,
      priority: 40,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses" as const,
      credentialConfigured: true,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([]);
    vi.mocked(api.saveModelProviderProfile).mockResolvedValue(savedProfile);
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    const addButton = within(panel).getByRole("button", {
      name: "添加模型后端",
    });
    expect(addButton).toHaveAttribute("aria-expanded", "false");
    await user.click(addButton);
    expect(addButton).toHaveAttribute("aria-expanded", "true");
    const addDialog = within(
      screen.getByRole("dialog", { name: "添加模型后端" }),
    );
    expect(
      addDialog.getByRole("form", { name: "添加模型后端表单" }),
    ).toBeVisible();
    expect(addDialog.getByLabelText("后端类型")).toHaveFocus();
    await user.selectOptions(addDialog.getByLabelText("后端类型"), "openai");
    await user.type(addDialog.getByLabelText("模型"), "gpt-5-mini");
    await user.type(addDialog.getByLabelText("API 密钥"), "sk-private");
    await user.selectOptions(addDialog.getByLabelText("代理连接方式"), "custom");
    await user.type(addDialog.getByLabelText("代理地址"), "http://127.0.0.1:7890");
    await user.type(addDialog.getByLabelText("代理绕过主机"), "localhost");
    await user.click(
      addDialog.getByRole("button", {
        name: "保存后端",
      }),
    );

    expect(api.saveModelProviderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          kind: "openai",
          model: "gpt-5-mini",
          proxy: { mode: "custom", url: "http://127.0.0.1:7890", noProxy: "localhost" },
        }),
        secret: "sk-private",
      }),
    );
    expect(screen.queryByDisplayValue("sk-private")).not.toBeInTheDocument();
  });

  it("says a model backend value it refuses on its field and takes focus there", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "models" }));
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App api={api} />);
    const panel = await screen.findByRole("region", { name: "模型后端" });
    await user.click(within(panel).getByRole("button", { name: "添加模型后端" }));
    const dialog = within(screen.getByRole("dialog", { name: "添加模型后端" }));
    const save = dialog.getByRole("button", { name: "保存后端" });

    // Said only below the form, it was heard once from 保存后端, and 模型 said nothing when reached.
    await user.click(save);
    const model = dialog.getByLabelText("模型");
    expect(dialog.getByRole("alert")).toHaveTextContent("请输入模型名称。");
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(model).toHaveAccessibleDescription("请输入模型名称。");
    expect(model).toHaveFocus();

    await user.type(model, "gpt-5-mini");
    await user.click(save);
    const key = dialog.getByLabelText("API 密钥");
    expect(key).toHaveAccessibleDescription("请输入 API 密钥。");
    expect(key).toHaveFocus();
    expect(model).not.toHaveAttribute("aria-invalid");
    expect(api.saveModelProviderProfile).not.toHaveBeenCalled();
  });

  it("manages provider order, state, tests, edits, deletion, and URL validation", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const apple = {
      version: 1 as const,
      profileId: "builtin-apple",
      kind: "apple" as const,
      label: "Apple Foundation Models",
      enabled: true,
      priority: 0,
      model: "system-language-model",
      timeoutMs: 5_000,
      credentialConfigured: false,
    };
    const openai = {
      version: 1 as const,
      profileId: "remote-openai",
      kind: "openai" as const,
      label: "OpenAI",
      enabled: true,
      priority: 10,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses" as const,
      credentialConfigured: true,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([apple, openai]);
    vi.mocked(api.saveModelProviderProfile).mockImplementation(
      async (value) => value.profile,
    );
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: true,
      profileId: "remote-openai",
      latencyMs: 42,
      requestId: "health-check-1",
      modelVersion: "gpt-5-mini",
      tokenSource: "provider_reported",
    });
    vi.mocked(api.deleteModelProviderProfile).mockResolvedValue(true);
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    expect(await within(panel).findByText("OpenAI")).toBeVisible();

    await user.click(
      within(panel).getByRole("switch", {
        name: "启用 OpenAI",
      }),
    );
    expect(api.saveModelProviderProfile).toHaveBeenCalledWith({
      profile: { ...openai, enabled: false },
    });

    const openAiDragHandle = within(panel).getByRole("button", {
      name: /拖拽排序 OpenAI/u,
    });
    const dragHandle = within(panel).getByRole("button", {
      name: /拖拽排序 Apple Foundation Models/u,
    });
    const openAiRow = openAiDragHandle.closest("li");
    const transferredData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn((type: string, value: string) => {
        transferredData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferredData.get(type) ?? ""),
    };
    expect(dragHandle).toHaveAttribute("draggable", "true");
    expect(
      within(panel).queryByRole("button", { name: /上移|下移/u }),
    ).toBeNull();
    expect(openAiRow).not.toBeNull();
    vi.spyOn(openAiRow!, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.dragStart(dragHandle, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      "text/plain",
      "builtin-apple",
    );
    fireEvent.dragOver(openAiRow!, { clientY: 10, dataTransfer });
    fireEvent.drop(openAiRow!, { clientY: 10, dataTransfer });
    expect(dataTransfer.getData).toHaveBeenCalledWith("text/plain");
    await waitFor(() => {
      expect(api.reorderModelProviderProfiles).toHaveBeenCalledWith([
        "remote-openai",
        "builtin-apple",
      ]);
    });

    await user.click(
      within(panel).getByRole("button", {
        name: "测试 OpenAI",
      }),
    );
    expect(
      await within(panel).findByText(/测试通过.*42 ms.*gpt-5-mini/u),
    ).toBeVisible();

    await user.click(
      within(panel).getByRole("button", {
        name: "编辑 OpenAI",
      }),
    );
    const editDialog = within(
      screen.getByRole("dialog", { name: "编辑 OpenAI" }),
    );
    expect(editDialog.getByLabelText("API 密钥")).toHaveValue("");
    expect(editDialog.getByText("已安全保存，留空则不更换")).toBeVisible();
    await user.click(
      editDialog.getByRole("button", {
        name: "取消编辑",
      }),
    );

    await user.click(
      within(panel).getByRole("button", {
        name: "删除 OpenAI",
      }),
    );
    await user.click(
      within(panel).getByRole("button", {
        name: "确认删除 OpenAI",
      }),
    );
    expect(api.deleteModelProviderProfile).toHaveBeenCalledWith(
      "remote-openai",
    );

    await user.click(
      within(panel).getByRole("button", {
        name: "添加模型后端",
      }),
    );
    const compatibleDialog = within(
      screen.getByRole("dialog", { name: "添加模型后端" }),
    );
    await user.selectOptions(
      compatibleDialog.getByLabelText("后端类型"),
      "openai-compatible",
    );
    await user.clear(compatibleDialog.getByLabelText("服务地址"));
    await user.type(
      compatibleDialog.getByLabelText("服务地址"),
      "http://models.example.com",
    );
    await user.type(compatibleDialog.getByLabelText("模型"), "local-model");
    await user.type(
      compatibleDialog.getByLabelText("API 密钥"),
      "local-secret",
    );
    await user.click(
      compatibleDialog.getByRole("button", {
        name: "保存后端",
      }),
    );
    expect(compatibleDialog.getByRole("alert")).toHaveTextContent(
      "HTTPS 或本机回环地址",
    );
  });

  it("shows the concrete failure reason returned by a model backend test", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const openai = {
      version: 1 as const,
      profileId: "remote-openai",
      kind: "openai" as const,
      label: "OpenAI",
      enabled: false,
      priority: 0,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses" as const,
      credentialConfigured: true,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([openai]);
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: false,
      profileId: "remote-openai",
      latencyMs: 83,
      requestId: "health-check-failed",
      errorCode: "authentication_failed",
      diagnosticExcerpt: "HTTP 401：API 密钥无效",
      providerRequestId: "provider-request-401",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "测试 OpenAI",
      }),
    );

    const result = await within(panel).findByRole("status", {
      name: "OpenAI 测试失败",
    });
    expect(result).toHaveTextContent("测试失败 · 认证失败 · 83 ms");
    expect(result).toHaveTextContent("HTTP 401：API 密钥无效");
    expect(result).toHaveTextContent("请求 ID：provider-request-401");

    // A new key makes that result about a backend that is no more: it is not left under the row.
    vi.mocked(api.saveModelProviderProfile).mockImplementation(async (value) => value.profile);
    await user.click(within(panel).getByRole("button", { name: "编辑 OpenAI" }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑 OpenAI" }));
    await user.type(dialog.getByLabelText("API 密钥"), "sk-new-key");
    await user.click(dialog.getByRole("button", { name: "保存后端" }));
    expect(await within(panel).findByText("模型后端已保存。")).toBeVisible();
    expect(within(panel).queryByRole("status", { name: "OpenAI 测试失败" })).toBeNull();
  });

  it("saves DeepSeek's cache and peak rates with an editable holiday calendar", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "models" }));
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([{
      version: 1, profileId: "remote-deepseek", kind: "openai-compatible", label: "DeepSeek", enabled: true, priority: 10,
      model: "deepseek-flash", timeoutMs: 30000, baseUrl: "https://api.deepseek.com", apiProtocol: "chat-completions", credentialConfigured: true,
    }]);
    vi.mocked(api.saveModelProviderProfile).mockImplementation(async (value) => value.profile);
    const user = userEvent.setup(); render(<App api={api} />);
    const panel = within(await screen.findByRole("region", { name: "模型后端" }));
    await user.click(await panel.findByRole("button", { name: "编辑 DeepSeek" }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑 DeepSeek" }));
    await user.click(dialog.getByRole("button", { name: "填入 DeepSeek Flash 参考价格" }));
    expect(dialog.getByLabelText("缓存命中输入单价")).toHaveValue("0.02");
    expect(dialog.getByLabelText("高峰输出单价")).toHaveValue("8");
    await user.clear(dialog.getByLabelText("空闲价节假日"));
    await user.type(dialog.getByLabelText("空闲价节假日"), "2026-10-01\n2026-10-02");
    await user.click(dialog.getByRole("button", { name: "保存后端" }));
    expect(api.saveModelProviderProfile).toHaveBeenCalledWith({ profile: expect.objectContaining({ pricing: {
      currency: "¥", inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4,
      peak: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8, holidayYear: 2026, holidays: ["2026-10-01", "2026-10-02"] },
    } }) });
  });

  it("does not drop a price begun and left incomplete, and says what it needs", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "models" }));
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([{
      version: 1, profileId: "remote-deepseek", kind: "openai-compatible", label: "DeepSeek", enabled: true, priority: 10,
      model: "deepseek-chat", timeoutMs: 30_000, baseUrl: "https://api.deepseek.com", credentialConfigured: true,
      pricing: { currency: "¥", inputPerMillion: 2, outputPerMillion: 8 },
    }]);
    const user = userEvent.setup();
    render(<App api={api} />);
    const panel = within(await screen.findByRole("region", { name: "模型后端" }));
    await user.click(await panel.findByRole("button", { name: "编辑 DeepSeek" }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑 DeepSeek" }));
    await user.clear(dialog.getByLabelText("输出单价"));
    await user.type(dialog.getByLabelText("输出单价"), "8,5");
    await user.click(dialog.getByRole("button", { name: "保存后端" }));

    expect(await dialog.findByText(/计费单价要三项都填/u)).toBeVisible();
    expect(api.saveModelProviderProfile).not.toHaveBeenCalled();
  });

  it("asks for the new site's own key when a backend's address moves to another site", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "models" }));
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([{
      version: 1 as const, profileId: "remote-openai", kind: "openai" as const, label: "OpenAI", enabled: true, priority: 10,
      model: "gpt-5-mini", timeoutMs: 30_000, baseUrl: "https://api.openai.com", apiProtocol: "responses" as const, credentialConfigured: true,
    }]);
    const user = userEvent.setup();
    render(<App api={api} />);
    const panel = within(await screen.findByRole("region", { name: "模型后端" }));
    await user.click(await panel.findByRole("button", { name: "编辑 OpenAI" }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑 OpenAI" }));
    expect(dialog.getByText("已安全保存，留空则不更换")).toBeVisible();

    // Pointed at another site (a preset, a relay), the saved key is not sent there: it asks for that site's own.
    await user.clear(dialog.getByLabelText("服务地址"));
    await user.type(dialog.getByLabelText("服务地址"), "https://api.deepseek.com");
    expect(dialog.getByText("地址换到了另一个站点，需要填写这个站点的 API 密钥")).toBeVisible();
    await user.click(dialog.getByRole("button", { name: "取消编辑" }));
  });

  it("keeps focus on a backend's handle while the arrow keys move it", async () => {
    // What Chromium does and jsdom does not: a focused control that is disabled gives focus to the page.
    const chromium = new MutationObserver(() => {
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && active.disabled) {
        active.disabled = false;
        active.blur();
        active.disabled = true;
      }
    });
    chromium.observe(document.body, { attributes: true, attributeFilter: ["disabled"], subtree: true });
    try {
      const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "models" }));
      const backend = (profileId: string, label: string, priority: number) => ({
        version: 1 as const, profileId, kind: "openai-compatible" as const, label, enabled: true, priority,
        model: "model", timeoutMs: 30_000, baseUrl: "https://api.example.com", credentialConfigured: true,
      });
      let order = [backend("a", "Alpha", 0), backend("b", "Beta", 10), backend("c", "Gamma", 20)];
      vi.mocked(api.listModelProviderProfiles).mockImplementation(async () => order);
      vi.mocked(api.reorderModelProviderProfiles).mockImplementation(async (ids) => {
        order = ids.map((id, index) => ({ ...order.find((item) => item.profileId === id)!, priority: index * 10 }));
      });
      const user = userEvent.setup();
      render(<App api={api} />);
      const panel = within(await screen.findByRole("region", { name: "模型后端" }));
      const handle = () => panel.getByRole("button", { name: /拖拽排序 Alpha/u });

      (await panel.findByRole("button", { name: /拖拽排序 Alpha/u })).focus();
      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(api.reorderModelProviderProfiles).toHaveBeenLastCalledWith(["b", "a", "c"]));
      await waitFor(() => expect(handle()).toHaveFocus());
      // And the next press moves it again, rather than scrolling the page.
      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(api.reorderModelProviderProfiles).toHaveBeenLastCalledWith(["b", "c", "a"]));
    } finally {
      chromium.disconnect();
    }
  });

  it("says under each backend how much the call records show it was used", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "models" }),
      [modelTraceFixture(), { ...modelTraceFixture(), traceId: "trace-2", usage: { source: "runtime_measured", inputTokens: 900, outputTokens: 146, totalTokens: 1_046 } }],
    );
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([
      { version: 1, profileId: "qwen", kind: "qwen", label: "Qwen 本地模型", enabled: true, priority: 0, model: "qwen3.5-2b-q4-k-m", timeoutMs: 5_000, credentialConfigured: false },
      { version: 1, profileId: "builtin-apple", kind: "apple", label: "Apple Foundation Models", enabled: true, priority: 1, model: "system-language-model", timeoutMs: 5_000, credentialConfigured: false },
    ]);

    render(<App api={api} />);

    expect(await screen.findByText("调用记录：2 次 · 1.1k tokens")).toBeVisible();
    // A backend the records never used says nothing, rather than "0 次".
    expect(screen.getAllByText(/^调用记录：/u)).toHaveLength(1);
  });

  it("counts a backend's tokens only as far as its calls reported them", async () => {
    const trace = modelTraceFixture();
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "models" }),
      [trace, { ...trace, traceId: "trace-2", usage: { source: "unavailable" } },
        { ...trace, traceId: "trace-3", profile: { ...trace.profile, profileId: "builtin-apple" }, usage: { source: "unavailable" } }],
    );
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([
      { version: 1, profileId: "qwen", kind: "qwen", label: "Qwen 本地模型", enabled: true, priority: 0, model: "qwen3.5-2b-q4-k-m", timeoutMs: 5_000, credentialConfigured: false },
      { version: 1, profileId: "builtin-apple", kind: "apple", label: "Apple Foundation Models", enabled: true, priority: 1, model: "system-language-model", timeoutMs: 5_000, credentialConfigured: false },
    ]);

    render(<App api={api} />);

    // One of two calls reported its tokens: the count is a floor.
    expect(await screen.findByText("调用记录：2 次 · 至少 54 tokens")).toBeVisible();
    // Apple's model reports none at all: "0 tokens" would read as an idle backend.
    expect(screen.getByText("调用记录：1 次")).toBeVisible();
  });

  it("describes Qwen output exhaustion as a length limit", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const qwen = {
      version: 1 as const,
      profileId: "builtin-qwen",
      kind: "qwen" as const,
      label: "Qwen 本地模型",
      enabled: true,
      priority: 0,
      model: "qwen3.5-2b-q4-k-m",
      timeoutMs: 5_000,
      credentialConfigured: false,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([qwen]);
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: false,
      profileId: "builtin-qwen",
      latencyMs: 719,
      requestId: "qwen-health-check",
      errorCode: "output_limit",
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "测试 Qwen 本地模型",
      }),
    );

    const result = await within(panel).findByRole("status", {
      name: "Qwen 本地模型 测试失败",
    });
    expect(result).toHaveTextContent("测试失败 · 输出达到长度上限 · 719 ms");
  });

  it("does not expose the internal unavailable token source after a successful Qwen test", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const qwen = {
      version: 1 as const,
      profileId: "builtin-qwen",
      kind: "qwen" as const,
      label: "Qwen 本地模型",
      enabled: true,
      priority: 0,
      model: "qwen3.5-2b-q4-k-m",
      timeoutMs: 5_000,
      credentialConfigured: false,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([qwen]);
    vi.mocked(api.testModelProviderProfile).mockResolvedValue({
      ok: true,
      profileId: "builtin-qwen",
      latencyMs: 719,
      requestId: "qwen-health-check",
      modelVersion: "qwen3.5-2b-q4-k-m",
      tokenSource: "unavailable",
    });
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "测试 Qwen 本地模型",
      }),
    );

    const result = await within(panel).findByRole("status", {
      name: "Qwen 本地模型 测试通过",
    });
    expect(result).toHaveTextContent(
      "测试通过 · 719 ms · qwen3.5-2b-q4-k-m · Token 统计未提供",
    );
    expect(result).not.toHaveTextContent("unavailable");
  });

  it("shows detected Codex and Claude Code client readiness and enables them without losing the path", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const codex = {
      version: 1 as const,
      profileId: "builtin-codex",
      kind: "codex-cli" as const,
      label: "Codex CLI",
      enabled: false,
      priority: 20,
      timeoutMs: 30_000,
      credentialConfigured: false,
    };
    const claude = {
      version: 1 as const,
      profileId: "builtin-claude-code",
      kind: "claude-code-cli" as const,
      label: "Claude Code CLI",
      enabled: false,
      priority: 30,
      timeoutMs: 30_000,
      credentialConfigured: false,
    };
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([codex, claude]);
    vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([
      {
        kind: "codex-cli",
        models: [{ id: "gpt-test-candidate", label: "Test candidate" }],
        modelsSource: "client",
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        kind: "claude-code-cli",
        models: [{ id: "sonnet", label: "Sonnet" }],
        modelsSource: "cache",
        executablePath: "/Users/demo/.volta/bin/claude",
        version: "2.1.220",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);
    vi.mocked(api.saveModelProviderProfile).mockImplementation(
      async (value) => value.profile,
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    expect(await within(panel).findByText("Codex CLI")).toBeVisible();
    expect(within(panel).getByText("Claude Code CLI")).toBeVisible();
    // Run here, they send to OpenAI and Anthropic: shown by version alone, they read as models on this Mac.
    expect(within(panel).getByText("v0.146.0 · 远程调用")).toBeVisible();
    expect(within(panel).getByText("v2.1.220 · 远程调用")).toBeVisible();
    expect(within(panel).getAllByText("已登录，可用")).toHaveLength(2);

    await user.click(
      within(panel).getByRole("button", {
        name: "测试 Codex CLI",
      }),
    );
    expect(api.testModelProviderProfile).toHaveBeenCalledWith("builtin-codex");

    await user.click(
      within(panel).getByRole("switch", {
        name: "启用 Claude Code CLI",
      }),
    );
    expect(api.saveModelProviderProfile).toHaveBeenCalledWith({
      profile: {
        ...claude,
        enabled: true,
        executablePath: "/Users/demo/.volta/bin/claude",
      },
    });

    await user.click(
      within(panel).getByRole("button", {
        name: "配置 Codex CLI",
      }),
    );
    const cliDialog = within(
      screen.getByRole("dialog", { name: "配置 Codex CLI" }),
    );
    expect(cliDialog.getByText(/内容经本机客户端发送给 OpenAI 的模型服务/u)).toBeVisible();
    const modelInput = cliDialog.getByLabelText("客户端模型");
    expect(modelInput).toHaveAttribute("list");
    const suggestions = document.getElementById(modelInput.getAttribute("list")!);
    expect(suggestions?.querySelector("option")).toHaveAttribute("value", "gpt-test-candidate");
    expect(cliDialog.getByText(/候选来源：CLI 目录/u)).toBeVisible();
    const pathInput = cliDialog.getByLabelText("客户端路径");
    expect(pathInput).toHaveValue("/opt/homebrew/bin/codex");
    await user.clear(pathInput);
    await user.type(pathInput, "relative/codex");
    await user.click(
      cliDialog.getByRole("button", {
        name: "保存客户端",
      }),
    );
    expect(cliDialog.getByRole("alert")).toHaveTextContent("绝对路径");
    await user.clear(pathInput);
    await user.type(pathInput, "/custom/bin/codex");
    await user.type(cliDialog.getByLabelText("客户端模型"), "gpt-5.6-terra");
    await user.selectOptions(cliDialog.getByLabelText("代理连接方式"), "direct");
    await user.click(
      cliDialog.getByRole("button", {
        name: "保存客户端",
      }),
    );
    expect(api.saveModelProviderProfile).toHaveBeenLastCalledWith({
      profile: {
        ...codex,
        executablePath: "/custom/bin/codex",
        model: "gpt-5.6-terra",
        proxy: { mode: "direct" },
      },
    });
    await user.click(within(panel).getByRole("button", { name: "配置 Claude Code CLI" }));
    const claudeDialog = within(screen.getByRole("dialog", { name: "配置 Claude Code CLI" }));
    const claudeModel = claudeDialog.getByLabelText("客户端模型");
    expect(document.getElementById(claudeModel.getAttribute("list")!)?.querySelector("option")).toHaveAttribute("value", "sonnet");
    expect(claudeDialog.getByText(/候选来源：本机缓存/u)).toBeVisible();
    vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([{ kind: "claude-code-cli", authenticated: true, supported: true, availability: "available", checkedAt: "2026-07-30T00:00:00.000Z", modelsSource: "client", models: [{ id: "opus", label: "Opus" }] }]);
    await user.type(claudeModel, "custom-model");
    await user.click(claudeDialog.getByRole("button", { name: "刷新模型候选" }));
    expect(await claudeDialog.findByText(/候选来源：CLI 目录/u)).toBeVisible();
    expect(document.getElementById(claudeModel.getAttribute("list")!)?.querySelector("option")).toHaveAttribute("value", "opus");
    expect(claudeModel).toHaveValue("custom-model");
    vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([{ kind: "claude-code-cli", authenticated: true, supported: true, availability: "available", checkedAt: "2026-07-30T00:00:00.000Z", modelsSource: "server", models: [{ id: "claude-opus-test", label: "Opus" }] }]);
    await user.click(claudeDialog.getByRole("button", { name: "刷新模型候选" }));
    expect(await claudeDialog.findByText(/候选来源：服务端直查/u)).toBeVisible();
    expect(document.getElementById(claudeModel.getAttribute("list")!)?.querySelector("option")).toHaveAttribute("value", "claude-opus-test");
    expect(claudeModel).toHaveValue("custom-model");
  });

  it("shows model profiles without waiting for slow local client discovery", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );
    const codex = {
      version: 1 as const,
      profileId: "builtin-codex",
      kind: "codex-cli" as const,
      label: "Codex CLI",
      enabled: true,
      priority: 20,
      timeoutMs: 30_000,
      credentialConfigured: false,
    };
    let resolveStatuses:
      | ((
          value: Awaited<
            ReturnType<DecisionApi["listLocalModelClientStatuses"]>
          >,
        ) => void)
      | undefined;
    const statuses = new Promise<
      Awaited<ReturnType<DecisionApi["listLocalModelClientStatuses"]>>
    >((resolve) => {
      resolveStatuses = resolve;
    });
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([codex]);
    vi.mocked(api.listLocalModelClientStatuses).mockReturnValue(statuses);

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型后端",
    });
    expect(await within(panel).findByText("Codex CLI")).toBeVisible();
    expect(within(panel).getByText("正在检查客户端…")).toBeVisible();

    resolveStatuses?.([
      {
        kind: "codex-cli",
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);

    expect(await within(panel).findByText("已登录，可用")).toBeVisible();
  });

  it("inspects, deletes, and disables future model trace content", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "activity",
        modelTraceContentEnabled: true,
      }),
      [modelTraceFixture()],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const activity = await screen.findByRole("region", {
      name: "日志",
    });
    expect(
      within(activity).getByRole("heading", { name: "识别概览" }),
    ).toBeVisible();
    expect(within(activity).getByText("处理轮次")).toBeVisible();
    expect(within(activity).getByText("直接捕获")).toBeVisible();

    const panel = await screen.findByRole("region", {
      name: "模型调用记录",
    });
    const trace = within(panel);
    expect(trace.getByRole("heading", { name: "模型调用记录" })).toBeVisible();
    expect(await trace.findByText("Qwen 本地模型")).toBeVisible();
    // Which feature made the call, beside the model.
    expect(trace.getByText(/^语义识别 · /u)).toBeVisible();
    expect(trace.getByText("54 tokens")).toBeVisible();
    expect(
      trace.getByRole("list", { name: "模型调用记录列表" }),
    ).toHaveAttribute("tabindex", "0");

    await user.click(trace.getByRole("button", { name: "详情" }));
    const detailsDialog = within(
      screen.getByRole("dialog", { name: "Qwen 本地模型 调用详情" }),
    );
    expect(detailsDialog.getByText("模型输入")).toBeVisible();
    expect(detailsDialog.getByText("模型输出")).toBeVisible();
    // In words, as the backend card says it, not as "provider_reported".
    expect(detailsDialog.getByText("Token 来源").nextElementSibling).toHaveTextContent(/^(服务商 Token 统计|本地 Token 计数|Token 估算|Token 统计未提供)$/u);

    await user.click(
      detailsDialog.getByRole("button", { name: "删除这条记录" }),
    );
    expect(api.deleteModelTrace).toHaveBeenCalledWith("trace-1");

    await user.click(
      trace.getByRole("switch", {
        name: /记录模型输入和输出/u,
      }),
    );
    expect(api.setModelTraceContentEnabled).toHaveBeenCalledWith(false);
  });

  it("says the ratings could not be read rather than that there are none", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "activity" }));
    vi.mocked(api.getAssistantFeedbackSummary).mockResolvedValue({ helpful: 0, notHelpful: 0, unavailable: true });
    render(<App api={api} />);

    expect(await screen.findByText(/评分记录读不出来/u)).toBeVisible();
    expect(screen.queryByText(/还没有评分/u)).toBeNull();
  });

  it("keeps the trace switch unchanged after a failed save and supports keyboard retry", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "activity", modelTraceContentEnabled: true }));
    vi.mocked(api.setModelTraceContentEnabled).mockRejectedValueOnce(new Error("开关保存失败"));
    const user = userEvent.setup();
    render(<App api={api} />);
    const toggle = await screen.findByRole("switch", { name: "记录模型输入和输出" });
    toggle.focus();
    await user.keyboard(" ");
    expect(await screen.findByText("开关保存失败")).toBeVisible();
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    await user.keyboard(" ");
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(api.setModelTraceContentEnabled).toHaveBeenCalledTimes(2);
  });

  it("narrows the model call records to the calls that did not succeed", async () => {
    const failed: ModelInvocationTrace = { ...modelTraceFixture(), traceId: "trace-2", status: "failed", errorCode: "network_error" };
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "activity" }),
      [modelTraceFixture(), failed],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = within(await screen.findByRole("region", { name: "模型调用记录" }));
    const list = await panel.findByRole("list", { name: "模型调用记录列表" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    await user.click(panel.getByRole("checkbox", { name: "只看未成功（1）" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("失败")).toBeVisible();
    expect(panel.getByText(/^1 次调用 · 未成功 1/u)).toBeVisible();
  });

  it("describes a missing token count without implying that the model failed", async () => {
    const traceWithoutTokenCount: ModelInvocationTrace = {
      ...modelTraceFixture(),
      usage: { source: "unavailable" },
    };
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "activity",
      }),
      [traceWithoutTokenCount],
    );

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型调用记录",
    });
    expect(await within(panel).findByText("Token 统计未提供")).toBeVisible();
    expect(within(panel).queryByText("Token 不可用")).not.toBeInTheDocument();
  });

  it("adds up the listed model calls, with money only where the backend has a price", async () => {
    const answer: ModelInvocationTrace = {
      ...modelTraceFixture(),
      traceId: "trace-2",
      purpose: "retrieval-answer",
      profile: { ...modelTraceFixture().profile, profileId: "remote-deepseek" },
      usage: { source: "provider_reported", inputTokens: 200_000, outputTokens: 50_000, totalTokens: 250_000 },
      timing: { queuedMs: 0, providerMs: 1_900, totalMs: 1_972 },
      status: "timed_out",
    };
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "activity" }),
      [modelTraceFixture(), answer],
    );
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([{
      version: 1, profileId: "remote-deepseek", kind: "openai-compatible", label: "DeepSeek", enabled: true, priority: 10,
      model: "deepseek-chat", timeoutMs: 30_000, baseUrl: "https://api.deepseek.com", credentialConfigured: true,
      pricing: { currency: "¥", inputPerMillion: 2, outputPerMillion: 8 },
    }]);
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = within(await screen.findByRole("region", { name: "模型调用记录" }));
    // The local call has no price: it counts in tokens, not in money.
    expect(await panel.findByText("2 次调用 · 未成功 1 · 250.1k tokens · 平均 1.0 秒 · ≈ ¥0.8000（1 次未计价）")).toBeVisible();
    await user.selectOptions(panel.getByRole("combobox", { name: "按用途筛选" }), "retrieval-answer");
    expect(panel.getByText("1 次调用 · 未成功 1 · 250.0k tokens · 平均 2.0 秒 · ≈ ¥0.8000")).toBeVisible();

    // Deleting the last of the kind chosen goes back to all of them, filter and all.
    vi.mocked(api.listModelTraces).mockResolvedValue([modelTraceFixture()]);
    await user.click(panel.getByRole("button", { name: "详情" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除这条记录" }));
    expect(await panel.findByText("这条模型调用记录已删除。")).toBeVisible();
    expect(panel.queryByText("这一类下没有记录。")).toBeNull();
    expect(panel.getAllByRole("button", { name: "详情" })).toHaveLength(1);
  });

  it("shows a friendly output-limit label in model trace details", async () => {
    const outputLimitedTrace: ModelInvocationTrace = {
      ...modelTraceFixture(),
      status: "invalid_output",
      errorCode: "output_limit",
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
      usage: {
        source: "runtime_measured",
        inputTokens: 580,
        outputTokens: 512,
        totalTokens: 1_092,
      },
    };
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "activity",
      }),
      [outputLimitedTrace],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const panel = await screen.findByRole("region", {
      name: "模型调用记录",
    });
    await user.click(
      await within(panel).findByRole("button", {
        name: "详情",
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "Qwen 本地模型 调用详情" }),
      ).getByText("输出达到长度上限"),
    ).toBeVisible();
  });

  it("does not describe Apple model eligibility as unsupported hardware", async () => {
    const base = rationaleSnapshot({
      current: null,
      primarySurface: "models",
    });
    const { api } = apiFixture({
      ...base,
      semanticRecognition: {
        ...base.semanticRecognition,
        provider: "rules",
        providerLabel: "规则识别",
        availability: "device_not_eligible",
      },
    });

    render(<App api={api} />);

    const card = await screen.findByRole("region", {
      name: "模型",
    });
    expect(within(card).getByText("Apple 智能当前不可用")).toBeVisible();
    expect(card).not.toHaveTextContent("设备不支持");
  });

  it("says which model could not be used and why, while the rules read on their own", async () => {
    const base = rationaleSnapshot({
      current: null,
      primarySurface: "models",
    });
    const { api } = apiFixture({
      ...base,
      semanticRecognition: {
        ...base.semanticRecognition,
        provider: "rules",
        providerLabel: "规则识别",
        availability: "available",
        mode: "rules_only",
        unavailableModels: [
          { providerLabel: "Apple 本地模型", availability: "apple_intelligence_disabled" },
          { providerLabel: "Qwen 本地模型", availability: "runtime_unavailable" },
        ],
      },
    });

    render(<App api={api} />);

    const card = await screen.findByRole("region", {
      name: "模型",
    });
    // It said the rules were "暂时不可用，将自动重试" in 混合模式, and not that Apple Intelligence was off.
    expect(
      within(card).getByText(
        "没有可用的模型，正在只用规则：Apple 本地模型（Apple Intelligence 未开启）、Qwen 本地模型（暂时不可用，将自动重试）。",
      ),
    ).toBeVisible();
    expect(within(card).getByText("只用规则")).toBeVisible();
    expect(within(card).getByText("注意")).toBeVisible();
  });

  it("opens candidate review from the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        decisionCandidates: {
          current: reviewCandidate(),
          count: 3,
        },
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(
      await screen.findByRole("region", {
        name: "首页",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "开始处理" }));
    expect(api.openCandidateReview).toHaveBeenCalledOnce();
  });

  it("shows rationale recovery corruption in the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
        health: {
          index: "healthy",
          recovery: "degraded",
          recoveryMessage:
            "理由恢复日志损坏，已隔离；原始决策仍保留在待处理队列。",
        },
      }),
    );

    render(<App api={api} />);

    expect(await screen.findByText(/理由恢复日志损坏/u)).toBeVisible();
    expect(screen.queryByText("SQLite 健康")).toBeNull();
  });

  it("keeps failed persistence visible and allows retry", async () => {
    const current = {
      ...candidate(),
      status: "completed" as const,
    };
    const { api } = apiFixture(
      rationaleSnapshot({
        current,
        persistenceStatus: "failed",
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(
      await screen.findByText(/原生答案和理由仍保留在本机/u),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试保存" }));

    expect(api.retryPersistence).toHaveBeenCalledOnce();
  });

  it("says when it is the recovery queue on this machine, not Obsidian, that would not take a save", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: { ...candidate(), status: "completed" as const },
        persistenceStatus: "failed",
        persistenceFailure: "recovery_queue",
      }),
    );
    render(<App api={api} />);

    expect(await screen.findByText(/本机恢复队列暂时写不进/u)).toBeVisible();
    expect(screen.queryByText(/Obsidian 暂时无法写入/u)).toBeNull();
  });

  it("keeps the page a closed window had, rather than the home page in its place", async () => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "decisions" });
    const { api, emit } = apiFixture(snapshot);
    render(<App api={api} />);
    const page = await screen.findByRole("region", { name: "知识" });

    // ⌘W: drawn as the home page, the page went, and what was being written on it with it.
    act(() => emit({ ...snapshot, primarySurface: "hidden" }));
    expect(page).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "首页", hidden: true })).toBeNull();
  });

  it("keeps why a save failed through refreshes that are about something else", async () => {
    const snapshot = rationaleSnapshot({
      current: { ...candidate(), status: "completed" as const },
      persistenceStatus: "failed",
    });
    const { api, emit } = apiFixture(snapshot);
    vi.mocked(api.retryPersistence).mockRejectedValueOnce(new Error("找不到仓库目录：它可能被移动、改名，或所在的磁盘没有连接。"));
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "重试保存" }));
    expect(await screen.findByText(/找不到仓库目录/u)).toBeVisible();
    // A vault watcher or a semantic pair pushes snapshots all the time: the reason stays.
    act(() => emit({ ...snapshot }));
    expect(screen.getByText(/找不到仓库目录/u)).toBeVisible();
  });

  it("keeps every page in reach while a save waits, Settings above all", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: { ...candidate(), status: "completed" as const },
        persistenceStatus: "failed",
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    const alert = await screen.findByRole("region", { name: "决策保存状态" });
    // Held in place of every page, the window had only a retry that could not work while the vault was gone.
    expect(screen.getByRole("button", { name: "设置" })).toBeEnabled();
    await user.click(within(alert).getByRole("button", { name: "打开设置" }));
    expect(api.openSurface).toHaveBeenCalledWith("settings");
  });

  it("shows and changes the persisted appearance preference", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "settings",
        theme: "auto",
      }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);

    expect(await screen.findByRole("button", { name: "自动" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "浅色" }));

    expect(api.setTheme).toHaveBeenCalledWith("light");
  });
});

describe("App focus through a capture", () => {
  it("puts focus on the next question when the one answered gives way to it", async () => {
    const user = userEvent.setup();
    const { api, emit } = apiFixture(rationaleSnapshot({ waitingCount: 1 }));
    render(<App api={api} />);
    await screen.findByRole("heading", { level: 1, name: "选择本地服务协议" });
    screen.getByRole("button", { name: "记录到知识库" }).focus();
    await user.keyboard("{Enter}");

    const event = serverCaptureFixture({
      questions: [{
        questionIndex: 0, header: "Store", question: "选择草稿存放位置",
        options: [{ id: "a", label: "本机" }, { id: "b", label: "仓库" }],
        answer: { kind: "preset", values: ["本机"] }, multiSelect: false,
      }],
    });
    act(() => emit(rationaleSnapshot({
      current: { ...candidate(), candidateId: "candidate-2", candidateKey: "candidate-key-2", event, question: event.questions[0]! },
      waitingCount: 0,
    })));

    // Left on the page, Tab started over at the sidebar and a screen reader said nothing of the new question.
    expect(await screen.findByRole("heading", { level: 1, name: "选择草稿存放位置" })).toHaveFocus();
  });

  it("gives focus back to the rationale when its save fails", async () => {
    // Chromium takes focus from a control as it is disabled (jsdom does not): done here as it does.
    const observer = new MutationObserver(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null || !active.matches(":disabled")) return;
      const standIn = document.createElement("button");
      document.body.append(standIn);
      standIn.focus();
      standIn.remove();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
    try {
      const user = userEvent.setup();
      const { api } = apiFixture(rationaleSnapshot());
      vi.mocked(api.submitRationale).mockImplementationOnce(
        () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Obsidian 仓库暂时不可写")), 30)),
      );
      render(<App api={api} />);
      const textarea = await screen.findByLabelText("补充说明（可选）");
      await user.click(textarea);
      await user.keyboard("本机优先{Meta>}{Enter}{/Meta}");

      expect(await screen.findByRole("alert")).toHaveTextContent("Obsidian 仓库暂时不可写");
      // Back where the reader was writing, where Tab started over at the sidebar.
      await waitFor(() => expect(textarea).toHaveFocus());
    } finally {
      observer.disconnect();
    }
  });

  it("says a save that failed as an alert, with focus on its retry", async () => {
    const user = userEvent.setup();
    const { api, emit } = apiFixture(rationaleSnapshot({ waitingCount: 0 }));
    render(<App api={api} />);
    await user.click(await screen.findByLabelText("补充说明（可选）"));
    await user.keyboard("本机优先{Meta>}{Enter}{/Meta}");

    const completed = { ...candidate(), status: "completed" as const };
    act(() => emit(rationaleSnapshot({ current: completed, primarySurface: "dashboard" })));
    act(() => emit(rationaleSnapshot({ current: completed, primarySurface: "dashboard", persistenceStatus: "failed" })));

    // A status was not read out, and focus went to the page's title after it, Tab leading away from the retry.
    expect(await screen.findByRole("alert")).toHaveTextContent("Obsidian 暂时无法写入");
    await waitFor(() => expect(screen.getByRole("button", { name: "重试保存" })).toHaveFocus());
  });
});
