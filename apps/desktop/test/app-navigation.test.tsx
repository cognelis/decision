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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantTurnResponse } from "@cognelis/decision-protocol";

import { App } from "../src/renderer/App.js";
import { loadSessions } from "../src/renderer/components/pages/assistant/assistant-session.js";
import {
  acceptedMethodologyFixture,
  apiFixture,
  rationaleSnapshot,
  renderDecisionLibrary,
} from "./app-fixtures.js";

/**
 * How the reader moves around the app: the sidebar, the global shortcuts, the
 * dashboard's own todos, and the jumps between records that any page can start.
 *
 * These were part of a 7000-line App.test.tsx, where the one thing they have in
 * common — none of them belong to a single page — was impossible to see.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("workspace navigation", () => {
  it("shows on the knowledge page in view an outcome an agent recorded for the open decision", async () => {
    let stored: import("../src/shared/renderer-api.js").DecisionLibraryItem = {
      id: "decision-1",
      created: "2026-09-20T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "缓存先放内存还是直接上 Redis？",
      selectedAnswer: "先放内存",
      rationaleStatus: "captured",
      rationale: null,
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: "2026-10-01",
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    const initial = rationaleSnapshot({
      current: null,
      primarySurface: "decisions",
      dashboard: { revision: 4, totalDecisions: 1, recorded7d: 0, reviewAttention: 1, recentDecisions: [] },
    });
    const { api, emit } = apiFixture(initial);
    vi.mocked(api.listDecisions).mockImplementation(async () => [stored]);
    render(<App api={api} />);
    fireEvent.click(await screen.findByText(stored.question));
    const details = within(screen.getByRole("dialog", { name: "决策详情" }));
    expect(details.getByText("尚未记录实际结果。")).toBeInTheDocument();

    // record_decision_outcome through MCP: the index moves, the count of decisions does not.
    stored = { ...stored, outcome: "内存缓存撑住了峰值，暂不需要 Redis。" };
    await act(async () => emit({ ...initial, dashboard: { ...initial.dashboard, revision: 5, reviewAttention: 0 } }));

    // The page in view kept saying 尚未记录实际结果 and offered 记录结果, and a save from it was refused as out of date.
    expect(await details.findByText("内存缓存撑住了峰值，暂不需要 Redis。")).toBeInTheDocument();
    expect(details.queryByText("尚未记录实际结果。")).toBeNull();
  });

  it("reads preferences and ideas again when the page is shown again, not at each move of the decisions' index", async () => {
    const initial = rationaleSnapshot({
      current: null,
      primarySurface: "decisions",
      dashboard: { revision: 4, totalDecisions: 1, recorded7d: 0, reviewAttention: 0, recentDecisions: [] },
    });
    const { api, emit } = apiFixture(initial);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("tab", { name: "偏好与想法" }));
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalled());
    const journalReads = vi.mocked(api.listJournalEntries).mock.calls.length;
    const decisionReads = vi.mocked(api.listDecisions).mock.calls.length;

    // Another decision captured: the decisions are read again, and preferences, in no index, are not.
    const moved = { ...initial, dashboard: { ...initial.dashboard, revision: 5 } };
    await act(async () => emit(moved));
    await waitFor(() => expect(vi.mocked(api.listDecisions).mock.calls.length).toBeGreaterThan(decisionReads));
    // Past the list's own 100 ms wait before it reads.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(api.listJournalEntries).toHaveBeenCalledTimes(journalReads);

    // A captured decision takes the window and gives it back: shown again, they are read again.
    await act(async () => emit(rationaleSnapshot({ primarySurface: "decisions", dashboard: moved.dashboard })));
    await act(async () => emit(moved));
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalledTimes(journalReads + 1));
  });

  it("reads preferences and ideas again when one is written while their list stays in view", async () => {
    const initial = rationaleSnapshot({
      current: null,
      primarySurface: "decisions",
      dashboard: { revision: 4, journalRevision: 1, totalDecisions: 1, recorded7d: 0, reviewAttention: 0, recentDecisions: [] },
    });
    const { api, emit } = apiFixture(initial);
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("tab", { name: "偏好与想法" }));
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalled());
    const journalReads = vi.mocked(api.listJournalEntries).mock.calls.length;

    // An agent records an idea through the bridge: unread, it waited unseen until the page was shown again.
    await act(async () => emit({ ...initial, dashboard: { ...initial.dashboard, journalRevision: 2 } }));
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalledTimes(journalReads + 1));
  });

  it("opens the decision saved from a filtered knowledge page", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    vi.mocked(api.createProactiveRecord).mockResolvedValue({
      recordVersion: 1, status: "created", recordKind: "decision", recordId: "new-decision",
      knowledgeStatus: "active", sensitivity: "private", storedTranscript: false,
    });
    vi.mocked(api.listDecisions).mockImplementation(async (query) => query.decisionId === "new-decision" ? [{
      id: "new-decision", created: "2026-09-24T03:04:00.000Z", sourceClient: "manual", project: "decision",
      question: "新保存的决定", selectedAnswer: "先灰度", rationaleStatus: "skipped", rationale: null,
      context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    }] : []);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await user.type(await screen.findByRole("searchbox", { name: "搜索决策与笔记" }), "不相关的筛选");
    await user.click(within(screen.getByRole("region", { name: "知识" })).getByRole("button", { name: "主动记录" }));
    const dialog = within(await screen.findByRole("dialog", { name: "主动记录" }));
    await user.type(dialog.getByLabelText("标题"), "新保存的决定");
    await user.type(dialog.getByLabelText("最终选择"), "先灰度");
    await user.click(dialog.getByRole("button", { name: "保存记录" }));
    const detail = await screen.findByRole("dialog", { name: "决策详情" });
    expect(within(detail).getByRole("heading", { name: "新保存的决定" })).toBeVisible();
  });

  it.each([true, false])("carries a reviewed decision into distillation (source available: %s)", async (available) => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "decisions" });
    const { api, emit } = apiFixture(snapshot);
    const evidence = {
      id: "older-reviewed-decision", created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex" as const, project: "decision", question: "缓存层放在哪一侧？",
      selectedAnswer: "先放在读取端", rationaleStatus: "captured" as const,
      rationale: "可回退。", context: null, outcome: "延迟已降低", expectedOutcome: "读取延迟降低且可回退",
      outcomeReview: { verdict: "as_expected" as const, lesson: "先验证读取端", reviewedAt: "2026-08-01T03:04:00.000Z" },
      reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) => {
      if (query?.reviewState === "reviewed") {
        return query.decisionId === evidence.id && available ? [evidence] : [];
      }
      return [evidence];
    });
    const user = userEvent.setup();
    await act(async () => { render(<App api={api} />); });
    await user.click(await screen.findByRole("button", { name: /缓存层放在哪一侧/u }));
    expect(screen.getByText("读取延迟降低且可回退")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "用于提炼原则" }));
    expect(api.openSurface).toHaveBeenCalledWith("methodology");
    await act(async () => { emit({ ...snapshot, primarySurface: "methodology" }); });
    const chooser = await screen.findByRole("dialog", { name: "选择复盘证据" });
    if (available) {
      expect(await within(chooser).findByRole("checkbox", { name: /缓存层放在哪一侧/u })).toBeChecked();
      expect(within(chooser).getByText("已选 1 / 5")).toBeVisible();
    } else {
      expect(await within(chooser).findByRole("alert")).toHaveTextContent("部分来源已不存在或不再是完整复盘");
      expect(within(chooser).getByText("已选 0 / 5")).toBeVisible();
    }
    expect(api.generateMethodology).not.toHaveBeenCalled();
  });

  it("keeps an in-flight answer and the next question when leaving the assistant page", async () => {
    const snapshot = rationaleSnapshot({ current: null, primarySurface: "assistant" });
    const { api, emit } = apiFixture(snapshot);
    const provider = { profileId: "local", label: "本机模型", kind: "qwen" as const, model: "qwen", leavesDevice: false };
    vi.mocked(api.listAssistantModels).mockResolvedValue([provider]);
    let complete!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    await act(async () => { render(<App api={api} />); });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "问一句你自己的历史" }), "上次为什么这样选？");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "设置" }));
    await act(async () => { emit({ ...snapshot, primarySurface: "settings" }); });
    expect(screen.queryByRole("textbox", { name: "问一句你自己的历史" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();

    await act(async () => {
      complete({
        version: 1, status: "answered",
        message: { role: "assistant", content: "当时需要能够回滚。", citations: [] },
        provider, durationMs: 100, requestId: "background-turn", truncated: false,
      });
    });
    // Kept with the vault it was asked in.
    expect(loadSessions(snapshot.vaultPath).conversations.flatMap((conversation) => conversation.messages)).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "当时需要能够回滚。" }),
    );
    await act(async () => { emit(snapshot); });
    expect(screen.getByText("当时需要能够回滚。")).toBeVisible();
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(api.cancelAssistantTurn).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "问一句你自己的历史" }), "还没发送的追问");
    await act(async () => { emit({ ...snapshot, primarySurface: "settings" }); });
    await act(async () => { emit(snapshot); });
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("还没发送的追问");
  });

  it("keeps model configuration focused while retaining provider status", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "models",
      }),
    );

    render(<App api={api} />);

    const card = await screen.findByRole("region", {
      name: "模型",
    });
    const semantic = within(card);
    expect(semantic.getByText("Qwen 本地模型")).toBeVisible();
    expect(semantic.getByText("可用")).toBeVisible();
    expect(semantic.getByText("混合模式")).toBeVisible();
    expect(semantic.queryByText("处理轮次")).toBeNull();
    expect(semantic.queryByText("直接捕获")).toBeNull();
    expect(semantic.queryByText("候选")).toBeNull();
    expect(semantic.queryByText("失败")).toBeNull();
    expect(screen.queryByText("待确认")).toBeNull();
    expect(screen.queryByText("待补理由")).toBeNull();
    expect(screen.queryByText("最近决策")).toBeNull();
    expect(card.textContent).not.toContain("semantic-session");
    expect(card.textContent).not.toContain("/Users/");
    expect(semantic.queryByRole("slider")).not.toBeInTheDocument();
    expect(semantic.queryByText(/阈值|置信度/u)).not.toBeInTheDocument();
  });

  it("returns from settings to the decision center", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "settings",
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", {
        name: "首页",
      }),
    );

    expect(api.openSurface).toHaveBeenCalledWith("dashboard");
  });

  it("opens the shortcut cheat sheet with ? and from the sidebar", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    const search = await screen.findByRole("searchbox", { name: "搜索决策与笔记" });

    await user.keyboard("?");
    const dialog = screen.getByRole("dialog", { name: "键盘快捷键" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText("按侧边栏顺序切换页面")).toBeVisible();
    expect(within(dialog).getByText("知识：聚焦搜索框")).toBeVisible();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "关闭键盘快捷键" }),
      ).toHaveFocus(),
    );

    await user.keyboard("{Meta>}1{/Meta}");
    expect(api.openSurface).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).toBeNull();

    await user.click(search);
    await user.keyboard("?");
    expect(search).toHaveValue("?");
    expect(screen.queryByRole("dialog", { name: "键盘快捷键" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "键盘快捷键" }));
    expect(screen.getByRole("dialog", { name: "键盘快捷键" })).toBeVisible();
  });

  it("routes every management entry to its own desktop page", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({
        current: null,
        primarySurface: "dashboard",
      }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    await screen.findByRole("region", { name: "首页" });

    for (const surface of [
      ["知识", "decisions"],
      ["方法论", "methodology"],
      ["设置", "settings"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: surface[0] }));
      expect(api.openSurface).toHaveBeenLastCalledWith(surface[1]);
    }
  });

  /*
   * 接入、模型和日志不再各占一个侧栏入口——它们是同一件事的四个分栏，收在
   * 「设置」里面，由页内的次级导航切换。
   */
  it("reaches each settings section from the settings sub-navigation", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "settings" }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const subnav = await screen.findByRole("navigation", { name: "设置分区" });
    expect(within(subnav).getByRole("button", { name: "通用" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    for (const section of [
      ["接入", "clients"],
      ["链接", "connections"],
      ["模型", "models"],
      ["日志", "activity"],
    ] as const) {
      await user.click(within(subnav).getByRole("button", { name: section[0] }));
      expect(api.openSurface).toHaveBeenLastCalledWith(section[1]);
    }
  });

  it("switches surfaces with Cmd/Ctrl+number and Cmd/Ctrl+comma", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "dashboard" }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "首页" });

    expect(screen.getByRole("button", { name: "知识" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+3 Control+3",
    );
    await user.keyboard("{Meta>}1{/Meta}");
    expect(api.openSurface).not.toHaveBeenCalled();
    await user.keyboard("{Meta>}2{/Meta}");
    expect(api.openSurface).toHaveBeenLastCalledWith("assistant");
    await user.keyboard("{Meta>}3{/Meta}");
    expect(api.openSurface).toHaveBeenLastCalledWith("decisions");
    await user.keyboard("{Control>}4{/Control}");
    expect(api.openSurface).toHaveBeenLastCalledWith("pr-review");
    await user.keyboard("{Control>}5{/Control}");
    expect(api.openSurface).toHaveBeenLastCalledWith("methodology");
    // 接入、模型与日志收进设置后，侧栏只剩六项，设置就是第六个。
    await user.keyboard("{Meta>}6{/Meta}");
    expect(api.openSurface).toHaveBeenLastCalledWith("settings");
    await user.keyboard("{Meta>},{/Meta}");
    expect(api.openSurface).toHaveBeenLastCalledWith("settings");
    // 第七个位置已经没有页面了，按下去什么也不该发生。
    await user.keyboard("{Meta>}7{/Meta}");
    await user.keyboard("{Meta>}0{/Meta}");
    await user.keyboard("{Shift>}{Meta>}3{/Meta}{/Shift}");
    expect(api.openSurface).toHaveBeenCalledTimes(6);
  });

  it("keeps surface shortcuts locked while a decision task is active", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "待补充决策理由" });

    await user.keyboard("{Meta>}2{/Meta}");
    await user.keyboard("{Meta>},{/Meta}");
    expect(api.openSurface).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "知识" })).toBeDisabled();
  });

  it("shows what a decision was later distilled into, and opens it", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const evidence = {
      id: "decision-evidence",
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex" as const,
      project: "decision",
      question: "缓存层放在哪一侧？",
      selectedAnswer: "先放在读取端",
      rationaleStatus: "captured" as const,
      rationale: "可回退。",
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockResolvedValue([evidence]);
    vi.mocked(api.listMethodologies).mockResolvedValue([
      acceptedMethodologyFixture({
        id: "principle-distilled",
        title: "先验证边界再扩大投入",
        sourceDecisionIds: ["decision-evidence"],
      }),
      acceptedMethodologyFixture({
        id: "principle-unrelated",
        title: "别的原则",
        sourceDecisionIds: ["decision-other"],
      }),
      acceptedMethodologyFixture({
        id: "principle-retired",
        title: "后来归档的原则",
        status: "retired",
        sourceDecisionIds: ["decision-evidence"],
      }),
    ]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.click(
      await screen.findByRole("button", { name: /缓存层放在哪一侧/u }),
    );

    // "采用的方法论" is what this decision applied; this is the other
    // direction — what it became evidence for. Only principles that name it.
    const section = await screen.findByText("由此沉淀的原则");
    const panel = section.closest("section")!;
    expect(within(panel).getByText("先验证边界再扩大投入")).toBeVisible();
    expect(within(panel).queryByText("别的原则")).toBeNull();
    // A principle distilled from this decision can since have been set aside;
    // saying "待确认" about an archived one would be a plain untruth.
    expect(
      within(panel).getByRole("button", { name: /后来归档的原则 · 已归档/u }),
    ).toBeVisible();
    // Listed, but not counted as distilled: only the one still in use is.
    const progress = screen.getByRole("heading", { name: "进度" }).closest("section")!;
    expect(within(progress).getByText("沉淀原则").closest("li")).toHaveTextContent("1 条");

    // Listing principles reads every methodology note; selecting a decision
    // must not pay for that again each time.
    expect(vi.mocked(api.listMethodologies).mock.calls).toHaveLength(1);

    await user.click(
      within(panel).getByRole("button", { name: "先验证边界再扩大投入" }),
    );
    expect(api.openSurface).toHaveBeenCalledWith("methodology");
  });

  it("shows the retrospective when quick jump asks for it while the methodology page is already open", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "methodology" }));
    const user = userEvent.setup();
    render(<App api={api} />);
    const page = await screen.findByRole("region", { name: "方法论" });
    const tabs = within(page).getByRole("tablist", { name: "方法论视图" });
    expect(within(tabs).getByRole("tab", { name: "原则" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "快速跳转" }));
    await user.type(await screen.findByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }), "回顾");
    await user.click(await screen.findByRole("option", { name: /周期回顾/u }));

    await waitFor(() => expect(within(tabs).getByRole("tab", { name: "分析" })).toHaveAttribute("aria-selected", "true"));
  });

  it("keeps focus on a settings button while what it does runs", async () => {
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
      const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "settings" }));
      const user = userEvent.setup();
      render(<App api={api} />);
      const dark = await screen.findByRole("button", { name: "深色" });
      dark.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(api.setTheme).toHaveBeenCalledWith("dark"));
      await waitFor(() => expect(dark).toHaveFocus());
    } finally {
      chromium.disconnect();
    }
  });

  it("shows one shell dialog at a time", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "dashboard" }),
    );
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "首页" });

    await user.click(screen.getByRole("button", { name: /快速跳转/u }));
    expect(screen.getByRole("dialog", { name: "快速跳转" })).toBeVisible();

    // Straight at the document, which is where the shortcut lands whenever
    // focus is not inside the open dialog. The guard that ignores shortcuts
    // fired from within a dialog does not cover this.
    fireEvent.keyDown(document.body, { key: "n", metaKey: true });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: /主动记录/u })).toBeVisible();
  });

  describe("after a page the reader did not choose", () => {
    // Saved with ⌘N, an idea lands the reader on 知识, wherever they were.
    const recordFrom = async (primarySurface: "methodology" | "models") => {
      const { api, emit } = apiFixture(rationaleSnapshot({ current: null, primarySurface }));
      // The real openSurface answers with a new snapshot; without that the app never leaves the page.
      vi.mocked(api.openSurface).mockImplementation(async (surface) => {
        emit(rationaleSnapshot({ current: null, primarySurface: surface }));
      });
      vi.mocked(api.createProactiveRecord).mockResolvedValue({
        recordVersion: 1, status: "created", recordKind: "idea", recordId: "idea-new",
        knowledgeStatus: "inbox", sensitivity: "personal", storedTranscript: false,
      });
      const user = userEvent.setup();
      render(<App api={api} />);
      await user.keyboard("{Meta>}n{/Meta}");
      const dialog = within(await screen.findByRole("dialog", { name: /主动记录/u }));
      await user.click(dialog.getByRole("button", { name: "想法" }));
      await user.type(dialog.getByLabelText("标题"), "缓存失效用事件驱动");
      await user.type(dialog.getByLabelText("想法内容"), "让写入端发事件。");
      await user.click(dialog.getByRole("button", { name: "保存记录" }));
      await screen.findByRole("region", { name: "知识" });
      return { api, user };
    };

    it("leaves the way back to the sidebar, always on screen", async () => {
      const { api, user } = await recordFrom("methodology");
      expect(screen.queryByRole("button", { name: /返回/u })).toBeNull();

      await user.click(screen.getByRole("button", { name: "方法论" }));
      expect(api.openSurface).toHaveBeenLastCalledWith("methodology");
      await screen.findByRole("region", { name: "方法论" });
    });

    it("leads 设置 back to the settings section the jump left, and on from there to 通用", async () => {
      const { api, user } = await recordFrom("models");

      await user.click(screen.getByRole("button", { name: "设置" }));
      expect(api.openSurface).toHaveBeenLastCalledWith("models");
      // Back on 模型, 设置 goes where it always has.
      await waitFor(() => expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("aria-current", "page"));
      await user.click(screen.getByRole("button", { name: "设置" }));
      expect(api.openSurface).toHaveBeenLastCalledWith("settings");
    });

    it("sends 设置 to 通用 once the reader has moved on from the section the jump left", async () => {
      const { api, user } = await recordFrom("models");
      await user.click(screen.getByRole("button", { name: "设置" }));
      expect(api.openSurface).toHaveBeenLastCalledWith("models");

      // On to 接入 by the sections' own navigation, which opens it straight from the main process.
      const sections = await screen.findByRole("navigation", { name: "设置分区" });
      await user.click(within(sections).getByRole("button", { name: "接入" }));
      await waitFor(() => expect(api.openSurface).toHaveBeenLastCalledWith("clients"));
      // 设置 led back to 模型, a section left since.
      await user.click(screen.getByRole("button", { name: "设置" }));
      expect(api.openSurface).toHaveBeenLastCalledWith("settings");
    });
  });

  describe("going back to the page a jump left", () => {
    const lesson = {
      id: "decision-lesson", created: "2026-09-10T03:04:00.000Z", sourceClient: "codex" as const,
      project: "decision", question: "缓存层放在哪一侧？", selectedAnswer: "先放在读取端",
      rationaleStatus: "deferred" as const, rationale: null, context: null, outcome: "上线后命中率 80%",
      outcomeReview: { verdict: "worse" as const, lesson: "写入端失效太慢", reviewedAt: "2026-09-20T10:00:00.000Z" },
      reviewDueDate: null, appliedPrincipleIds: ["principle-1"],
      appliedPrinciples: [{ id: "principle-1", title: "先验证边界再扩大投入", status: "accepted" as const }],
    };
    const navigating = (primarySurface: "methodology" | "decisions") => {
      const fixture = apiFixture(rationaleSnapshot({ current: null, primarySurface }));
      vi.mocked(fixture.api.openSurface).mockImplementation(async (surface) => {
        fixture.emit(rationaleSnapshot({ current: null, primarySurface: surface }));
      });
      return fixture.api;
    };

    it("finds the retrospective where the reader left it", async () => {
      const api = navigating("methodology");
      vi.mocked(api.listDecisions).mockImplementation(async (query) => (query.decisionId === lesson.id ? [lesson] : []));
      const analytics = await api.getDecisionAnalytics();
      const period = (days: number, lessons: unknown[]) => ({
        days, startDate: "2026-09-04", endDate: "2026-10-03", decisions: 3, previousDecisions: 1, rationaleCaptured: 2,
        rationaleDeferred: 1, expectationMissing: 0, reviews: lessons.length, previousReviews: 0, lessons, repeats: [],
        projects: [], principles: [],
      });
      vi.mocked(api.getDecisionAnalytics).mockResolvedValue({
        ...analytics,
        totals: { ...analytics.totals, decisions: 3 },
        retrospective: {
          reviewAttention: 0,
          periods: [period(7, []), period(30, [{
            decisionId: lesson.id, question: lesson.question, project: "decision", sourceClient: "codex",
            verdict: "worse", lesson: "写入端失效太慢", expectedOutcome: null, reviewedAt: "2026-09-20T10:00:00.000Z",
          }])],
        },
      } as never);
      const user = userEvent.setup();
      render(<App api={api} />);
      const page = await screen.findByRole("region", { name: "方法论" });
      await user.click(within(page).getByRole("tab", { name: "分析" }));
      await user.click(await within(page).findByRole("button", { name: "近 30 天" }));
      await user.click(await within(page).findByRole("button", { name: /缓存层放在哪一侧/u }));
      const detail = await screen.findByRole("dialog", { name: "决策详情" });
      await user.click(within(detail).getByRole("button", { name: "关闭决策详情" }));

      const readsBefore = vi.mocked(api.listMethodologies).mock.calls.length;
      await user.click(screen.getByRole("button", { name: "方法论" }));
      // Mounted afresh, it came back on 原则, with the 30 days the reader was reading gone.
      const back = await screen.findByRole("region", { name: "方法论" });
      expect(within(back).getByRole("tab", { name: "分析" })).toHaveAttribute("aria-selected", "true");
      expect(within(back).getByRole("heading", { name: /这 30 天做了什么决定/u })).toBeVisible();
      // Kept as it was, it is read again: what was done meanwhile on 知识 (a review saved) shows.
      await waitFor(() => expect(vi.mocked(api.listMethodologies).mock.calls.length).toBeGreaterThan(readsBefore));
    });

    it("finds the knowledge page with its words, filter and record, until another page is chosen", async () => {
      const api = navigating("decisions");
      vi.mocked(api.listDecisions).mockResolvedValue([lesson]);
      const user = userEvent.setup();
      await renderDecisionLibrary(api);
      await user.type(screen.getByRole("searchbox", { name: "搜索决策与笔记" }), "缓存");
      await user.click(screen.getByRole("button", { name: "待补理由" }));
      await user.click(await screen.findByRole("button", { name: /缓存层放在哪一侧/u }));
      const followPrinciple = async (): Promise<void> => {
        const detail = screen.getByRole("dialog", { name: "决策详情" });
        await user.click(within(detail).getByRole("button", { name: "先验证边界再扩大投入" }));
        await screen.findByRole("region", { name: "方法论" });
      };
      await followPrinciple();

      await user.click(screen.getByRole("button", { name: "知识" }));
      await screen.findByRole("region", { name: "知识" });
      expect(screen.getByRole("searchbox", { name: "搜索决策与笔记" })).toHaveValue("缓存");
      expect(screen.getByRole("button", { name: "待补理由" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("dialog", { name: "决策详情" })).toBeVisible();

      // Choosing another page is leaving it: the next visit starts afresh, as one from the sidebar always has.
      await followPrinciple();
      await user.click(screen.getByRole("button", { name: "首页" }));
      await screen.findByRole("region", { name: "首页" });
      await user.click(screen.getByRole("button", { name: "知识" }));
      await screen.findByRole("region", { name: "知识" });
      expect(screen.getByRole("searchbox", { name: "搜索决策与笔记" })).toHaveValue("");
      expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull();
    });

    it("shows the open record as it now is when the knowledge page is shown again", async () => {
      const api = navigating("decisions");
      vi.mocked(api.listDecisions).mockResolvedValue([lesson]);
      const user = userEvent.setup();
      await renderDecisionLibrary(api);
      await user.click(await screen.findByRole("button", { name: /缓存层放在哪一侧/u }));
      await user.click(within(screen.getByRole("dialog", { name: "决策详情" })).getByRole("button", { name: "先验证边界再扩大投入" }));
      await screen.findByRole("region", { name: "方法论" });

      // Meanwhile its outcome was written again elsewhere (an agent, Obsidian).
      vi.mocked(api.listDecisions).mockResolvedValue([{ ...lesson, outcome: "改到写入端后命中率 95%" }]);
      await user.click(screen.getByRole("button", { name: "知识" }));
      // Shown again, the list was read again but the open record said what it said before.
      const detail = await screen.findByRole("dialog", { name: "决策详情" });
      expect(await within(detail).findByText("改到写入端后命中率 95%")).toBeVisible();
    });

    it("reads the open record again on its own when the list shown again does not hold it", async () => {
      const api = navigating("decisions");
      vi.mocked(api.listDecisions).mockResolvedValue([lesson]);
      const user = userEvent.setup();
      await renderDecisionLibrary(api);
      await user.click(await screen.findByRole("button", { name: /缓存层放在哪一侧/u }));
      await user.click(within(screen.getByRole("dialog", { name: "决策详情" })).getByRole("button", { name: "先验证边界再扩大投入" }));
      await screen.findByRole("region", { name: "方法论" });

      // Reviewed again elsewhere meanwhile, and no longer in the list as filtered (or past what it shows).
      vi.mocked(api.listDecisions).mockImplementation(async (query) =>
        query.decisionId === lesson.id ? [{ ...lesson, outcome: "改到写入端后命中率 95%" }] : []);
      await user.click(screen.getByRole("button", { name: "知识" }));
      // Looked for in the list alone, it said what it said before, and an edit from it was refused as out of date.
      const detail = await screen.findByRole("dialog", { name: "决策详情" });
      expect(await within(detail).findByText("改到写入端后命中率 95%")).toBeVisible();
    });
  });

  it("opens the principle a decision says it applied", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const applied = {
      id: "decision-applied",
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex" as const,
      project: "decision",
      question: "缓存层放在哪一侧？",
      selectedAnswer: "先放在读取端",
      rationaleStatus: "captured" as const,
      rationale: "可回退。",
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: null,
      appliedPrincipleIds: ["principle-1"],
      appliedPrinciples: [
        {
          id: "principle-1",
          title: "先验证边界再扩大投入",
          status: "accepted" as const,
        },
      ],
    };
    vi.mocked(api.listDecisions).mockResolvedValue([applied]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);

    await user.click(
      await screen.findByRole("button", { name: /缓存层放在哪一侧/u }),
    );
    await user.click(
      await screen.findByRole("button", { name: "先验证边界再扩大投入" }),
    );

    // Naming the principle without a way to it leaves the reader to go and
    // find its conditions and cautions by hand.
    expect(api.openSurface).toHaveBeenCalledWith("methodology");
  });

  it("lands on the preference or idea quick jump found", async () => {
    // Already on the knowledge surface: this fixture's openSurface is a no-op,
    // and what is under test is arriving at the entry, not the page switch.
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const idea = {
      id: "idea-1",
      kind: "idea" as const,
      title: "缓存失效可以用事件驱动",
      content: "与其定时清理，不如让写入端发事件。",
      knowledgeStatus: "inbox" as const,
      sourceKind: "app_manual" as const,
      sourceForm: "user_original" as const,
      project: "decision",
      occurredAt: null,
      sensitivity: "personal" as const,
      context: null,
      rationale: null,
      tags: [],
      languages: [],
      ideaForm: "hypothesis" as const,
      whyInteresting: null,
      openQuestions: [],
      nextTest: null,
      incubateUntil: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      revision: 1,
      revisionEvents: [],
    };
    vi.mocked(api.listJournalEntries).mockResolvedValue([idea]);
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await screen.findByRole("searchbox", { name: "搜索决策与笔记" });

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }),
      "缓存",
    );
    const dialog = screen.getByRole("dialog", { name: "快速跳转" });
    await user.click(await within(dialog).findByText("缓存失效可以用事件驱动"));

    // The journal is a flat list behind its own tab, so arriving means the tab
    // switched and the list says which card was meant.
    const card = await screen.findByText("缓存失效可以用事件驱动");
    expect(card.closest("li")).toHaveAttribute("aria-current", "true");

    // The arrival is taken once: back on the decisions, the same entry can be arrived at again.
    await user.click(screen.getByRole("tab", { name: "决策" }));
    expect(screen.getByRole("tab", { name: "决策" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }), "缓存");
    await user.click(await within(screen.getByRole("dialog", { name: "快速跳转" })).findByText("缓存失效可以用事件驱动"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "偏好与想法" })).toHaveAttribute("aria-selected", "true"));
  });

  it("applies a filter asked for from quick jump while the knowledge page is already open", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await screen.findByRole("searchbox", { name: "搜索决策与笔记" });
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }), "补理由");
    await user.click(await within(screen.getByRole("dialog", { name: "快速跳转" })).findByText("待补理由"));
    await waitFor(() => expect(api.listDecisions).toHaveBeenLastCalledWith(expect.objectContaining({ rationaleStatus: "deferred" })));
  });

  it("closes a review from the dashboard and reloads what is still due", async () => {
    const { api } = apiFixture(
      // A review is due, so something was recorded: not the first-run page.
      rationaleSnapshot({ current: null, primarySurface: "dashboard", dashboard: { totalDecisions: 1, recorded7d: 0, reviewAttention: 1, recentDecisions: [] } }),
    );
    const due = {
      id: "decision-due",
      created: "2026-07-30T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "索引重建应该自动还是手动？",
      selectedAnswer: "保持手动重建",
      rationaleStatus: "captured" as const,
      rationale: "自动重建难以取消。",
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: "2026-08-30",
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.reviewState === "attention" ? [due] : [],
    );
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "首页" });

    await user.click(await screen.findByRole("button", { name: "回填结果" }));
    const form = screen.getByRole("form", { name: "回填实际结果表单" });
    await user.type(
      within(form).getByLabelText("结果说明"),
      "手动重建够用，没有遗漏。",
    );
    const before = vi.mocked(api.listDecisions).mock.calls.length;
    await user.click(within(form).getByRole("button", { name: /保存结果/u }));

    await waitFor(() =>
      expect(api.updateDecisionOutcome).toHaveBeenCalledWith(
        "decision-due",
        "手动重建够用，没有遗漏。",
      ),
    );
    // The card holds what is still due; saving changes that, and the list is
    // loaded here rather than carried by the pushed snapshot.
    await waitFor(() =>
      expect(
        vi.mocked(api.listDecisions).mock.calls.length,
      ).toBeGreaterThan(before),
    );
  });

  it("records from any page and lands on what was just recorded", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "activity" }),
    );
    vi.mocked(api.createProactiveRecord).mockResolvedValue({
      recordVersion: 1,
      status: "created",
      recordKind: "idea",
      recordId: "idea-new",
      knowledgeStatus: "inbox",
      sensitivity: "personal",
      storedTranscript: false,
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "日志" });

    await user.keyboard("{Meta>}n{/Meta}");
    const dialog = within(await screen.findByRole("dialog", { name: /主动记录/u }));
    await user.click(dialog.getByRole("button", { name: "想法" }));
    await user.type(dialog.getByLabelText("标题"), "缓存失效用事件驱动");
    await user.type(
      dialog.getByLabelText("想法内容"),
      "与其定时清理，不如让写入端发事件。",
    );
    await user.click(dialog.getByRole("button", { name: "保存记录" }));

    await waitFor(() => expect(api.createProactiveRecord).toHaveBeenCalled());
    // The log page shows none of this, so arriving on the record is the only
    // way the reader can see that it landed.
    await waitFor(() =>
      expect(api.openSurface).toHaveBeenCalledWith("decisions"),
    );
  });

  it("keeps capture locked while a decision task is active", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "待补充决策理由" });

    await user.keyboard("{Meta>}n{/Meta}");
    // The task in front of the reader is a capture waiting for an answer;
    // starting a second one on top of it abandons the first.
    expect(screen.queryByRole("dialog", { name: /主动记录/u })).toBeNull();
    expect(screen.getByRole("button", { name: /主动记录/u })).toBeDisabled();
  });

  it("opens quick jump with the shortcut and from the sidebar", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );
    const user = userEvent.setup();
    await renderDecisionLibrary(api);
    await screen.findByRole("searchbox", { name: "搜索决策与笔记" });

    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByRole("dialog", { name: "快速跳转" })).toBeVisible();
    // The caret has to land in the field, or the first thing typed is lost.
    const field = screen.getByRole("combobox", {
      name: "搜索决策、想法、笔记、原则、问答与评审",
    });
    await waitFor(() => expect(field).toHaveFocus());

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "快速跳转" })).toBeNull(),
    );

    // Not shortcut-only: a reader who never opens the cheat sheet still finds it.
    await user.click(screen.getByRole("button", { name: /快速跳转/u }));
    expect(screen.getByRole("dialog", { name: "快速跳转" })).toBeVisible();
  });

  it("jumps from quick jump to the decision it found", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "dashboard" }),
    );
    vi.mocked(api.listDecisions).mockResolvedValue([
      {
        id: "decision-a",
        created: "2026-07-30T03:04:00.000Z",
        sourceClient: "codex",
        project: "decision",
        question: "缓存策略应该如何调整？",
        selectedAnswer: "使用可清理的本地缓存",
        rationaleStatus: "captured",
        rationale: "便于恢复。",
        context: null,
        outcome: null,
        outcomeReview: null,
        reviewDueDate: null,
        appliedPrincipleIds: [],
        appliedPrinciples: [],
      },
    ]);
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "首页" });

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }),
      "缓存",
    );
    await user.click(
      await screen.findByRole("option", { name: /缓存策略应该如何调整/u }),
    );

    // The jump is both halves: switch page, and arrive on that record.
    expect(api.openSurface).toHaveBeenCalledWith("decisions");
    expect(screen.queryByRole("dialog", { name: "快速跳转" })).toBeNull();
  });

  it("keeps quick jump locked while a decision task is active", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const user = userEvent.setup();
    render(<App api={api} />);
    await screen.findByRole("region", { name: "待补充决策理由" });

    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("dialog", { name: "快速跳转" })).toBeNull();
    expect(screen.getByRole("button", { name: /快速跳转/u })).toBeDisabled();
  });

  it("searches decisions and vault notes from one knowledge surface", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "decisions" }),
    );

    await renderDecisionLibrary(api);

    expect(
      await screen.findByRole("region", { name: "知识" }),
    ).toBeVisible();
    // Both halves live on this one page; Obsidian is no longer its own surface.
    expect(
      await screen.findByRole("region", { name: "Vault 笔记" }),
    ).toBeVisible();
    expect(api.getObsidianSearchStatus).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Obsidian" })).toBeNull();
    expect(
      screen.getByRole("searchbox", { name: "搜索决策与笔记" }),
    ).toBeVisible();
  });

  it("describes and rebuilds only the Decision Markdown index in settings", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "settings" }),
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(await screen.findByText("决策索引")).toBeVisible();
    expect(
      screen.getByText("用于搜索和统计决策 Markdown，可以从 Markdown 恢复"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重建决策索引" }));
    expect(api.rebuildIndex).toHaveBeenCalledTimes(1);
    expect(api.rebuildObsidianSearch).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已从 Markdown 重建决策索引，共 0 条。",
    );
  });

  it("shows due reviews on the dashboard without auto-opening the app", async () => {
    const { api } = apiFixture(
      // Reviews are due, so something was recorded: not the first-run page.
      rationaleSnapshot({ current: null, primarySurface: "dashboard", dashboard: { totalDecisions: 2, recorded7d: 0, reviewAttention: 2, recentDecisions: [] } }),
    );
    const dueDecision = {
      id: "decision-due-1",
      created: "2026-08-01T03:04:00.000Z",
      sourceClient: "codex",
      project: "decision",
      question: "新的索引策略是否达到预期？",
      selectedAnswer: "先灰度验证",
      rationaleStatus: "captured" as const,
      rationale: "先验证风险更低。",
      context: null,
      outcome: null,
      outcomeReview: null,
      reviewDueDate: "2026-08-01",
      appliedPrincipleIds: [],
      appliedPrinciples: [],
    };
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.reviewState === "attention" ? [dueDecision] : [],
    );
    const user = userEvent.setup();

    render(<App api={api} />);

    const inbox = await screen.findByRole("region", { name: "首页" });
    expect(within(inbox).getByText("复盘收件箱")).toBeVisible();
    expect(
      await within(inbox).findByText("新的索引策略是否达到预期？"),
    ).toBeVisible();
    expect(
      within(inbox).getByText("到期后，应用运行时会发一条系统通知，不会弹出窗口；可在设置里关闭。"),
    ).toBeVisible();
    expect(api.openSurface).not.toHaveBeenCalled();

    await user.click(
      within(inbox).getByRole("button", {
        name: /新的索引策略是否达到预期/u,
      }),
    );
    expect(api.openSurface).toHaveBeenCalledWith("decisions");
  });

  it("says due reviews wait on the dashboard alone when reminders are off", async () => {
    const { api } = apiFixture(
      rationaleSnapshot({ current: null, primarySurface: "dashboard", reviewRemindersEnabled: false, dashboard: { totalDecisions: 2, recorded7d: 0, reviewAttention: 1, recentDecisions: [] } }),
    );
    vi.mocked(api.listDecisions).mockImplementation(async (query) =>
      query.reviewState === "attention" ? [{
        id: "decision-due-1", created: "2026-08-01T03:04:00.000Z", sourceClient: "codex", project: "decision",
        question: "新的索引策略是否达到预期？", selectedAnswer: "先灰度验证", rationaleStatus: "captured" as const, rationale: "先验证风险更低。",
        context: null, outcome: null, outcomeReview: null, reviewDueDate: "2026-08-01", appliedPrincipleIds: [], appliedPrinciples: [],
      }] : [],
    );

    render(<App api={api} />);

    const inbox = await screen.findByRole("region", { name: "首页" });
    expect(await within(inbox).findByText("复盘提醒已关闭，到期事项只在这里出现。")).toBeVisible();
  });
});

