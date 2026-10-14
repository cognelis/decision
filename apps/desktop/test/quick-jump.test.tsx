// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DecisionLibraryItem,
  JournalEntry,
  MethodologyItem,
} from "../src/shared/renderer-api.js";
import {
  QuickJumpDialog,
  matchPrinciples,
  type QuickJumpApi,
} from "../src/renderer/components/QuickJumpDialog.js";
import { saveReviewHistory } from "../src/renderer/components/pages/pr-review/review-history.js";
import { emptyConversation, saveSessions } from "../src/renderer/components/pages/assistant/assistant-session.js";

/**
 * Quick jump exists because each page searched only its own store, so finding
 * something meant first remembering where it was written. These cases hold the
 * two properties that make it worth the shortcut: all three stores answer at
 * once, and one of them failing still leaves the other two usable.
 */

const decisionFixture = (
  overrides: Partial<DecisionLibraryItem> = {},
): DecisionLibraryItem => ({
  id: "decision-1",
  created: "2026-09-01T10:00:00.000Z",
  sourceClient: "claude-code",
  project: "decision",
  question: "缓存层放在哪一侧",
  selectedAnswer: "先放在读取端，可回退",
  rationaleStatus: "captured",
  rationale: null,
  context: null,
  outcome: null,
  outcomeReview: null,
  reviewDueDate: null,
  appliedPrincipleIds: [],
  appliedPrinciples: [],
  ...overrides,
});

const principleFixture = (
  overrides: Partial<MethodologyItem> = {},
): MethodologyItem => ({
  id: "principle-1",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T10:00:00.000Z",
  title: "先验证边界再扩大投入",
  principle: "先用可回退的小步验证缓存边界，再扩大不可逆投入。",
  appliesWhen: "关键效果仍需真实运行验证时。",
  caution: "验证成本高于潜在损失时应重新评估。",
  evidenceSummary: "两条复盘结果支持这项原则。",
  sourceDecisionIds: [],
  sourceDecisions: [],
  confidence: "medium",
  quality: {
    recommendedConfidence: "medium",
    confidenceReason: "两条复盘结果一致。",
    evidenceCount: 2,
    missingEvidenceCount: 0,
    projectCount: 1,
    sourceCount: 1,
    favorableEvidenceCount: 2,
    attentionEvidenceCount: 0,
    unclearEvidenceCount: 0,
    flags: [],
    relations: [],
  },
  generation: {
    requestId: "methodology:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5",
  },
  ...overrides,
});

const journalFixture = (): JournalEntry => ({
  id: "idea-1",
  kind: "idea",
  title: "缓存失效可以用事件驱动",
  content: "与其定时清理，不如让写入端发事件。",
  knowledgeStatus: "inbox",
  sourceKind: "app_manual",
  sourceForm: "user_original",
  project: "decision",
  occurredAt: null,
  sensitivity: "personal",
  context: null,
  rationale: null,
  tags: [],
  languages: [],
  ideaForm: "hypothesis",
  whyInteresting: null,
  openQuestions: [],
  nextTest: null,
  incubateUntil: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  revision: 1,
  revisionEvents: [],
});

const apiFixture = (overrides: Partial<QuickJumpApi> = {}): QuickJumpApi => ({
  listDecisions: vi.fn(async () => [decisionFixture()]),
  listJournalEntries: vi.fn(async () => [journalFixture()]),
  searchObsidian: vi.fn(async ({ query }) => ({
    query,
    results: [
      {
        relativePath: "notes/缓存.md",
        title: "缓存笔记",
        heading: "读取端缓存",
        snippet: "读取端缓存的取舍",
        matchKind: "keyword" as const,
      },
    ],
    status: {
      state: "ready" as const,
      discoveredNotes: 1,
      indexedNotes: 1,
      chunkCount: 1,
      processedNotes: 1,
      totalNotes: 1,
      skippedNotes: 0,
      failedNotes: 0,
      synchronizedAt: null,
      semanticAvailable: false,
      message: null,
    },
  })),
  listMethodologies: vi.fn(async () => [principleFixture()]),
  openObsidianNote: vi.fn(async () => undefined),
  ...overrides,
});

