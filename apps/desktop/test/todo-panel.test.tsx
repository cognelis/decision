// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { BUILT_IN_CLIENTS, clientSummary } from "@cognelis/decision-integrations";
import { TODO_VERSION, type TodoListQuery, type TodoListView } from "@cognelis/decision-protocol";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rememberClients } from "../src/renderer/client-labels.js";
import { addDays, localDay } from "../src/renderer/components/pages/todos/todo-dates.js";
import { TodoPanel, type TodoApi } from "../src/renderer/components/pages/todos/TodoPanel.js";
import { createTodoPreview } from "../src/renderer/preview-todos.js";

/**
 * The 待办 page against the preview's lists, held in memory and changed the way the App changes them: an agent's write
 * is a call on the same store, and its revision moving is what tells the page to read again.
 */

const RESEARCH = "preview-todo-research";
const LEARNING = "preview-todo-learning";

const setup = (overrides: Partial<TodoApi> = {}) => {
  const store = createTodoPreview();
  const api: TodoApi = { ...store, openVaultDocument: vi.fn(async () => undefined), ...overrides };
  const view = render(<TodoPanel api={api} todoRevision={0} />);
  return { store, api, view };
};

const listRow = (title: string) => screen.findByRole("button", { name: title });

/** The page opened on a list (it opens on 今天): the research list unless another is named. */
const setupInList = async (overrides: Partial<TodoApi> = {}, title = "Paraself 遗留问题调研") => {
  const rendered = setup(overrides);
  fireEvent.click(await listRow(title));
  await screen.findByRole("heading", { level: 2, name: title });
  return rendered;
};

/** 长期清单 in the header's 更多 menu: opened, and the item found. Closes the menu again with Escape. */
const longTermItem = async (): Promise<HTMLElement> => {
  const more = screen.getByRole("button", { name: "更多" });
  if (more.getAttribute("aria-expanded") !== "true") fireEvent.click(more);
  return screen.findByRole("menuitemcheckbox", { name: "长期清单" });
};

/** An item's row (its <li>), found by its number and title. */
const itemRow = async (number: number, title: string): Promise<HTMLElement> =>
  (await screen.findByRole("button", { name: new RegExp(`第 ${number} 项：${title}`, "u") })).closest("li")!;

/** An item's status changed from the menu its status label opens (no note asked). */
const setStatus = async (row: HTMLElement, number: number, label: string): Promise<void> => {
  fireEvent.click(within(row).getByRole("button", { name: new RegExp(`^第 ${number} 项状态：`, "u") }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: label }));
};

/** An item opened: its drawer, with the row it opened from. */
const openItem = async (number: number, title: string): Promise<{ row: HTMLElement; drawer: HTMLElement }> => {
  const row = await itemRow(number, title);
  fireEvent.click(within(row).getByRole("button", { name: new RegExp(`第 ${number} 项：`, "u") }));
  const drawer = await screen.findByRole("complementary", { name: `第 ${number} 项详情` });
  return { row, drawer };
};

const detailHeader = (title: string): HTMLElement => screen.getByRole("heading", { level: 2, name: title }).closest("header")!;

const statusOf = (row: HTMLElement): string | null | undefined => row.querySelector(".todo-status-button")?.textContent;

/** The numbers of the items a list of them shows, in its order. */
const numbersIn = (list: HTMLElement): string[] => [...list.querySelectorAll(".todo-item-number")].map((number) => (number.textContent ?? "").replace("#", ""));

