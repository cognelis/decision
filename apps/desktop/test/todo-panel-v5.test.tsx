// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_CLIENTS, clientSummary } from "@cognelis/decision-integrations";
import { rememberClients } from "../src/renderer/client-labels.js";
import { TodoPanel, type TodoApi } from "../src/renderer/components/pages/todos/TodoPanel.js";
import { copiedNotice, pickedPrompt, type PromptEntry } from "../src/renderer/components/pages/todos/todo-text.js";
import { createTodoPreview } from "../src/renderer/preview-todos.js";

/** 待办 page, fifth version: 处置备注 and 复制给 agent for the items picked. Against the preview's lists. */

const RESEARCH = "preview-todo-research";
const WINDOWS = "Windows 上 bridge 路径含空格时接入失败";
const TRAY = "托盘提示没有区分复盘";
const LOGS = "日志页的用途筛选在最小窗口下换行错位";

const setup = (overrides: Partial<TodoApi> = {}) => {
  const store = createTodoPreview();
  const api: TodoApi = { ...store, openVaultDocument: vi.fn(async () => undefined), ...overrides };
  const view = render(<TodoPanel api={api} todoRevision={0} />);
  return { store, api, view };
};
const setupInList = async (title = "Paraself 遗留问题调研") => {
  const rendered = setup();
  fireEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("heading", { level: 2, name: title });
  return rendered;
};
const itemRow = async (number: number, title: string): Promise<HTMLElement> =>
  (await screen.findByRole("button", { name: new RegExp(`第 ${number} 项：${title}`, "u") })).closest("li")!;
const clipboard = () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
};

