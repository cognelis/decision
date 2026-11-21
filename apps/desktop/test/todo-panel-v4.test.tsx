// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_CLIENTS, clientSummary } from "@cognelis/decision-integrations";
import { rememberClients } from "../src/renderer/client-labels.js";
import { TodoPanel, type TodoApi } from "../src/renderer/components/pages/todos/TodoPanel.js";
import { createTodoPreview } from "../src/renderer/preview-todos.js";

/** 待办 page, fourth version: P0–P3, tags, moving to another list, the keyboard, the wider drawer. Against the preview's lists. */

const RESEARCH = "preview-todo-research";
const SITE = "preview-todo-site";

const setup = (overrides: Partial<TodoApi> = {}) => {
  const store = createTodoPreview();
  const api: TodoApi = { ...store, openVaultDocument: vi.fn(async () => undefined), ...overrides };
  const view = render(<TodoPanel api={api} todoRevision={0} />);
  return { store, api, view };
};
const listRow = (title: string) => screen.findByRole("button", { name: title });
const setupInList = async (overrides: Partial<TodoApi> = {}, title = "Paraself 遗留问题调研") => {
  const rendered = setup(overrides);
  fireEvent.click(await listRow(title));
  await screen.findByRole("heading", { level: 2, name: title });
  return rendered;
};
const itemRow = async (number: number, title: string): Promise<HTMLElement> =>
  (await screen.findByRole("button", { name: new RegExp(`第 ${number} 项：${title}`, "u") })).closest("li")!;
const toggleOf = (row: HTMLElement, number: number) => within(row).getByRole("button", { name: new RegExp(`^第 ${number} 项：`, "u") });
const TRAY = "托盘提示没有区分复盘";
const WINDOWS = "Windows 上 bridge 路径含空格时接入失败";
const LOGS = "日志页的用途筛选在最小窗口下换行错位";

beforeEach(() => {
  localStorage.clear();
  rememberClients(BUILT_IN_CLIENTS.map(clientSummary));
});
afterEach(cleanup);

describe("priority P0–P3", () => {
  it("shows P0–P3 on the cards, opens a menu from the chip, and writes the pick", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const row = await itemRow(3, TRAY);
    expect(within(row).getByRole("button", { name: "第 3 项优先级：P2" })).toHaveTextContent("P2");
    expect(row).toHaveAttribute("data-priority", "p2");

    await user.click(within(row).getByRole("button", { name: "第 3 项优先级：P2" }));
    const menu = await screen.findByRole("menu", { name: "第 3 项优先级" });
    expect(within(menu).getAllByRole("menuitemradio").map((entry) => entry.textContent)).toEqual(["P0", "P1", "P2", "P3", "无"].map((label) => (label === "P2" ? "✓P2" : label)).map((text) => text.replace("✓", "✓")));
    await user.click(within(menu).getByRole("menuitemradio", { name: "P0" }));
    await waitFor(() => expect(row).toHaveAttribute("data-priority", "p0"));
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.priority).toBe("p0");

    await user.click(within(row).getByRole("button", { name: "第 3 项优先级：P0" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "无" }));
    await waitFor(() => expect(row).not.toHaveAttribute("data-priority"));
  });

  it("sorts P0 first", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await store.changeTodoItem({ listId: RESEARCH, item: 3, priority: "p0", expectedStatus: "open" });
    await store.changeTodoItem({ listId: RESEARCH, item: 6, priority: "p1", expectedStatus: "open" });
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByRole("button", { name: "第 3 项优先级：P0" })).toBeVisible());
    await user.click(screen.getByRole("button", { name: "优先级" }));
    const waiting = within(screen.getByRole("region", { name: /待处理，\d 项/u })).getAllByRole("listitem");
    expect(waiting.map((row) => row.getAttribute("data-priority"))).toEqual(["p0", "p1"]);
  });
});

