// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { createJournalEntry } from "@cognelis/decision-core";
import type { AmendmentState } from "@cognelis/decision-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JournalEntryView } from "../src/renderer/components/pages/decisions/JournalEntryView.js";
import type { AmendmentRecordView, DecisionApi } from "../src/shared/renderer-api.js";

afterEach(cleanup);
beforeEach(() => { try { localStorage.clear(); } catch { /* none kept */ } });

const made = (id: string, title: string, content: string, kind: "preference" | "idea" = "preference") => createJournalEntry(
  kind === "preference"
    ? { kind, title, content, appliesWhen: "改动难以撤回时。", exceptions: "只影响本机的改动。", knowledgeStatus: "active" }
    : { kind, title, content, whyInteresting: "省一层转换", knowledgeStatus: "active" },
  { sourceKind: "app_manual", sourceForm: "user_original", sensitivity: "private" }, id, new Date("2026-11-01T10:00:00"));

const state = (over: Partial<AmendmentState> = {}): AmendmentState => ({ revision: 0, relativePath: "Decision Journal/decision-amendments/x.md", amendments: [], revised: null, withdrawn: null, history: [], ...over });
const view = (source: "preferences" | "ideas", recordId: string, over: Partial<AmendmentState> = {}, contentHash: string | null = "a".repeat(64)): AmendmentRecordView =>
  ({ source, recordId, contentHash, state: state(over) });

const rewritten = made("P-1", "先留回滚入口", "不可逆的发布步骤要先有回滚路径。");
const plain = made("P-2", "命名用完整单词", "变量名不缩写。");
const stale = made("I-1", "缓存失效改成事件驱动", "与其定时清理，不如发失效事件。", "idea");
const gone = made("P-3", "提交信息写英文", "提交信息统一写英文。");

const records: AmendmentRecordView[] = [
  view("preferences", "P-1", {
    revision: 3,
    amendments: [
      { n: 1, at: "2026-11-11T10:20:00", client: "Codex", text: "数据库迁移要先在影子库演练一次。", basis: "user_said", reason: null },
      { n: 2, at: "2026-11-08T16:02:00", client: "Claude Code", text: "灰度阶段可以只留回滚入口。", basis: "user_confirmed", reason: null },
    ],
    revised: { fields: ["summary"], values: { summary: "不可逆的发布步骤要先有回滚路径；数据库迁移要先演练。" }, at: "2026-11-11T10:28:00", client: "Codex", reason: "用户补充", stale: false },
    history: [{ revision: 3, at: "2026-11-11T10:28:00", client: "Codex", action: "revise", reason: "用户补充", before: { summary: "不可逆的发布步骤要先有回滚路径。" }, basis: null }],
  }),
  view("ideas", "I-1", {
    revision: 1,
    revised: { fields: ["summary"], values: { summary: "写入端提交后发失效事件，读端订阅。" }, at: "2026-11-10T09:00:00", client: "Claude Code", reason: "r", stale: true },
    history: [{ revision: 1, at: "2026-11-10T09:00:00", client: "Claude Code", action: "revise", reason: "r", before: { summary: "与其定时清理，不如发失效事件。" }, basis: null }],
  }),
  view("preferences", "P-3", {
    revision: 1, withdrawn: { at: "2026-11-11T11:00:00", client: "Codex", reason: "你说以后统一写中文" },
    history: [{ revision: 1, at: "2026-11-11T11:00:00", client: "Codex", action: "withdraw", reason: "你说以后统一写中文", before: null, basis: "user_said" }],
  }),
];

const api = (over: Partial<DecisionApi> = {}) => ({
  listJournalEntries: vi.fn(async () => [rewritten, plain, stale, gone]),
  listDecisionAmendments: vi.fn(async () => ({ records, unavailable: false })),
  updateDecisionAmendment: vi.fn(async () => ({ amendVersion: 1 as const, status: "saved" as const, revision: 4, relativePath: "x.md", originalUnchanged: true as const })),
  reviseJournalEntry: vi.fn(),
  ...over,
}) as unknown as DecisionApi & { listJournalEntries: ReturnType<typeof vi.fn>; updateDecisionAmendment: ReturnType<typeof vi.fn>; listDecisionAmendments: ReturnType<typeof vi.fn> };
const card = (title: string) => screen.getAllByText(title)[0]!.closest("li")!;
const loaded = () => screen.findByText("命名用完整单词");