beforeEach(() => {
  rememberClients(BUILT_IN_CLIENTS.map(clientSummary));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("todo page", () => {
  it("keeps the full waiting count in the list tooltip and accessible description without a badge", async () => {
    const store = createTodoPreview();
    setup({ listTodoLists: async query => {
      const result = await store.listTodoLists(query);
      const list = result.lists.find(entry => entry.id === RESEARCH);
      if (list !== undefined) list.items[1]!.dependents = Array.from({ length: 100 }, (_, index) => ({ id: null, listId: "other", listTitle: "后续清单", item: index + 1, title: `后续 ${index + 1}`, status: "open", issue: null }));
      return result;
    } });
    const row = await listRow("Paraself 遗留问题调研");
    expect(row).toHaveAttribute("data-waiting", "100");
    expect(row).toHaveAttribute("title", expect.stringContaining("后续 100 项等待"));
    expect(row.querySelector(".todo-list-wait-mark,.todo-list-wait-slot")).toBeNull();
    expect(row.querySelector(".todo-list-title")?.firstElementChild?.tagName).toBe("STRONG");
    expect(row).toHaveAccessibleDescription(/后续 100 项等待/u);
  });

  it("announces waiting dependents and refreshes the marker after a cross-list status change", async () => {
    const { store, api, view } = setup();
    const row = await listRow("Paraself 遗留问题调研");
    expect(row).not.toHaveAttribute("data-waiting");
    expect(row.querySelector(".todo-list-wait-slot")).toBeNull();
    await act(async () => {
      await store.changeTodoItem({ listId: LEARNING, item: 1, expectedStatus: "open", addDependencies: [{ listId: RESEARCH, item: 2 }, { listId: RESEARCH, item: 3 }] });
    });
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    await waitFor(() => expect(row).toHaveAccessibleDescription(/后续 1 项等待.*2 项未完成前置/u));
    expect(row).toHaveAttribute("title", expect.stringContaining("1 个后续事项来自其他清单"));
    expect(row).toHaveAttribute("data-waiting", "1");
    await act(async () => { await store.changeTodoItem({ listId: LEARNING, item: 1, expectedStatus: "open", status: "done" }); });
    view.rerender(<TodoPanel api={api} todoRevision={2} />);
    await waitFor(() => expect(row).not.toHaveAttribute("data-waiting"));
    expect(row).toHaveAttribute("title", "Paraself 遗留问题调研");
    expect(row.querySelector(".todo-list-wait-slot")).toBeNull();
    expect(row).not.toHaveAccessibleDescription(/后续/u);
  });

  it("opens on 今天, shows the unfinished lists with their progress, and opens one", async () => {
    setup();

    const research = await listRow("Paraself 遗留问题调研");
    expect(research).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: /^今天/u })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 2, name: "今天" })).toBeVisible();
    fireEvent.click(research);
    expect(research).toHaveAttribute("aria-current", "true");
    // Done 2 and dropped 1 of 6; one under way.
    expect(research).toHaveTextContent("3/6");
    expect(research).toHaveTextContent("处理中 1");
    expect(research).toHaveAccessibleDescription(/paraself.*Codex/u);
    expect(await listRow("官网首页加载性能调研")).toHaveTextContent("0/3");
    // Every item done: not among the unfinished.
    expect(screen.queryByRole("button", { name: "1.3.0 发布前检查" })).toBeNull();
    // Long-term lists among the rest, by their latest change: 日常 was made after 学习 was last ticked.
    expect(within(screen.getByRole("list", { name: "清单" })).getAllByRole("button").map((row) => row.getAttribute("aria-label"))).toEqual([
      "Paraself 遗留问题调研",
      "官网首页加载性能调研",
      "日常",
      "学习",
    ]);

    expect(screen.getByRole("heading", { level: 2, name: "Paraself 遗留问题调研" })).toBeVisible();
    expect(screen.getByText(/按影响从大到小排列/u)).toBeVisible();
    expect(screen.getByText("已处理 3/6")).toBeVisible();
    // Open and under way across every list: 3 here, 3 on the site's, 2 in 学习.
    expect(screen.getByText("项未完成").closest(".desktop-view-meta")).toHaveTextContent("8项未完成");
    expect(await itemRow(2, "Windows 上 bridge 路径含空格时接入失败")).toHaveAttribute("data-status", "in_progress");
    // What is handled is folded away below, closed.
    expect(numbersIn(screen.getByRole("list", { name: "处理中" }))).toEqual(["2"]);
    expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["3", "6"]);
    fireEvent.click(screen.getByRole("button", { name: "已处理 3 项" }));
    expect(statusOf(await itemRow(4, "设置页「重建索引」没有进度"))).toBe("已放弃");
    // Ticked in Obsidian, not yet in the history.
    const ticked = await itemRow(5, "README 的数据目录表缺少 todos");
    expect(within(ticked).getByText("Obsidian 里改过")).toBeVisible();
  });

  it("lists the finished ones too under 全部", async () => {
    await setupInList();
    await listRow("Paraself 遗留问题调研");

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    const finished = await listRow("1.3.0 发布前检查");
    expect(finished).toHaveTextContent("2/2");
    expect(finished).toHaveTextContent("已处理完");
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "未完成" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "1.3.0 发布前检查" })).toBeNull());
  });

  it("marks the long-term lists, and says so of a list with nothing in it yet", async () => {
    await setupInList();
    await listRow("Paraself 遗留问题调研");

    const learning = await listRow("学习");
    expect(within(learning).getByText("长期")).toBeVisible();
    expect(learning).toHaveAccessibleDescription(/^长期清单 /u);
    expect(learning).toHaveTextContent("1/3");
    const daily = await listRow("日常");
    expect(within(daily).getByText("长期")).toBeVisible();
    expect(daily).toHaveTextContent("还没有事项");
    expect(daily).not.toHaveTextContent("0/0");
    expect(daily.querySelector(".todo-progress-bar")).toBeNull();
    expect(daily).toHaveAccessibleDescription(/还没有事项/u);
    expect(screen.getByRole("button", { name: "Paraself 遗留问题调研" })).not.toHaveTextContent("长期");

    // Under 全部 too, a long-term list is never filed away as 已处理完.
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(await listRow("1.3.0 发布前检查")).toHaveTextContent("已处理完");
    for (const row of [await listRow("学习"), await listRow("日常")]) {
      expect(row).not.toHaveTextContent("已处理完");
      expect(row).not.toHaveAttribute("data-closed");
    }
  });

  it("leaves focus in the lists pane when the arrow keys reach an empty list", async () => {
    await setupInList();
    const research = await listRow("Paraself 遗留问题调研");

    research.focus();
    fireEvent.keyDown(research, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("button", { name: "官网首页加载性能调研" }), { key: "ArrowDown" });
    expect(await screen.findByRole("heading", { level: 2, name: "日常" })).toBeVisible();
    expect(screen.getByText("还没有事项，在下面添加第一项。")).toBeVisible();
    const daily = screen.getByRole("button", { name: "日常" });
    expect(daily).toHaveFocus();
    fireEvent.keyDown(daily, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "学习" })).toHaveFocus();
  });

  it("opens a list chosen in the sidebar, by a click or the arrow keys", async () => {
    await setupInList();
    const research = await listRow("Paraself 遗留问题调研");

    fireEvent.click(await listRow("官网首页加载性能调研"));
    expect(await screen.findByRole("heading", { level: 2, name: "官网首页加载性能调研" })).toBeVisible();
    expect(await itemRow(1, "首屏大图改用 AVIF 并加尺寸")).toBeVisible();
    expect(screen.getByRole("button", { name: "官网首页加载性能调研" })).toHaveAttribute("aria-current", "true");

    research.focus();
    fireEvent.keyDown(research, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "官网首页加载性能调研" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "官网首页加载性能调研" }), { key: "ArrowUp" });
    expect(research).toHaveFocus();
    expect(await screen.findByRole("heading", { level: 2, name: "Paraself 遗留问题调研" })).toBeVisible();
    // Up from the first list: back to the search field.
    fireEvent.keyDown(research, { key: "ArrowUp" });
    expect(screen.getByRole("searchbox", { name: "搜索待办清单" })).toHaveFocus();
  });

  it("finds lists by what their items say, and / goes to the search", async () => {
    const user = userEvent.setup();
    await setupInList();
    await listRow("Paraself 遗留问题调研");

    await user.keyboard("/");
    const search = screen.getByRole("searchbox", { name: "搜索待办清单" });
    expect(search).toHaveFocus();
    await user.type(search, "AVIF");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Paraself 遗留问题调研" })).toBeNull());
    expect(await screen.findByRole("heading", { level: 2, name: "官网首页加载性能调研" })).toBeVisible();
    // The header keeps counting every list, not those the search found.
    expect(screen.getByText("项未完成").closest(".desktop-view-meta")).toHaveTextContent("8项未完成");

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(await listRow("Paraself 遗留问题调研")).toBeVisible();
  });

  it("finishes an item from its drawer with a line of progress, and shows the status and the timeline after", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const { row, drawer } = await openItem(3, "托盘提示没有区分复盘");

    // Finishing needs words, as it does for an agent.
    const finish = within(drawer).getByRole("button", { name: "标为完成" });
    expect(finish).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: "放弃" })).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: "只记进展" })).toBeDisabled();
    await user.type(within(drawer).getByRole("textbox", { name: "写一句进展" }), "托盘提示已区分复盘与待确认，补了单测。");
    await user.click(finish);

    await waitFor(() => expect(statusOf(row)).toBe("已完成"));
    expect(within(drawer).getByRole("textbox", { name: "写一句进展" })).toHaveValue("");
    // Kept as history: from 待处理 to 已完成, by the reader, with the note.
    const timeline = within(drawer).getByRole("list");
    expect(within(timeline).getByText("从「待处理」改为「已完成」")).toBeInTheDocument();
    expect(within(timeline).getByText("托盘提示已区分复盘与待确认，补了单测。")).toBeVisible();
    expect(within(row).getByRole("button", { name: "第 3 项状态：已完成" })).toBeVisible();
    await waitFor(() => expect(screen.getByText("项未完成").closest(".desktop-view-meta")).toHaveTextContent("7项未完成"));
    expect(screen.getByText("已处理 4/6")).toBeVisible();

    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.items.find((candidate) => candidate.number === 3)).toMatchObject({ status: "done", note: "托盘提示已区分复盘与待确认，补了单测。", changedBy: { kind: "user" } });
  });

  it("drops an item with the reason, and a finished one only takes a note", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const { row, drawer } = await openItem(6, "日志页的用途筛选在最小窗口下换行错位");
    await user.type(within(drawer).getByRole("textbox", { name: "写一句进展" }), "等日志页改版一起做。");
    await user.click(within(drawer).getByRole("button", { name: "放弃" }));
    await waitFor(() => expect(statusOf(row)).toBe("已放弃"));
    expect(within(drawer).queryByRole("button", { name: "标为完成" })).toBeNull();
    expect(within(drawer).getByRole("button", { name: "重新打开" })).toBeVisible();

    await user.type(within(drawer).getByRole("textbox", { name: "写一句进展" }), "改版排期在下个月。");
    await user.click(within(drawer).getByRole("button", { name: "只记进展" }));
    await waitFor(() => expect(within(drawer).getByText("改版排期在下个月。")).toBeVisible());
    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.items.find((item) => item.number === 6)).toMatchObject({ status: "dropped", note: "改版排期在下个月。" });
  });

  it("finishes an item from its status menu at once, and opens a finished one again", async () => {
    const { store } = await setupInList();
    const third = await itemRow(3, "托盘提示没有区分复盘");
    await setStatus(third, 3, "已完成");
    await waitFor(() => expect(statusOf(third)).toBe("已完成"));

    fireEvent.click(screen.getByRole("button", { name: "已处理 3 项" }));
    const first = await itemRow(1, "本地审阅取消后残留私有副本目录");
    await setStatus(first, 1, "待处理");
    // Opened again, it goes back among the unfinished (a new row).
    expect(await screen.findByRole("button", { name: "第 1 项状态：待处理" })).toBeVisible();
    expect((await itemRow(1, "本地审阅取消后残留私有副本目录")).getAttribute("data-status")).toBe("open");

    // From the opened item too: a dropped one back to 待处理.
    const { drawer } = await openItem(4, "设置页「重建索引」没有进度");
    fireEvent.click(within(drawer).getByRole("button", { name: "重新打开" }));
    await waitFor(() => expect(within(drawer).getByText("待处理", { selector: ".todo-drawer-status" })).toBeVisible());

    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.items.map((item) => item.status)).toEqual(["open", "in_progress", "done", "open", "done", "open"]);
  });

  it("writes nothing when the item moved on since the page showed it, and says so", async () => {
    const { store } = await setupInList();
    const { drawer } = await openItem(3, "托盘提示没有区分复盘");

    // An agent starts on it meanwhile; the page has not read the lists again.
    await store.changeTodoItem({ listId: RESEARCH, item: 3, status: "in_progress", expectedStatus: "open" });
    fireEvent.click(within(drawer).getByRole("button", { name: "开始处理" }));

    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent("第 3 项在你看到之后被改过，现在是「处理中」，这次的修改没有保存。");
    await waitFor(() => expect(within(drawer).getByText("处理中", { selector: ".todo-drawer-status" })).toBeVisible());
    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.history.filter((event) => event.item === 3)).toHaveLength(1);
  });

  it("keeps a line being written when the item moved on, and saves it on the status read again", async () => {
    const user = userEvent.setup();
    const { store, api, view } = await setupInList();
    const { row, drawer } = await openItem(3, "托盘提示没有区分复盘");
    await user.type(within(drawer).getByRole("textbox", { name: "写一句进展" }), "已在托盘里分开显示。");

    // An agent drops it meanwhile, and the page reads the lists again: the new status is on screen, the field stays.
    await store.changeTodoItem({ listId: RESEARCH, item: 3, status: "dropped", note: "和托盘改版重复。", expectedStatus: "open" });
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    await waitFor(() => expect(statusOf(row)).toBe("已放弃"));
    expect(within(drawer).getByRole("textbox", { name: "写一句进展" })).toHaveValue("已在托盘里分开显示。");

    // Written on what the field was opened on: refused and said, not saved over the agent's.
    await user.click(within(drawer).getByRole("button", { name: "只记进展" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("现在是「已放弃」");
    expect(within(drawer).getByRole("textbox", { name: "写一句进展" })).toHaveValue("已在托盘里分开显示。");
    const [unchanged] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(unchanged!.items.find((item) => item.number === 3)?.note).toBe("和托盘改版重复。");

    // Told, the reader writes it again: made on the status now shown.
    await user.click(within(drawer).getByRole("button", { name: "只记进展" }));
    await waitFor(() => expect(within(drawer).getByRole("textbox", { name: "写一句进展" })).toHaveValue(""));
    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.history.at(-1)).toMatchObject({ item: 3, previous: "dropped", status: "dropped", note: "已在托盘里分开显示。" });
  });

  it("adds a line of progress alone, which needs words", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const { row, drawer } = await openItem(2, "Windows 上 bridge 路径含空格时接入失败");

    const save = within(drawer).getByRole("button", { name: "只记进展" });
    expect(save).toBeDisabled();
    await user.type(within(drawer).getByRole("textbox", { name: "写一句进展" }), "引号已补上，还差 Windows 上实测。");
    await user.click(save);

    await waitFor(() => expect(within(drawer).getByText("引号已补上，还差 Windows 上实测。", { selector: ".todo-history-note" })).toBeVisible());
    expect(within(drawer).getByText("处理中", { selector: ".todo-drawer-status" })).toBeVisible();
    expect(row).toHaveAttribute("data-status", "in_progress");
    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.history.at(-1)).toMatchObject({ item: 2, previous: "in_progress", status: "in_progress", note: "引号已补上，还差 Windows 上实测。" });
  });

  it("closes the drawer with Escape, back on its row, and keeps the line half written", async () => {
    const user = userEvent.setup();
    await setupInList();
    const { row, drawer } = await openItem(3, "托盘提示没有区分复盘");
    await user.type(within(drawer).getByRole("textbox", { name: "写一句进展" }), "写了一半");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("complementary", { name: "第 3 项详情" })).toBeNull());
    await waitFor(() => expect(within(row).getByRole("button", { name: /第 3 项：/u })).toHaveFocus());
    fireEvent.click(within(row).getByRole("button", { name: /第 3 项：/u }));
    expect(within(await screen.findByRole("complementary", { name: "第 3 项详情" })).getByRole("textbox", { name: "写一句进展" })).toHaveValue("写了一半");
    // Another click on the same row puts it away too.
    fireEvent.click(within(row).getByRole("button", { name: /第 3 项：/u }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "第 3 项详情" })).toBeNull());
  });

  it("changes an item's priority and due date from the drawer without a note, and records both", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const { row, drawer } = await openItem(3, "托盘提示没有区分复盘");

    await user.selectOptions(within(drawer).getByRole("combobox", { name: "优先级" }), "p1");
    await waitFor(() => expect(within(row).getByText("P1")).toBeVisible());
    fireEvent.change(within(drawer).getByLabelText("截止日期"), { target: { value: "2030-01-05" } });
    await waitFor(() => expect(within(row).getByText("2030年1月5日")).toBeVisible());

    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.items.find((item) => item.number === 3)).toMatchObject({ priority: "p1", due: "2030-01-05" });
    expect(within(drawer).getByText("优先级从「P2」改为「P1」")).toBeVisible();
    expect(within(drawer).getByText(/截止日期从 .* 改为 2030年1月5日/u)).toBeVisible();

    await user.click(within(drawer).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(within(row).queryByText("2030年1月5日")).toBeNull());
    expect(within(drawer).getByText(/清除了截止日期/u)).toBeVisible();
  });

  it("adds an item to the list, and says when the list already has it", async () => {
    const user = userEvent.setup();
    await setupInList();
    const field = await screen.findByRole("textbox", { name: "添加事项" });

    await user.type(field, "托盘图标在深色菜单栏下看不清{Enter}");
    expect(await itemRow(7, "托盘图标在深色菜单栏下看不清")).toBeVisible();
    expect(screen.getByText("已添加为第 7 项。", { selector: ".todo-message" })).toBeVisible();
    expect(field).toHaveValue("");

    await user.type(field, "托盘提示没有区分复盘{Enter}");
    expect(await screen.findByText("这份清单里已经有「托盘提示没有区分复盘」（第 3 项），没有重复添加。")).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("button", { name: /第 8 项/u })).toBeNull();
  });

  it("creates a list in the dialog, one item a line, and opens it", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await listRow("Paraself 遗留问题调研");

    await user.click(screen.getByRole("button", { name: "新建清单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建清单" });
    const create = within(dialog).getByRole("button", { name: "创建清单" });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText("标题"), "周会待跟进");
    await user.type(within(dialog).getByLabelText("项目（可选）"), "paraself");
    await user.type(within(dialog).getByLabelText("事项（可选）"), "确认发布日期{Enter}{Enter}  整理用户反馈  {Enter}");
    expect(within(dialog).getByText(/已写 2 项/u)).toBeVisible();
    // Written out whole: worked through and put away, unless the reader says otherwise.
    expect(within(dialog).getByRole("checkbox", { name: "长期清单" })).not.toBeChecked();
    await user.click(create);

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建清单" })).toBeNull());
    expect(await screen.findByRole("heading", { level: 2, name: "周会待跟进" })).toBeVisible();
    expect(screen.getByRole("button", { name: "周会待跟进" })).toHaveAttribute("aria-current", "true");
    expect(await itemRow(1, "确认发布日期")).toBeVisible();
    expect(await itemRow(2, "整理用户反馈")).toBeVisible();
    expect(await longTermItem()).toHaveAttribute("aria-checked", "false");
    // Made with items, focus is not taken from where the dialog left it.
    expect(screen.getByRole("textbox", { name: "添加事项" })).not.toHaveFocus();

    const { lists } = await store.listTodoLists({ query: "周会待跟进" });
    expect(lists[0]).toMatchObject({ project: "paraself", sourceKind: "app_manual", sourceClient: null, longTerm: false });
    expect(lists[0]!.items.map((item) => item.title)).toEqual(["确认发布日期", "整理用户反馈"]);
  });

  it("creates an empty list, long-term unless told otherwise, and takes its first item", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await listRow("Paraself 遗留问题调研");

    await user.click(screen.getByRole("button", { name: "新建清单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建清单" });
    await user.type(within(dialog).getByLabelText("标题"), "读书");
    expect(within(dialog).getByText(/也可以先空着，建好后再逐项添加/u)).toBeVisible();
    const longTerm = within(dialog).getByRole("checkbox", { name: "长期清单" });
    expect(longTerm).toBeChecked();
    expect(longTerm).toHaveAccessibleDescription(/一直留在「未完成」里，适合日常、学习这类随时往里加的清单/u);
    await user.click(within(dialog).getByRole("button", { name: "创建清单" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建清单" })).toBeNull());
    expect(await screen.findByRole("heading", { level: 2, name: "读书" })).toBeVisible();
    // Among the unfinished, marked long-term, with nothing in it yet.
    const row = screen.getByRole("button", { name: "读书" });
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveTextContent("长期");
    expect(row).toHaveTextContent("还没有事项");
    expect(row).not.toHaveTextContent("0/0");
    expect(screen.getByRole("button", { name: "未完成" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("还没有事项，在下面添加第一项。")).toBeVisible();
    expect(screen.queryByText(/已处理 0\/0/u)).toBeNull();
    expect(screen.queryByText(/这份清单的事项都处理完了/u)).toBeNull();
    // Made to be added to: its add field has the cursor.
    const field = screen.getByRole("textbox", { name: "添加事项" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(await longTermItem()).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await user.type(field, "《设计数据密集型应用》第 6 章{Enter}");
    expect(await itemRow(1, "《设计数据密集型应用》第 6 章")).toBeVisible();
    expect(screen.queryByText("还没有事项，在下面添加第一项。")).toBeNull();
    expect(screen.getByText("已处理 0/1")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "读书" })).toHaveTextContent("0/1"));

    const { lists } = await store.listTodoLists({ query: "读书" });
    expect(lists[0]).toMatchObject({ title: "读书", longTerm: true, sourceKind: "app_manual" });
    expect(lists[0]!.items.map((item) => item.title)).toEqual(["《设计数据密集型应用》第 6 章"]);
  });

  it("ticks 长期清单 as the items field suggests, until the reader sets it, and sends what it shows", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const recordTodoList = vi.fn(store.recordTodoList);
    await setupInList({ ...store, recordTodoList });
    await listRow("Paraself 遗留问题调研");

    await user.click(screen.getByRole("button", { name: "新建清单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建清单" });
    const items = within(dialog).getByLabelText("事项（可选）");
    const longTerm = within(dialog).getByRole("checkbox", { name: "长期清单" });
    expect(longTerm).toBeChecked();
    await user.type(items, "第一项");
    expect(longTerm).not.toBeChecked();
    await user.clear(items);
    expect(longTerm).toBeChecked();

    // Set by the reader, it stays as they left it, whatever the items field holds.
    await user.click(longTerm);
    expect(longTerm).not.toBeChecked();
    await user.type(items, "第一项");
    await user.clear(items);
    expect(longTerm).not.toBeChecked();

    await user.type(within(dialog).getByLabelText("标题"), "这周要做的");
    await user.click(within(dialog).getByRole("button", { name: "创建清单" }));
    await waitFor(() => expect(recordTodoList).toHaveBeenCalledTimes(1));
    expect(recordTodoList.mock.calls[0]![0]).toEqual({ title: "这周要做的", longTerm: false, items: [] });

    // Empty and one-off: still among the unfinished, as there is nothing in it to finish yet.
    const row = await listRow("这周要做的");
    expect(row).not.toHaveTextContent("长期");
    expect(row).toHaveTextContent("还没有事项");
    expect(await longTermItem()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/这份清单的事项都处理完了/u)).toBeNull();
  });

  it("opens the list already there when an empty one is made again, and says so", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await listRow("Paraself 遗留问题调研");

    await user.click(screen.getByRole("button", { name: "新建清单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建清单" });
    await user.type(within(dialog).getByLabelText("标题"), "学习");
    await user.click(within(dialog).getByRole("button", { name: "创建清单" }));

    expect(await screen.findByRole("heading", { level: 2, name: "学习" })).toBeVisible();
    expect(screen.getByText("已经有一份叫「学习」的清单，已为你打开它。", { selector: ".todo-message" })).toBeVisible();
    expect(screen.getByRole("button", { name: "学习" })).toHaveAttribute("aria-current", "true");
    // What it holds now, not a second 学习 beside it.
    expect(await itemRow(1, "读完 DDIA 第 5 章（复制）")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "学习" })).toHaveLength(1);
    expect((await store.listTodoLists({ query: "学习", includeClosed: true })).lists.filter((list) => list.title === "学习")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "添加事项" })).toHaveFocus());
  });

  it("keeps saying a list with the same items was there already", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const [release] = (await store.listTodoLists({ listId: "preview-todo-release" })).lists;
    const { id, title, project, longTerm, revision, updatedAt, relativePath, counts } = release!;
    setup({
      recordTodoList: async () => ({
        todoVersion: TODO_VERSION,
        status: "duplicate",
        list: { id, title, project, longTerm, revision, updatedAt, relativePath, counts },
        added: [],
        skipped: [],
      }),
      listTodoLists: store.listTodoLists,
    });
    await listRow("Paraself 遗留问题调研");

    await user.click(screen.getByRole("button", { name: "新建清单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建清单" });
    await user.type(within(dialog).getByLabelText("标题"), "1.3.0 发布前检查");
    await user.type(within(dialog).getByLabelText("事项（可选）"), "更新发布说明{Enter}核对两个平台的 SHA-256");
    await user.click(within(dialog).getByRole("button", { name: "创建清单" }));

    expect(
      await screen.findByText("已经有一份同样的清单「1.3.0 发布前检查」（标题和事项都一样），没有重复创建，已为你打开它。", { selector: ".todo-message" }),
    ).toBeVisible();
    expect(await screen.findByRole("heading", { level: 2, name: "1.3.0 发布前检查" })).toBeVisible();
  });

  it("refuses more items than one call takes", async () => {
    const user = userEvent.setup();
    await setupInList();
    await listRow("Paraself 遗留问题调研");
    await user.click(screen.getByRole("button", { name: "新建清单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建清单" });

    await user.type(within(dialog).getByLabelText("标题"), "太多了");
    fireEvent.change(within(dialog).getByLabelText("事项（可选）"), {
      target: { value: Array.from({ length: 51 }, (_, index) => `事项 ${index + 1}`).join("\n") },
    });
    expect(within(dialog).getByText(/一次最多 50 项，现在有 51 项/u)).toBeVisible();
    expect(within(dialog).getByLabelText("事项（可选）")).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("button", { name: "创建清单" })).toBeDisabled();
  });

  it("copies a prompt for an agent, and offers the text when the clipboard refuses", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await setupInList();
    const { drawer } = await openItem(3, "托盘提示没有区分复盘");

    fireEvent.click(within(drawer).getByRole("button", { name: "复制给 agent" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const prompt = writeText.mock.calls[0]![0];
    expect(prompt).toContain(`请处理 Paraself 待办清单「Paraself 遗留问题调研」（listId: ${RESEARCH}）里的下面 1 项，清单里其它事项不要动：`);
    expect(prompt).toContain("- #3 [P2] 托盘提示没有区分复盘");
    expect(prompt).not.toContain("我的处置意见：");
    expect(prompt).toContain("开始时用 update_todo_item 把它标为 in_progress；完成后标为 done，并在 note 里写明做了什么、怎么验证的；决定不做就标为 dropped 并写明原因。");
    expect(await within(drawer).findByRole("button", { name: "已复制" })).toBeVisible();

    fireEvent.click(within(detailHeader("Paraself 遗留问题调研")).getByRole("button", { name: "复制给 agent" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const whole = writeText.mock.calls[1]![0];
    expect(whole).toContain(`请逐项处理 Paraself 待办「Paraself 遗留问题调研」（清单编号 ${RESEARCH}）里未完成的事项（目前是第 2、3、6 项）`);
    expect(whole).toContain(`先用 list_todo_lists 读取这份清单（listId 填 ${RESEARCH}），然后一次只处理一项`);
    // The reader's 处置备注 on the items go with the list.
    expect(whole).toContain("- #2 Windows 上 bridge 路径含空格时接入失败\n  我的处置意见：先只修引号，不要改安装目录结构；改完在我的 Windows 虚拟机上验证");
    expect(whole).toContain("按意见办；意见和实际情况冲突时先停下来问我。");

    const { drawer: sixth } = await openItem(6, "日志页的用途筛选在最小窗口下换行错位");
    writeText.mockRejectedValueOnce(new Error("Document is not focused."));
    fireEvent.click(within(sixth).getByRole("button", { name: "复制给 agent" }));
    const fallback = await within(sixth).findByRole("alert");
    expect(fallback).toHaveTextContent("没能写入剪贴板");
    const text = within(fallback).getByRole("textbox", { name: "要交给 agent 的内容" });
    expect((text as HTMLTextAreaElement).value).toContain("- #6 [P2] 日志页的用途筛选在最小窗口下换行错位\n  我的处置意见：改成横向滚动，不要换行");
    fireEvent.click(within(fallback).getByRole("button", { name: "收起" }));
    expect(within(sixth).queryByRole("alert")).toBeNull();
  });

  it("opens the list's note in Obsidian", async () => {
    const { api } = await setupInList();
    await listRow("Paraself 遗留问题调研");

    fireEvent.click(within(detailHeader("Paraself 遗留问题调研")).getByRole("button", { name: "在 Obsidian 中打开" }));
    expect(api.openVaultDocument).toHaveBeenCalledWith(`Decision Journal/todos/2026/11/${RESEARCH}.md`);
  });

  it("explains where lists come from when there are none", async () => {
    const listTodoLists = vi.fn(async () => ({ todoVersion: TODO_VERSION, lists: [], total: 0, nextOffset: null, unreadable: [] }));
    setup({ listTodoLists });

    expect(await screen.findByRole("heading", { level: 2, name: "还没有待办清单" })).toBeVisible();
    expect(screen.getByText(/把这次发现的问题存成 Paraself 待办/u)).toBeVisible();
    for (const tool of ["record_todo_list", "list_todo_lists", "update_todo_item"]) expect(screen.getByText(tool)).toBeVisible();
    const create = screen.getAllByRole("button", { name: "新建清单" });
    expect(create).toHaveLength(2);
    fireEvent.click(create[1]!);
    expect(await screen.findByRole("dialog", { name: "新建清单" })).toBeVisible();
  });

  it("offers 全部 when every list is finished", async () => {
    const store = createTodoPreview();
    const finished = (await store.listTodoLists({ listId: "preview-todo-release" })).lists;
    const listTodoLists = vi.fn(async (query: TodoListQuery) => {
      const lists: TodoListView[] = query.includeClosed === true ? finished : [];
      return { todoVersion: TODO_VERSION, lists, total: lists.length, nextOffset: null, unreadable: [] };
    });
    setup({ listTodoLists });

    expect(await screen.findByText("没有未完成的清单。")).toBeVisible();
    expect(screen.getByText("项未完成").closest(".desktop-view-meta")).toHaveTextContent("0项未完成");
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.click(await listRow("1.3.0 发布前检查"));
    expect(await listRow("1.3.0 发布前检查")).toHaveAttribute("aria-current", "true");
    expect(await screen.findByRole("heading", { level: 2, name: "1.3.0 发布前检查" })).toBeVisible();
  });

  it("names the notes it could not read, and opens one to fix", async () => {
    const store = createTodoPreview();
    const broken = "Decision Journal/todos/2026/11/坏掉的清单-1a2b3c.md";
    const { api } = await setupInList({
      listTodoLists: async (query) => ({
        ...(await store.listTodoLists(query)),
        unreadable: [{ relativePath: broken, message: "第 7 行的复选框后缺少事项编号" }],
      }),
    });

    const notice = await screen.findByRole("region", { name: "读不出的待办笔记" });
    expect(notice).toHaveTextContent("有 1 篇待办笔记读不出来，其中的清单暂时不在这里");
    expect(notice).toHaveTextContent("第 7 行的复选框后缺少事项编号");
    fireEvent.click(within(notice).getByRole("button", { name: broken }));
    expect(api.openVaultDocument).toHaveBeenCalledWith(broken);
  });

  it("says a read that failed, and reads again on 重试", async () => {
    const store = createTodoPreview();
    const listTodoLists = vi.fn(store.listTodoLists);
    listTodoLists.mockRejectedValueOnce(new Error("Obsidian 仓库目录不存在"));
    setup({ listTodoLists });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("读取待办失败：Obsidian 仓库目录不存在");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    expect(await listRow("Paraself 遗留问题调研")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the lists again when a write moves todoRevision", async () => {
    const { store, api, view } = await setupInList();
    await listRow("Paraself 遗留问题调研");

    // An agent saves a list: the store has it, the page does not until the revision moves.
    await store.recordTodoList({ title: "依赖升级排查", items: [{ title: "electron 43 的沙箱变化" }] });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(screen.queryByRole("button", { name: "依赖升级排查" })).toBeNull();

    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    expect(await listRow("依赖升级排查")).toBeVisible();
    // The list in view stays the one the reader had open.
    expect(screen.getByRole("button", { name: "Paraself 遗留问题调研" })).toHaveAttribute("aria-current", "true");
  });

  it("shows an answer even while writes keep coming faster than a read takes", async () => {
    const store = createTodoPreview();
    const slow: TodoApi = {
      ...store,
      openVaultDocument: vi.fn(async () => undefined),
      listTodoLists: async (query) => {
        const answer = await store.listTodoLists(query);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return answer;
      },
    };
    const view = render(<TodoPanel api={slow} todoRevision={0} />);
    await listRow("Paraself 遗留问题调研");
    await store.recordTodoList({ title: "一直在写的清单", items: [{ title: "x" }] });
    // An agent writes every 100 ms; each read takes 250 ms. The newest read never ends before the next write.
    let shown = false;
    for (let revision = 1; revision <= 8 && !shown; revision += 1) {
      view.rerender(<TodoPanel api={slow} todoRevision={revision} />);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
      shown = screen.queryByRole("button", { name: "一直在写的清单" }) !== null;
    }
    expect(shown).toBe(true);
  });

  it("reads the lists again when the window comes back to the front", async () => {
    const { store } = await setupInList();
    await store.recordTodoList({ title: "离开时写下的清单", items: [{ title: "x" }] });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(screen.queryByRole("button", { name: "离开时写下的清单" })).toBeNull();
    fireEvent.focus(window);
    expect(await listRow("离开时写下的清单")).toBeVisible();
  });

  it("does not overwrite what the reader is typing when the lists are read again", async () => {
    const user = userEvent.setup();
    const { store, api, view } = await setupInList();
    const { drawer } = await openItem(3, "托盘提示没有区分复盘");
    const note = within(drawer).getByRole("textbox", { name: "写一句进展" });
    await user.type(note, "写了一半的进展");
    const add = screen.getByRole("textbox", { name: "添加事项" });
    await user.type(add, "还没按回车的新事项");

    // An agent changes the very item whose drawer is open, and adds another to the list.
    await store.changeTodoItem({ listId: RESEARCH, item: 3, status: "in_progress", expectedStatus: "open" });
    await store.recordTodoList({ listId: RESEARCH, items: [{ title: "agent 加的一项" }] });
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    expect(await screen.findByRole("button", { name: /agent 加的一项/u })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "写一句进展" })).toHaveValue("写了一半的进展");
    expect(screen.getByRole("textbox", { name: "添加事项" })).toHaveValue("还没按回车的新事项");
  });

  it("keeps a list whose last item was just finished in view, until the reader moves on", async () => {
    const { store, api, view } = await setupInList();
    await store.recordTodoList({ title: "只剩一项", items: [{ title: "最后一项" }] });
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    fireEvent.click(await listRow("只剩一项"));
    const row = await itemRow(1, "最后一项");

    await setStatus(row, 1, "已完成");
    await waitFor(() => expect(statusOf(row)).toBe("已完成"));
    expect(screen.getByText(/这份清单的事项都处理完了/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "只剩一项" })).toHaveAttribute("aria-current", "true");

    fireEvent.click(screen.getByRole("button", { name: "Paraself 遗留问题调研" }));
    view.rerender(<TodoPanel api={api} todoRevision={2} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "只剩一项" })).toBeNull());
  });
});

