// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import type {
  AssistantProgress,
  AssistantTurnResponse,
  RetrievalAnswerCitation,
  RetrievalAnswerProvider,
} from "@cognelis/decision-protocol";
import { assistantTurnRequestSchema } from "@cognelis/decision-protocol";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssistantPanel,
  type AssistantApi,
} from "../src/renderer/components/pages/assistant/AssistantPanel.js";
import { ConversationLibrary } from "../src/renderer/components/pages/assistant/ConversationLibrary.js";
import * as markdown from "../src/renderer/components/pages/assistant/markdown.js";
import { emptyConversation, loadSessions, saveSessions } from "../src/renderer/components/pages/assistant/assistant-session.js";

const LOCAL: RetrievalAnswerProvider = {
  profileId: "qwen",
  label: "Qwen 本地模型",
  kind: "qwen",
  model: "qwen3.5-2b",
  leavesDevice: false,
};

/** A decision this app recorded, so it has a page of its own to open. */
const CITED_DECISION: RetrievalAnswerCitation = {
  index: 1,
  kind: "decision",
  title: "配置变更先留测试环境",
  reference: "Decision Journal/decisions/2026/07/配置变更.md",
  recordId: "decision-config",
  excerpt: "本轮只保证 dev 环境完整可验。",
  matchReason: "关键词命中",
};

/** A note, or a decision in the historical format: no record id to open. */
const { recordId: _unheld, ...CITED_DOCUMENT } = CITED_DECISION;

const answered = (
  content: string,
  citation: RetrievalAnswerCitation = CITED_DECISION,
): AssistantTurnResponse => ({
  version: 1,
  status: "answered",
  message: {
    role: "assistant",
    content,
    citations: [citation],
    steps: [{ kind: "search", query: "配置变更", hits: 1 }, { kind: "answer" }],
    turnId: "turn-fixture",
  },
  provider: LOCAL,
  durationMs: 120,
  requestId: "assistant:test",
  truncated: false,
});

/** Captures the panel's progress listener so a test can push steps at it. */
let pushProgress: ((progress: AssistantProgress) => void) | null = null;

const apiFixture = (
  response: AssistantTurnResponse = answered("先留测试环境 [1]。"),
): AssistantApi => ({
  listAssistantModels: vi.fn(async () => [LOCAL]),
  checkAssistantSource: vi.fn(async () => ({ status: "matched" as const, content: "当前内容", truncated: false })),
  searchAssistantSources: vi.fn(async () => ({ sources: [CITED_DECISION], issues: [] })),
  runAssistantTurn: vi.fn(async () => response),
  openVaultDocument: vi.fn(async () => undefined),
  cancelAssistantTurn: vi.fn(async () => undefined),
  saveAssistantFeedback: vi.fn(async () => ({
    status: "saved" as const,
    recorded: 1,
  })),
  exportAssistantConversation: vi.fn(async () => ({
    status: "saved" as const,
    path: "/tmp/对话.md",
  })),
  createProactiveRecord: vi.fn(async () => ({
    recordVersion: 1 as const,
    status: "created" as const,
    recordKind: "decision" as const,
    recordId: "rec-1",
    knowledgeStatus: "active" as const,
    sensitivity: "private" as const,
    storedTranscript: false as const,
  })),
  forgetAssistantTurns: vi.fn(async () => undefined),
  onAssistantProgress: vi.fn((listener) => {
    pushProgress = listener;
    return () => {
      pushProgress = null;
    };
  }),
});

const ask = async (question: string): Promise<void> => {
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, question);
  await user.click(screen.getByRole("button", { name: "发送" }));
};

/** The conversation itself — titles also appear in the picker's options. */
const stream = (): HTMLElement =>
  document.querySelector<HTMLElement>(".assistant-stream")!;

const conversationList = () => screen.getByRole("list", { name: "会话搜索结果" });
const conversationButton = (id: string) => conversationList().querySelector<HTMLButtonElement>(`[data-conversation-id="${id}"]`)!;
const menuButton = (name: string) => {
  const summary = screen.getByLabelText("对话操作");
  if (!summary.closest("details")!.open) fireEvent.click(summary);
  return screen.getByRole("button", { name });
};

const openCitation = async (name: string): Promise<void> => {
  await userEvent.setup().click(await screen.findByRole("button", { name }));
};

/** The panel now has somewhere to send a citation besides the vault. */
let navigation = {
  onOpenDecision: vi.fn<(id: string) => void>(),
  onOpenJournalEntry: vi.fn<(id: string) => void>(),
  onOpenPrinciple: vi.fn<(id: string) => void>(),
};

const renderPanel = (api: AssistantApi) =>
  render(<AssistantPanel api={api} {...navigation} />);

