// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { TODO_VERSION, type TodoListView, type TodoRecordResult } from "@cognelis/decision-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodoQuickAddDialog } from "../src/renderer/components/pages/todos/TodoQuickAddDialog.js";

const list = (id: string, title: string): TodoListView => ({
  id, title, summary: null, project: null, tags: [], sourceKind: "app_manual", sourceClient: null, longTerm: true, archived: false,
  createdAt: "2026-11-09T09:00:00.000Z", updatedAt: "2026-11-09T09:00:00.000Z", revision: 1, relativePath: `${id}.md`,
  items: [], history: [], counts: { open: 0, inProgress: 0, done: 0, dropped: 0 },
});

const result = (status: TodoRecordResult["status"], id = "daily"): TodoRecordResult => ({
  todoVersion: TODO_VERSION, status, added: [], skipped: [], list: { id, title: "日常", project: null, longTerm: true, revision: 2, updatedAt: "2026-11-09T09:00:00.000Z", relativePath: "x.md", counts: { open: 1, inProgress: 0, done: 0, dropped: 0 } },
});

const setup = (props: { currentListId?: string | null; initialText?: string; status?: TodoRecordResult["status"] } = {}) => {
  const recordTodoList = vi.fn(async () => result(props.status ?? "appended"));
  const api = {
    listTodoLists: vi.fn(async () => ({ todoVersion: TODO_VERSION, lists: [list("daily", "日常"), list("work", "Work")], total: 2, nextOffset: null, unreadable: [] })),
    recordTodoList,
    updateTodoList: vi.fn(async () => ({ todoVersion: TODO_VERSION, status: "saved" as const, list: null })),
  };
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(<TodoQuickAddDialog api={api} currentListId={props.currentListId ?? null} initialText={props.initialText ?? ""} onAdded={onAdded} onClose={onClose} />);
  return { recordTodoList, onAdded, onClose, api };
};

const field = (): HTMLInputElement => screen.getByRole("textbox", { name: "事项" });
const loaded = () => waitFor(() => expect(screen.getByRole("option", { name: "日常" })).toBeInTheDocument());

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("quick add dialog", () => {
  it("shows what it understood, saves on the list named, and remembers it", async () => {
    const { recordTodoList, onAdded, onClose } = setup({ currentListId: "work" });
    await loaded();
    await userEvent.type(field(), "2099-01-05 !高 写周报 #日常");
    expect(screen.getByText(/将保存为：/u)).toHaveTextContent("写周报 · 截止 2099年1月5日 周一 · 优先级 P1 · 清单 日常");
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(recordTodoList).toHaveBeenCalledWith({ listId: "daily", items: [{ title: "写周报", priority: "p1", due: "2099-01-05" }] }));
    expect(onAdded).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem("paraself.todos.quick-add-list")).toBe("daily");
  });

  it("reads @list, #tags and !p0, and says in the chip when a list was named the old way", async () => {
    const { recordTodoList } = setup({ currentListId: "work", initialText: "复盘本周的审阅 明天 !p0 @日常 #本周 #文档" });
    await loaded();
    const chips = within(screen.getByRole("list", { name: "识别结果" }));
    expect(chips.getAllByRole("listitem").map((item) => item.textContent)).toEqual([expect.stringContaining("截止"), "优先级P0", "清单日常", "标签#本周", "标签#文档"]);
    expect(screen.getByText(/将保存为：/u)).toHaveTextContent("复盘本周的审阅 · 截止");
    expect(screen.getByLabelText("清单")).toHaveValue("daily");
    await userEvent.click(chips.getByRole("button", { name: "取消识别「#文档」" }));
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(recordTodoList).toHaveBeenCalledWith({ listId: "daily", items: [{ title: "复盘本周的审阅 #文档", priority: "p0", due: expect.any(String), tags: ["本周"] }] }));
  });

  it("still reads #日常 as the list when it is exactly a list's name, and says so", async () => {
    setup({ currentListId: "work", initialText: "a #日常" });
    await loaded();
    expect(within(screen.getByRole("list", { name: "识别结果" })).getByRole("button")).toHaveTextContent("清单日常（按旧写法 #日常）");
    expect(screen.queryByText(/没有名为/u)).toBeNull();
  });

  it("takes a tag off and gives its word back to the title", async () => {
    setup({ currentListId: "work", initialText: "明天 开会" });
    await loaded();
    expect(screen.getByText(/将保存为：/u)).toHaveTextContent("开会 · 截止");
    await userEvent.click(screen.getByRole("button", { name: "取消识别「明天」" }));
    expect(screen.getByText(/将保存为：/u)).toHaveTextContent("明天 开会 · 清单 Work");
  });

  it("chooses the list by @name, then the open page's, then the last used", async () => {
    setup({ currentListId: "work", initialText: "a @日常" });
    await loaded();
    expect(screen.getByLabelText("清单")).toHaveValue("daily");
    cleanup();
    setup({ currentListId: "work", initialText: "a" });
    await loaded();
    expect(screen.getByLabelText("清单")).toHaveValue("work");
    cleanup();
    localStorage.setItem("paraself.todos.quick-add-list", "daily");
    setup({ initialText: "a" });
    await loaded();
    expect(screen.getByLabelText("清单")).toHaveValue("daily");
    cleanup();
    localStorage.clear();
    setup({ initialText: "a" });
    await loaded();
    expect(screen.getByLabelText("清单")).toHaveValue("");
    expect(screen.getByRole("button", { name: "添加" })).toBeDisabled();
  });

  it("does not make up a list for an @name nothing matches: it asks, and creates only when told", async () => {
    const { recordTodoList } = setup({ currentListId: "work", initialText: "买菜 @家务" });
    await loaded();
    expect(screen.getByText(/没有名为「家务」的清单/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加" })).toBeDisabled();
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(recordTodoList).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "新建清单「家务」" }));
    await waitFor(() => expect(recordTodoList).toHaveBeenCalledWith({ title: "家务", longTerm: true, items: [{ title: "买菜" }] }));
  });

  it("keeps the dialog open and says why when nothing was added", async () => {
    const { onClose } = setup({ currentListId: "work", initialText: "a", status: "duplicate" });
    await loaded();
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("已经有同名的事项");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("finds an archived list by its #name, says it will be taken out of the archive, and does that before adding", async () => {
    const { recordTodoList, api } = setup({ initialText: "买菜 #旧清单" });
    api.listTodoLists.mockResolvedValue({
      todoVersion: TODO_VERSION,
      lists: [{ ...list("old", "旧清单"), archived: true }, list("daily", "日常")],
      total: 2, nextOffset: null, unreadable: [],
    });
    cleanup();
    const onAdded = vi.fn();
    render(<TodoQuickAddDialog api={api} currentListId={null} initialText="买菜 #旧清单" onAdded={onAdded} onClose={vi.fn()} />);
    expect(await screen.findByText("这份清单已归档，添加后会取消归档。")).toBeVisible();
    expect(screen.queryByText(/没有名为/u)).toBeNull();
    expect(api.listTodoLists).toHaveBeenLastCalledWith({ includeClosed: true, limit: 200 });
    await userEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(recordTodoList).toHaveBeenCalledWith({ listId: "old", items: [{ title: "买菜" }] }));
    expect(api.updateTodoList).toHaveBeenCalledWith({ listId: "old", archived: false });
    expect(api.updateTodoList.mock.invocationCallOrder[0]!).toBeLessThan(recordTodoList.mock.invocationCallOrder[0]!);
  });
});