describe("long-term todo lists", () => {
  it("folds the handled items of a long-term list away below the unfinished ones", async () => {
    const user = userEvent.setup();
    await setupInList();
    await user.click(await listRow("学习"));
    expect(await screen.findByRole("heading", { level: 2, name: "学习" })).toBeVisible();

    // The unfinished first, in their order; the one done folded away, closed.
    expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["1", "3"]);
    const fold = screen.getByRole("button", { name: "已处理 1 项" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /第 2 项：/u })).toBeNull();
    expect(screen.getByText("已处理 1/3")).toBeVisible();

    await user.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(numbersIn(screen.getByRole("list", { name: "已处理的事项" }))).toEqual(["2"]);
    expect(statusOf(await itemRow(2, "整理 MCP 规范里 tool annotations 的含义"))).toBe("已完成");

    // Left open for this list, as long as the page is: still open after a look at another one.
    await user.click(screen.getByRole("button", { name: "日常" }));
    expect(await screen.findByRole("heading", { level: 2, name: "日常" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /已处理 \d+ 项/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: "学习" }));
    expect(screen.getByRole("button", { name: "已处理 1 项" })).toHaveAttribute("aria-expanded", "true");

    // Finished here, an item keeps its place, and focus, until the reader moves on.
    const finishing = await itemRow(1, "读完 DDIA 第 5 章（复制）");
    await setStatus(finishing, 1, "已完成");
    await waitFor(() => expect(within(finishing).getByRole("button", { name: "第 1 项状态：已完成" })).toBeVisible());
    await waitFor(() => expect(within(finishing).getByRole("button", { name: /第 1 项：/u })).toHaveFocus());
    expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["1", "3"]);
    expect(screen.getByRole("button", { name: "已处理 1 项" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "日常" }));
    await user.click(screen.getByRole("button", { name: "学习" }));
    expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["3"]);
    expect(numbersIn(screen.getByRole("list", { name: "已处理的事项" }))).toEqual(["1", "2"]);

    // Opened again, it goes back among the unfinished, and focus goes with it.
    await setStatus(within(screen.getByRole("list", { name: "已处理的事项" })).getByRole("button", { name: /第 2 项：/u }).closest("li")!, 2, "待处理");
    await waitFor(() => expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["2", "3"]));
    await waitFor(() => expect(screen.getByRole("button", { name: /第 2 项：整理 MCP/u })).toHaveFocus());
    expect(screen.getByRole("button", { name: "已处理 1 项" })).toBeVisible();

    // A one-off list folds what is handled too, and groups the rest by 处理中 and 待处理.
    await user.click(screen.getByRole("button", { name: "Paraself 遗留问题调研" }));
    expect(numbersIn(await screen.findByRole("list", { name: "处理中" }))).toEqual(["2"]);
    expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["3", "6"]);
    expect(screen.getByRole("button", { name: "已处理 3 项" })).toHaveAttribute("aria-expanded", "false");
  });

  it("stays with the unfinished lists however many of its items are done", async () => {
    const { api, view } = await setupInList();
    fireEvent.click(await listRow("学习"));
    for (const [number, title] of [[1, "读完 DDIA 第 5 章（复制）"], [3, "试一下 Obsidian Bases 的表格视图"]] as const) {
      const row = await itemRow(number, title);
      await setStatus(row, number, "已完成");
      await waitFor(() => expect(statusOf(row)).toBe("已完成"));
    }
    expect(screen.queryByText(/这份清单的事项都处理完了/u)).toBeNull();
    expect(screen.getByRole("button", { name: "学习" })).not.toHaveTextContent("已处理完");
    // Nothing left to hand an agent.
    expect(within(detailHeader("学习")).queryByRole("button", { name: "复制给 agent" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Paraself 遗留问题调研" }));
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    fireEvent.click(await listRow("学习"));
    expect(await screen.findByText("事项都处理完了，有新的随时在下面添加。")).toBeVisible();
    expect(screen.getByRole("button", { name: "已处理 3 项" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "待处理" })).toBeNull();
  });

  it("turns a list long-term and back from its header", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await user.click(await listRow("官网首页加载性能调研"));
    expect(await screen.findByRole("heading", { level: 2, name: "官网首页加载性能调研" })).toBeVisible();
    expect(await longTermItem()).toHaveAttribute("aria-checked", "false");

    await user.click(await longTermItem());
    await waitFor(() => expect(within(screen.getByRole("button", { name: "官网首页加载性能调研" })).getByText("长期")).toBeVisible());
    expect((await store.listTodoLists({ listId: "preview-todo-site" })).lists[0]).toMatchObject({ longTerm: true });
    // Its items untouched.
    expect(numbersIn(screen.getByRole("region", { name: /待处理，3 项/u }))).toEqual(["1", "2", "3"]);
    expect(await longTermItem()).toHaveAttribute("aria-checked", "true");

    await user.click(await longTermItem());
    await waitFor(() => expect(screen.getByRole("button", { name: "官网首页加载性能调研" })).not.toHaveTextContent("长期"));
    expect((await store.listTodoLists({ listId: "preview-todo-site" })).lists[0]).toMatchObject({ longTerm: false });
  });

  it("puts a list made one-off away, its items all handled, once the reader moves on", async () => {
    const { store, api, view } = await setupInList();
    fireEvent.click(await listRow("学习"));
    expect(await screen.findByRole("heading", { level: 2, name: "学习" })).toBeVisible();
    // Done while the list is in view (the page reads at once now, so the list is opened before the writes).
    await store.changeTodoItem({ listId: LEARNING, item: 1, status: "done", expectedStatus: "open" });
    await store.changeTodoItem({ listId: LEARNING, item: 3, status: "dropped", expectedStatus: "open" });
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(screen.queryByText(/这份清单的事项都处理完了/u)).toBeNull();

    fireEvent.click(await longTermItem());
    expect(await screen.findByText("这份清单的事项都处理完了。切到别的清单后，它会收进「全部」里。")).toBeVisible();
    const row = screen.getByRole("button", { name: "学习" });
    expect(row).toHaveTextContent("已处理完");
    expect(row).toHaveAttribute("aria-current", "true");
    // One-off too, what is handled is folded: the one done while the list was open keeps its place until the reader moves on.
    expect(numbersIn(screen.getByRole("region", { name: /待处理，\d 项/u }))).toEqual(["1", "3"]);

    fireEvent.click(screen.getByRole("button", { name: "Paraself 遗留问题调研" }));
    view.rerender(<TodoPanel api={api} todoRevision={2} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "学习" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(await listRow("学习")).toHaveTextContent("已处理完");
  });

  it("says so where the list's messages go when the setting is not saved", async () => {
    const updateTodoList = vi.fn(async () => {
      throw new Error("笔记正被另一个程序写入");
    });
    await setupInList({ updateTodoList });

    fireEvent.click(await longTermItem());
    expect(await screen.findByRole("alert")).toHaveTextContent("没有保存：笔记正被另一个程序写入");
    expect(updateTodoList).toHaveBeenCalledWith({ listId: RESEARCH, longTerm: true });
    expect(screen.getByRole("button", { name: "更多" })).toBeEnabled();
  });

  it("points a one-off list's reader to the item done before when the same one is added again", async () => {
    const user = userEvent.setup();
    await setupInList();
    await listRow("Paraself 遗留问题调研");

    await user.type(await screen.findByRole("textbox", { name: "添加事项" }), "本地审阅取消后残留私有副本目录{Enter}");
    expect(
      await screen.findByText("这份清单里已经有「本地审阅取消后残留私有副本目录」（第 1 项，已完成），没有重复添加；要再做一次，可以把它重新打开。"),
    ).toHaveAttribute("role", "alert");
    expect(screen.getByRole("textbox", { name: "添加事项" })).toHaveValue("本地审阅取消后残留私有副本目录");
  });

  it("takes the title of an item done before again in a long-term list", async () => {
    const user = userEvent.setup();
    await setupInList();
    await user.click(await listRow("学习"));
    expect(await screen.findByRole("heading", { level: 2, name: "学习" })).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "添加事项" }), "整理 MCP 规范里 tool annotations 的含义{Enter}");
    expect(await screen.findByText("已添加为第 4 项。", { selector: ".todo-message" })).toBeVisible();
    // The new one among the unfinished, the one done before still folded away.
    await waitFor(() => expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["1", "3", "4"]));
    expect(screen.getByRole("button", { name: "已处理 1 项" })).toBeVisible();
  });

  it("lets the oldest handled items of a full long-term list go to make room, and says which", async () => {
    const user = userEvent.setup();
    const { store, api, view } = await setupInList();
    // 学习 filled to the limit: its 3 items and 197 more, by an agent, 50 a call.
    const more = Array.from({ length: 197 }, (_, index) => ({ title: `第 ${index + 1} 篇论文` }));
    for (let start = 0; start < more.length; start += 50) {
      await store.recordTodoList({ listId: LEARNING, items: more.slice(start, start + 50) });
    }
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    await user.click(await listRow("学习"));
    expect(await screen.findByText("已处理 1/200")).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "添加事项" }), "读完 DDIA 第 6 章（分区）{Enter}");
    const said = "已添加为第 201 项。清单已满 200 项，移走了最早处理完的 1 项：第 2 项「整理 MCP 规范里 tool annotations 的含义」。";
    expect(await screen.findByText(said, { selector: ".todo-message" })).toBeVisible();
    await waitFor(() => expect(screen.getByText("已处理 0/200")).toBeVisible());
    expect(screen.queryByRole("button", { name: /已处理 \d+ 项/u })).toBeNull();
    const [saved] = (await store.listTodoLists({ listId: LEARNING })).lists;
    expect(saved!.items).toHaveLength(200);
    expect(saved!.items.some((item) => item.number === 2)).toBe(false);
  });

  it("hands an agent only what is unfinished in a long-term list, and nothing of an empty one", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await setupInList();
    fireEvent.click(await listRow("学习"));
    expect(await screen.findByRole("heading", { level: 2, name: "学习" })).toBeVisible();

    fireEvent.click(within(detailHeader("学习")).getByRole("button", { name: "复制给 agent" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain(
      `请逐项处理 Paraself 待办「学习」（清单编号 ${LEARNING}）里未完成的事项（目前是第 1、3 项）。这是一份长期清单，之后还会往里加事项，这次只处理这几项。`,
    );

    fireEvent.click(screen.getByRole("button", { name: "日常" }));
    expect(await screen.findByRole("heading", { level: 2, name: "日常" })).toBeVisible();
    expect(within(detailHeader("日常")).queryByRole("button", { name: "复制给 agent" })).toBeNull();
  });
});