beforeEach(() => {
  localStorage.clear();
  pushProgress = null;
  navigation = {
    onOpenDecision: vi.fn<(id: string) => void>(),
    onOpenJournalEntry: vi.fn<(id: string) => void>(),
    onOpenPrinciple: vi.fn<(id: string) => void>(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AssistantPanel", () => {
  it.skipIf(process.env.DECISION_BENCHMARK !== "1")("benchmarks long-conversation input", async () => {
    const history = emptyConversation();
    history.messages = Array.from({ length: 20 }, (_unused, index) => [
      { role: "user" as const, content: `问题 ${index}` },
      { role: "assistant" as const, content: ("**配置变更** 先验证 [1]，再发布。\n\n".repeat(80)), citations: [CITED_DECISION] },
    ]).flat();
    saveSessions({ activeId: history.id, conversations: [history] });
    const start = performance.now();
    renderPanel(apiFixture());
    const composer = await screen.findByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(composer).toBeEnabled());
    const startupMs = performance.now() - start;
    const samples: number[] = [];
    for (let index = 0; index < 70; index += 1) {
      const tick = performance.now();
      fireEvent.change(composer, { target: { value: `输入第 ${index} 个字符` } });
      if (index >= 10) samples.push(performance.now() - tick);
    }
    samples.sort((a, b) => a - b);
    process.stdout.write("ASSISTANT_BENCHMARK " + JSON.stringify({ startupMs, inputP50Ms: samples[30], inputP95Ms: samples[57], samples: samples.length, rounds: 20, paragraphsPerAnswer: 80 }) + "\n");
    await waitFor(() => expect(loadSessions().conversations[0]?.draft).toBe("输入第 69 个字符"));
  }, 30_000);

  it("writes the sessions once typing pauses rather than on every key, and before the window goes away", async () => {
    renderPanel(apiFixture());
    const composer = await screen.findByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(composer).toBeEnabled());
    const save = vi.spyOn(Storage.prototype, "setItem");
    for (const value of ["先", "先留", "先留回滚"]) fireEvent.change(composer, { target: { value } });
    expect(save).not.toHaveBeenCalled();
    await waitFor(() => expect(loadSessions().conversations[0]?.draft).toBe("先留回滚"));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.change(composer, { target: { value: "先留回滚入口" } });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(loadSessions().conversations[0]?.draft).toBe("先留回滚入口");
  });

  it("compares current sources and prepares a separate recheck without overwriting the old answer", async () => {
    const api = apiFixture();
    vi.mocked(api.checkAssistantSource).mockResolvedValue({ status: "review", content: "目前已改为灰度发布", truncated: false });
    renderPanel(api);
    await ask("原问题");
    fireEvent.click(await screen.findByRole("button", { name: "查看引用 1" }));
    fireEvent.click(screen.getByRole("button", { name: "核对当前来源" }));
    expect(await screen.findByText("目前已改为灰度发布")).toBeVisible();
    expect(screen.getByText(/历史摘录未在当前来源中完整匹配/)).toBeVisible();
    expect(screen.getByText(CITED_DECISION.excerpt)).toBeVisible();
    const originalId = loadSessions().activeId;
    fireEvent.click(screen.getByRole("button", { name: "根据当前引用重新核对" }));
    expect(loadSessions().activeId).not.toBe(originalId);
    const recheck = loadSessions().conversations[0]!;
    expect(recheck.selectedSources).toEqual([CITED_DECISION]);
    expect(recheck.draft).toContain("核对这条历史回答是否仍适用");
    expect(recheck.draft).toContain("原问题");
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(loadSessions().conversations.find((entry) => entry.id === originalId)?.messages.at(-1)?.content).toBe("先留测试环境 [1]。");
  });

  it("lets an empty conversation go when another is opened, rather than piling up rows that cannot be deleted", async () => {
    const old = { ...emptyConversation(), title: "原来的对话", messages: [{ role: "user" as const, content: "旧问" }, { role: "assistant" as const, content: "旧答" }] };
    saveSessions({ activeId: old.id, conversations: [old] });
    renderPanel(apiFixture());
    await screen.findByRole("textbox");
    for (let round = 0; round < 3; round += 1) {
      fireEvent.click(screen.getByRole("button", { name: "新对话" }));
      fireEvent.click(conversationButton(old.id));
    }
    await waitFor(() => expect(loadSessions().conversations.map((entry) => entry.id)).toEqual([old.id]));
  });

  it("lets a recheck whose question was cleared be deleted, as it is kept when left", async () => {
    const api = apiFixture();
    renderPanel(api);
    await ask("原问题");
    await screen.findByRole("button", { name: "根据当前引用重新核对" });
    const originalId = loadSessions().activeId;
    fireEvent.click(screen.getByRole("button", { name: "根据当前引用重新核对" }));
    const branchId = loadSessions().activeId;
    fireEvent.change(screen.getByRole("textbox", { name: "问一句你自己的历史" }), { target: { value: "" } });

    fireEvent.click(menuButton("删除此对话"));
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除对话" })).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(loadSessions().conversations.map((entry) => entry.id)).toEqual([originalId]));
    expect(loadSessions().conversations.map((entry) => entry.id)).not.toContain(branchId);
  });

  it("does not stop a turn when its send button is double-clicked", async () => {
    const api = apiFixture();
    vi.mocked(api.runAssistantTurn).mockImplementation(() => new Promise(() => undefined));
    renderPanel(api);
    const user = userEvent.setup();
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "双击发送的问题");
    await user.dblClick(screen.getByRole("button", { name: "发送" }));
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(api.cancelAssistantTurn).not.toHaveBeenCalled();
  });

  it("forks at a chosen turn without changing the original conversation or later turns", async () => {
    const original = { ...emptyConversation(), title: "原始推演", draft: "原始草稿", selectedSources: [CITED_DECISION], messages: [
      { role: "user" as const, content: "第一问" }, { role: "assistant" as const, content: "第一答" },
      { role: "user" as const, content: "第二问" }, { role: "assistant" as const, content: "第二答" },
    ] };
    saveSessions({ activeId: original.id, conversations: [original] });
    const api = apiFixture();
    renderPanel(api);
    fireEvent.click(screen.getAllByRole("button", { name: "修改问题并分支" })[1]!);
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("第二问");
    expect(within(stream()).queryByText("第二答")).toBeNull();
    const forked = loadSessions();
    expect(forked.activeId).not.toBe(original.id);
    expect(forked.conversations.find((entry) => entry.id === original.id)).toMatchObject(original);
    expect(forked.conversations[0]?.messages).toHaveLength(2);
    expect(forked.conversations[0]?.selectedSources).toEqual([CITED_DECISION]);
    fireEvent.change(screen.getByRole("textbox", { name: "问一句你自己的历史" }), { target: { value: "换个假设" } });
    expect(loadSessions().conversations.find((entry) => entry.id === original.id)?.draft).toBe("原始草稿");
    fireEvent.click(conversationButton(original.id));
    expect(within(stream()).getByText("第二答")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "从此处继续分支" })[0]!);
    expect(loadSessions().conversations[0]?.messages).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("");
    expect(api.runAssistantTurn).not.toHaveBeenCalled();
  });

  it("requires a selection in material-only mode and restores the selection after restart", async () => {
    const api = apiFixture();
    const view = renderPanel(api);
    fireEvent.click(screen.getByRole("button", { name: "材料范围" }));
    fireEvent.click(screen.getByRole("button", { name: "仅根据指定材料回答" }));
    fireEvent.change(screen.getByRole("textbox", { name: "问一句你自己的历史" }), { target: { value: "只根据指定材料" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索指定材料" }), { target: { value: "配置" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索材料" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /配置变更先留测试环境/ }));
    fireEvent.click(screen.getByRole("button", { name: "关闭材料范围" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("button", { name: "查看引用 1" });
    expect(vi.mocked(api.runAssistantTurn).mock.calls[0]![0].selectedSources).toEqual([CITED_DECISION]);
    view.unmount();
    renderPanel(api);
    expect(screen.getByRole("button", { name: "材料范围" })).toBeVisible();
    expect(loadSessions().conversations[0]?.selectedSources).toEqual([CITED_DECISION]);
  });

  it("archives and exports all history while loading older messages in pages", async () => {
    const history = emptyConversation();
    history.messages = Array.from({ length: 120 }, (_unused, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `归档消息 ${index}`,
    }));
    saveSessions({ activeId: history.id, conversations: [history] });
    const api = apiFixture();
    const view = renderPanel(api);
    expect(stream().querySelectorAll("article")).toHaveLength(40);
    expect(within(stream()).queryByText("归档消息 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息（还有 80 条）" }));
    expect(stream().querySelectorAll("article")).toHaveLength(80);
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息（还有 40 条）" }));
    expect(within(stream()).getByText("归档消息 0")).toBeVisible();
    fireEvent.click(menuButton("导出"));
    await waitFor(() => expect(api.exportAssistantConversation).toHaveBeenCalled());
    expect(vi.mocked(api.exportAssistantConversation).mock.calls[0]![0].markdown).toContain("归档消息 0");
    view.unmount();
    renderPanel(api);
    expect(loadSessions().conversations[0]?.messages).toHaveLength(120);
    expect(stream().querySelectorAll("article")).toHaveLength(40);
    await ask("继续长对话");
    await screen.findByRole("button", { name: "查看引用 1" });
    expect(vi.mocked(api.runAssistantTurn).mock.calls[0]![0].messages).toHaveLength(39);
    expect(loadSessions().conversations[0]?.messages).toHaveLength(122);
  });

  it("does not parse unchanged answers again while editing the next question", async () => {
    const parse = vi.spyOn(markdown, "renderMarkdown");
    renderPanel(apiFixture());
    await ask("为什么？");
    await screen.findByRole("button", { name: "查看引用 1" });
    parse.mockClear();
    fireEvent.change(screen.getByRole("textbox", { name: "问一句你自己的历史" }), { target: { value: "继续问" } });
    expect(parse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "查看引用 1" })).toHaveLength(2));
    expect(parse).toHaveBeenCalled();
    parse.mockRestore();
  });

  it("hands focus to the search field when a rename is let go while 重命名 is disabled", () => {
    const active = { ...emptyConversation(), id: "current", title: "当前会话" };
    const props = { active, conversations: [active], onOpen: vi.fn(), onRename: vi.fn(), onFavorite: vi.fn() };
    const view = render(<ConversationLibrary {...props} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    // A reply starts while the form is open: 重命名 behind it is disabled.
    view.rerender(<ConversationLibrary {...props} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "取消重命名" }));
    // A disabled button takes no focus: it was left on the window.
    expect(screen.getByRole("searchbox", { name: "搜索会话标题和正文" })).toHaveFocus();
  });

  it("searches body text, renames and favorites a conversation across restart", async () => {
    const old = { ...emptyConversation(), id: "old", title: "旧会话", messages: [{ role: "user" as const, content: "特别的正文关键词" }] };
    const current = { ...emptyConversation(), id: "current", title: "当前会话" };
    saveSessions({ activeId: current.id, conversations: [current, old] });
    const view = renderPanel(apiFixture());
    const search = await screen.findByRole("searchbox", { name: "搜索会话标题和正文" });
    fireEvent.change(search, { target: { value: "正文关键词" } });
    const results = screen.getByRole("list", { name: "会话搜索结果" });
    expect(results.querySelectorAll(".assistant-conversation-row")).toHaveLength(1);
    fireEvent.click(within(results).getByRole("button", { name: /旧会话/ }));
    expect(screen.queryByRole("textbox", { name: "当前会话名称" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    // An Escape that only ends an input method's composition keeps the rename going.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "当前会话名称" }), { key: "Escape", isComposing: true });
    expect(screen.getByRole("textbox", { name: "当前会话名称" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "当前会话名称" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "当前会话名称" })).toBeNull();
    // The form gone with the field that had focus, focus goes back to 重命名 rather than to the top of the window.
    expect(screen.getByRole("button", { name: "重命名" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByRole("textbox", { name: "当前会话名称" }), { target: { value: "重要的决定" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    expect(screen.getByRole("button", { name: "重命名" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "收藏此对话" }));
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "只看收藏" }));
    expect(results.querySelectorAll(".assistant-conversation-row")).toHaveLength(1);
    expect(within(results).getByRole("button", { name: /重要的决定/ })).toBeVisible();
    view.unmount();
    renderPanel(apiFixture());
    expect(loadSessions().conversations.find((entry) => entry.id === "old")).toMatchObject({ title: "重要的决定", favorite: true });
    expect(await screen.findByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens a conversation picked elsewhere, as if from its list", async () => {
    const old = { ...emptyConversation(), id: "old", title: "旧会话", messages: [{ role: "user" as const, content: "以前问过的" }] };
    const current = { ...emptyConversation(), id: "current", title: "当前会话" };
    saveSessions({ activeId: current.id, conversations: [current, old] });
    const view = render(<AssistantPanel api={apiFixture()} {...navigation} />);
    expect(await screen.findByRole("heading", { name: "当前会话" })).toBeVisible();
    view.rerender(<AssistantPanel api={apiFixture()} {...navigation} openConversationId={{ id: "old" }} />);
    expect(await screen.findByRole("heading", { name: "旧会话" })).toBeVisible();
  });

  it("opens a conversation picked while an answer is coming once it arrives, saying so meanwhile", async () => {
    const old = { ...emptyConversation(), id: "old", title: "旧会话", messages: [{ role: "user" as const, content: "以前问过的" }] };
    const current = { ...emptyConversation(), id: "current", title: "当前会话" };
    saveSessions({ activeId: current.id, conversations: [current, old] });
    const api = apiFixture();
    let complete!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const view = render(<AssistantPanel api={api} {...navigation} />);
    await ask("现在问的");
    view.rerender(<AssistantPanel api={api} {...navigation} openConversationId={{ id: "old" }} />);

    expect(await screen.findByText("当前回答或操作完成后会打开所选会话。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "当前会话" })).toBeVisible();
    await act(async () => complete(answered("答完了。")));
    expect(await screen.findByRole("heading", { name: "旧会话" })).toBeVisible();
    expect(loadSessions().conversations.find((entry) => entry.id === "current")?.messages.at(-1)?.content).toContain("答完了");
  });

  it("stays to show why a turn failed rather than opening the conversation picked meanwhile", async () => {
    const old = { ...emptyConversation(), id: "old", title: "旧会话", messages: [{ role: "user" as const, content: "以前问过的" }] };
    const current = { ...emptyConversation(), id: "current", title: "当前会话" };
    saveSessions({ activeId: current.id, conversations: [current, old] });
    const api = apiFixture();
    let complete!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const view = render(<AssistantPanel api={api} {...navigation} />);
    await ask("现在问的");
    view.rerender(<AssistantPanel api={api} {...navigation} openConversationId={{ id: "old" }} />);
    expect(await screen.findByText("当前回答或操作完成后会打开所选会话。")).toBeVisible();

    await act(async () => complete({ version: 1, status: "unavailable", message: "这次没能回答。" }));
    expect(await screen.findByText("这次没能回答。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "当前会话" })).toBeVisible();
    expect(screen.getByText(/没有打开所选会话/u)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("现在问的");

    // Picked again, it opens.
    view.rerender(<AssistantPanel api={api} {...navigation} openConversationId={{ id: "old" }} />);
    expect(await screen.findByRole("heading", { name: "旧会话" })).toBeVisible();
  });

  it("opens a picked conversation on first mount without listing the old one twice", async () => {
    const old = { ...emptyConversation(), id: "old", title: "旧会话", messages: [{ role: "user" as const, content: "以前问过的" }] };
    const current = { ...emptyConversation(), id: "current", title: "当前会话", messages: [{ role: "user" as const, content: "现在问的" }] };
    saveSessions({ activeId: current.id, conversations: [current, old] });
    render(<StrictMode><AssistantPanel api={apiFixture()} {...navigation} openConversationId={{ id: "old" }} /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "旧会话" })).toBeVisible();
    await waitFor(() => expect(loadSessions().conversations.map((conversation) => conversation.id).sort()).toEqual(["current", "old"]));
  });

  it("opens the excerpt belonging to the current answer's inline citation", async () => {
    const first = answered("第一答 [1]。", { ...CITED_DOCUMENT, title: "第一份材料", excerpt: "第一份保存的摘录" });
    const second = answered("第二答 [1]。", { ...CITED_DOCUMENT, title: "第二份材料", reference: "notes/second.md", excerpt: "第二份保存的摘录", lifecycle: "superseded" });
    const api = apiFixture(second);
    vi.mocked(api.runAssistantTurn).mockResolvedValueOnce(first);
    renderPanel(api);
    await ask("第一问");
    await screen.findByText(/第一答/);
    await ask("第二问");
    const secondArticle = (await screen.findByText(/第二答/)).closest("article")!;
    const firstArticle = screen.getByText(/第一答/).closest("article")!;
    await userEvent.setup().click(within(secondArticle).getByRole("button", { name: "查看引用 1" }));
    expect(secondArticle.querySelector("details")).toHaveAttribute("open");
    expect(firstArticle.querySelector("details")).not.toHaveAttribute("open");
    expect(within(secondArticle).getByText("第二份保存的摘录")).toBeVisible();
    expect(within(secondArticle).getByText("已被取代")).toBeVisible();
    expect(secondArticle.querySelector("summary")).toHaveFocus();
    expect(api.openVaultDocument).not.toHaveBeenCalled();
    await userEvent.setup().click(within(secondArticle).getByRole("button", { name: "在 Obsidian 中打开：第二份材料" }));
    expect(api.openVaultDocument).toHaveBeenCalledWith("notes/second.md");
  });

  it.each(["before", "after"])("keeps a reference-open failure out of a new conversation when it arrives %s switching", async (timing) => {
    const api = apiFixture(answered("包含笔记引用的回答", CITED_DOCUMENT));
    let fail!: (error: Error) => void;
    vi.mocked(api.openVaultDocument).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    renderPanel(api);
    await ask("原来的问题");
    await openCitation("在 Obsidian 中打开：配置变更先留测试环境");
    if (timing === "before") {
      await act(async () => { fail(new Error("旧引用无法打开")); });
      expect(screen.getByRole("alert")).toHaveTextContent("旧引用无法打开");
    }
    await userEvent.setup().click(screen.getByRole("button", { name: "新对话" }));
    if (timing === "after") await act(async () => { fail(new Error("旧引用无法打开")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("");
  });

  it("ignores an older reference-open failure after another open succeeds", async () => {
    const api = apiFixture(answered("包含笔记引用的回答", CITED_DOCUMENT));
    let fail!: (error: Error) => void;
    vi.mocked(api.openVaultDocument).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    renderPanel(api);
    await ask("打开原文");
    await openCitation("在 Obsidian 中打开：配置变更先留测试环境");
    await openCitation("在 Obsidian 中打开：配置变更先留测试环境");
    await act(async () => { fail(new Error("前一次打开失败")); });
    expect(api.openVaultDocument).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["有用", "没用"])("keeps an earlier feedback draft when the next answer is rated %s", async (rating) => {
    const first = answered("第一条回答");
    const second = answered("第二条回答");
    if (first.status !== "answered" || second.status !== "answered") throw new Error("Invalid fixture");
    first.message.turnId = "first-feedback";
    second.message.turnId = "second-feedback";
    const api = apiFixture(second);
    vi.mocked(api.runAssistantTurn).mockResolvedValueOnce(first);
    renderPanel(api);
    await ask("第一问");
    let firstArticle = (await screen.findByText("第一条回答")).closest("article")!;
    const user = userEvent.setup();
    await user.click(within(firstArticle).getByRole("button", { name: "没用" }));
    fireEvent.change(within(firstArticle).getByRole("textbox", { name: "哪里没用（可不填）" }), { target: { value: "第一条尚未保存的说明" } });
    fireEvent.change(screen.getByRole("textbox", { name: "问一句你自己的历史" }), { target: { value: "第二问" } });
    await user.click(screen.getByRole("button", { name: "发送" }));
    let secondArticle = (await screen.findByText("第二条回答")).closest("article")!;
    await user.click(within(secondArticle).getByRole("button", { name: rating }));
    expect(within(firstArticle).getByRole("textbox", { name: "哪里没用（可不填）" })).toHaveValue("第一条尚未保存的说明");
    if (rating === "没用") {
      fireEvent.change(within(secondArticle).getByRole("textbox"), { target: { value: "第二条独立说明" } });
      const currentId = loadSessions().activeId;
      await user.click(screen.getByRole("button", { name: "新对话" }));
      await user.click(conversationButton(currentId));
      firstArticle = screen.getByText("第一条回答").closest("article")!;
      secondArticle = screen.getByText("第二条回答").closest("article")!;
      expect(within(firstArticle).getByRole("textbox")).toHaveValue("第一条尚未保存的说明");
    }
    await user.click(within(firstArticle).getByRole("button", { name: "记下" }));
    expect(api.saveAssistantFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: "first-feedback", question: "第一问", note: "第一条尚未保存的说明" }));
    expect(within(firstArticle).queryByRole("textbox")).toBeNull();
    if (rating === "没用") expect(within(secondArticle).getByRole("textbox")).toHaveValue("第二条独立说明");
  });

  it("keeps each answer's actual provider across model changes, restart and export", async () => {
    const remote: RetrievalAnswerProvider = { profileId: "remote", label: "远端模型", kind: "openai-compatible", model: "remote-model", leavesDevice: true };
    const remoteAnswer = answered("远端给出的回答");
    if (remoteAnswer.status !== "answered") throw new Error("Invalid fixture");
    remoteAnswer.provider = remote;
    const api = apiFixture(answered("本机给出的回答"));
    vi.mocked(api.listAssistantModels).mockResolvedValue([remote, LOCAL]);
    vi.mocked(api.runAssistantTurn).mockResolvedValueOnce(remoteAnswer);
    const view = renderPanel(api);
    await ask("第一问");
    await screen.findByText("远端给出的回答");
    expect(within(stream()).getByText("模型：远端模型 · remote-model · 远端回答")).toBeVisible();
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "回答模型" }), LOCAL.profileId);
    await ask("第二问");
    await screen.findByText("本机给出的回答");
    expect(within(stream()).getByText("模型：Qwen 本地模型 · qwen3.5-2b · 本机回答")).toBeVisible();
    expect(loadSessions().conversations[0]?.messages.filter((message) => message.role === "assistant").map((message) => message.provider?.profileId)).toEqual(["remote", "qwen"]);
    view.unmount();
    vi.mocked(api.listAssistantModels).mockResolvedValue([LOCAL]);
    renderPanel(api);
    expect(within(stream()).getByText("模型：远端模型 · remote-model · 远端回答")).toBeVisible();
    await userEvent.setup().click(menuButton("导出"));
    const markdown = vi.mocked(api.exportAssistantConversation).mock.calls[0]![0].markdown;
    expect(markdown).toContain("模型：远端模型 · remote-model · 远端回答");
    expect(markdown).toContain("模型：Qwen 本地模型 · qwen3.5-2b · 本机回答");
  });

  it.each(["removed", "renamed", "empty"] as const)("keeps the running model identity when the refreshed list is %s", async (change) => {
    const remote: RetrievalAnswerProvider = { profileId: "remote", label: "原远端模型", kind: "openai-compatible", model: "remote-model", leavesDevice: true };
    const api = apiFixture();
    vi.mocked(api.listAssistantModels).mockResolvedValue([remote, LOCAL]);
    let finish!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = renderPanel(api);
    await ask("继续使用已选模型回答");
    let refresh!: (models: RetrievalAnswerProvider[]) => void;
    vi.mocked(api.listAssistantModels).mockReturnValueOnce(new Promise((resolve) => { refresh = resolve; }));
    view.rerender(<AssistantPanel api={api} {...navigation} hidden />);
    view.rerender(<AssistantPanel api={api} {...navigation} />);
    const refreshed = change === "removed" ? [LOCAL] : change === "empty" ? [] : [{ ...remote, label: "更新后的名称" }];
    await act(async () => { refresh(refreshed); });
    expect(screen.getByRole("combobox", { name: "回答模型" })).toHaveValue(remote.profileId);
    expect(screen.getByRole("option", { name: "原远端模型 · remote-model" })).toBeInTheDocument();
    expect(screen.getByText("问题与检索材料会发送给远端模型")).toBeVisible();
    expect(screen.getByText("已发送给 原远端模型，正在检索并回答…")).toBeVisible();
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    const response = answered("原模型完成的回答");
    if (response.status !== "answered") throw new Error("Invalid fixture");
    response.provider = remote;
    await act(async () => { finish(response); });
    expect(screen.getByText("原模型完成的回答")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "回答模型" })).toHaveValue(refreshed[0]?.profileId ?? "");
    expect(screen.queryByRole("option", { name: "原远端模型 · remote-model" })).toBeNull();
  });

  it("offers model-list retry without losing the draft or opening duplicate loads", async () => {
    const conversation = { ...emptyConversation(), draft: "模型恢复后再发送的问题" };
    saveSessions({ activeId: conversation.id, conversations: [conversation] });
    const api = apiFixture();
    vi.mocked(api.listAssistantModels).mockRejectedValueOnce(new Error("IPC unavailable"));
    renderPanel(api);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取回答模型列表，请重试。");
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    expect(input).toHaveValue(conversation.draft);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(menuButton("导出")).toBeEnabled();
    let finish!: (models: RetrievalAnswerProvider[]) => void;
    vi.mocked(api.listAssistantModels).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const retry = screen.getByRole("button", { name: "重试加载模型" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(api.listAssistantModels).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(api.runAssistantTurn).not.toHaveBeenCalled();
    await act(async () => { finish([LOCAL]); });
    expect(input).toBeEnabled();
    expect(input).toHaveValue(conversation.draft);
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toBeVisible();
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
  });

  it("shows setup guidance only when the model list loaded successfully but is empty", async () => {
    const api = apiFixture();
    vi.mocked(api.listAssistantModels).mockResolvedValue([]);
    renderPanel(api);
    expect(await screen.findByRole("option", { name: "暂无可用模型" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "先在“模型”里启用一个可用于回答的后端");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试加载模型" })).toBeNull();
  });

  it("shows unavailable sources alongside the search result count", async () => {
    const response = answered("根据可用来源回答。");
    if (response.status !== "answered") throw new Error("Invalid fixture");
    response.truncated = true;
    response.message.steps![0]!.title = "来源受限：Obsidian 笔记不可用";
    renderPanel(apiFixture(response));
    await ask("查找相关记录");
    await screen.findByText("根据可用来源回答。");
    await userEvent.setup().click(screen.getByRole("button", { name: /查看推理过程/ }));
    expect(screen.getByText("检索「配置变更」· 1 条 · 来源受限：Obsidian 笔记不可用")).toBeVisible();
  });

  it("says an answer was cut at its length, apart from a search that was limited", async () => {
    const response = answered("很长的回答…");
    if (response.status !== "answered") throw new Error("Invalid fixture");
    response.answerCut = true;
    renderPanel(apiFixture(response));
    await ask("配置怎么安排？");
    // Told only that the search was limited, if anything, the reader took the cut answer as whole.
    expect(await screen.findByText("回答超过 4000 字，后面的部分没有显示。")).toBeVisible();
  });

  it.each([undefined, "未能读取全文，保留摘录：配置记录"])("shows a truthful limitation reason for %s", async (title) => {
    const response = answered("依据已有摘录回答。");
    if (response.status !== "answered") throw new Error("Invalid fixture");
    response.truncated = true;
    response.message.steps = [{ kind: "step_limit", ...(title === undefined ? {} : { title }) }, { kind: "answer" }];
    renderPanel(apiFixture(response));
    await ask("为什么这样选？");
    expect(await screen.findByText("本轮部分检索或读取受到限制，回答基于已有材料。")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: /查看推理过程/ }));
    expect(screen.getByText(title ?? "检索或读取受到限制，使用已有材料作答")).toBeVisible();
    expect(screen.queryByText(/这一轮用完了检索步数|达到检索上限/)).toBeNull();
  });

  it.each([0, 20])("restores an interrupted turn as a draft without trimming %i completed rounds", async (rounds) => {
    const conversation = {
      ...emptyConversation(),
      messages: Array.from({ length: rounds }, (_, index) => [
        { role: "user" as const, content: `已完成的问题 ${index}` },
        { role: "assistant" as const, content: `已完成的回答 ${index}` },
      ]).flat(),
    };
    saveSessions({ activeId: conversation.id, conversations: [conversation] });
    const api = apiFixture();
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise(() => undefined));
    const view = renderPanel(api);
    await ask("退出前仍在等待的问题");
    expect(within(stream()).getByText("退出前仍在等待的问题")).toBeVisible();
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
    const saved = loadSessions().conversations[0]!;
    expect(saved.messages).toEqual(conversation.messages);
    expect(saved.draft).toBe("退出前仍在等待的问题");
    view.unmount();
    renderPanel(api);
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("退出前仍在等待的问题");
    expect(within(stream()).queryByText("退出前仍在等待的问题")).toBeNull();
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toBeVisible();
    const completed = loadSessions().conversations[0]!;
    expect(completed.draft).toBe("");
    expect(completed.messages.filter((message) => message.content === "退出前仍在等待的问题")).toHaveLength(1);
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(2);
  });

  it("keeps a separate unsent draft for each conversation across switching, restart and deletion", async () => {
    const api = apiFixture();
    const view = renderPanel(api);
    await ask("第一段对话");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    const firstId = loadSessions().activeId;
    fireEvent.change(input, { target: { value: "第一段未发送的追问" } });
    await user.click(screen.getByRole("button", { name: "新对话" }));
    const secondId = loadSessions().activeId;
    fireEvent.change(input, { target: { value: "第二段未发送的问题" } });
    await user.click(conversationButton(firstId));
    expect(input).toHaveValue("第一段未发送的追问");
    await user.click(conversationButton(secondId));
    expect(input).toHaveValue("第二段未发送的问题");
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    view.unmount();
    renderPanel(api);
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("第二段未发送的问题");
    await user.click(menuButton("删除此对话"));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("第一段未发送的追问");
    expect(loadSessions().conversations.some((entry) => entry.id === secondId)).toBe(false);
  });

  it("lets the call records and ratings of a deleted conversation's answers go with it", async () => {
    const api = apiFixture();
    renderPanel(api);
    await ask("第一段对话");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    const user = userEvent.setup();

    await user.click(menuButton("删除此对话"));
    expect(within(screen.getByRole("dialog", { name: "删除对话" })).getByText(/以及这些回答的模型调用记录和评分/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    // Deleted from this window alone, its question and the notes read for it stayed in the ratings and the call records.
    expect(api.forgetAssistantTurns).toHaveBeenCalledWith(["turn-fixture"]);
  });

  it("retains an oversized draft-only conversation and exports it as unsent", async () => {
    const api = apiFixture();
    const view = renderPanel(api);
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(input).toBeEnabled());
    const draft = `  尚未发送的长问题${"问".repeat(8_001)}  `;
    fireEvent.change(input, { target: { value: draft } });
    const firstId = loadSessions().activeId;
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(menuButton("导出")).toBeEnabled();
    await user.click(menuButton("导出"));
    const exported = vi.mocked(api.exportAssistantConversation).mock.calls[0]![0];
    expect(exported.markdown).toContain(`## 未发送的草稿\n\n${draft}`);
    expect(exported.markdown).not.toContain("## 问\n");
    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(input).toHaveValue("");
    await user.click(conversationButton(firstId));
    expect(input).toHaveValue(draft);
    view.unmount();
    renderPanel(api);
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue(draft);
    expect(conversationList()).toHaveTextContent("草稿：尚未发送的长问题");
    expect(api.runAssistantTurn).not.toHaveBeenCalled();
  });

  it.each(["current", "legacy", "read denied"])("keeps %s history untouched until it can be read and retried", async (failure) => {
    const key = failure === "legacy" ? "decision.assistant.session.v1" : "decision.assistant.sessions.v2";
    const conversation = { ...emptyConversation(), messages: [{ role: "user" as const, content: "不能覆盖的问题" }, { role: "assistant" as const, content: "不能覆盖的回答" }] };
    const valid = JSON.stringify(failure === "legacy" ? conversation : { activeId: conversation.id, conversations: [conversation] });
    const original = failure === "read denied" ? valid : "{broken history";
    localStorage.setItem(key, original);
    const read = vi.spyOn(Storage.prototype, "getItem");
    if (failure === "read denied") read.mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    const api = apiFixture();
    const view = renderPanel(api);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取本机对话历史");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "重试读取历史" }));
    expect(screen.getByRole("alert")).toHaveTextContent("无法读取本机对话历史");
    expect(write).not.toHaveBeenCalled();
    expect(api.runAssistantTurn).not.toHaveBeenCalled();
    view.rerender(<AssistantPanel api={api} {...navigation} hidden />);
    expect(screen.queryByRole("alert")).toBeNull();
    view.rerender(<AssistantPanel api={api} {...navigation} />);
    read.mockRestore();
    expect(localStorage.getItem(key)).toBe(original);
    localStorage.setItem(key, valid);
    await userEvent.setup().click(screen.getByRole("button", { name: "重试读取历史" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(stream()).getByText("不能覆盖的问题")).toBeVisible();
    expect(within(stream()).getByText("不能覆盖的回答")).toBeVisible();
    expect(loadSessions().conversations[0]?.messages).toEqual(conversation.messages);
  });

  it.each(["restore", "refresh"])("requires a new choice when an explicitly selected model disappears on %s", async (mode) => {
    const remote = { ...LOCAL, profileId: "remote", label: "远端模型", leavesDevice: true };
    const api = apiFixture();
    vi.mocked(api.listAssistantModels).mockResolvedValue([remote, LOCAL]);
    if (mode === "restore") {
      const conversation = { ...emptyConversation(), profileId: LOCAL.profileId };
      saveSessions({ activeId: conversation.id, conversations: [conversation] });
      vi.mocked(api.listAssistantModels).mockResolvedValue([remote]);
    }
    const view = renderPanel(api);
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    const picker = screen.getByRole("combobox", { name: "回答模型" });
    if (mode === "refresh") {
      await waitFor(() => expect(input).toBeEnabled());
      await userEvent.setup().selectOptions(picker, LOCAL.profileId);
      fireEvent.change(input, { target: { value: "尚未发送的问题" } });
      view.rerender(<AssistantPanel api={api} {...navigation} hidden />);
      vi.mocked(api.listAssistantModels).mockResolvedValue([remote]);
      view.rerender(<AssistantPanel api={api} {...navigation} />);
    }
    expect(await screen.findByText("原先选择的模型已不可用，请重新选择回答模型。问题已保留。")).toBeVisible();
    expect(picker).toHaveValue("");
    expect(picker).toHaveAccessibleDescription(/原先选择的模型已不可用/);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    if (mode === "refresh") expect(input).toHaveValue("尚未发送的问题");
    else fireEvent.change(input, { target: { value: "尚未发送的问题" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(api.runAssistantTurn).not.toHaveBeenCalled();
    expect(loadSessions().conversations[0]?.profileId).toBe(LOCAL.profileId);
    await userEvent.setup().selectOptions(picker, remote.profileId);
    expect(input).toBeEnabled();
    expect(picker).not.toHaveAttribute("aria-describedby");
    expect(screen.getByText("问题与检索材料会发送给远端模型")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
    expect(api.runAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({ profileId: remote.profileId }));
    expect(await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toBeVisible();
  });

  it.each(["retry", "autosave"])("keeps unsaved answers visible and exportable until a successful %s", async (recovery) => {
    const api = apiFixture();
    const view = renderPanel(api);
    await ask("已保存的问题");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    const stored = localStorage.getItem("decision.assistant.sessions.v2");
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    await ask("尚未保存的问题");
    expect(await screen.findByRole("alert")).toHaveTextContent("对话更改尚未保存到本机");
    expect(localStorage.getItem("decision.assistant.sessions.v2")).toBe(stored);
    await waitFor(() => expect(menuButton("导出")).toBeEnabled());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重试保存" }));
    expect(screen.getByRole("alert")).toHaveTextContent("对话更改尚未保存到本机");
    await user.click(menuButton("导出"));
    expect(vi.mocked(api.exportAssistantConversation).mock.calls[0]![0].markdown).toContain("尚未保存的问题");
    expect(screen.getByRole("alert")).toHaveTextContent("对话更改尚未保存到本机");
    write.mockRestore();
    if (recovery === "retry") {
      await user.click(screen.getByRole("button", { name: "重试保存" }));
    } else {
      await ask("恢复后继续追问");
      await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeVisible());
    }
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
    renderPanel(api);
    expect(within(stream()).getByText("尚未保存的问题")).toBeVisible();
    expect(within(stream()).getAllByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toHaveLength(recovery === "retry" ? 2 : 3);
  });

  it.each(["新对话", "删除此对话", "切换对话"])("keeps the pending turn in its conversation when %s arrives before rendering", async (action) => {
    const current = { ...emptyConversation(), messages: [{ role: "user" as const, content: "原问题" }, { role: "assistant" as const, content: "原回答" }] };
    const other = { ...emptyConversation(), messages: [{ role: "user" as const, content: "另一问题" }] };
    saveSessions({ activeId: current.id, conversations: [current, other] });
    const api = apiFixture();
    let finish!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderPanel(api);
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "继续追问" } });
    act(() => {
      fireEvent.submit(input.closest("form")!);
      if (action === "切换对话") {
        fireEvent.click(conversationButton(other.id));
      } else {
        fireEvent.click(action === "删除此对话" ? menuButton(action) : screen.getByRole("button", { name: action }));
      }
    });
    expect(conversationButton(current.id)).toHaveAttribute("aria-current", "true");
    await act(async () => { finish(answered("追问的回答")); });
    const saved = loadSessions();
    expect(saved.activeId).toBe(current.id);
    expect(saved.conversations.find((entry) => entry.id === current.id)?.messages.map((message) => message.content)).toEqual(["原问题", "原回答", "继续追问", "追问的回答"]);
    expect(saved.conversations.find((entry) => entry.id === other.id)?.messages).toEqual(other.messages);
  });

  it("sends only one turn before rendering and releases the guard after failure", async () => {
    const api = apiFixture();
    let reject!: (error: Error) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    renderPanel(api);
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: "为什么先留测试环境？" } });
    act(() => {
      fireEvent.submit(input.closest("form")!);
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
      fireEvent.submit(input.closest("form")!);
    });
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    const turnId = vi.mocked(api.runAssistantTurn).mock.calls[0]![0].turnId!;
    act(() => { pushProgress!({ turnId, step: { kind: "search", query: "测试环境", hits: 1 } }); });
    expect(screen.getByText("检索「测试环境」· 1 条")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "停止" }));
    expect(api.cancelAssistantTurn).toHaveBeenCalledWith(turnId);
    await act(async () => { reject(new Error("后端暂时不可用")); });
    expect(input).toHaveValue("为什么先留测试环境？");
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toBeVisible();
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(2);
    expect(stream().querySelectorAll(".assistant-turn.user")).toHaveLength(1);
    expect(stream().querySelectorAll(".assistant-turn.assistant")).toHaveLength(1);
  });

  it.each(["turn-fixture", "__proto__"])("confirms feedback for %s only after saving and keeps a failed note editable", async (turnId) => {
    const response = answered("先留测试环境 [1]。");
    if (response.status !== "answered") throw new Error("Invalid fixture");
    response.message.turnId = turnId;
    const api = apiFixture(response);
    let finish!: (result: { status: "saved" | "unavailable"; recorded: number }) => void;
    vi.mocked(api.saveAssistantFeedback).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderPanel(api);
    await ask("为什么这样选？");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "没用" }));
    expect(screen.queryByText("已记为没用")).toBeNull();
    expect(screen.getByRole("button", { name: "没用" })).toBeDisabled();
    await act(async () => { finish({ status: "unavailable", recorded: 0 }); });
    expect(screen.getByRole("alert")).toHaveTextContent("评价未能保存");
    expect(screen.getByRole("button", { name: "没用" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "没用" }));
    expect(await screen.findByText("已记为没用")).toBeVisible();
    const note = screen.getByRole("textbox", { name: "哪里没用（可不填）" });
    fireEvent.change(note, { target: { value: "说".repeat(2_001) } });
    await user.click(screen.getByRole("button", { name: "记下" }));
    expect(api.saveAssistantFeedback).toHaveBeenCalledTimes(2);
    expect(note).toHaveValue("说".repeat(2_001));
    expect(note).toHaveAttribute("aria-invalid", "true");
    expect(note).toHaveAccessibleDescription(/2000/);
    await user.clear(note);
    await user.type(note, "忽略了限定条件");
    vi.mocked(api.saveAssistantFeedback).mockRejectedValueOnce(new Error("disk unavailable"));
    await user.click(screen.getByRole("button", { name: "记下" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("评价未能保存");
    expect(note).toHaveValue("忽略了限定条件");
    await user.click(screen.getByRole("button", { name: "记下" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "哪里没用（可不填）" })).toBeNull());
    expect(api.saveAssistantFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ note: "忽略了限定条件" }));
  });

  it("does not offer feedback for an answer whose original question is missing", async () => {
    const conversation = {
      ...emptyConversation(),
      messages: [{ role: "assistant" as const, content: "没有保留原问题的回答", turnId: "orphan-turn" }],
    };
    saveSessions({ activeId: conversation.id, conversations: [conversation] });
    renderPanel(apiFixture());
    expect(await screen.findByText("没有保留原问题的回答")).toBeVisible();
    expect(screen.queryByRole("button", { name: "有用" })).toBeNull();
    expect(screen.queryByRole("button", { name: "没用" })).toBeNull();
  });

  it("keeps oversized input editable and blocks submission until it fits the protocol", async () => {
    const api = apiFixture();
    renderPanel(api);
    const input = await screen.findByRole("textbox", { name: "问一句你自己的历史" });
    await waitFor(() => expect(input).toBeEnabled());
    const oversized = "问".repeat(8_001);
    fireEvent.change(input, { target: { value: oversized } });

    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(input).toHaveValue(oversized);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/8000/);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    fireEvent.submit(input.closest("form")!);
    expect(api.runAssistantTurn).not.toHaveBeenCalled();

    const accepted = "问".repeat(8_000);
    fireEvent.change(input, { target: { value: ` ${accepted} ` } });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "发送" }));
    const sent = vi.mocked(api.runAssistantTurn).mock.calls[0]![0];
    expect(assistantTurnRequestSchema.safeParse(sent).success).toBe(true);
    expect(sent.messages.at(-1)?.content).toBe(accepted);
  });

  it("continues a full conversation without exceeding the request limit or losing history on failure", async () => {
    const conversation = {
      ...emptyConversation(),
      messages: Array.from({ length: 20 }, (_, index) => [
        { role: "user" as const, content: `旧问题 ${index}` },
        { role: "assistant" as const, content: `旧回答 ${index}` },
      ]).flat(),
    };
    saveSessions({ activeId: conversation.id, conversations: [conversation] });
    const api = apiFixture();
    vi.mocked(api.runAssistantTurn).mockImplementation(async (input) => {
      const request = assistantTurnRequestSchema.parse(input);
      return answered(`回答：${request.messages.at(-1)!.content}`);
    });
    const view = renderPanel(api);

    for (const question of ["第21问", "第22问"]) {
      await ask(question);
      const sent = vi.mocked(api.runAssistantTurn).mock.calls.at(-1)![0];
      expect(assistantTurnRequestSchema.safeParse(sent).success).toBe(true);
      expect(sent.messages).toHaveLength(39);
      expect(sent.messages[0]?.role).toBe("user");
      expect(sent.messages.at(-1)?.content).toBe(question);
      expect(await screen.findByText(`回答：${question}`)).toBeVisible();
      const loadOlder = screen.queryByRole("button", { name: /加载更早的消息/ });
      if (loadOlder) fireEvent.click(loadOlder);
      expect(within(stream()).getByText("旧问题 0")).toBeVisible();
      expect(loadSessions().conversations[0]?.messages).toHaveLength(question === "第21问" ? 42 : 44);
      expect(within(conversationList()).getByRole("button", { name: /旧问题 0/ })).toBeInTheDocument();
      expect(loadSessions().conversations[0]?.title).toBe("旧问题 0");
    }

    const beforeFailure = loadSessions().conversations[0]?.messages;
    vi.mocked(api.runAssistantTurn).mockRejectedValueOnce(new Error("后端暂时不可用"));
    await ask("失败后继续编辑的问题");
    expect(await screen.findByText("后端暂时不可用")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "问一句你自己的历史" })).toHaveValue("失败后继续编辑的问题");
    expect(loadSessions().conversations[0]?.messages).toEqual(beforeFailure);
    view.unmount();
    renderPanel(api);
    expect(within(conversationList()).getByRole("button", { name: /旧问题 0/ })).toBeInTheDocument();
    const restoredDraft = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    expect(restoredDraft).toHaveValue("失败后继续编辑的问题");
    await waitFor(() => expect(restoredDraft).toBeEnabled());
    await userEvent.setup().clear(restoredDraft);
    await ask("重开后继续追问");
    expect(await screen.findByText("回答：重开后继续追问")).toBeVisible();
    expect(loadSessions().conversations[0]?.draft).toBe("");
  });

  it("names the composer for a reader who cannot see the placeholder", async () => {
    renderPanel(apiFixture());

    // The 问答 page has no layout check of its own, and a placeholder is not a
    // name: it disappears the moment the reader types.
    expect(
      await screen.findByRole("textbox", { name: "问一句你自己的历史" }),
    ).toBeInTheDocument();
  });

  it("gives the question back when the turn produced no answer", async () => {
    const api = apiFixture({
      version: 1,
      status: "unavailable",
      message: "Qwen 本地模型 这次没能回答。每一次调用的状态都记在「日志」里。",
    });
    renderPanel(api);

    await ask("配置变更怎么决定的？");

    expect(
      await screen.findByText("Qwen 本地模型 这次没能回答。每一次调用的状态都记在「日志」里。"),
    ).toBeInTheDocument();
    // Left in the conversation the question sits there unanswered for good,
    // and every later turn sends it again as history.
    expect(stream()).not.toHaveTextContent("配置变更怎么决定的？");
    expect(await screen.findByRole("textbox")).toHaveValue("配置变更怎么决定的？");
  });

  it("says what a turn that produced no answer spent", async () => {
    const api = apiFixture({
      version: 1,
      status: "unavailable",
      message: "OpenAI 这次没能回答。",
      tokens: { input: 15_000, output: 1_000, unreportedSteps: 0 },
    });
    renderPanel(api);

    await ask("配置变更怎么决定的？");

    // Billed for the calls it made, and said only on an answer: the failure said nothing of them.
    expect(await screen.findByText("OpenAI 这次没能回答。本轮 16.0k tokens（输入 15.0k · 输出 1.0k）。")).toBeInTheDocument();
  });

  it("shows full conversation titles in the library", async () => {
    // A `<select>` has no ellipsis of its own: whatever does not fit is cut
    // off mid-character, so the label has to be short before it gets there.
    localStorage.setItem(
      "decision.assistant.sessions.v2",
      JSON.stringify({
        activeId: "c-long",
        conversations: [
          {
            id: "c-long",
            title: "",
            updatedAt: 2,
            profileId: "qwen",
            scope: "all",
            messages: [{ role: "user", content: "配置变更这件事我之前是怎么决定的？" }],
          },
          {
            id: "c-short",
            title: "",
            updatedAt: 1,
            profileId: "qwen",
            scope: "all",
            messages: [{ role: "user", content: "短问题" }],
          },
        ],
      }),
    );
    renderPanel(apiFixture());

    const titles = conversationList().querySelectorAll(".assistant-conversation-title");
    expect([...titles].map(item => item.textContent)).toEqual(loadSessions().conversations.sort((a, b) => b.updatedAt - a.updatedAt).map(item => item.title || item.messages[0]?.content));
  });

  it("sends a cited decision to its own page rather than its Markdown", async () => {
    const api = apiFixture();
    renderPanel(api);

    await ask("为什么？");
    await openCitation("打开决策详情：配置变更先留测试环境");

    // The Markdown is the same record with the scope, relations and review
    // stripped off, which is most of why the reader followed the citation.
    expect(navigation.onOpenDecision).toHaveBeenCalledWith("decision-config");
    expect(api.openVaultDocument).not.toHaveBeenCalled();
  });

  it("sends a cited principle to the methodology page", async () => {
    const api = apiFixture(
      answered("按这条原则 [1]", {
        ...CITED_DECISION,
        kind: "principle",
        title: "先验证边界再扩大投入",
        recordId: "principle-1",
      }),
    );
    renderPanel(api);

    await ask("为什么？");
    await openCitation("打开原则详情：先验证边界再扩大投入");

    expect(navigation.onOpenPrinciple).toHaveBeenCalledWith("principle-1");
    expect(navigation.onOpenDecision).not.toHaveBeenCalled();
  });

  it("sends a cited preference to the preferences and ideas view", async () => {
    const api = apiFixture(
      answered("你之前的偏好是 [1]", {
        ...CITED_DECISION,
        kind: "preference",
        title: "先留回滚入口，再扩大发布",
        reference: "preference-rollback",
        recordId: "preference-rollback",
      }),
    );
    renderPanel(api);

    await ask("回滚怎么处理？");
    await openCitation("在偏好与想法中打开：先留回滚入口，再扩大发布");

    // A preference has no decision detail and no principle detail; sending it
    // to either would show the reader a different record.
    expect(navigation.onOpenJournalEntry).toHaveBeenCalledWith(
      "preference-rollback",
    );
    expect(navigation.onOpenDecision).not.toHaveBeenCalled();
    expect(navigation.onOpenPrinciple).not.toHaveBeenCalled();
    expect(api.openVaultDocument).not.toHaveBeenCalled();
  });

  it("sends a cited idea to the same view as a preference", async () => {
    const api = apiFixture(
      answered("你有过这个想法 [1]", {
        ...CITED_DECISION,
        kind: "idea",
        title: "缓存失效可以改成事件驱动",
        reference: "idea-event-driven-cache",
        recordId: "idea-event-driven-cache",
      }),
    );
    renderPanel(api);

    await ask("缓存怎么失效？");
    await openCitation("在偏好与想法中打开：缓存失效可以改成事件驱动");

    expect(navigation.onOpenJournalEntry).toHaveBeenCalledWith(
      "idea-event-driven-cache",
    );
  });

  it("opens by vault path what this app does not hold a record for", async () => {
    const api = apiFixture(answered("看这里 [1]", CITED_DOCUMENT));
    renderPanel(api);

    await ask("为什么？");
    await openCitation("在 Obsidian 中打开：配置变更先留测试环境");

    // Notes, and decisions in the historical format, have no page to open.
    await waitFor(() =>
      expect(api.openVaultDocument).toHaveBeenCalledWith(
        "Decision Journal/decisions/2026/07/配置变更.md",
      ),
    );
    expect(navigation.onOpenDecision).not.toHaveBeenCalled();
  });

  it("opens in the vault what it says it will open in the vault", async () => {
    // A note carrying a record id is not something the agent produces today,
    // but the label and the action must not be able to disagree if it ever is.
    const api = apiFixture(
      answered("看这里 [1]", {
        ...CITED_DECISION,
        kind: "note",
        title: "缓存笔记",
        recordId: "note-1",
      }),
    );
    renderPanel(api);

    await ask("为什么？");
    await openCitation("在 Obsidian 中打开：缓存笔记");

    await waitFor(() => expect(api.openVaultDocument).toHaveBeenCalled());
    expect(navigation.onOpenDecision).not.toHaveBeenCalled();
    expect(navigation.onOpenPrinciple).not.toHaveBeenCalled();
  });

  it("says so plainly when the source cannot be opened", async () => {
    const api = apiFixture(answered("看这里 [1]", CITED_DOCUMENT));
    vi.mocked(api.openVaultDocument).mockRejectedValue(
      new Error("无法打开这份 Vault 文档"),
    );
    renderPanel(api);

    await ask("为什么？");
    await openCitation("在 Obsidian 中打开：配置变更先留测试环境");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法打开这份 Vault 文档",
    );
  });

  it("renders the answer's Markdown instead of its source text", async () => {
    const api = apiFixture(
      answered("## 结论\n\n- **先留**测试环境 [1]\n- 再上线"),
    );
    renderPanel(api);

    await ask("为什么？");

    const heading = await screen.findByRole("heading", { name: "结论" });
    expect(heading).toBeVisible();
    // Scope past the citation list, which is made of list items too.
    const answer = heading.closest(".assistant-answer")!;
    expect(within(answer as HTMLElement).getAllByRole("listitem")).toHaveLength(
      2,
    );
    expect(within(answer as HTMLElement).getByText("先留")).toBeVisible();
    expect(screen.queryByText(/## 结论/u)).toBeNull();
  });

  it("marks a superseded citation so it cannot read as the current answer", async () => {
    const response = answered("当时是这样 [1]。");
    if (response.status !== "answered") throw new Error("unreachable");
    response.message.citations![0]!.lifecycle = "superseded";
    renderPanel(apiFixture(response));

    await ask("为什么？");

    expect(await screen.findByText("已被取代")).toBeVisible();
  });

  it("shows what the agent is doing while the turn is still running", async () => {
    let settle!: (value: AssistantTurnResponse) => void;
    const api = apiFixture();
    vi.mocked(api.runAssistantTurn).mockReturnValue(
      new Promise<AssistantTurnResponse>((resolve) => {
        settle = resolve;
      }),
    );
    renderPanel(api);
    await ask("为什么？");

    const turnId = vi.mocked(api.runAssistantTurn).mock.calls[0]![0].turnId!;
    expect(turnId).toBeTruthy();
    act(() => {
      pushProgress!({
        turnId,
        step: { kind: "search", query: "配置变更", hits: 3 },
      });
      pushProgress!({
        turnId,
        step: { kind: "read", title: "配置变更先留测试环境" },
      });
    });

    expect(screen.getByText("检索「配置变更」· 3 条")).toBeVisible();
    expect(screen.getByText("读全文《配置变更先留测试环境》")).toBeVisible();

    await act(async () => settle(answered("先留测试环境 [1]。")));
    // Once the answer lands, the live list gives way to the answer itself.
    expect(screen.queryByText("检索「配置变更」· 3 条")).toBeNull();
  });

  it("ignores progress from a turn nobody is waiting on", async () => {
    const api = apiFixture();
    vi.mocked(api.runAssistantTurn).mockReturnValue(
      new Promise<AssistantTurnResponse>(() => undefined),
    );
    renderPanel(api);
    await ask("为什么？");

    act(() => {
      pushProgress!({
        turnId: "some-other-turn",
        step: { kind: "search", query: "无关查询", hits: 9 },
      });
    });

    expect(screen.queryByText("检索「无关查询」· 9 条")).toBeNull();
  });

  it("stops a turn and hands the question back for editing", async () => {
    let settle!: (value: AssistantTurnResponse) => void;
    const api = apiFixture();
    vi.mocked(api.runAssistantTurn).mockReturnValue(
      new Promise<AssistantTurnResponse>((resolve) => {
        settle = resolve;
      }),
    );
    renderPanel(api);
    await ask("为什么？");

    const turnId = vi.mocked(api.runAssistantTurn).mock.calls[0]![0].turnId!;
    await userEvent.setup().click(screen.getByRole("button", { name: "停止" }));
    expect(api.cancelAssistantTurn).toHaveBeenCalledWith(turnId);

    await act(async () =>
      settle({
        version: 1,
        status: "cancelled",
        steps: [{ kind: "search", query: "配置变更", hits: 3 }],
        durationMs: 400,
      }),
    );

    // The question comes back as editable text, not as a turn left unanswered.
    expect(screen.getByRole("textbox")).toHaveValue("为什么？");
    expect(document.querySelector(".assistant-turn.user")).toBeNull();
    expect(screen.getByText("已停止这一轮。")).toBeVisible();
  });

  it("keeps focus in the question box while an answer is made, so the next question typed lands in it", async () => {
    const api = apiFixture();
    let finish!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    renderPanel(api);
    const user = userEvent.setup();
    const box = await screen.findByRole("textbox");
    await waitFor(() => expect(box).toBeEnabled());
    await user.type(box, "为什么先留测试环境？");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    // Disabled while the answer was made, the box lost focus to the page, and the follow-up went nowhere.
    expect(box).not.toBeDisabled();
    expect(box).toHaveFocus();
    await act(async () => { finish(answered("先留测试环境。")); });
    await user.keyboard("还有别的原因吗");
    expect(box).toHaveValue("还有别的原因吗");
  });

  it("reports a failed stop without losing the running turn and allows retry", async () => {
    const api = apiFixture();
    let finish!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(api.cancelAssistantTurn).mockRejectedValueOnce(new Error("IPC unavailable"));
    renderPanel(api);
    await ask("保留正在回答的问题");
    const turnId = vi.mocked(api.runAssistantTurn).mock.calls[0]![0].turnId!;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("停止请求未能确认");
    // Read-only while the turn runs, and so still the place focus stays.
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(within(stream()).getByText("保留正在回答的问题")).toBeVisible();
    expect(screen.queryByText("已停止这一轮。")).toBeNull();
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(api.cancelAssistantTurn).toHaveBeenNthCalledWith(2, turnId);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    await act(async () => { finish({ version: 1, status: "cancelled", steps: [], durationMs: 10 }); });
    expect(screen.getByRole("textbox")).toHaveValue("保留正在回答的问题");
    expect(screen.getByText("已停止这一轮。")).toBeVisible();
  });

  it("discards a stop failure once its turn has finished, even during the next turn", async () => {
    const api = apiFixture();
    let finish!: (response: AssistantTurnResponse) => void;
    let rejectStop!: (error: Error) => void;
    vi.mocked(api.runAssistantTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(api.cancelAssistantTurn).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectStop = reject; }));
    renderPanel(api);
    await ask("第一问");
    await userEvent.setup().click(screen.getByRole("button", { name: "停止" }));
    await act(async () => { finish(answered("第一轮已经回答")); });
    await ask("第二问");
    await act(async () => { rejectStop(new Error("Late IPC failure")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(stream()).getByText("第一轮已经回答")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    await act(async () => { finish(answered("第二轮正常回答")); });
    expect(within(stream()).getByText("第二轮正常回答")).toBeVisible();
  });

  it("clears the failed stop warning when an answer arrives without retrying", async () => {
    const api = apiFixture();
    let finish!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(api.cancelAssistantTurn).mockRejectedValueOnce(new Error("IPC unavailable"));
    renderPanel(api);
    await ask("继续等待回答");
    await userEvent.setup().click(screen.getByRole("button", { name: "停止" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("停止请求未能确认");
    await act(async () => { finish(answered("正常完成的回答")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(within(stream()).getByText("正常完成的回答")).toBeVisible();
    expect(loadSessions().conversations[0]?.messages.at(-1)?.content).toBe("正常完成的回答");
  });

  it("offers no stop button when nothing is running", async () => {
    renderPanel(apiFixture());

    expect(await screen.findByRole("button", { name: "发送" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("shows what the turn cost, and marks a partial total as a floor", async () => {
    const exact = answered("结论 [1]。");
    if (exact.status !== "answered") throw new Error("unreachable");
    exact.message.tokens = { input: 11_800, output: 500, unreportedSteps: 0 };
    const view = renderPanel(apiFixture(exact));

    await ask("为什么？");
    expect(
      await screen.findByText("本轮 12.3k tokens（输入 11.8k · 输出 500）"),
    ).toBeVisible();
    view.unmount();
    localStorage.clear();

    const partial = answered("结论 [1]。");
    if (partial.status !== "answered") throw new Error("unreachable");
    partial.message.tokens = { input: 11_800, output: 500, unreportedSteps: 2 };
    renderPanel(apiFixture(partial));

    await ask("为什么？");
    // A floor must not read as an exact figure.
    expect(
      await screen.findByText(
        "本轮至少 12.3k tokens（输入 11.8k · 输出 500；2 步未报告用量）",
      ),
    ).toBeVisible();
  });

  it("records a rating against the turn that produced the answer", async () => {
    const api = apiFixture();
    renderPanel(api);
    await ask("为什么？");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");

    await userEvent.setup().click(screen.getByRole("button", { name: "有用" }));

    expect(api.saveAssistantFeedback).toHaveBeenCalledWith({
      turnId: "turn-fixture",
      rating: "helpful",
      question: "为什么？",
      citedReferences: ["Decision Journal/decisions/2026/07/配置变更.md"],
    });
    expect(screen.getByText("已记为有用")).toBeVisible();
    expect(screen.queryByRole("button", { name: "有用" })).toBeNull();
  });

  it("offers somewhere to say why, without demanding it", async () => {
    const user = userEvent.setup();
    const api = apiFixture();
    renderPanel(api);
    await ask("为什么？");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");

    await user.click(screen.getByRole("button", { name: "没用" }));
    // The click already counted; the note only adds to it.
    expect(api.saveAssistantFeedback).toHaveBeenCalledTimes(1);

    await user.type(
      screen.getByRole("textbox", { name: "哪里没用（可不填）" }),
      "答非所问",
    );
    await user.click(screen.getByRole("button", { name: "记下" }));

    expect(api.saveAssistantFeedback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        turnId: "turn-fixture",
        rating: "not_helpful",
        note: "答非所问",
      }),
    );
  });

  it("remembers an answer's rating across a restart, rather than offering it again", async () => {
    const answeredBefore = { ...emptyConversation(), messages: [{ role: "user" as const, content: "上次为什么选 SQLite？" }, { role: "assistant" as const, content: "因为要本地优先。", turnId: "turn-1" }] };
    saveSessions({ activeId: answeredBefore.id, conversations: [answeredBefore] });
    const api = apiFixture();
    const first = renderPanel(api);
    await userEvent.setup().click(await screen.findByRole("button", { name: "有用" }));
    expect(await screen.findByText("已记为有用")).toBeVisible();
    first.unmount();

    renderPanel(api);

    expect(await screen.findByText("已记为有用")).toBeVisible();
    expect(screen.queryByRole("button", { name: "有用" })).toBeNull();
  });

  it("never offers a rating it could not attach to a turn", async () => {
    const untraceable = answered("没有 turnId 的回答");
    if (untraceable.status !== "answered") throw new Error("unreachable");
    delete untraceable.message.turnId;
    renderPanel(apiFixture(untraceable));

    await ask("为什么？");
    await screen.findByText("没有 turnId 的回答");

    expect(screen.queryByRole("button", { name: "有用" })).toBeNull();
  });

  it("numbers and flags the sources it hands on, as the page shows them", async () => {
    const api = apiFixture(answered("先留测试环境 [1]。", { ...CITED_DECISION, lifecycle: "superseded" }));
    renderPanel(api);
    await ask("为什么先留测试环境？");
    await screen.findByText("已被取代");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "整理成记录" }));
    expect(
      within(screen.getByRole("dialog")).getByDisplayValue(/依据：\s\[1\] 配置变更先留测试环境（.+，已被取代）/u),
    ).toBeVisible();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));

    await user.click(menuButton("导出"));
    expect(vi.mocked(api.exportAssistantConversation).mock.calls[0]![0].markdown).toMatch(
      /- \[1\] 配置变更先留测试环境 — .+（已被取代）/u,
    );
  });

  it("hands an answer to the record form instead of writing it", async () => {
    const api = apiFixture();
    const view = renderPanel(api);
    await ask("为什么先留测试环境？");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "整理成记录" }));

    // Nothing is written by clicking: the form opens with the answer in it and
    // the reader is the one who saves.
    expect(api.createProactiveRecord).not.toHaveBeenCalled();
    // Scope to the form: the conversation picker carries the same question as
    // its title.
    const form = within(screen.getByRole("dialog"));
    expect(form.getByDisplayValue("为什么先留测试环境？")).toBeVisible();
    expect(form.getByDisplayValue("先留测试环境 [1]。")).toBeVisible();
    expect(
      form.getByDisplayValue(
        /依据：[\s\S]*配置变更先留测试环境（Decision Journal/u,
      ),
    ).toBeVisible();

    fireEvent.change(form.getByDisplayValue("为什么先留测试环境？"), { target: { value: "改写过的问题" } });

    // Out of sight with the page (a captured decision has the window, say), the form and its edits are kept.
    view.rerender(<AssistantPanel api={api} {...navigation} hidden />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    vi.mocked(api.listAssistantModels).mockResolvedValue([
      { ...LOCAL, profileId: "replacement", label: "更新后的本机模型" },
    ]);
    view.rerender(<AssistantPanel api={api} {...navigation} />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "回答模型" })).toHaveValue("replacement"),
    );
    expect(within(screen.getByRole("dialog")).getByDisplayValue("改写过的问题")).toBeVisible();
    expect(api.createProactiveRecord).not.toHaveBeenCalled();
  });

  it("exports a conversation renamed to the longest title under a name the export takes", async () => {
    const named = { ...emptyConversation(), title: "长".repeat(200), messages: [{ role: "user" as const, content: "问" }, { role: "assistant" as const, content: "答" }] };
    saveSessions({ activeId: named.id, conversations: [named] });
    const api = apiFixture();
    renderPanel(api);
    await screen.findByRole("textbox");

    await userEvent.setup().click(menuButton("导出"));

    const call = vi.mocked(api.exportAssistantConversation).mock.calls[0]![0];
    expect(call.suggestedName).toBe(`${"长".repeat(196)}.md`);
  });

  it("exports the conversation as Markdown that still points at its sources", async () => {
    const api = apiFixture();
    renderPanel(api);
    await ask("为什么先留测试环境？");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");

    await userEvent.setup().click(menuButton("导出"));

    const call = vi.mocked(api.exportAssistantConversation).mock.calls[0]![0];
    expect(call.suggestedName).toBe("为什么先留测试环境？.md");
    expect(call.markdown).toContain("## 问");
    expect(call.markdown).toContain("为什么先留测试环境？");
    expect(call.markdown).toContain("## 答");
    expect(call.markdown).toContain("先留测试环境 [1]。");
    // An export that dropped the sources would be a transcript, not a record
    // of where the answer came from.
    expect(call.markdown).toContain(
      "Decision Journal/decisions/2026/07/配置变更.md",
    );
    expect(await screen.findByText("对话已导出。")).toBeVisible();
  });

  it.each(["cancelled", "failed", "rejected"] as const)("serializes exports and clears stale success after %s", async (outcome) => {
    const api = apiFixture();
    renderPanel(api);
    await ask("准备导出的对话");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    const user = userEvent.setup();
    await user.click(menuButton("导出"));
    expect(await screen.findByText("对话已导出。")).toBeVisible();
    const input = screen.getByRole("textbox", { name: "问一句你自己的历史" });
    fireEvent.change(input, { target: { value: "尚未发送的草稿" } });
    let finish!: (value: Awaited<ReturnType<AssistantApi["exportAssistantConversation"]>>) => void;
    let fail!: (error: Error) => void;
    vi.mocked(api.exportAssistantConversation).mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const exportButton = menuButton("导出");
    const conversationId = loadSessions().activeId;
    act(() => {
      fireEvent.click(exportButton);
      fireEvent.click(exportButton);
      fireEvent.click(screen.getByRole("button", { name: "新对话" }));
      fireEvent.click(menuButton("删除此对话"));
      fireEvent.submit(input.closest("form")!);
    });
    expect(api.exportAssistantConversation).toHaveBeenCalledTimes(2);
    expect(api.runAssistantTurn).toHaveBeenCalledTimes(1);
    expect(loadSessions().activeId).toBe(conversationId);
    expect(screen.queryByText("对话已导出。")).toBeNull();
    expect(menuButton("正在导出…")).toBeDisabled();
    expect(conversationButton(loadSessions().activeId)).toBeDisabled();
    expect(input).toBeDisabled();
    await act(async () => {
      if (outcome === "rejected") fail(new Error("IPC failed"));
      else finish({ status: outcome });
    });
    expect(screen.queryByText("对话已导出。")).toBeNull();
    expect(input).toHaveValue("尚未发送的草稿");
    expect(input).toBeEnabled();
    expect(menuButton("导出")).toBeEnabled();
    if (outcome === "cancelled") expect(screen.queryByRole("alert")).toBeNull();
    else expect(screen.getByRole("alert")).toBeVisible();
    await user.click(menuButton("导出"));
    expect(await screen.findByText("对话已导出。")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.exportAssistantConversation).toHaveBeenCalledTimes(3);
  });

  it("offers no export for a conversation with nothing in it", async () => {
    renderPanel(apiFixture());

    expect(menuButton("导出")).toBeDisabled();
  });

  it("keeps the previous conversation when a new one is started", async () => {
    const first = renderPanel(apiFixture());
    await ask("第一个问题");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    await userEvent.setup().click(screen.getByRole("button", { name: "新对话" }));

    // The old conversation is put away, not erased.
    expect(document.querySelector(".assistant-turn.user")).toBeNull();
    expect(
      within(conversationList()).getByText(
        "第一个问题",
      ),
    ).toBeInTheDocument();

    first.unmount();
    renderPanel(apiFixture());

    // And it is still there after a remount.
    expect(
      within(conversationList()).getByText(
        "第一个问题",
      ),
    ).toBeInTheDocument();
  });

  it("reopens an earlier conversation from the picker", async () => {
    const user = userEvent.setup();
    renderPanel(apiFixture());
    await ask("第一个问题");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(document.querySelector(".assistant-turn.user")).toBeNull();

    await user.click(within(conversationList()).getByRole("button", { name: /第一个问题/ }));

    expect(within(stream()).getByText("第一个问题")).toBeVisible();
    expect(within(stream()).getByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toBeVisible();
  });

  it("forgets a conversation for good when asked to", async () => {
    const user = userEvent.setup();
    renderPanel(apiFixture());
    await ask("要删掉的问题");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");

    await user.click(menuButton("删除此对话"));
    await user.click(screen.getByRole("button", { name: "确认删除" }));

    // A conversation the reader deleted must not survive a remount.
    expect(within(stream()).queryByText("要删掉的问题")).toBeNull();
    cleanup();
    renderPanel(apiFixture());
    expect(
      within(conversationList()).queryByText(
        "要删掉的问题",
      ),
    ).toBeNull();
  });

  it("keeps the conversation across a remount", async () => {
    const first = renderPanel(apiFixture());
    await ask("为什么？");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    first.unmount();

    renderPanel(apiFixture());

    conversationList();
    expect(within(stream()).getByText("为什么？")).toBeVisible();
    expect(within(stream()).getByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。")).toBeVisible();
  });

  it("keeps the reader's position during progress and resumes following only on request", async () => {
    const api = apiFixture();
    let finish!: (response: AssistantTurnResponse) => void;
    vi.mocked(api.runAssistantTurn).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderPanel(api);
    await ask("查看历史时不要跳动");
    const log = stream();
    Object.defineProperties(log, { scrollHeight: { configurable: true, value: 800 }, clientHeight: { configurable: true, value: 200 } });
    log.scrollTop = 100;
    fireEvent.scroll(log);
    const id = vi.mocked(api.runAssistantTurn).mock.calls[0]![0].turnId!;
    act(() => pushProgress?.({ turnId: id, step: { kind: "search", query: "历史", hits: 1 } }));
    expect(log.scrollTop).toBe(100);
    await act(async () => finish(answered("新回答")));
    expect(log.scrollTop).toBe(100);
    const bottom = screen.getByRole("button", { name: "滚动到底部" });
    fireEvent.change(screen.getByRole("textbox", { name: "问一句你自己的历史" }), { target: { value: "草稿" } });
    expect(log.scrollTop).toBe(100);
    fireEvent.click(bottom);
    expect(log.scrollTop).toBe(800);
    expect(bottom).not.toBeVisible();
  });

  it("keeps scope selection and deletion confirmation available through compact controls", async () => {
    const api = apiFixture();
    renderPanel(api);
    await userEvent.setup().click(screen.getByRole("button", { name: "材料范围" }));
    const dialog = screen.getByRole("dialog", { name: "材料范围" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Obsidian" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "材料范围" })).toHaveFocus();
    await ask("根据笔记回答");
    await screen.findByText((_text, element) => element?.tagName === "P" && element.textContent === "先留测试环境 [1]。");
    expect(api.runAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({ scope: "obsidian" }));
    fireEvent.click(menuButton("删除此对话"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(within(stream()).getByText("根据笔记回答")).toBeVisible();
    fireEvent.click(screen.getByLabelText("对话操作"));
    fireEvent.keyDown(screen.getByLabelText("对话操作"), { key: "Escape" });
    expect(screen.getByLabelText("对话操作").closest("details")).not.toHaveAttribute("open");
  });

});