const renderDialog = async (overrides: Partial<QuickJumpApi> = {}) => {
  const api = apiFixture(overrides);
  const onClose = vi.fn();
  const onOpenDecision = vi.fn();
  const onOpenJournalEntry = vi.fn();
  const onOpenPrinciple = vi.fn();
  await act(async () => {
    render(
      <QuickJumpDialog
        api={api}
        onClose={onClose}
        onOpenDecision={onOpenDecision}
        onOpenJournalEntry={onOpenJournalEntry}
        onOpenPrinciple={onOpenPrinciple}
      />,
    );
  });
  return {
    api,
    onClose,
    onOpenDecision,
    onOpenJournalEntry,
    onOpenPrinciple,
  };
};

const options = (): HTMLElement[] =>
  within(screen.getByRole("listbox")).getAllByRole("option");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const changeQuery = (value: string) => {
  const field = screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" });
  expect(field).toHaveFocus();
  expect(field).toBeEnabled();
  fireEvent.change(field, { target: { value } });
};

const finishSearch = async () => {
  await act(() => vi.advanceTimersByTimeAsync(160));
};

describe("Enter before the results of what was typed", () => {
  it("opens the first result of the words typed once it is in, not a row of the list before", async () => {
    const recent = decisionFixture({ id: "recent-decision", question: "最近一条决策" });
    const { onOpenDecision } = await renderDialog({
      listDecisions: vi.fn(async ({ query }) => (query === "" ? [recent] : [decisionFixture({ id: "found", question: "缓存层放在哪一侧" })])),
    });
    await finishSearch();
    expect(screen.getByRole("group", { name: "最近决策" })).toBeVisible();

    changeQuery("缓存层");
    // The recent rows still showing are not headed as matches for the new words.
    expect(screen.queryByRole("group", { name: "决策" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }), { key: "Enter" });
    expect(onOpenDecision).not.toHaveBeenCalled();

    await finishSearch();
    expect(onOpenDecision).toHaveBeenCalledWith("found");
  });
});

describe("matchPrinciples", () => {
  it("matches on the wording a reader would remember, not only the title", () => {
    const items = [principleFixture()];

    // Each field is one of the three a reader might recall the principle by.
    expect(matchPrinciples(items, "边界")).toHaveLength(1);
    expect(matchPrinciples(items, "不可逆投入")).toHaveLength(1);
    expect(matchPrinciples(items, "真实运行验证")).toHaveLength(1);
    expect(matchPrinciples(items, "无关词")).toHaveLength(0);
    // Words apart, as decisions and the journal match them: each somewhere, in any field.
    expect(matchPrinciples(items, "缓存 边界")).toHaveLength(1);
    expect(matchPrinciples(items, "缓存 无关词")).toHaveLength(0);
  });

  it("keeps the result list short enough to stay beside the other two groups", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      principleFixture({ id: `principle-${index}`, title: `边界 ${index}` }),
    );

    expect(matchPrinciples(many, "边界").length).toBeLessThanOrEqual(5);
  });
});