describe("todo views", () => {
  const countOf = (name: RegExp): string => screen.getByRole("button", { name }).querySelector(".todo-view-count")?.textContent ?? "";

  it("counts what is overdue, due today and coming up, and lists it with the list each item is in", async () => {
    setup();
    await listRow("Paraself 遗留问题调研");

    // Overdue (6) and due today (2); the dated ones in the next days; all that is unfinished.
    expect(countOf(/^今天/u)).toBe("2");
    expect(countOf(/^即将到期/u)).toBe("3");
    expect(countOf(/^全部未完成/u)).toBe("8");

    const overdue = screen.getByRole("region", { name: "已逾期，1 项" });
    const sixth = within(overdue).getByRole("button", { name: /第 6 项：/u }).closest("li")!;
    expect(within(sixth).getByText("Paraself 遗留问题调研")).toBeVisible();
    expect(within(sixth).getByText("昨天").closest(".todo-chip")).toHaveAttribute("data-due", "overdue");
    expect(within(sixth).getByText("P2")).toBeVisible();
    const due = screen.getByRole("region", { name: "今天到期，1 项" });
    expect(within(due).getByText("今天")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /^即将到期/u }));
    expect(await screen.findByRole("heading", { level: 2, name: "即将到期" })).toBeVisible();
    const tomorrow = addDays(localDay(new Date()), 1);
    expect(screen.getAllByRole("region").filter((region) => /^(明天|后天)?/u.test(region.getAttribute("aria-label") ?? "")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: /^明天 · .* 周.，1 项$/u })).toBeVisible();
    expect(tomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    fireEvent.click(screen.getByRole("button", { name: /^全部未完成/u }));
    const grouped = await screen.findAllByRole("region", { name: /项$/u });
    expect(grouped.map((group) => group.getAttribute("aria-label"))).toEqual(["Paraself 遗留问题调研，3 项", "官网首页加载性能调研，3 项", "学习，2 项"]);
  });

  it("finishes an item and opens its drawer from a view", async () => {
    const { store } = setup();
    const row = await itemRow(6, "日志页的用途筛选在最小窗口下换行错位");
    await setStatus(row, 6, "已完成");
    await waitFor(() => expect(countOf(/^今天/u)).toBe("1"));
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 6)?.status).toBe("done");

    const today = await itemRow(2, "Windows 上 bridge 路径含空格时接入失败");
    fireEvent.click(within(today).getByRole("button", { name: /第 2 项：/u }));
    const drawer = await screen.findByRole("complementary", { name: "第 2 项详情" });
    expect(within(drawer).getByText(/清单「Paraself 遗留问题调研」/u)).toBeVisible();
    expect(within(drawer).getByRole("combobox", { name: "优先级" })).toHaveValue("p1");
  });

  it("says when a view is empty", async () => {
    const store = createTodoPreview();
    const listTodoLists = vi.fn(async (query: TodoListQuery) => {
      const response = await store.listTodoLists(query);
      return { ...response, lists: response.lists.filter((list) => list.id === "preview-todo-daily") };
    });
    setup({ listTodoLists });
    expect(await screen.findByText("今天没有要处理的事项。已逾期、今天到期和处理中的事项会出现在这里。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^即将到期/u }));
    expect(await screen.findByText(/未来 7 天没有到期的事项/u)).toBeVisible();
  });
});