describe("tags", () => {
  it("shows tags on the cards and lists them with their unfinished counts above the lists", async () => {
    await setupInList();
    const row = await itemRow(6, LOGS);
    expect(within(row).getByTitle("标签 #windows")).toHaveTextContent("#windows");
    expect(within(row).getByTitle("标签 #ui")).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "标签" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(["#本周3", "#ui2", "#windows2"]);
    // Above the lists.
    expect(nav.compareDocumentPosition(screen.getByRole("list", { name: "清单" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens a tag as a view across the lists, grouped by list, and filters a list by tag", async () => {
    const user = userEvent.setup();
    await setupInList();
    await user.click(within(screen.getByRole("navigation", { name: "标签" })).getByRole("button", { name: /本周/u }));
    expect(await screen.findByRole("heading", { level: 2, name: "#本周" })).toBeVisible();
    expect(screen.getByRole("region", { name: "#本周" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Paraself 遗留问题调研，1 项" })).toBeVisible();
    expect(screen.getByRole("region", { name: "官网首页加载性能调研，1 项" })).toBeVisible();
    expect(screen.getByRole("region", { name: "学习，1 项" })).toBeVisible();
    expect(screen.getByRole("navigation", { name: "标签" }).querySelector('[aria-current="true"]')).toHaveTextContent("#本周");

    fireEvent.click(screen.getByRole("button", { name: "Paraself 遗留问题调研" }));
    await screen.findByRole("heading", { level: 2, name: "Paraself 遗留问题调研" });
    await user.type(screen.getByRole("searchbox", { name: "在本清单中筛选" }), "#ui");
    expect(screen.queryByRole("button", { name: new RegExp(WINDOWS, "u") })).toBeNull();
    expect(screen.getByRole("button", { name: new RegExp(TRAY, "u") })).toBeVisible();
    expect(screen.getByRole("button", { name: new RegExp(LOGS, "u") })).toBeVisible();
  });

  it("adds and takes off tags in the drawer, refusing what is no tag", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    const field = within(drawer).getByRole("combobox", { name: "标签" });
    await user.type(field, "123{Enter}");
    expect(within(drawer).getByRole("status")).toHaveTextContent("不能全是数字");
    await user.clear(field);
    await user.type(field, "#本周{Enter}");
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "去掉标签 #本周" })).toBeVisible());
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.tags).toEqual(["ui", "本周"]);
    expect(within(drawer).getByText("加标签 #本周")).toBeVisible();
    await user.click(within(drawer).getByRole("button", { name: "去掉标签 #ui" }));
    await waitFor(() => expect((screen.getByRole("complementary", { name: "第 3 项详情" }))).not.toHaveTextContent("#ui ✕"));
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.tags).toEqual(["本周"]);
  });

  it("adds a tag to the items picked and takes one off from them", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(screen.getByLabelText("选择第 6 项"));
    const bar = screen.getByRole("toolbar", { name: "批量操作" });
    await user.click(within(bar).getByRole("button", { name: "标签 ▾" }));
    await user.type(within(screen.getByRole("dialog", { name: "加标签 / 去标签" })).getByRole("textbox", { name: "加标签" }), "等回复{Enter}");
    expect(await screen.findByText("成功 2 项。", { selector: ".todo-message" })).toBeVisible();
    const tagsOf = async () => (await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.filter((item) => [3, 6].includes(item.number)).map((item) => item.tags);
    expect(await tagsOf()).toEqual([["ui", "等回复"], ["windows", "ui", "等回复"]]);

    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(screen.getByLabelText("选择第 6 项"));
    await user.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "标签 ▾" }));
    await user.click(within(screen.getByRole("dialog", { name: "加标签 / 去标签" })).getByRole("button", { name: "去标签 #ui" }));
    await waitFor(async () => expect(await tagsOf()).toEqual([["等回复"], ["windows", "等回复"]]));
  });
});