describe("what agents did to preferences and ideas", () => {
  it("marks a rewritten entry, shows the rewrite with its changed part marked and the original words one click away", async () => {
    render(<JournalEntryView api={api()} refreshRevision={0} />);
    await loaded();
    const item = card("先留回滚入口");
    expect(within(item).getByText(/已被 Codex 改写 · 11 月 11 日/u)).toBeVisible();
    expect(within(item).getByText("增补 2")).toBeVisible();
    // The rewrite is what is shown; the part it added is marked; the reader's words are in the disclosure.
    expect(item.querySelector("mark.amendment-changed")).toHaveTextContent("；数据库迁移要先演练");
    fireEvent.click(within(item).getByText(/原话（你写的 v1）/u));
    expect(within(item).getByText("偏好内容：", { exact: false })).toBeVisible();
  });

  it("lists the additions with time, who and on what ground", async () => {
    render(<JournalEntryView api={api()} refreshRevision={0} />);
    const group = within(await screen.findByRole("group", { name: "增补" }));
    expect(group.getByText("11-11 10:20")).toBeVisible();
    expect(group.getByText("Codex")).toHaveAttribute("title", "Codex");
    expect(group.getByText("用户原话")).toBeVisible();
    expect(group.getByText("用户认可")).toBeVisible();
  });

  it("says a rewrite did not take, shows what it was, rewrites from it, and can be told to stop mentioning it", async () => {
    const entries = api();
    render(<JournalEntryView api={entries} refreshRevision={0} />);
    await loaded();
    const item = card("缓存失效改成事件驱动");
    expect(await within(item).findByText("改写未生效")).toBeVisible();
    // Not shown as the entry's content: the reader's words stay.
    expect(within(item).getByText("与其定时清理，不如发失效事件。")).toBeVisible();
    fireEvent.click(within(item).getByRole("button", { name: "查看当时的改写文字" }));
    expect(within(item).getByText(/写入端提交后发失效事件，读端订阅。/u)).toBeVisible();
    fireEvent.click(within(item).getByRole("button", { name: "按新原文重新改写" }));
    expect(await screen.findByLabelText("修订内容")).toHaveValue("写入端提交后发失效事件，读端订阅。");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(within(item).getByRole("button", { name: "忽略" }));
    await waitFor(() => expect(within(item).queryByText("改写未生效")).toBeNull());
    expect(localStorage.getItem("paraself.amendments.ignored")).toContain("ideas:I-1#1");
  });

  it("shows a withdrawn entry only under 全部 and 已撤回, struck through, with who, when and why, and restores it as the reader", async () => {
    const entries = api();
    render(<JournalEntryView api={entries} refreshRevision={0} />);
    await loaded();
    const item = card("提交信息写英文");
    expect(item).toHaveClass("withdrawn");
    expect(within(item).getByText(/Codex · 11 月 11 日 · 原因：你说以后统一写中文/u)).toBeVisible();
    // Not among the valid ones.
    fireEvent.change(screen.getByLabelText("记录状态筛选"), { target: { value: "active" } });
    await waitFor(() => expect(screen.queryByText("提交信息写英文")).toBeNull());
    fireEvent.change(screen.getByLabelText("记录状态筛选"), { target: { value: "withdrawn" } });
    const back = within(await screen.findByText("提交信息写英文").then((node) => node.closest("li")!));
    expect(screen.queryByText("命名用完整单词")).toBeNull();
    fireEvent.click(back.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(entries.updateDecisionAmendment).toHaveBeenCalledWith(expect.objectContaining({
      action: "restore", source: "preferences", recordId: "P-3", sourceClient: "我", basis: "user_said", expectedRevision: 1,
    })));
  });

  it("withdraws with the reason the reader gives, as the reader", async () => {
    const entries = api();
    render(<JournalEntryView api={entries} refreshRevision={0} />);
    await loaded();
    fireEvent.click(within(card("命名用完整单词")).getByRole("button", { name: "撤回" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "撤回" })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("撤回原因"), { target: { value: "不再这样要求" } });
    fireEvent.click(dialog.getByRole("button", { name: "撤回" }));
    await waitFor(() => expect(entries.updateDecisionAmendment).toHaveBeenCalledWith(expect.objectContaining({
      action: "withdraw", recordId: "P-2", sourceClient: "我", basis: "user_said", expectedRevision: 0, reason: "不再这样要求",
    })));
  });

  it("opens the history by day, with the rewrite before and after and a way back that asks first", async () => {
    const entries = api();
    render(<JournalEntryView api={entries} refreshRevision={0} />);
    await loaded();
    fireEvent.click(within(card("先留回滚入口")).getByRole("button", { name: "修订记录" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("改写「偏好内容」")).toBeVisible();
    expect(dialog.getByText("不可逆的发布步骤要先有回滚路径。", { selector: "del" })).toBeVisible();
    expect(dialog.getByText("不可逆的发布步骤要先有回滚路径；数据库迁移要先演练。", { selector: "ins" })).toBeVisible();
    fireEvent.click(dialog.getAllByRole("button", { name: "恢复为这一版之前" })[0]!);
    // Asked first: nothing is written until the reader says so.
    expect(entries.updateDecisionAmendment).not.toHaveBeenCalled();
    const confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    fireEvent.click(within(confirm).getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(entries.updateDecisionAmendment).toHaveBeenCalledWith(expect.objectContaining({
      action: "revert", toRevision: 3, source: "preferences", recordId: "P-1", sourceClient: "我", expectedContentHash: "a".repeat(64), expectedRevision: 3,
    })));
  });

  it("says a refusal and reads again when the record moved on", async () => {
    const entries = api({ updateDecisionAmendment: vi.fn(async () => ({ amendVersion: 1 as const, status: "revision_conflict" as const, revision: 4, relativePath: "x.md", originalUnchanged: true as const })) } as never);
    render(<JournalEntryView api={entries} refreshRevision={0} />);
    await loaded();
    fireEvent.click(within(card("提交信息写英文")).getByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("增补刚刚又有更新");
    await waitFor(() => expect(entries.listDecisionAmendments.mock.calls.length).toBeGreaterThan(1));
  });

  it("searches with the words added by agents (placeholder says so) and still lists when the amendments cannot be read", async () => {
    const entries = api({ listDecisionAmendments: vi.fn(async () => { throw new Error("boom"); }) } as never);
    render(<JournalEntryView api={entries} refreshRevision={0} />);
    expect(screen.getByPlaceholderText("搜索偏好与想法（也搜增补内容）")).toBeVisible();
    expect(await screen.findByText("先留回滚入口")).toBeVisible();
    expect(screen.getByText(/增补与撤回记录这次没能读取/u)).toBeVisible();
    expect(screen.queryByText(/已被 Codex 改写/u)).toBeNull();
  });
});

describe("who did it", () => {
  it("shows a client's name, not its id, in the tag, the additions, the history and the stale note", async () => {
    const byId: AmendmentRecordView[] = records.map((record) => ({ ...record, state: {
      ...record.state,
      amendments: record.state.amendments.map((item) => ({ ...item, client: item.client === "Claude Code" ? "claude-code" : "codex" })),
      revised: record.state.revised === null ? null : { ...record.state.revised, client: "claude-code" },
      withdrawn: record.state.withdrawn === null ? null : { ...record.state.withdrawn, client: "codex" },
      history: record.state.history.map((item) => ({ ...item, client: "claude-code" })),
    } }));
    render(<JournalEntryView api={api({ listDecisionAmendments: vi.fn(async () => ({ records: byId, unavailable: false })) } as never)} refreshRevision={0} />);
    await loaded();
    expect(document.body.textContent).not.toMatch(/claude-code|codex/u);
    expect(within(card("先留回滚入口")).getByText(/已被 Claude Code 改写/u)).toBeVisible();
    expect(within(card("缓存失效改成事件驱动")).getByText(/Claude Code 11 月 10 日的改写基于旧版原文/u)).toBeVisible();
    expect(within(card("提交信息写英文")).getByText(/^Codex · /u)).toBeVisible();
    const who = within(card("先留回滚入口")).getAllByText("Claude Code");
    expect(who[0]).toHaveAttribute("title", "Claude Code");
    fireEvent.click(within(card("先留回滚入口")).getByRole("button", { name: "修订记录" }));
    expect(within(await screen.findByRole("dialog")).getAllByText("Claude Code").length).toBeGreaterThan(0);
  });
});