describe("todo list detail", () => {
  it("shows the progress ring and groups the items by 处理中, 待处理 and 已处理", async () => {
    await setupInList();
    expect(screen.getByRole("img", { name: "已处理 3/6" })).toBeVisible();
    expect(numbersIn(screen.getByRole("list", { name: "处理中" }))).toEqual(["2"]);
    expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["3", "6"]);
    expect(screen.getByRole("button", { name: "已处理 3 项" })).toHaveAttribute("aria-expanded", "false");
  });

  it("renames a list (its title, not its file), and puts it away and brings it back", async () => {
    const user = userEvent.setup();
    const { store, api, view } = await setupInList({}, "官网首页加载性能调研");

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "改清单名" }));
    const field = screen.getByRole("textbox", { name: "清单名" });
    await user.clear(field);
    await user.type(field, "官网性能{Enter}");
    expect(await screen.findByRole("heading", { level: 2, name: "官网性能" })).toBeVisible();
    const [renamed] = (await store.listTodoLists({ listId: "preview-todo-site" })).lists;
    expect(renamed).toMatchObject({ title: "官网性能", relativePath: "Decision Journal/todos/2026/11/preview-todo-site.md" });

    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "归档" }));
    // The list in view stays until the reader moves on, marked as put away.
    expect(await within(await screen.findByRole("button", { name: "官网性能" })).findByText("已归档")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "学习" }));
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "官网性能" })).toBeNull());
    // Gone from the views too; under 全部 it can be filtered out and brought back.
    expect(screen.getByRole("button", { name: /^全部未完成/u }).querySelector(".todo-view-count")?.textContent).toBe("5");
    await user.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.queryByRole("button", { name: "官网性能" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /只看已归档/u }));
    const archived = await screen.findByRole("button", { name: "官网性能" });
    expect(within(archived).getByText("已归档")).toBeVisible();
    await user.click(archived);
    await user.click(await screen.findByRole("button", { name: "取消归档" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "官网性能" })).toBeNull());
    expect((await store.listTodoLists({ listId: "preview-todo-site" })).lists[0]).toMatchObject({ archived: false });
  });

  it("sorts by priority or due date for display only", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const waiting = () => numbersIn(screen.getByRole("list", { name: "待处理" }));
    expect(waiting()).toEqual(["3", "6"]);
    await user.click(screen.getByRole("button", { name: "截止日期" }));
    expect(waiting()).toEqual(["6", "3"]);
    expect(screen.getByRole("button", { name: "截止日期" })).toHaveAttribute("aria-pressed", "true");
    // The note's own order is untouched.
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 6]);
    await user.click(screen.getByRole("button", { name: "手动" }));
    expect(waiting()).toEqual(["3", "6"]);
  });

  it("moves an item up with ⌥↑, and by dragging it onto another", async () => {
    const store = createTodoPreview();
    const moveTodoItem = vi.fn(store.moveTodoItem);
    await setupInList({ ...store, moveTodoItem });
    const six = within(await itemRow(6, "日志页的用途筛选在最小窗口下换行错位")).getByRole("button", { name: /第 6 项：/u });
    six.focus();
    fireEvent.keyDown(six, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(moveTodoItem).toHaveBeenCalledWith({ listId: RESEARCH, item: 6, before: 3 }));
    await waitFor(() => expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["6", "3"]));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "待处理" })).getByRole("button", { name: /第 6 项：/u })).toHaveFocus());

    // Dragging 3 onto the top half of 6 puts it before 6; the bottom half, before whatever follows 6 in the note.
    const dataTransfer = { setData: () => undefined, effectAllowed: "" };
    const three = (await itemRow(3, "托盘提示没有区分复盘"));
    const sixRow = await itemRow(6, "日志页的用途筛选在最小窗口下换行错位");
    // The pointer (clientY 0) is in the top half of a 20-pixel row.
    sixRow.getBoundingClientRect = () => ({ top: 0, height: 20, bottom: 20, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.dragStart(three, { dataTransfer });
    // jsdom has no DragEvent, so the pointer's position is put on the event by hand.
    const dragged = (type: "dragOver" | "drop") => {
      const event = createEvent[type](sixRow, { dataTransfer });
      Object.defineProperty(event, "clientY", { value: 0 });
      fireEvent(sixRow, event);
    };
    dragged("dragOver");
    expect(sixRow).toHaveAttribute("data-drop", "before");
    dragged("drop");
    await waitFor(() => expect(moveTodoItem).toHaveBeenLastCalledWith({ listId: RESEARCH, item: 3, before: 6 }));
    await waitFor(() => expect(numbersIn(screen.getByRole("list", { name: "待处理" }))).toEqual(["3", "6"]));
  });

  it("does not move items while the list is sorted another way", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const moveTodoItem = vi.fn(store.moveTodoItem);
    await setupInList({ ...store, moveTodoItem });
    await user.click(screen.getByRole("button", { name: "优先级" }));
    const six = within(await itemRow(6, "日志页的用途筛选在最小窗口下换行错位")).getByRole("button", { name: /第 6 项：/u });
    fireEvent.keyDown(six, { key: "ArrowUp", altKey: true });
    expect(moveTodoItem).not.toHaveBeenCalled();
    expect(six.closest("li")).toHaveAttribute("draggable", "false");
  });
});