beforeEach(() => {
  localStorage.clear();
  rememberClients(BUILT_IN_CLIENTS.map(clientSummary));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

const entry = (listId: string, number: number, title: string, extra: Partial<PromptEntry["item"]> = {}): PromptEntry => ({
  list: { id: listId, title: `清单 ${listId}` },
  item: { number, title, status: "open", priority: null, disposition: null, ...extra },
});

describe("the text copied for an agent", () => {
  it("names the list and its id, each item with its number and priority, and the reader's 处置意见 under it", () => {
    const prompt = pickedPrompt([
      entry("a", 2, "修引号", { priority: "p0", disposition: "先只修引号\n改完在虚拟机上验证" }),
      entry("a", 3, "托盘提示"),
      entry("a", 6, "筛选错位", { priority: "p2", disposition: "改成横向滚动" }),
    ])!;
    expect(prompt).toMatchObject({ count: 3, skipped: 0 });
    expect(prompt.text).toBe(
      [
        "请处理 Paraself 待办清单「清单 a」（listId: a）里的下面 3 项，清单里其它事项不要动：",
        "",
        "- #2 [P0] 修引号",
        "  我的处置意见：先只修引号",
        "    改完在虚拟机上验证",
        "- #3 托盘提示",
        "- #6 [P2] 筛选错位",
        "  我的处置意见：改成横向滚动",
        "",
        "先用 list_todo_lists 读这份清单，拿到每项的补充说明和最新进展。一次处理一项：先核对前置事项；未完成的前置应先处理，已放弃、缺失或循环的前置先确认，不要自动跳过。开始时用 update_todo_item 把它标为 in_progress；完成后标为 done，并在 note 里写明做了什么、怎么验证的；决定不做就标为 dropped 并写明原因。有「我的处置意见」的，按意见办；意见和实际情况冲突时先停下来问我。",
      ].join("\n"),
    );
  });

  it("splits items from several lists by list, each with its own listId", () => {
    const prompt = pickedPrompt([entry("a", 1, "甲一"), entry("b", 4, "乙四", { disposition: "别动 CI" }), entry("a", 2, "甲二")])!;
    expect(prompt.text).toContain("请处理 Paraself 待办里的下面 3 项（分属 2 份清单），清单里其它事项不要动：");
    expect(prompt.text).toContain("清单「清单 a」（listId: a）：\n- #1 甲一\n- #2 甲二\n\n清单「清单 b」（listId: b）：\n- #4 乙四\n  我的处置意见：别动 CI");
    expect(prompt.text).toContain("先用 list_todo_lists 读这几份清单（每份用各自的 listId）");
  });

  it("leaves out what is done or dropped and says how many, and has nothing when none is left", () => {
    const prompt = pickedPrompt([entry("a", 1, "甲一"), entry("a", 2, "甲二", { status: "done" }), entry("a", 3, "甲三", { status: "dropped" })])!;
    expect(prompt).toMatchObject({ count: 1, skipped: 2 });
    expect(prompt.text).not.toContain("甲二");
    expect(copiedNotice(prompt.count, prompt.skipped)).toBe("已复制 1 项，粘贴到 Claude Code 或 Codex 即可（跳过 2 项已处理的）");
    expect(copiedNotice(3, 0)).toBe("已复制 3 项，粘贴到 Claude Code 或 Codex 即可");
    expect(pickedPrompt([entry("a", 2, "甲二", { status: "done" })])).toBeNull();
  });
});

describe("复制给 agent from the items picked, the row and the drawer", () => {
  it("copies what is picked from the batch bar's first button, with each 处置备注, and says how many", async () => {
    const writeText = clipboard();
    await setupInList();
    fireEvent.click(screen.getByLabelText("选择第 2 项"));
    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(screen.getByLabelText("选择第 6 项"));
    const bar = screen.getByRole("toolbar", { name: "批量操作" });
    const buttons = within(bar).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("复制给 agent");
    expect(buttons[0]).toHaveClass("primary-button");
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain(`（listId: ${RESEARCH}）里的下面 3 项，清单里其它事项不要动：`);
    expect(text).toContain(`- #2 [P1] ${WINDOWS}\n  我的处置意见：先只修引号，不要改安装目录结构；改完在我的 Windows 虚拟机上验证`);
    expect(text).toContain(`- #3 [P2] ${TRAY}\n- #6 [P2] ${LOGS}\n  我的处置意见：改成横向滚动，不要换行`);
    expect(text).not.toContain("#1");
    expect(await screen.findByText("已复制 3 项，粘贴到 Claude Code 或 Codex 即可", { selector: ".todo-message" })).toBeVisible();
    // The pick stays, to go on with.
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toHaveTextContent("已选 3 项");
  });

  it("offers the text by hand when the clipboard refuses a batch", async () => {
    const writeText = clipboard();
    writeText.mockRejectedValueOnce(new Error("Document is not focused."));
    await setupInList();
    fireEvent.click(screen.getByLabelText("选择第 3 项"));
    fireEvent.click(within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole("button", { name: "复制给 agent" }));
    const fallback = await screen.findByRole("alert");
    expect((within(fallback).getByRole("textbox", { name: "要交给 agent 的内容" }) as HTMLTextAreaElement).value).toContain(`- #3 [P2] ${TRAY}`);
  });

  it("copies one item from its row menu", async () => {
    const user = userEvent.setup();
    const writeText = clipboard();
    await setupInList();
    const row = await itemRow(6, LOGS);
    await user.click(within(row).getByRole("button", { name: /^第 6 项状态/u }));
    await user.click(await screen.findByRole("menuitem", { name: "复制给 agent" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("里的下面 1 项");
    expect(writeText.mock.calls[0]![0]).toContain("我的处置意见：改成横向滚动，不要换行");
    expect(await screen.findByText("已复制 1 项，粘贴到 Claude Code 或 Codex 即可", { selector: ".todo-message" })).toBeVisible();

  });
});

describe("处置备注 on the page", () => {
  it("shows on the card as a small line and in the drawer's box", async () => {
    await setupInList();
    const row = await itemRow(6, LOGS);
    expect(within(row).getByText("处置：改成横向滚动，不要换行")).toHaveClass("todo-item-disposition");
    expect(within(await itemRow(3, TRAY)).queryByText(/^处置：/u)).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: new RegExp(`第 6 项：${LOGS}`, "u") }));
    const drawer = await screen.findByRole("complementary", { name: "第 6 项详情" });
    expect(within(drawer).getByRole("textbox", { name: "处置备注 · 给 agent 的人工意见" })).toHaveValue("改成横向滚动，不要换行");
  });

  it("is saved when the box loses focus and with the submit shortcut, and recorded as 修改了处置备注", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(within(await itemRow(3, TRAY)).getByRole("button", { name: new RegExp(`第 3 项：${TRAY}`, "u") }));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    const box = within(drawer).getByRole("textbox", { name: "处置备注 · 给 agent 的人工意见" });
    await user.click(box);
    await user.type(box, "只改文案，别动图标");
    await user.tab();
    const disposition = async () => (await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 3)!.disposition;
    await waitFor(async () => expect(await disposition()).toBe("只改文案，别动图标"));
    expect(await within(drawer).findByText("修改了处置备注")).toBeVisible();
    expect(within(await itemRow(3, TRAY)).getByText("处置：只改文案，别动图标")).toBeVisible();
    await waitFor(() => expect(box).toHaveValue(""));

    await user.click(box);
    await user.clear(box);
    await user.type(box, "改成两处{Meta>}{Enter}{/Meta}");
    await waitFor(async () => expect(await disposition()).toBe("改成两处"));
    await waitFor(() => expect(box).toHaveValue(""));
    await user.tab();
    await user.click(box);
    await user.tab();
    expect(await disposition()).toBe("改成两处");
    await user.click(box);
    await user.type(box, "再补一处{Control>}{Enter}{/Control}");
    await waitFor(async () => expect(await disposition()).toBe("再补一处"));
    await waitFor(() => expect(box).toHaveValue(""));

    // Reopening still reads the saved opinion; explicitly clearing it removes it.
    await user.click(within(drawer).getByRole("button", { name: "关闭详情" }));
    await user.click(within(await itemRow(3, TRAY)).getByRole("button", { name: new RegExp(`第 3 项：${TRAY}`, "u") }));
    const reopened = within(await screen.findByRole("complementary", { name: "第 3 项详情" })).getByRole("textbox", { name: "处置备注 · 给 agent 的人工意见" });
    expect(reopened).toHaveValue("再补一处");
    await user.click(reopened);
    await user.clear(reopened);
    await user.tab();
    await waitFor(async () => expect(await disposition()).toBeNull());
  });

  it("is not written over a change made elsewhere meanwhile, and the typed text stays", async () => {
    const user = userEvent.setup();
    const { store } = await setupInList();
    fireEvent.click(within(await itemRow(6, LOGS)).getByRole("button", { name: new RegExp(`第 6 项：${LOGS}`, "u") }));
    const drawer = await screen.findByRole("complementary", { name: "第 6 项详情" });
    const box = within(drawer).getByRole("textbox", { name: "处置备注 · 给 agent 的人工意见" });
    await user.click(box);
    await store.changeTodoItem({ listId: RESEARCH, item: 6, disposition: "在 Obsidian 里改的", expectedStatus: "open" });
    await user.type(box, "加一句");
    await user.tab();
    expect(await within(drawer).findByText(/处置备注已在别处改过/u)).toBeVisible();
    expect((await store.listTodoLists({ listId: RESEARCH })).lists[0]!.items.find((item) => item.number === 6)!.disposition).toBe("在 Obsidian 里改的");
    expect(box).toHaveValue("改成横向滚动，不要换行加一句");
  });

  it("keeps the opinion when shortcut saving fails, then clears it after a successful retry", async () => {
    const user = userEvent.setup();
    const { api } = await setupInList();
    const change = vi.spyOn(api, "changeTodoItem").mockRejectedValueOnce(new Error("写入失败"));
    await user.click(within(await itemRow(3, TRAY)).getByRole("button", { name: new RegExp(`第 3 项：${TRAY}`, "u") }));
    const drawer = await screen.findByRole("complementary", { name: "第 3 项详情" });
    const box = within(drawer).getByRole("textbox", { name: "处置备注 · 给 agent 的人工意见" });
    await user.type(box, "保留这段意见{Meta>}{Enter}{/Meta}");
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("没有保存：写入失败");
    expect(box).toHaveValue("保留这段意见");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(box).toHaveValue(""));
    expect(change).toHaveBeenCalledTimes(2);
    expect(within(await itemRow(3, TRAY)).getByText("处置：保留这段意见")).toBeVisible();
  });
});