describe("QuickJumpDialog", () => {
  it("says it is still looking rather than saying there is nothing", async () => {
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const { api } = await renderDialog({
      listDecisions: vi.fn(async () => {
        await pending;
        return [decisionFixture()];
      }),
    });

    // The keyword pass is debounced and the semantic one only starts after it
    // comes back empty; "没有匹配" during that stretch would be a false answer.
    expect(screen.getByText("正在检索…")).toBeVisible();
    expect(screen.queryByText("没有匹配的记录。")).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(159));
    expect(api.listDecisions).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(api.listDecisions).toHaveBeenCalledTimes(1);
    expect(screen.getByText("正在检索…")).toBeVisible();
    expect(within(screen.getByRole("listbox")).queryAllByRole("option")).toHaveLength(0);

    await act(async () => { release(); });
    expect(options().length).toBeGreaterThan(0);
    expect(screen.queryByText("正在检索…")).toBeNull();
  });

  it("does not call the newest records a search result", async () => {
    await renderDialog();

    // Nothing typed yet: these are the latest records, not matches, and the
    // heading is the only thing that can say so.
    await finishSearch();
    expect(screen.getByText("最近决策")).toBeVisible();
    expect(screen.queryByText("最近笔记")).toBeNull();
  });

  it("answers from all three stores at once", async () => {
    await renderDialog();

    changeQuery("缓存");

    await finishSearch();
    expect(options()).toHaveLength(4);
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getByText("缓存层放在哪一侧")).toBeVisible();
    expect(within(listbox).getByText("缓存失效可以用事件驱动")).toBeVisible();
    expect(within(listbox).getByText("缓存笔记")).toBeVisible();
    expect(within(listbox).getByText("先验证边界再扩大投入")).toBeVisible();
    // Grouped for reading, but one list for the arrow keys. All four kinds of
    // sedimented knowledge answer, not only the three with their own page.
    expect(within(listbox).getByText("决策")).toBeVisible();
    expect(within(listbox).getByText("偏好与想法")).toBeVisible();
    expect(within(listbox).getByText("笔记")).toBeVisible();
    expect(within(listbox).getByText("原则")).toBeVisible();
  });

  it("walks the arrow keys across the group boundaries", async () => {
    const { onOpenPrinciple, onClose } = await renderDialog();
    const field = screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" });

    changeQuery("缓存");
    await finishSearch();
    expect(options()).toHaveLength(4);
    expect(options()[0]).toHaveAttribute("aria-selected", "true");

    // Three presses cross three group headings to reach the principle.
    for (let index = 0; index < 3; index += 1) {
      fireEvent.keyDown(field, { key: "ArrowDown" });
    }
    expect(options()[3]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onOpenPrinciple).toHaveBeenCalledWith("principle-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the highlighted decision on Enter", async () => {
    const { onOpenDecision, onClose } = await renderDialog();

    changeQuery("缓存");
    await finishSearch();
    expect(options()).toHaveLength(4);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onOpenDecision).toHaveBeenCalledWith("decision-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("asks decisions the other way when the words find nothing", async () => {
    const listDecisions: QuickJumpApi["listDecisions"] = vi.fn(
      async ({ searchMode }) =>
        searchMode === "semantic"
          ? [decisionFixture({ searchMatch: "semantic" })]
          : [],
    );
    await renderDialog({ listDecisions });

    changeQuery("命中率");

    // Keyword found nothing; without the second pass the reader is told the
    // decision was never recorded.
    await finishSearch();
    expect(screen.getByText("缓存层放在哪一侧")).toBeVisible();
    expect(screen.getAllByText("语义命中")).not.toHaveLength(0);
  });

  it("does not pay for a semantic pass the words already answered", async () => {
    const listDecisions: QuickJumpApi["listDecisions"] = vi.fn(async () => [
      decisionFixture(),
    ]);
    await renderDialog({ listDecisions });

    changeQuery("缓存");
    await finishSearch();
    expect(options().length).toBeGreaterThan(0);

    expect(
      vi
        .mocked(listDecisions)
        .mock.calls.filter(([query]) => query.searchMode === "semantic"),
    ).toHaveLength(0);
  });

  it("opens a preference or idea, which has no page of its own", async () => {
    const { onOpenJournalEntry, onClose } = await renderDialog();

    changeQuery("缓存");
    await finishSearch();
    expect(options()).toHaveLength(4);
    fireEvent.click(screen.getByText("缓存失效可以用事件驱动"));

    expect(onOpenJournalEntry).toHaveBeenCalledWith("idea-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("tells two decisions with the same wording apart", async () => {
    await renderDialog({
      listDecisions: vi.fn(async () => [
        decisionFixture({ id: "a", project: "decision" }),
        decisionFixture({ id: "b", project: "obsidian-tools" }),
        // Same project as the first, asked again on another day.
        decisionFixture({
          id: "c",
          project: "decision",
          created: "2026-09-08T10:00:00.000Z",
        }),
      ]),
    });

    changeQuery("缓存");

    // Same question and answer three times: what separates them goes first.
    await finishSearch();
    expect(options()).toHaveLength(6);
    const details = options()
      .filter((option) => option.textContent?.includes("缓存层放在哪一侧"))
      .map((option) => option.querySelector(".quick-jump-result-detail")
        ?.textContent);
    expect(new Set(details).size).toBe(details.length);
    expect(details[0]).toMatch(/^decision · /u);
    expect(details[1]).toMatch(/^obsidian-tools · /u);
  });

  it("says which of the two a journal result is", async () => {
    await renderDialog();

    changeQuery("缓存");
    await finishSearch();
    expect(options()).toHaveLength(4);

    // A preference is a current stance; an idea is not a commitment. The list
    // must not blur the two into one row type.
    expect(screen.getByText(/^想法 · /u)).toBeVisible();
  });

  it("says whether a principle has actually been accepted", async () => {
    await renderDialog({
      listMethodologies: vi.fn(async () => [
        principleFixture({ status: "candidate" }),
      ]),
    });

    changeQuery("边界");

    // A candidate is not a rule yet; a row that reads like one invites acting
    // on something nobody has confirmed.
    await finishSearch();
    expect(screen.getByText(/^待确认 · /u)).toBeVisible();
  });

  it("keeps the other groups when the vault cannot answer", async () => {
    await renderDialog({
      searchObsidian: vi.fn(async () => {
        throw new Error("index unavailable");
      }),
    });

    changeQuery("缓存");

    // A silently short list would read as "nothing was written down".
    await finishSearch();
    expect(screen.getByRole("status")).toHaveTextContent(
      "笔记暂时无法检索，结果不完整。",
    );
    expect(options()).toHaveLength(3);
    expect(screen.getByText("缓存层放在哪一侧")).toBeVisible();
  });

  it("stays open and says so when a note will not open", async () => {
    const { onClose } = await renderDialog({
      openObsidianNote: vi.fn(async () => {
        throw new Error("gone");
      }),
    });

    changeQuery("缓存");
    await finishSearch();
    expect(options()).toHaveLength(4);
    await act(async () => {
      fireEvent.click(options()[2]!);
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂时无法在 Obsidian 中打开这篇笔记。",
    );
    // Closing would take the message with it before it could be read.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens a note once while Obsidian is still being asked, however often it is chosen", async () => {
    let finish: () => void = () => undefined;
    const { api } = await renderDialog({
      openObsidianNote: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
    });
    changeQuery("缓存");
    await finishSearch();
    const field = screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" });
    await act(async () => { fireEvent.click(options()[2]!); });
    // Enter held on it: the key repeats before the first open is back, and each repeat opened it again.
    await act(async () => { fireEvent.keyDown(field, { key: "Enter", repeat: true }); });
    await act(async () => { fireEvent.click(options()[2]!); });

    expect(api.openObsidianNote).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  it("loads the principles once instead of on every keystroke", async () => {
    const { api } = await renderDialog();

    for (const query of ["缓", "缓存", "缓存边", "缓存边界"]) {
      changeQuery(query);
      await act(() => vi.advanceTimersByTimeAsync(80));
      expect(api.listDecisions).not.toHaveBeenCalled();
    }
    await finishSearch();
    expect(options().length).toBeGreaterThan(0);

    expect(api.listMethodologies).toHaveBeenCalledTimes(1);
    expect(api.listDecisions).toHaveBeenCalledExactlyOnceWith({ query: "缓存边界", limit: 5 });
  });
});

describe("QuickJumpDialog pages", () => {
  it("offers the lists worth working through when the words name them", async () => {
    const api = apiFixture();
    const onClose = vi.fn();
    const onOpenPage = vi.fn();
    await act(async () => {
      render(
        <QuickJumpDialog
          api={api}
          onClose={onClose}
          onOpenDecision={vi.fn()}
          onOpenJournalEntry={vi.fn()}
          onOpenPrinciple={vi.fn()}
          onOpenPage={onOpenPage}
        />,
      );
    });

    changeQuery("回顾");
    await finishSearch();
    // Places come first: the reader named one, not a record.
    expect(options()[0]).toHaveTextContent("周期回顾");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpenPage).toHaveBeenCalledWith("retrospective");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps Enter on the records when a common word only appears in a page name", async () => {
    const api = apiFixture();
    const onOpenPage = vi.fn();
    await act(async () => {
      render(
        <QuickJumpDialog
          api={api}
          onClose={vi.fn()}
          onOpenDecision={vi.fn()}
          onOpenJournalEntry={vi.fn()}
          onOpenPrinciple={vi.fn()}
          onOpenPage={onOpenPage}
        />,
      );
    });

    changeQuery("预期");
    await finishSearch();
    expect(screen.queryByText("待写预期")).toBeNull();
    changeQuery("待写");
    await finishSearch();
    expect(options()[0]).toHaveTextContent("待写预期");

    changeQuery("复盘");
    await finishSearch();
    expect(screen.queryByText("需复盘")).toBeNull();
    changeQuery("待复盘");
    await finishSearch();
    expect(options()[0]).toHaveTextContent("需复盘");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onOpenPage).toHaveBeenCalledWith("review-attention");
  });

  it("offers no places where the host cannot take the reader there", async () => {
    await renderDialog();
    changeQuery("待补");
    await finishSearch();
    expect(screen.queryByText("待补理由")).toBeNull();
  });
});

describe("QuickJumpDialog reviews", () => {
  it("finds a PR review kept on this machine and opens it on the review page", async () => {
    saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000aa", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], report: null, state: "finished", error: "", published: [], verdicts: [], rechecks: [],
      snapshot: { snapshotId: "00000000-0000-4000-8000-0000000000ab", reference: "org/app#7", title: "重构请求重试", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [], warnings: [] } }]);
    const onOpenReview = vi.fn();
    await act(async () => {
      render(<QuickJumpDialog api={apiFixture()} onClose={vi.fn()} onOpenDecision={vi.fn()} onOpenJournalEntry={vi.fn()} onOpenPrinciple={vi.fn()} onOpenReview={onOpenReview} />);
    });
    await finishSearch();
    expect(screen.getByRole("group", { name: "最近评审" })).toHaveTextContent("重构请求重试org/app#7 · 评审");
    changeQuery("重试");
    await finishSearch();
    fireEvent.click(within(screen.getByRole("group", { name: "评审" })).getByRole("option", { name: /重构请求重试/u }));
    expect(onOpenReview).toHaveBeenCalledWith("00000000-0000-4000-8000-0000000000aa");
    localStorage.clear();
  });
});