describe("adding an item on the page", () => {
  it("adds a plain line at once, and never rewrites words that merely look like a day", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const recordTodoList = vi.fn(store.recordTodoList);
    await setupInList({ ...store, recordTodoList });
    const field = await screen.findByRole("textbox", { name: "添加事项" });

    await user.type(field, "写发版总结{Enter}");
    await waitFor(() => expect(recordTodoList).toHaveBeenCalledWith({ listId: RESEARCH, items: [{ title: "写发版总结" }] }));
    // Nothing in them is a whole day word, priority or list: kept as typed.
    for (const line of ["看 明天的会", "周一例会", "读 1.5 章"]) {
      await user.clear(field);
      await user.type(field, `${line}{Enter}`);
      await waitFor(() => expect(recordTodoList).toHaveBeenLastCalledWith({ listId: RESEARCH, items: [{ title: line }] }));
    }
  });

  it("opens the dialog with the line when the parser finds a day, a priority or a list, and adds nothing until it is confirmed", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const recordTodoList = vi.fn(store.recordTodoList);
    await setupInList({ ...store, recordTodoList });
    const field = await screen.findByRole("textbox", { name: "添加事项" });

    for (const line of ["读 1/2 章", "看 明天 的会", "明天 !p1 写发版总结", "整理书单 #学习", "买菜 #不存在的清单"]) {
      await user.clear(field);
      await user.type(field, `${line}{Enter}`);
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("textbox", { name: "事项" })).toHaveValue(line);
      expect(within(dialog).getByText(/将保存为：/u)).toBeVisible();
      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    expect(recordTodoList).not.toHaveBeenCalled();
  });

  it("opens the quick-add dialog from the page's 添加事项 button, on the list in view", async () => {
    await setupInList();
    fireEvent.click(screen.getByRole("button", { name: "添加事项" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("combobox")).toHaveValue(RESEARCH));
  });
});