it("starts compact, labels icon navigation and restores text when expanded", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "dashboard" }));
  const view = render(<App api={api} />);
  await screen.findByRole("button", { name: "展开菜单栏" });
  expect(document.querySelector(".desktop-app")).toHaveAttribute("data-sidebar-collapsed", "true");
  const nav = screen.getByRole("navigation", { name: "主导航" });
  fireEvent.mouseEnter(within(nav).getByRole("button", { name: "问答" }));
  expect(screen.getByRole("tooltip")).toHaveTextContent("问答");
  fireEvent.mouseLeave(within(nav).getByRole("button", { name: "问答" }));
  fireEvent.click(within(nav).getByRole("button", { name: "问答" }));
  expect(api.openSurface).toHaveBeenCalledWith("assistant");
  view.unmount();
  render(<App api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "展开菜单栏" }));
  expect(document.querySelector(".desktop-app")).toHaveAttribute("data-sidebar-collapsed", "false");
  expect(screen.getByRole("button", { name: "收起菜单栏" })).toHaveTextContent("收起菜单栏");
  expect(screen.getByRole("button", { name: "键盘快捷键" })).toHaveTextContent("键盘快捷键");
  cleanup();
  render(<App api={api} />);
  expect(await screen.findByRole("button", { name: "展开菜单栏" })).toHaveAttribute("aria-expanded", "false");
});