describe("QuickJumpDialog conversations", () => {
  it("finds a Q&A conversation by any question asked in it and opens it on the assistant page", async () => {
    const release = { ...emptyConversation(), id: "c-release", updatedAt: Date.parse("2026-09-28T10:00:00.000Z"),
      messages: [{ role: "user" as const, content: "发布窗口放在周几？" }, { role: "user" as const, content: "要不要先灰度一周？" }] };
    saveSessions({ activeId: release.id, conversations: [release, { ...emptyConversation(), id: "c-empty" }] });
    const onOpenConversation = vi.fn();
    await act(async () => {
      render(<QuickJumpDialog api={apiFixture()} onClose={vi.fn()} onOpenDecision={vi.fn()} onOpenJournalEntry={vi.fn()} onOpenPrinciple={vi.fn()} onOpenConversation={onOpenConversation} />);
    });
    await finishSearch();
    // An empty conversation is not worth a jump.
    expect(within(screen.getByRole("group", { name: "最近问答" })).getAllByRole("option")).toHaveLength(1);
    changeQuery("灰度");
    await finishSearch();
    const option = within(screen.getByRole("group", { name: "问答" })).getByRole("option", { name: /发布窗口放在周几/u });
    expect(option).toHaveTextContent("2 个问题");
    fireEvent.click(option);
    expect(onOpenConversation).toHaveBeenCalledWith("c-release");
    localStorage.clear();
  });
});