describe("item cards", () => {
  it("shows the title in full, and a quiet second line: #number and what is under way, or the first sentence of the detail", async () => {
    await setupInList();
    const working = await itemRow(2, "Windows 上 bridge 路径含空格时接入失败");
    expect(working.querySelector(".todo-item-sub")).toHaveTextContent(/^#2标签 #windows标签 #本周处理中 · Codex .*更新处置：先只修引号/u);
    // Not under way: the first sentence of its detail (the first line, up to its first full stop).
    const waiting = await itemRow(6, "日志页的用途筛选在最小窗口下换行错位");
    expect(waiting.querySelector(".todo-item-second")).toHaveTextContent("最小窗口（960×640）下，用途筛选和刷新按钮挤在同一行，筛选的标签被截成两行，按钮的文字也被裁掉一半。");
    // No detail: nothing after the number.
    const bare = await itemRow(3, "托盘提示没有区分复盘");
    expect(bare.querySelector(".todo-item-sub")).toHaveTextContent(/^#3标签 #ui$/u);
  });
});

describe("batch selection", () => {
  const box = (row: HTMLElement, number: number) => within(row).getByRole("checkbox", { name: `选择第 ${number} 项` });
  const bar = () => screen.queryByRole("toolbar", { name: "批量操作" });

  it("picks items with their boxes, which no longer finish them, and shows the bar", async () => {
    const { store } = await setupInList();
    expect(bar()).toBeNull();
    const three = await itemRow(3, "托盘提示没有区分复盘");
    fireEvent.click(box(three, 3));
    fireEvent.click(box(await itemRow(6, "日志页的用途筛选在最小窗口下换行错位"), 6));
    expect(box(three, 3)).toBeChecked();
    expect(within(bar()!).getByText("已选 2 项")).toBeVisible();
    // Only picked: nothing was written.
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)?.status).toBe("open");

    fireEvent.click(within(bar()!).getByRole("button", { name: "取消选择（Esc）" }));
    expect(bar()).toBeNull();
    expect(box(three, 3)).not.toBeChecked();
  });

  it("floats the bar over the top of the list: out of the flow, and the first item where it was", async () => {
    await setupInList();
    const first = await itemRow(3, "托盘提示没有区分复盘");
    const before = first.getBoundingClientRect().top;
    const body = document.querySelector(".todo-detail-body")!;
    fireEvent.click(box(first, 3));
    // Not a child of the scrolling body, so it takes no room in the list; the first item has not moved.
    expect(body.contains(bar())).toBe(false);
    expect(bar()!.closest(".todo-float")).not.toBeNull();
    expect((await itemRow(3, "托盘提示没有区分复盘")).getBoundingClientRect().top).toBe(before);
    fireEvent.click(within(bar()!).getByRole("button", { name: "取消选择（Esc）" }));
    expect((await itemRow(3, "托盘提示没有区分复盘")).getBoundingClientRect().top).toBe(before);
  });

  it("clears the due date of the picked items from the date popover", async () => {
    const store = createTodoPreview();
    const changeTodoItems = vi.fn(store.changeTodoItems);
    await setupInList({ ...store, changeTodoItems });
    fireEvent.click(box(await itemRow(3, "托盘提示没有区分复盘"), 3));
    fireEvent.click(within(bar()!).getByRole("button", { name: "设截止日期" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "设截止日期" })).getByRole("button", { name: "清除截止日期" }));
    await waitFor(() => expect(changeTodoItems).toHaveBeenCalledWith({ listId: RESEARCH, changes: [{ item: 3, due: null, expectedDue: expect.any(String), expectedStatus: "open" }] }));
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)?.due).toBeNull();
  });

  it("picks a run with Shift, everything with ⌘A, and lets go with Escape", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    await store.recordTodoList({ listId: RESEARCH, items: [{ title: "第七项" }, { title: "第八项" }] });
    await setupInList({ ...store });
    fireEvent.click(await screen.findByRole("button", { name: "Paraself 遗留问题调研" }));
    const first = await itemRow(3, "托盘提示没有区分复盘");
    await user.click(box(first, 3));
    await user.keyboard("{Shift>}");
    await user.click(box(await itemRow(8, "第八项"), 8));
    await user.keyboard("{/Shift}");
    // 3, 6, 7, 8 are the open ones in the order shown.
    expect(within(bar()!).getByText("已选 4 项")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(bar()).toBeNull();
    (await itemRow(3, "托盘提示没有区分复盘")).querySelector<HTMLElement>(".todo-item-toggle")!.focus();
    await user.keyboard("{Meta>}a{/Meta}");
    // Every item of the list: the 8, handled ones included.
    expect(within(bar()!).getByText("已选 8 项")).toBeVisible();
  });

  it("completes, starts, prioritises and dates the picked items without a note, and says what came of it", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(box(await itemRow(3, "托盘提示没有区分复盘"), 3));
    fireEvent.click(box(await itemRow(6, "日志页的用途筛选在最小窗口下换行错位"), 6));
    await user.selectOptions(within(bar()!).getByRole("combobox", { name: "设优先级" }), "p1");
    expect(await screen.findByText("成功 2 项。", { selector: ".todo-message" })).toBeVisible();
    expect(bar()).toBeNull();
    let [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.items.filter((item) => item.priority === "p1").map((item) => item.number)).toEqual([1, 2, 3, 6]);

    fireEvent.click(box(await itemRow(3, "托盘提示没有区分复盘"), 3));
    // The date picker is behind a button: no bare mm/dd/yyyy in the bar.
    expect(within(bar()!).queryByLabelText("截止日期")).toBeNull();
    fireEvent.click(within(bar()!).getByRole("button", { name: "设截止日期" }));
    fireEvent.change(within(await screen.findByRole("dialog", { name: "设截止日期" })).getByLabelText("截止日期"), { target: { value: "2031-02-03" } });
    await waitFor(() => expect(screen.getByText("成功 1 项。", { selector: ".todo-message" })).toBeVisible());
    fireEvent.click(box(await itemRow(3, "托盘提示没有区分复盘"), 3));
    fireEvent.click(within(bar()!).getByRole("button", { name: "开始处理" }));
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)?.status).toBe("in_progress"));
    fireEvent.click(box(await itemRow(3, "托盘提示没有区分复盘"), 3));
    fireEvent.click(within(bar()!).getByRole("button", { name: "标为完成" }));
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)).toMatchObject({ status: "done", due: "2031-02-03", note: null }));
    [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.history.filter((event) => event.item === 3).length).toBeGreaterThanOrEqual(3);
  });

  it("skips an item that an agent moved on meanwhile, and says how many and why", async () => {
    const { store } = await setupInList();
    fireEvent.click(box(await itemRow(3, "托盘提示没有区分复盘"), 3));
    fireEvent.click(box(await itemRow(6, "日志页的用途筛选在最小窗口下换行错位"), 6));
    await store.changeTodoItem({ listId: RESEARCH, item: 3, status: "in_progress", expectedStatus: "open" });
    fireEvent.click(within(bar()!).getByRole("button", { name: "标为完成" }));
    expect(await screen.findByText("成功 1 项，跳过 1 项（1 项已被改过）。", { selector: ".todo-message" })).toHaveAttribute("role", "alert");
    const [saved] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(saved!.items.find((item) => item.number === 3)?.status).toBe("in_progress");
    expect(saved!.items.find((item) => item.number === 6)?.status).toBe("done");
  });

  it("picks across lists in a view and changes each list in one write", async () => {
    const store = createTodoPreview();
    const changeTodoItems = vi.fn(store.changeTodoItems);
    setup({ ...store, changeTodoItems });
    fireEvent.click(await within(await screen.findByRole("region", { name: "已逾期，1 项" })).findByRole("checkbox", { name: "选择第 6 项" }));
    fireEvent.click(within(await screen.findByRole("region", { name: "今天到期，1 项" })).getByRole("checkbox", { name: "选择第 2 项" }));
    fireEvent.click(within(bar()!).getByRole("button", { name: "标为完成" }));
    await waitFor(() => expect(changeTodoItems).toHaveBeenCalledTimes(1));
    expect(changeTodoItems).toHaveBeenCalledWith({
      listId: RESEARCH,
      changes: [{ item: 6, status: "done", expectedStatus: "open" }, { item: 2, status: "done", expectedStatus: "in_progress" }],
    });
  });
});