describe("moving to another list", () => {
  it("moves one item from its menu: new in the target with its fields, gone from here, both sides told", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const row = await itemRow(3, TRAY);
    await user.click(within(row).getByRole("button", { name: "第 3 项状态：待处理" }));
    await user.click(await screen.findByRole("menuitem", { name: "移到…" }));
    const dialog = await screen.findByRole("dialog", { name: "移到…" });
    expect(within(dialog).getByText("把 1 项移到…")).toBeVisible();
    // The list it is in is not offered; the others are, with project, source and size.
    const options = within(dialog).getAllByRole("option").map((option) => option.textContent);
    expect(options.some((text) => text?.startsWith("Paraself 遗留问题调研"))).toBe(false);
    expect(options).toContain("官网首页加载性能调研paraself-site · Claude Code · 3 项");

    await user.type(within(dialog).getByRole("combobox", { name: "搜索清单" }), "官网");
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
    await user.click(within(dialog).getByRole("option", { name: /官网首页加载性能调研/u }));
    expect(await screen.findByText("已移到「官网首页加载性能调研」1 项。", { selector: ".todo-message" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "移到…" })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(`第 3 项：${TRAY}`, "u") })).toBeNull();

    const [site] = (await store.listTodoLists({ listId: SITE })).lists;
    expect(site!.items.at(-1)).toMatchObject({ number: 4, title: TRAY, priority: "p2", tags: ["ui"], status: "open" });
    expect(site!.history.at(-1)).toMatchObject({ item: 4, moved: { direction: "in", listTitle: "Paraself 遗留问题调研", item: 3 } });
    const [research] = (await store.listTodoLists({ listId: RESEARCH })).lists;
    expect(research!.items.map((item) => item.number)).toEqual([1, 2, 4, 5, 6]);
    expect(research!.history.at(-1)).toMatchObject({ item: 3, deleted: true, moved: { direction: "out", listTitle: "官网首页加载性能调研", item: 4 } });
  });

  it("moves the items picked from the bar, and from the drawer", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(screen.getByLabelText("选择第 6 项"));
    await user.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "移到…" }));
    const dialog = await screen.findByRole("dialog", { name: "移到…" });
    expect(within(dialog).getByText("把 2 项移到…")).toBeVisible();
    await user.click(within(dialog).getByRole("option", { name: /官网首页加载性能调研/u }));
    expect(await screen.findByText("已移到「官网首页加载性能调研」2 项。", { selector: ".todo-message" })).toBeVisible();
    expect((await store.listTodoLists({ listId: SITE })).lists[0]!.items.map((item) => item.title).slice(-2)).toEqual([TRAY, LOGS]);

    fireEvent.click(toggleOf(await itemRow(2, WINDOWS), 2));
    const drawer = await screen.findByRole("complementary", { name: "第 2 项详情" });
    await user.click(within(drawer).getByRole("button", { name: "移到…" }));
    await user.click(await screen.findByRole("option", { name: /学习/u }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "第 2 项详情" })).toBeNull());
    expect((await store.listTodoLists({ listId: "preview-todo-learning" })).lists[0]!.items.at(-1)).toMatchObject({ title: WINDOWS, status: "in_progress" });
  });

  it("leaves an item that was changed meanwhile, and says why", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    // Changed behind the page's back (an agent): the page still shows it open.
    await store.changeTodoItem({ listId: RESEARCH, item: 3, status: "in_progress", expectedStatus: "open" });
    await user.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "移到…" }));
    await user.click(await screen.findByRole("option", { name: /官网首页加载性能调研/u }));
    expect(await screen.findByText("没有移动：跳过 1 项（1 项已被改过）。", { selector: ".todo-message" })).toBeVisible();
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.map((item) => item.number)).toContain(3);
  });

  it("says when the original could not be taken out, and keeps the picker open with that", async () => {
    const user = userEvent.setup();
    const store = createTodoPreview();
    const moveTodoItemsToList = vi.fn(async () => {
      throw new Error("已复制到「官网首页加载性能调研」，但没能从「Paraself 遗留问题调研」删掉原项：磁盘写入失败。这些事项现在两边各有一份，请手动删掉重复的那份。");
    });
    await setupInList({ ...store, moveTodoItemsToList });
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    await user.click(await screen.findByRole("button", { name: "移到…" }));
    await user.click(await screen.findByRole("option", { name: /官网首页加载性能调研/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent("两边各有一份");
    expect(screen.getByRole("dialog", { name: "移到…" })).toBeVisible();
  });
});

describe("keyboard", () => {
  const focusFirst = async () => {
    const six = toggleOf(await itemRow(3, TRAY), 3);
    six.focus();
    return six;
  };

  it("moves focus with the arrows, picks with Space, extends with Shift, and puts the pick down with Escape", async () => {
    await setupInList();
    const three = await focusFirst();
    expect(three).toHaveFocus();
    // Order on the page: the item under way first, then the waiting ones.
    const order = screen.getAllByRole("button", { name: /^第 \d+ 项：/u }).map((button) => button.getAttribute("data-todo-focus"));
    const at = order.indexOf(three.getAttribute("data-todo-focus"));
    fireEvent.keyDown(three, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-todo-focus")).toBe(order[at + 1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(three).toHaveFocus();

    fireEvent.keyDown(three, { key: " " });
    expect(screen.getByLabelText("选择第 3 项")).toBeChecked();
    fireEvent.keyDown(three, { key: " " });
    expect(screen.getByLabelText("选择第 3 项")).not.toBeChecked();

    fireEvent.keyDown(three, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toHaveTextContent("已选 2 项");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "批量操作" })).toBeNull());
  });

  it("does not turn Space into a click that opens the drawer, and Enter opens it", async () => {
    await setupInList();
    const three = await focusFirst();
    fireEvent.keyDown(three, { key: " " });
    fireEvent.keyUp(three, { key: " " });
    expect(screen.queryByRole("complementary", { name: "第 3 项详情" })).toBeNull();
    fireEvent.click(three);
    expect(await screen.findByRole("complementary", { name: "第 3 项详情" })).toBeVisible();
  });

  it("opens the status menu with E and the priority menu with P, which take arrows and Enter", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const three = await focusFirst();
    fireEvent.keyDown(three, { key: "e" });
    const status = await screen.findByRole("menu", { name: "第 3 项" });
    expect(within(status).getByRole("menuitemradio", { name: /待处理/u })).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.status).toBe("in_progress"));

    const again = toggleOf(await itemRow(3, TRAY), 3);
    again.focus();
    fireEvent.keyDown(again, { key: "P" });
    const priority = await screen.findByRole("menu", { name: "第 3 项优先级" });
    expect(within(priority).getByRole("menuitemradio", { name: "P2" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.priority).toBe("p0"));
  });

  it("closes a menu with Escape and gives focus back to the item", async () => {
    await setupInList();
    const three = await focusFirst();
    fireEvent.keyDown(three, { key: "e" });
    const menu = await screen.findByRole("menu", { name: "第 3 项" });
    fireEvent.keyDown(within(menu).getAllByRole("menuitemradio")[0]!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(toggleOf(screen.getByText(TRAY).closest("li")!, 3)).toHaveFocus());
  });

  it("opens the move picker with M and the delete confirmation with Backspace, for the picked items when the focused one is among them", async () => {
    await setupInList();
    const three = await focusFirst();
    fireEvent.keyDown(three, { key: "m" });
    expect(await screen.findByText("把 1 项移到…")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索清单" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "移到…" })).toBeNull());

    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(screen.getByLabelText("选择第 6 项"));
    toggleOf(await itemRow(3, TRAY), 3).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    const dialog = await screen.findByRole("dialog", { name: "删除 2 项" });
    expect(within(dialog).getByText(/第 3 项「/u)).toBeVisible();
  });

  it("does nothing while typing in a field", async () => {
    const user = userEvent.setup();
    await setupInList();
    const filter = screen.getByRole("searchbox", { name: "在本清单中筛选" });
    await user.type(filter, "empm");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(filter).toHaveValue("empm");
    await user.type(filter, "{Backspace}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists the item keys in the keyboard cheat sheet that 「?」 opens", async () => {
    const { ShortcutHelpDialog } = await import("../src/renderer/components/ShortcutHelpDialog.js");
    render(<ShortcutHelpDialog onClose={() => undefined} />);
    const group = within(screen.getByRole("region", { name: "待办事项列表" }));
    for (const keys of ["E", "P", "M", "⌫", "Esc", "空格"]) expect(group.getAllByText(keys).length).toBeGreaterThan(0);
    expect(group.getByText("移到其它清单…（已选中的一并移）")).toBeVisible();
  });

  it("shows the keys under the list, and a ring around the item in focus", async () => {
    await setupInList();
    expect(screen.getByLabelText("快捷键")).toHaveTextContent("移到…");
    const css = readFileSync(join(process.cwd(), "apps/desktop/src/renderer/components/pages/todos/todos.css"), "utf8");
    expect(css).toMatch(/\.todo-item:has\(\.todo-item-toggle:focus-visible\)[^{]*\{\s*outline: 2px solid var\(--accent-bright\)/u);
  });
});

describe("the detail drawer", () => {
  it("is 560px wide to begin with, is resized with the keys, remembers it, and goes back with a double click", async () => {
    const user = userEvent.setup();
    await setupInList();
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    const handle = await screen.findByRole("separator", { name: "拖动调整详情宽度" });
    expect(handle).toHaveAttribute("aria-valuenow", "560");
    expect(handle).toHaveAttribute("aria-valuemin", "360");
    const workspace = handle.closest<HTMLElement>(".todo-workspace")!;
    expect(workspace.style.getPropertyValue("--todo-drawer-width")).toBe("560px");

    handle.focus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(workspace.style.getPropertyValue("--todo-drawer-width")).toBe("580px");
    expect(localStorage.getItem("paraself.todos.drawer-width")).toBe("580");
    await user.keyboard("{Home}");
    expect(workspace.style.getPropertyValue("--todo-drawer-width")).toBe("360px");
    await user.keyboard("{End}");
    expect(Number.parseInt(workspace.style.getPropertyValue("--todo-drawer-width"), 10)).toBe(Math.round(window.innerWidth * 0.6));

    fireEvent.doubleClick(handle);
    expect(workspace.style.getPropertyValue("--todo-drawer-width")).toBe("560px");
    expect(localStorage.getItem("paraself.todos.drawer-width")).toBeNull();
  });

  it("starts from the width kept, and still works when storage throws", async () => {
    localStorage.setItem("paraself.todos.drawer-width", "480");
    const { unmount } = (await setupInList(), { unmount: cleanup });
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    expect(await screen.findByRole("separator", { name: "拖动调整详情宽度" })).toHaveAttribute("aria-valuenow", "480");
    unmount();
    const broken = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    await setupInList();
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    expect(await screen.findByRole("separator", { name: "拖动调整详情宽度" })).toHaveAttribute("aria-valuenow", "560");
    broken.mockRestore();
  });

  it("shows the detail as Markdown, and edits the source", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await store.changeTodoItem({ listId: RESEARCH, item: 3, detail: "有**重点**和 `code`。\n\n- 第一条\n- 第二条", expectedStatus: "open" });
    fireEvent.focus(window);
    const row = await itemRow(3, TRAY);
    // The card's second line is the first sentence as plain text.
    await waitFor(() => expect(row.querySelector(".todo-item-second")).toHaveTextContent("有重点和 code。"));
    fireEvent.click(toggleOf(row, 3));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    expect(drawer.querySelector(".todo-markdown strong")).toHaveTextContent("重点");
    expect(drawer.querySelector(".todo-markdown code")).toHaveTextContent("code");
    expect(drawer.querySelectorAll(".todo-markdown li")).toHaveLength(2);

    await user.click(within(drawer).getByRole("button", { name: "编辑" }));
    const source = within(drawer).getByRole("textbox", { name: "补充说明（Markdown 原文）" });
    expect(source).toHaveValue("有**重点**和 `code`。\n\n- 第一条\n- 第二条");
    await user.clear(source);
    await user.type(source, "改成一句话");
    await user.click(within(drawer).getByRole("button", { name: "保存" }));
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.detail).toBe("改成一句话"));
    expect(within(drawer).getAllByText("修改了补充说明").length).toBeGreaterThan(0);
  });

  it("groups the changes by day: time, who (我 for the reader) and what", async () => {
    const user = userEvent.setup();
    await setupInList();
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    await user.selectOptions(within(drawer).getByRole("combobox", { name: "优先级" }), "p1");
    const today = await within(drawer).findByRole("region", { name: "今天" });
    const entry = within(today).getAllByRole("listitem")[0]!;
    expect(entry.querySelector("time")).toHaveTextContent(/^\d{2}:\d{2}$/u);
    expect(entry.querySelector(".todo-history-who")).toHaveTextContent("我");
    expect(entry.querySelector(".todo-history-who")).toHaveAttribute("data-who", "me");
    expect(entry).toHaveTextContent("优先级从「P2」改为「P1」");
  });

  it("names a group by its day: 今天, 昨天, then the date and weekday (with the year when it is not this one)", async () => {
    const { historyDayLabel, historyByDay } = await import("../src/renderer/components/pages/todos/todo-text.js");
    expect(historyDayLabel("2026-11-10", "2026-11-10")).toBe("今天");
    expect(historyDayLabel("2026-11-09", "2026-11-10")).toBe("昨天");
    expect(historyDayLabel("2026-11-06", "2026-11-10")).toBe("11 月 6 日 周五");
    expect(historyDayLabel("2025-12-31", "2026-11-10")).toBe("2025 年 12 月 31 日 周三");
    const groups = historyByDay([{ at: new Date(2026, 10, 9, 10).toISOString() }, { at: new Date(2026, 10, 10, 9).toISOString() }, { at: new Date(2026, 10, 10, 11).toISOString() }], "2026-11-10");
    expect(groups.map((group) => [group.label, group.events.map((event) => event.at.slice(11, 13))])).toEqual([["今天", expect.any(Array)], ["昨天", expect.any(Array)]]);
    expect(groups[0]!.events).toHaveLength(2);
    expect(groups[0]!.events[0]!.at > groups[0]!.events[1]!.at).toBe(true);
  });
});

