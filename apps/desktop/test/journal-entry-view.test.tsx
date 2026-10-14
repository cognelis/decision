// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { createJournalEntry, reviseJournalEntry as reviseEntry } from "@cognelis/decision-core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionApi } from "../src/shared/renderer-api.js";
import { JournalEntryView } from "../src/renderer/components/pages/decisions/JournalEntryView.js";

afterEach(cleanup);

const entry = createJournalEntry(
  {
    kind: "preference",
    title: "常规实现决策默认由系统自主完成",
    content: "普通可逆的方向与实现由系统自行判断并交付结果。",
    appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
    exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
  },
  { sourceKind: "agent_capture", sourceForm: "machine_summary", sensitivity: "private" },
  "preference-1",
  new Date("2026-08-26T10:00:00.000Z"),
);

describe("JournalEntryView", () => {
  it("fetches an arrival missing from the recent list and highlights the exact record", async () => {
    const listJournalEntries = vi.fn<DecisionApi["listJournalEntries"]>(async (query) => query.query === entry.id ? [entry] : []);
    render(<JournalEntryView api={{ listJournalEntries } as unknown as DecisionApi} refreshRevision={0} highlightId={entry.id} />);
    expect((await screen.findByText(entry.title)).closest("li")).toHaveAttribute("aria-current", "true");
    expect(listJournalEntries).toHaveBeenCalledWith({ query: entry.id, limit: 200 });
  });

  it.each(["preference", "idea"] as const)("clarifies and restores a %s without losing revision history", async (kind) => {
    let current = createJournalEntry({ kind, title: "未整理的记录", content: "保留这个观察", knowledgeStatus: "inbox" },
      { sourceKind: "app_manual", sourceForm: "user_original" }, "inbox-1", new Date());
    const listJournalEntries = vi.fn(async () => [current]);
    const reviseJournalEntry = vi.fn<DecisionApi["reviseJournalEntry"]>(async (_id, input) => {
      current = reviseEntry(current, input.draft, input.change, new Date());
      return current;
    });
    render(<JournalEntryView api={{ listJournalEntries, reviseJournalEntry } as unknown as DecisionApi} refreshRevision={0} />);
    await screen.findByText("未整理的记录");
    fireEvent.click(screen.getByRole("button", { name: "修订" }));
    fireEvent.change(screen.getByLabelText("记录状态"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "补充适用范围" } });
    expect(screen.getByRole("button", { name: "保存修订" })).toBeDisabled();
    if (kind === "preference") {
      fireEvent.change(screen.getByLabelText("适用条件"), { target: { value: "可逆的实现" } });
      fireEvent.change(screen.getByLabelText("例外与边界"), { target: { value: "付费和不可逆操作" } });
    } else {
      fireEvent.change(screen.getByLabelText("为什么值得保留"), { target: { value: "能减少重复劳动" } });
      fireEvent.change(screen.getByLabelText("下一步验证"), { target: { value: "在一个项目中试用" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(current.knowledgeStatus).toBe("active"));
    expect(current.revisionEvents[0]?.previous.knowledgeStatus).toBe("inbox");
    await screen.findByRole("button", { name: "归档" });
    fireEvent.click(screen.getByRole("button", { name: "归档" }));
    await waitFor(() => expect(current.knowledgeStatus).toBe("archived"));
    fireEvent.click(await screen.findByRole("button", { name: "修订" }));
    fireEvent.change(screen.getByLabelText("记录状态"), { target: { value: "active" } });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "重新适用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(current.knowledgeStatus).toBe("active"));
    expect(current.revision).toBe(4);
    expect(current.revisionEvents).toHaveLength(3);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByText("修订历史 · 3"));
    expect(screen.getByText("变更原因：重新适用")).toBeVisible();
    fireEvent.click(screen.getByText("查看修订前内容（v1）"));
    expect(screen.getByText("状态：待澄清")).toBeVisible();
    expect(screen.getByText(kind === "preference" ? "适用条件：未填写" : "保留理由：未填写")).toBeVisible();
  });

  it("shows the languages an entry is kept for, revises them as typed, and keeps them when it is archived", async () => {
    let current = createJournalEntry({ kind: "preference", title: "错误包装", content: "错误用 fmt.Errorf 包装", languages: ["go"] },
      { sourceKind: "app_manual", sourceForm: "user_original" }, "go-1", new Date());
    const general = { ...entry, id: "general-1", title: "通用的偏好" };
    const listJournalEntries = vi.fn(async () => [current, general]);
    const reviseJournalEntry = vi.fn<DecisionApi["reviseJournalEntry"]>(async (_id, input) => {
      current = reviseEntry(current, input.draft, input.change, new Date());
      return current;
    });
    render(<JournalEntryView api={{ listJournalEntries, reviseJournalEntry } as unknown as DecisionApi} refreshRevision={0} />);
    const card = (await screen.findByText("错误包装")).closest("li")!;
    expect(within(card).getByRole("list", { name: "适用语言" })).toHaveTextContent(/^Go$/u);
    expect(within(screen.getByText("通用的偏好").closest("li")!).getByRole("list", { name: "适用语言" })).toHaveTextContent(/^通用$/u);

    fireEvent.click(within(card).getByRole("button", { name: "修订" }));
    const field = screen.getByRole("textbox", { name: "适用语言" });
    expect(field).toHaveValue("Go");
    // Past eight, said here in its words, rather than refused at saving in the IPC's English.
    fireEvent.change(field, { target: { value: "a、b、c、d、e、f、g、h、i" } });
    expect(screen.getByRole("alert")).toHaveTextContent("适用语言最多 8 项");
    // Separated by commas, 顿号 or semicolons, not spaces: "Objective C" was "objective" and "c".
    fireEvent.change(field, { target: { value: "Go，TS、 golang ； Rust" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "也适用于 TypeScript 与 Rust" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(current.languages).toEqual(["go", "typescript", "rust"]));
    expect(current.revisionEvents[0]?.previous.languages).toEqual(["go"]);
    expect(await within(card).findByRole("list", { name: "适用语言" })).toHaveTextContent("GoTypeScriptRust");

    fireEvent.click(within(card).getByRole("button", { name: "归档" }));
    await waitFor(() => expect(current.knowledgeStatus).toBe("archived"));
    expect(current.languages).toEqual(["go", "typescript", "rust"]);
  });

  it("shows save errors inside the dialog and retains the clarification", async () => {
    const listJournalEntries = vi.fn(async () => [entry]);
    const reviseJournalEntry = vi.fn(async () => { throw new Error("存储不可用"); });
    render(<JournalEntryView api={{ listJournalEntries, reviseJournalEntry } as unknown as DecisionApi} refreshRevision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "修订" }));
    fireEvent.change(screen.getByLabelText("适用条件"), { target: { value: "新的适用范围" } });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "缩小范围" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("存储不可用");
    expect(within(dialog).getByLabelText("适用条件")).toHaveValue("新的适用范围");

    // Given up: its failure stood over the list as 处理失败 for nothing done there.
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps why a revision was refused, shows the entry as read again, and saves the draft against it", async () => {
    const { journalEntryBasis } = await import("../src/shared/journal-basis.js");
    let stored = entry;
    const listJournalEntries = vi.fn(async () => [stored]);
    const reviseJournalEntry = vi.fn<DecisionApi["reviseJournalEntry"]>(async (_id, input) => {
      if (input.basis !== journalEntryBasis(stored)) throw new Error("这条记录在你打开之后又被更新过，已重新读取，请在最新内容上再改。");
      stored = reviseEntry(stored, input.draft, input.change, new Date());
      return stored;
    });
    render(<JournalEntryView api={{ listJournalEntries, reviseJournalEntry } as unknown as DecisionApi} refreshRevision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "修订" }));
    fireEvent.change(screen.getByLabelText("例外与边界"), { target: { value: "权限、付费与不可逆操作先确认。" } });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "收紧边界" } });

    // An agent restates it while the dialog is open.
    if (entry.kind !== "preference") throw new Error("expected a preference");
    stored = reviseEntry(stored, {
      kind: "preference", title: entry.title, content: "可逆的实现由系统判断；涉及付费先问。", knowledgeStatus: entry.knowledgeStatus,
      context: entry.context, rationale: entry.rationale, tags: [...entry.tags], appliesWhen: entry.appliesWhen,
      exceptions: entry.exceptions, strength: entry.strength, evidenceMaturity: entry.evidenceMaturity,
    }, { changeNote: "智能体重述", sourceKind: "agent_capture", sourceForm: "machine_summary" }, new Date());
    const restated = stored;
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));

    // Cleared by the list's reload a tenth of a second later, the reason vanished, and the dialog said nothing.
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("note", { name: "最新内容" })).toHaveTextContent("涉及付费先问"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("已重新读取");
    expect(within(dialog).getByLabelText("例外与边界")).toHaveValue("权限、付费与不可逆操作先确认。");

    // Checked against the copy opened, every later save was refused as well.
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(reviseJournalEntry.mock.calls[1]![1].basis).toBe(journalEntryBasis(restated));
    expect(stored).toMatchObject({ exceptions: "权限、付费与不可逆操作先确认。" });
  });

  it("rests a refused revision on the entry read by itself when the change took it out of the filtered list", async () => {
    const { journalEntryBasis } = await import("../src/shared/journal-basis.js");
    const opened = createJournalEntry(
      { kind: "idea", title: "冲突时触发复盘", content: "两条决策冲突时提醒复盘。", knowledgeStatus: "inbox" },
      { sourceKind: "app_manual", sourceForm: "user_original" },
      "idea-1",
      new Date("2026-09-01T10:00:00.000Z"),
    );
    let stored = opened;
    const listJournalEntries = vi.fn<DecisionApi["listJournalEntries"]>(async (query) =>
      [stored].filter((item) => query.knowledgeStatus === undefined || item.knowledgeStatus === query.knowledgeStatus));
    const reviseJournalEntry = vi.fn<DecisionApi["reviseJournalEntry"]>(async (_id, input) => {
      if (input.basis !== journalEntryBasis(stored)) throw new Error("这条记录在你打开之后又被更新过，已重新读取，请在最新内容上再改。");
      stored = reviseEntry(stored, input.draft, input.change, new Date());
      return stored;
    });
    render(<JournalEntryView api={{ listJournalEntries, reviseJournalEntry } as unknown as DecisionApi} refreshRevision={0} />);
    await screen.findByText(opened.title);
    // Working through 待澄清.
    fireEvent.change(screen.getByLabelText("记录状态筛选"), { target: { value: "inbox" } });
    await waitFor(() => expect(listJournalEntries).toHaveBeenLastCalledWith(expect.objectContaining({ knowledgeStatus: "inbox" })));
    fireEvent.click(await screen.findByRole("button", { name: "修订" }));
    fireEvent.change(screen.getByLabelText("修订内容"), { target: { value: "两条决策冲突时提醒复盘，并给出两条的来源。" } });
    fireEvent.change(screen.getByLabelText("变更原因"), { target: { value: "补充来源" } });

    // Clarified in Obsidian meanwhile, and so out of 待澄清.
    stored = reviseEntry(stored, {
      kind: "idea", title: opened.title, content: opened.content, knowledgeStatus: "active", context: null, rationale: null, tags: [],
      whyInteresting: "能减少重复劳动", nextTest: "在一个项目中试用", openQuestions: [], incubateUntil: null,
    } as never, { changeNote: "在 Obsidian 中澄清", sourceKind: "app_manual", sourceForm: "user_original" }, new Date());
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));

    // Looked for in the list as filtered alone, it was never found: no 最新内容, and every later save refused again.
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("note", { name: "最新内容" });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stored.content).toBe("两条决策冲突时提醒复盘，并给出两条的来源。");
  });

  it("keeps the list, and the revision history open in it, while it is read again", async () => {
    const revised = reviseEntry(entry, { ...entry, content: "普通可逆的方向与实现由系统自行判断。" } as never,
      { changeNote: "收窄说法", sourceKind: "app_manual", sourceForm: "user_original" }, new Date("2026-08-27T10:00:00.000Z"));
    let stored = revised;
    // An IPC round trip, as in the app: not answered within the same task.
    const listJournalEntries = vi.fn(() => new Promise<typeof revised[]>((resolve) => setTimeout(() => resolve([stored]), 20)));
    const view = render(<JournalEntryView api={{ listJournalEntries } as unknown as DecisionApi} refreshRevision={0} />);
    const history = (await screen.findByText("修订历史 · 1")).closest("details")!;
    fireEvent.click(screen.getByText("修订历史 · 1"));
    expect(history.open).toBe(true);
    // As every other time on the knowledge page reads: it said "2026/8/27 18:00:00".
    expect(history.querySelector("time")).toHaveTextContent(/^2026年8月2[678]日 \d{2}:\d{2}$/u);

    // Edited in Obsidian, and the page shown again: swapped for 正在读取记录… meanwhile, the list came back with the
    // history closed.
    stored = { ...revised, content: "普通可逆的方向与实现由系统自行判断，并交付结果。" };
    view.rerender(<JournalEntryView api={{ listJournalEntries } as unknown as DecisionApi} refreshRevision={1} />);
    await screen.findByText(stored.content);
    expect(screen.getByText("修订历史 · 1").closest("details")).toBe(history);
    expect(history.open).toBe(true);
  });

  it("lists, filters, and revises a journal entry with a change note", async () => {
    const listJournalEntries = vi.fn(async () => [entry]);
    const reviseJournalEntry = vi.fn(async () => ({ ...entry, revision: 2 }));
    render(
      <JournalEntryView
        api={{ listJournalEntries, reviseJournalEntry } as unknown as DecisionApi}
        refreshRevision={0}
      />,
    );

    expect(await screen.findByText(entry.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "修订" }));
    fireEvent.change(screen.getByLabelText("修订内容"), {
      target: { value: "普通可逆的实现由系统自行完成，并给出验证结果。" },
    });
    fireEvent.change(screen.getByLabelText("变更原因"), {
      target: { value: "明确需要验证结果" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修订" }));

    await waitFor(() => expect(reviseJournalEntry).toHaveBeenCalledOnce());
    expect(reviseJournalEntry).toHaveBeenCalledWith(
      "preference-1",
      expect.objectContaining({
        draft: expect.objectContaining({
          kind: "preference",
          content: "普通可逆的实现由系统自行完成，并给出验证结果。",
        }),
        change: expect.objectContaining({ changeNote: "明确需要验证结果" }),
      }),
    );
  });

  it("keeps a revision being written open against a stray Escape or click outside; 取消 still closes it", async () => {
    const listJournalEntries = vi.fn(async () => [entry]);
    render(<JournalEntryView api={{ listJournalEntries } as unknown as DecisionApi} refreshRevision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "修订" }));
    // Untouched, it closes as any dialog does.
    fireEvent.keyDown(screen.getByRole("dialog", { name: "修订记录" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "修订记录" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "修订" }));
    const dialog = screen.getByRole("dialog", { name: "修订记录" });
    fireEvent.change(within(dialog).getByLabelText("变更原因"), { target: { value: "补全适用条件" } });
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(dialog.closest(".modal-backdrop")!);
    // Either took everything written in it.
    expect(within(dialog).getByLabelText("变更原因")).toHaveValue("补全适用条件");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "修订记录" })).toBeNull();
  });

  it("says the list stops at 200, rather than leaving older entries to look gone", async () => {
    const many = Array.from({ length: 200 }, (_, n) => createJournalEntry({ kind: "idea", title: `想法 ${n}`, content: `第 ${n} 个观察。` },
      { sourceKind: "app_manual", sourceForm: "user_original" }, `idea-${n}`, new Date(Date.UTC(2026, 8, 1, n))));
    render(<JournalEntryView api={{ listJournalEntries: vi.fn(async () => many) } as unknown as DecisionApi} refreshRevision={0} />);
    expect(await screen.findByText("只显示最近更新的 200 条；更早的记录请用关键词或筛选查找。")).toBeVisible();
  });

  it("gives focus to the entry's 修订 once 归档 has taken its own button away, or to the entry in its place", async () => {
    const other = createJournalEntry(
      { kind: "idea", title: "把复盘提醒放进菜单栏", content: "到期复盘在菜单栏里给一个数字。", whyInteresting: "少开一次窗口。" },
      { sourceKind: "app_manual", sourceForm: "user_original" },
      "idea-1",
      new Date("2026-08-25T10:00:00.000Z"),
    );
    let stored = [entry, other];
    const api = {
      listJournalEntries: vi.fn<DecisionApi["listJournalEntries"]>(async (query) =>
        stored.filter((item) => query.knowledgeStatus === undefined || item.knowledgeStatus === query.knowledgeStatus)),
      reviseJournalEntry: vi.fn<DecisionApi["reviseJournalEntry"]>(async (id, input) => {
        const revised = reviseEntry(stored.find((item) => item.id === id)!, input.draft, input.change, new Date("2026-08-27T10:00:00.000Z"));
        stored = stored.map((item) => (item.id === id ? revised : item));
        return revised;
      }),
    } as unknown as DecisionApi;
    render(<JournalEntryView api={api} refreshRevision={0} />);
    await screen.findByText(other.title);
    const card = (id: string) => within(document.getElementById(`journal-entry-${id}`)!);

    // Taken away with what it did, 归档 left focus at the top of the window.
    const archive = card(entry.id).getByRole("button", { name: "归档" });
    archive.focus();
    fireEvent.click(archive);
    await waitFor(() => expect(card(entry.id).getByRole("button", { name: "修订" })).toHaveFocus());

    // Under a status filter that leaves archived entries out, the read after it takes the entry away too.
    fireEvent.change(screen.getByRole("combobox", { name: "记录状态筛选" }), { target: { value: other.knowledgeStatus } });
    await waitFor(() => expect(document.getElementById(`journal-entry-${entry.id}`)).toBeNull());
    const next = card(other.id).getByRole("button", { name: "归档" });
    next.focus();
    fireEvent.click(next);
    await waitFor(() => expect(document.getElementById(`journal-entry-${other.id}`)).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("lets go of the refocus as soon as 归档 is refused, before the re-read it asks for lands", async () => {
    const api = {
      listJournalEntries: vi.fn<DecisionApi["listJournalEntries"]>(async () => [entry]),
      reviseJournalEntry: vi.fn<DecisionApi["reviseJournalEntry"]>(async () => {
        throw new Error("这条记录已在别处修改");
      }),
    } as unknown as DecisionApi;
    render(<JournalEntryView api={api} refreshRevision={0} />);
    await screen.findByText(entry.title);
    const archive = within(document.getElementById(`journal-entry-${entry.id}`)!).getByRole("button", { name: "归档" });
    archive.focus();
    fireEvent.click(archive);
    await screen.findByText(/这条记录已在别处修改/u);
    // The reader clicks the page's empty space at once; the re-read the refusal asked for lands after.
    (document.activeElement as HTMLElement | null)?.blur();
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // Left for that read to find not archived, it pulled focus to the entry's 修订 with nothing pressed.
    expect(document.activeElement).toBe(document.body);
  });

  it("lets go of the refocus once spent: a refused 归档 does not pull focus back at a later re-read", async () => {
    const other = createJournalEntry(
      { kind: "idea", title: "把复盘提醒放进菜单栏", content: "到期复盘在菜单栏里给一个数字。", whyInteresting: "少开一次窗口。" },
      { sourceKind: "app_manual", sourceForm: "user_original" },
      "idea-1",
      new Date("2026-08-25T10:00:00.000Z"),
    );
    const api = {
      listJournalEntries: vi.fn<DecisionApi["listJournalEntries"]>(async () => [entry, other]),
      // Refused: changed in Obsidian meanwhile.
      reviseJournalEntry: vi.fn<DecisionApi["reviseJournalEntry"]>(async () => {
        throw new Error("这条记录已在别处修改");
      }),
    } as unknown as DecisionApi;
    const { rerender } = render(<JournalEntryView api={api} refreshRevision={0} />);
    await screen.findByText(other.title);
    const card = (id: string) => within(document.getElementById(`journal-entry-${id}`)!);
    const archive = card(entry.id).getByRole("button", { name: "归档" });
    archive.focus();
    fireEvent.click(archive);
    await screen.findByText(/这条记录已在别处修改/u);
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalledTimes(2));
    // That read in place first: asked for is not yet shown, and under load the reader moved on before it was.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // The reader moves on (a click on the page's empty space), then the vault's watcher has the list read again.
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(<JournalEntryView api={api} refreshRevision={1} />);
    await waitFor(() => expect(api.listJournalEntries).toHaveBeenCalledTimes(3));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Kept, it pulled focus to that entry's 修订, the list scrolled to it, with nothing pressed.
    expect(document.activeElement).toBe(document.body);
  });

  it("marks each field the 有效 status still asks for, pointing at why", async () => {
    const unfinished = createJournalEntry(
      { kind: "preference", title: "接口错误统一用结构化返回", content: "错误一律返回 code 与 message。", appliesWhen: "对外接口。" },
      { sourceKind: "app_manual", sourceForm: "user_original" },
      "preference-2",
      new Date("2026-08-26T10:00:00.000Z"),
    );
    render(<JournalEntryView api={{ listJournalEntries: vi.fn(async () => [unfinished]) } as unknown as DecisionApi} refreshRevision={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "修订" }));
    const dialog = within(screen.getByRole("dialog", { name: "修订记录" }));
    fireEvent.change(dialog.getByRole("combobox", { name: "记录状态" }), { target: { value: "active" } });

    // Said once in passing, the reason was tied to no field.
    const missing = dialog.getByRole("textbox", { name: "例外与边界" });
    expect(missing).toHaveAttribute("aria-invalid", "true");
    expect(missing).toHaveAccessibleDescription("设为有效前，请填写适用条件和例外与边界。");
    expect(dialog.getByRole("textbox", { name: "适用条件" })).not.toHaveAttribute("aria-invalid");
  });

  it("focuses its search field on /, as the knowledge page's shortcut says", async () => {
    render(<JournalEntryView api={{ listJournalEntries: vi.fn(async () => [entry]) } as unknown as DecisionApi} refreshRevision={0} />);
    await screen.findByText(entry.title);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByRole("searchbox", { name: "搜索偏好与想法" })).toHaveFocus();
  });
});