describe("deleting", () => {
  it("asks first, naming the count and the first titles, then deletes the picked items", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    for (const [number, title] of [[3, "托盘提示没有区分复盘"], [6, "日志页的用途筛选在最小窗口下换行错位"]] as const) {
      fireEvent.click(within(await itemRow(number, title)).getByRole("checkbox", { name: `选择第 ${number} 项` }));
    }
    fireEvent.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 2 项" });
    expect(dialog).toHaveTextContent("连同它下面缩进的子列表和说明一起删除");
    expect(dialog).toHaveTextContent("第 3 项「托盘提示没有区分复盘」");
    expect(dialog).toHaveTextContent("第 6 项「日志页的用途筛选在最小窗口下换行错位」");
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items).toHaveLength(6);
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items).toHaveLength(6);

    fireEvent.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "删除" }));
    await user.click(within(await screen.findByRole("dialog", { name: "删除 2 项" })).getByRole("button", { name: "删除 2 项" }));
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.map((item) => item.number)).toEqual([1, 2, 4, 5]));
    expect(await screen.findByText("已删除 2 项。", { selector: ".todo-message" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /第 3 项：/u })).toBeNull();
  });

  it("deletes one item from its row menu or its drawer, and refuses what moved on", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const three = await itemRow(3, "托盘提示没有区分复盘");
    fireEvent.click(within(three).getByRole("button", { name: /^第 3 项状态：/u }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 1 项" });
    // An agent starts on it before the reader confirms: not deleted.
    await store.changeTodoItem({ listId: RESEARCH, item: 3, status: "in_progress", expectedStatus: "open" });
    await user.click(within(dialog).getByRole("button", { name: "删除 1 项" }));
    expect(await screen.findByText("已删除 0 项，跳过 1 项（1 项已被改过）。", { selector: ".todo-message" })).toBeVisible();
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.map((item) => item.number)).toContain(3);

    const { drawer } = await openItem(6, "日志页的用途筛选在最小窗口下换行错位");
    await user.click(within(drawer).getByRole("button", { name: "删除这一项" }));
    await user.click(within(await screen.findByRole("dialog", { name: "删除 1 项" })).getByRole("button", { name: "删除 1 项" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "第 6 项详情" })).toBeNull());
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.map((item) => item.number)).not.toContain(6);
  });

  it("deletes a list only once its name is typed, and says when the wastebasket fails", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const deleteTodoList = vi.fn(store.deleteTodoList);
    await setupInList({ ...store, deleteTodoList }, "官网首页加载性能调研");
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除清单" }));
    const dialog = await screen.findByRole("dialog", { name: "删除清单" });
    const confirm = within(dialog).getByRole("button", { name: "删除清单" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "官网首页");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "加载性能调研");
    deleteTodoList.mockRejectedValueOnce(new Error("废纸篓不可用"));
    await user.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("没有删除，笔记还在原处：废纸篓不可用");
    expect((await store.listTodoLists({ listId: "preview-todo-site" })).lists).toHaveLength(1);

    await user.click(confirm);
    await waitFor(() => expect(deleteTodoList).toHaveBeenLastCalledWith({ listId: "preview-todo-site", title: "官网首页加载性能调研" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "官网首页加载性能调研" })).toBeNull());
    expect((await store.listTodoLists({ listId: "preview-todo-site" })).lists).toHaveLength(0);
  });
});

describe("deleting a list that is already gone", () => {
  it("says it is not there any more, not that it went to the wastebasket, and reads the lists again", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const deleteTodoList = vi.fn(async () => ({ todoVersion: TODO_VERSION, status: "list_not_found" as const }));
    const listTodoLists = vi.fn(store.listTodoLists);
    await setupInList({ ...store, deleteTodoList, listTodoLists }, "官网首页加载性能调研");
    const before = listTodoLists.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "删除清单" }));
    const dialog = await screen.findByRole("dialog", { name: "删除清单" });
    await user.type(within(dialog).getByRole("textbox"), "官网首页加载性能调研");
    await user.click(within(dialog).getByRole("button", { name: "删除清单" }));
    expect((await screen.findAllByText("这份清单已不存在，可能在 Obsidian 里移走了。")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/废纸篓/u)).toBeNull();
    await waitFor(() => expect(listTodoLists.mock.calls.length).toBeGreaterThan(before));
  });
});

describe("long lists", () => {
  const longList = async () => {
    const store = createTodoPreview();
    const made = await store.recordTodoList({ title: "长清单", longTerm: true, items: Array.from({ length: 70 }, (_, index) => ({ title: `事项 ${index + 1}${index === 40 ? " 独特的词" : ""}`, ...(index === 41 ? { detail: "细节里的暗号。" } : {}) })) });
    return { store, id: made.list!.id };
  };

  it("shows 30 at a time, and asks for 30 more", async () => {
    const { store } = await longList();
    setup({ ...store });
    fireEvent.click(await listRow("长清单"));
    const waiting = async () => (await screen.findByRole("list", { name: "待处理" })).querySelectorAll(".todo-item").length;
    expect(await waiting()).toBe(30);
    fireEvent.click(screen.getByRole("button", { name: "再显示 30 项（还有 40 项）" }));
    expect(await waiting()).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "再显示 30 项（还有 10 项）" }));
    expect(await waiting()).toBe(70);
    expect(screen.queryByRole("button", { name: /再显示/u })).toBeNull();
  });

  it("filters what is shown by title and detail, and leaves the list as it is", async () => {
    const user = userEvent.setup();
    const { store, id } = await longList();
    setup({ ...store });
    fireEvent.click(await listRow("长清单"));
    const filter = await screen.findByRole("searchbox", { name: "在本清单中筛选" });
    await user.type(filter, "独特的词");
    expect(numbersIn(await screen.findByRole("list", { name: "待处理" }))).toEqual(["41"]);
    await user.clear(filter);
    await user.type(filter, "暗号");
    expect(numbersIn(await screen.findByRole("list", { name: "待处理" }))).toEqual(["42"]);
    expect((await store.listTodoLists({ listId: id })).lists[0]!.items).toHaveLength(70);
    await user.clear(filter);
    expect((await screen.findByRole("list", { name: "待处理" })).querySelectorAll(".todo-item")).toHaveLength(30);
  });
});

