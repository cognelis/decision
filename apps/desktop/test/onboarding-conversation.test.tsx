// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { OnboardingRequest, OnboardingView, RetrievalAnswerProvider } from "@cognelis/decision-protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantPanel, type AssistantApi } from "../src/renderer/components/pages/assistant/AssistantPanel.js";
import { loadSessions } from "../src/renderer/components/pages/assistant/assistant-session.js";
import { previewOnboarding } from "../src/renderer/preview-onboarding.js";
import { OnboardingConversation } from "../src/renderer/components/pages/assistant/OnboardingConversation.js";

const MODEL: RetrievalAnswerProvider = { profileId: "remote", label: "远端", kind: "openai", model: "m", leavesDevice: true };

const apiWith = (sendOnboarding: (input: OnboardingRequest) => Promise<OnboardingView>): AssistantApi => ({
  listAssistantModels: vi.fn(async () => [MODEL]),
  checkAssistantSource: vi.fn(),
  searchAssistantSources: vi.fn(),
  runAssistantTurn: vi.fn(),
  cancelAssistantTurn: vi.fn(async () => undefined),
  saveAssistantFeedback: vi.fn(),
  createProactiveRecord: vi.fn(),
  exportAssistantConversation: vi.fn(),
  openVaultDocument: vi.fn(),
  onAssistantProgress: vi.fn(() => () => undefined),
  forgetAssistantTurns: vi.fn(async () => undefined),
  sendOnboarding: vi.fn(sendOnboarding),
} as unknown as AssistantApi);

const props = (api: AssistantApi) => ({ api, onOpenDecision: vi.fn(), onOpenJournalEntry: vi.fn(), onOpenPrinciple: vi.fn(), vault: "/vault" });

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("接入新工具 in the assistant", () => {
  it("walks its four cards, asks nothing of retrieval, and is kept apart in the list", async () => {
    const api = apiWith(previewOnboarding());
    render(<AssistantPanel {...props(api)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "接入新工具" }));
    expect(screen.getByText("接入一个新工具")).toBeInTheDocument();
    const box = await screen.findByRole("textbox", { name: "和接入助手说" });
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.change(box, { target: { value: "我想接入 Kimi CLI" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    const command = await screen.findByRole("region", { name: "确认命令名" });
    expect(within(command).getByText("kimi")).toBeInTheDocument();
    fireEvent.click(within(command).getByRole("button", { name: "是这个命令" }));

    const probe = await screen.findByRole("region", { name: "确认探针" });
    expect(within(probe).getByText("~/.kimi/hooks.json")).toBeInTheDocument();
    expect(within(probe).getByText("UserPromptSubmit、Stop")).toBeInTheDocument();
    fireEvent.click(within(probe).getByRole("button", { name: "装探针" }));

    const waiting = await screen.findByRole("region", { name: "等待探针" });
    expect(within(waiting).getByText("请原样回复：DECISION-7F3K")).toBeInTheDocument();
    expect(within(waiting).getByRole("button", { name: "结束等待" })).toBeEnabled();
    expect(within(waiting).getByRole("status")).toHaveTextContent("正在等待 UserPromptSubmit、Stop 事件");
    expect(screen.getByRole("textbox", { name: "和接入助手说" })).toBeDisabled();
    // Held while it waits: not switched away from.
    expect(screen.getByRole("button", { name: "新对话" })).toBeDisabled();

    const plan = await screen.findByRole("region", { name: "确认接入方案" }, { timeout: 10_000 });
    for (const text of ["Kimi CLI（KM，id kimi）", "~/.kimi/hooks.json", "提问：请原样回复：DECISION-7F3K", "目录：/work/app"]) {
      expect(within(plan).getByText(text, { exact: false })).toBeInTheDocument();
    }
    fireEvent.click(within(plan).getByRole("button", { name: "确认接入" }));
    expect(await screen.findByText(/已接入 Kimi CLI/u)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "和接入助手说" })).toBeDisabled();

    expect(api.runAssistantTurn).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "会话搜索结果" })).toHaveTextContent("接入");
    expect(screen.getByRole("list", { name: "会话搜索结果" })).toHaveTextContent("接入对话 · 已结束");
    // Saved with what was said, and without the card (the plan's sample values stay in memory).
    await waitFor(() => {
      const saved = loadSessions("/vault").conversations.find((conversation) => conversation.onboarding !== undefined);
      expect(saved?.onboarding?.entries.some((entry) => entry.text.includes("已接入"))).toBe(true);
    });
    expect(JSON.stringify(localStorage)).not.toContain("/work/app");
  }, 20_000);

  it("cancels a waiting probe, and says so when the App no longer knows the conversation", async () => {
    const api = apiWith(previewOnboarding());
    render(<AssistantPanel {...props(api)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "接入新工具" }));
    const box = await screen.findByRole("textbox", { name: "和接入助手说" });
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.change(box, { target: { value: "接入 kimi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(within(await screen.findByRole("region", { name: "确认命令名" })).getByRole("button", { name: "是这个命令" }));
    fireEvent.click(within(await screen.findByRole("region", { name: "确认探针" })).getByRole("button", { name: "装探针" }));
    const waiting = await screen.findByRole("region", { name: "等待探针" });
    fireEvent.click(within(waiting).getByRole("button", { name: "取消探针" }));
    expect(await screen.findByText(/用户取消/u)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "等待探针" })).not.toBeInTheDocument());

    vi.mocked(api.sendOnboarding).mockRejectedValueOnce(new Error("这个接入对话已经结束（Decision 重启过，或对话已关闭）"));
    const again = screen.getByRole("textbox", { name: "和接入助手说" });
    await waitFor(() => expect(again).not.toBeDisabled());
    fireEvent.change(again, { target: { value: "继续" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "发送" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("已经结束");
    expect(screen.getByRole("textbox", { name: "和接入助手说" })).toBeDisabled();
  }, 20_000);
});

describe("the plan card", () => {
  it("says where MCP goes when it is written to the client's own configuration file", () => {
    const client = {
      id: "kimi", name: "Kimi CLI", shortName: "KM", command: "kimi",
      hooks: { file: "~/.kimi/hooks.json", format: "flat" as const },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "transcript" as const, format: "copilot" as const, field: "transcript_path" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      mcp: { mode: "file" as const, file: "~/.kimi/settings.json" },
    };
    render(<OnboardingConversation
      api={{ sendOnboarding: vi.fn() }}
      transcript={{ sessionId: "onb-test0001", entries: [], card: { kind: "plan", token: "plantoken000000001", client, preview: { prompt: "p", reply: "r", sessionId: "s", cwd: "/w", turnId: null, complete: null } } }}
      onChange={vi.fn()}
      onBusy={vi.fn()}
      model={MODEL}
      modelPicker={null}
      hidden={false}
    />);
    const plan = screen.getByRole("region", { name: "确认接入方案" });
    expect(plan).toHaveTextContent("写进它的 MCP 配置文件 ~/.kimi/settings.json（只写 mcpServers.decision 这一项");
    expect(plan).toHaveTextContent("从 transcript_path 指向的会话记录读（copilot）");
    expect(plan).toHaveTextContent("并注册 MCP 服务");
  });
});

describe("opened from the 接入 page", () => {
  it("starts a 接入新工具 conversation when asked to", async () => {
    const api = apiWith(previewOnboarding());
    render(<AssistantPanel {...props(api)} openConversationId={{ onboarding: true }} />);
    expect(await screen.findByText("接入一个新工具")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "和接入助手说" })).toBeInTheDocument();
  });
});