describe("review fixes", () => {
  it("keeps what is written in the detail box when the detail was changed elsewhere meanwhile", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await store.changeTodoItem({ listId: RESEARCH, item: 3, detail: "原来的说明", expectedStatus: "open" });
    fireEvent.focus(window);
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    await user.click(await within(drawer).findByRole("button", { name: "编辑" }));
    const box = within(drawer).getByRole("textbox", { name: "补充说明（Markdown 原文）" });
    await user.clear(box);
    await user.type(box, "我正在写的一段");
    // An agent rewrites it before the save.
    await store.changeTodoItem({ listId: RESEARCH, item: 3, detail: "别处改的说明", expectedStatus: "open" });
    await user.click(within(drawer).getByRole("button", { name: "保存" }));
    expect(await within(drawer).findByText(/补充说明已在别处改过/u)).toBeVisible();
    expect(within(drawer).getByRole("textbox", { name: "补充说明（Markdown 原文）" })).toHaveValue("我正在写的一段");
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.detail).toBe("别处改的说明");
  });

  it("does not give an item that already holds ten tags another from the bar, and says so", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    await store.changeTodoItem({ listId: RESEARCH, item: 3, tags: Array.from({ length: 10 }, (_, index) => `t${index}`), expectedStatus: "open" });
    fireEvent.focus(window);
    await screen.findByTitle("标签 #t9");
    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(screen.getByLabelText("选择第 6 项"));
    await user.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "标签 ▾" }));
    await user.type(within(screen.getByRole("dialog", { name: "加标签 / 去标签" })).getByRole("textbox", { name: "加标签" }), "新标签{Enter}");
    expect(await screen.findByText("成功 1 项，跳过 1 项（1 项已有 10 个标签）。", { selector: ".todo-message" })).toBeVisible();
    const items = (await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items;
    expect(items.find((item) => item.number === 3)!.tags).toHaveLength(10);
    expect(items.find((item) => item.number === 6)!.tags).toContain("新标签");
  });

  it("shows an item with more than ten tags (Obsidian wrote them) and lets one be taken off", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    const twelve = Array.from({ length: 12 }, (_, index) => `x${index}`);
    await store.changeTodoItem({ listId: RESEARCH, item: 3, tags: twelve, expectedStatus: "open" });
    fireEvent.focus(window);
    fireEvent.click(toggleOf(await itemRow(3, TRAY), 3));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    await user.click(await within(drawer).findByRole("button", { name: "去掉标签 #x0" }));
    await waitFor(async () => expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.tags).toHaveLength(11));
  });

  it("keeps the 修改人 column to its content: 2.5em at least, 6em at most", () => {
    const css = readFileSync(join(process.cwd(), "apps/desktop/src/renderer/components/pages/todos/todos.css"), "utf8");
    expect(css).toMatch(/\.todo-history-who \{[^}]*min-width: 2\.5em;[^}]*max-width: 6em;[^}]*text-overflow: ellipsis/u);
    expect(css).not.toMatch(/48px 1fr|auto 48px/u);
  });
});

describe("a change made while the page waits", () => {
  it("still reads the lists again (the revision), so tags added by an agent show up", async () => {
    const { store, api, view } = await setupInList();
    await store.changeTodoItem({ listId: RESEARCH, item: 3, tags: ["agent加的"], expectedStatus: "open" });
    view.rerender(<TodoPanel api={api} todoRevision={1} />);
    expect(await within(await itemRow(3, TRAY)).findByTitle("标签 #agent加的")).toBeVisible();
    await act(async () => undefined);
  });
});