describe("QuickJumpDialog order", () => {
  it("walks the results in the order the groups show them", async () => {
    saveReviewHistory([{ id: "00000000-0000-4000-8000-0000000000ba", kind: "review", at: "2026-09-29T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], report: null, state: "finished", error: "", published: [], verdicts: [], rechecks: [],
      snapshot: { snapshotId: "00000000-0000-4000-8000-0000000000bb", reference: "org/app#8", title: "灰度发布评审", description: "", project: "app", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [], warnings: [] } }]);
    saveSessions({ activeId: "c-gray", conversations: [{ ...emptyConversation(), id: "c-gray", messages: [{ role: "user" as const, content: "灰度一周可以吗？" }] }] });
    const none = apiFixture({ listDecisions: vi.fn(async () => []), listJournalEntries: vi.fn(async () => []), listMethodologies: vi.fn(async () => []),
      searchObsidian: vi.fn(async ({ query }) => ({ ...(await apiFixture().searchObsidian({ query, limit: 5 })), results: [] })) });
    await act(async () => {
      render(<QuickJumpDialog api={none} onClose={vi.fn()} onOpenDecision={vi.fn()} onOpenJournalEntry={vi.fn()} onOpenPrinciple={vi.fn()} onOpenReview={vi.fn()} onOpenConversation={vi.fn()} />);
    });
    changeQuery("灰度");
    await finishSearch();
    const [first, second] = options();
    // 问答 is listed above 评审, so it is the one Enter opens first.
    expect(first).toHaveTextContent("灰度一周可以吗");
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索决策、想法、笔记、原则、问答与评审" }), { key: "ArrowDown" });
    expect(second).toHaveTextContent("灰度发布评审");
    expect(second).toHaveAttribute("aria-selected", "true");
    localStorage.clear();
  });
});
