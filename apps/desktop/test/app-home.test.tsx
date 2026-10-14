// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App.js";
import type { AppSnapshot, DecisionLibraryItem, PendingRationaleSummary } from "../src/shared/renderer-api.js";
import { apiFixture, candidate, rationaleSnapshot } from "./app-fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item = (overrides: Partial<DecisionLibraryItem> = {}): DecisionLibraryItem => ({
  id: "decision-a", created: "2026-09-01T10:00:00.000Z", sourceClient: "codex", project: "decision",
  question: "缓存层放在哪一侧？", selectedAnswer: "先放在读取端", rationaleStatus: "captured",
  rationale: "可回退。", context: null, outcome: null, outcomeReview: null, reviewDueDate: "2026-09-10",
  appliedPrincipleIds: [], appliedPrinciples: [], ...overrides,
});

const pending = (id: string, question: string): PendingRationaleSummary => ({
  id, question, created: "2026-09-28T00:00:00.000Z", project: "decision", sourceClient: "codex",
  selectedAnswer: `答案-${id}`, contextSummary: null, capturedQuestion: null,
});

const home = (reviewAttention = 1): AppSnapshot =>
  rationaleSnapshot({
    current: null,
    primarySurface: "dashboard",
    dashboard: { totalDecisions: 5, recorded7d: 0, reviewAttention, recentDecisions: [] },
  });

describe("the home page's reviews", () => {
  it("reads the reviews again when a snapshot is pushed, so one done elsewhere is not still offered", async () => {
    const { api, emit } = apiFixture(home());
    let attention = [item()];
    vi.mocked(api.listDecisions).mockImplementation(async (query) => (query.reviewState === "attention" ? attention : []));
    render(<App api={api} />);
    const page = await screen.findByRole("region", { name: "首页" });
    expect(await within(page).findByRole("button", { name: "回填结果" })).toBeVisible();

    // The outcome written in Obsidian or by an agent: still to review, the count unchanged.
    attention = [item({ outcome: "在 Obsidian 里写的结果" }), item({ id: "decision-b", question: "索引重建自动还是手动？", outcome: "手动够用" })];
    act(() => emit(home(2)));

    expect(await within(page).findByText("索引重建自动还是手动？")).toBeVisible();
    expect(within(page).getAllByRole("button", { name: "完成复盘" })).toHaveLength(2);
    expect(within(page).queryByRole("button", { name: "回填结果" })).toBeNull();
  });

  it("keeps the list on screen while it is read again, and the button that opened the dialog keeps focus", async () => {
    const { api } = apiFixture(home());
    let attention = [item()];
    let release = (): void => undefined;
    let gate: Promise<void> = Promise.resolve();
    vi.mocked(api.listDecisions).mockImplementation(async (query) => {
      await gate;
      return query.reviewState === "attention" ? attention : [];
    });
    vi.mocked(api.updateDecisionOutcome).mockImplementation(async (_id, outcome) => {
      attention = [item({ outcome })];
      gate = new Promise<void>((resolve) => { release = resolve; });
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    const open = await screen.findByRole("button", { name: "回填结果" });
    await user.click(open);
    await user.type(screen.getByLabelText("结果说明"), "命中率达标。");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Read again after the save: the list does not turn into "正在读取…" under the reader.
    expect(screen.queryByText("正在读取复盘计划…")).toBeNull();
    await act(async () => release());
    const same = await screen.findByRole("button", { name: "完成复盘" });
    expect(same).toBe(open);
    expect(same).toHaveFocus();
  });

  it("hands focus to the row in its place when a rationale finished from its row takes the row off the list", async () => {
    const initial = { ...home(), pendingRationales: [pending("p1", "缓存"), pending("p2", "协议")] };
    const { api, emit } = apiFixture(initial);
    // The main process pushes the snapshot without the row before it answers.
    vi.mocked(api.submitRationale).mockImplementation(async () => {
      emit({ ...initial, pendingRationales: [pending("p1", "缓存")] });
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click((await screen.findAllByRole("button", { name: "补充理由" }))[1]!);
    await user.type(screen.getByRole("textbox", { name: "理由原文", description: "协议" }), "先统一协议。");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "补充理由" })).toHaveFocus());
  });

  it("keeps a typed rationale through a stray Escape", async () => {
    const { api } = apiFixture({ ...home(), pendingRationales: [pending("p1", "缓存")] });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "补充理由" }));
    await user.type(screen.getByRole("textbox", { name: "理由原文", description: "缓存" }), "读取端可以随时回退。");

    await user.keyboard("{Escape}");

    expect(screen.getByRole("textbox", { name: "理由原文", description: "缓存" })).toHaveValue("读取端可以随时回退。");
  });

  it("says the reviews could not be read, rather than that there are none, and reads them again on request", async () => {
    const { api } = apiFixture(home(3));
    vi.mocked(api.listDecisions).mockRejectedValue(new Error("SQLITE_BUSY"));
    const user = userEvent.setup();
    render(<App api={api} />);
    const page = await screen.findByRole("region", { name: "首页" });

    expect(await within(page).findByText(/复盘计划暂时无法读取/u)).toBeVisible();
    expect(within(page).queryByText("目前没有需要处理的复盘。")).toBeNull();

    vi.mocked(api.listDecisions).mockImplementation(async (query) => (query.reviewState === "attention" ? [item()] : []));
    await user.click(within(page).getByRole("button", { name: "重试" }));
    expect(await within(page).findByRole("button", { name: "回填结果" })).toBeVisible();
  });
});

describe("the home page's dialogs", () => {
  it("keeps an outcome being written while a capture takes the window over and gives it back", async () => {
    const { api, emit } = apiFixture(home());
    vi.mocked(api.listDecisions).mockImplementation(async (query) => (query.reviewState === "attention" ? [item()] : []));
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "回填结果" }));
    await user.type(screen.getByLabelText("结果说明"), "命中率达标，没有回退。");

    // The native question answered in the terminal: its rationale panel takes the window over.
    act(() => emit({ ...home(), current: candidate() }));
    await screen.findByRole("region", { name: "待补充决策理由" });
    act(() => emit(home()));
    await screen.findByRole("region", { name: "首页" });

    // Reopened once the list is read again, with the decision as it is now.
    expect(await screen.findByLabelText("结果说明")).toHaveValue("命中率达标，没有回退。");
  });

  it("keeps the outcome being written through a list that could not be read once, and gives it back after", async () => {
    const { api, emit } = apiFixture(home());
    let failing = false;
    vi.mocked(api.listDecisions).mockImplementation(async (query) => {
      if (failing) throw new Error("SQLITE_BUSY");
      return query.reviewState === "attention" ? [item()] : [];
    });
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "回填结果" }));
    await user.type(screen.getByLabelText("结果说明"), "命中率达标，没有回退。");
    act(() => emit({ ...home(), current: candidate() }));
    await screen.findByRole("region", { name: "待补充决策理由" });

    // Busy for a moment as the window comes back: unread says nothing of whether it still waits.
    failing = true;
    act(() => emit(home()));
    const page = await screen.findByRole("region", { name: "首页" });
    expect(await within(page).findByText(/复盘计划暂时无法读取/u)).toBeVisible();
    failing = false;
    await user.click(within(page).getByRole("button", { name: "重试" }));

    expect(await screen.findByLabelText("结果说明")).toHaveValue("命中率达标，没有回退。");
  });

  it("does not bring the dialog back for a decision done elsewhere meanwhile", async () => {
    const { api, emit } = apiFixture(home());
    let attention = [item()];
    vi.mocked(api.listDecisions).mockImplementation(async (query) => (query.reviewState === "attention" ? attention : []));
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "回填结果" }));
    await user.type(screen.getByLabelText("结果说明"), "命中率达标。");

    act(() => emit({ ...home(), current: candidate() }));
    await screen.findByRole("region", { name: "待补充决策理由" });
    // Reviewed in Obsidian while the window was taken: it no longer waits here.
    attention = [];
    act(() => emit(home(0)));
    const page = await screen.findByRole("region", { name: "首页" });

    expect(await within(page).findByText("目前没有需要处理的复盘。")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a rationale being written the same way", async () => {
    const initial = { ...home(), pendingRationales: [pending("p1", "缓存"), pending("p2", "协议")] };
    const { api, emit } = apiFixture(initial);
    const user = userEvent.setup();
    render(<App api={api} />);
    await user.click((await screen.findAllByRole("button", { name: "补充理由" }))[0]!);
    await user.type(screen.getByRole("textbox", { name: "理由原文", description: "缓存" }), "读取端可回退。");

    act(() => emit({ ...initial, current: candidate() }));
    await screen.findByRole("region", { name: "待补充决策理由" });
    act(() => emit(initial));
    await screen.findByRole("region", { name: "首页" });

    expect(screen.getByRole("textbox", { name: "理由原文", description: "缓存" })).toHaveValue("读取端可回退。");
  });
});
