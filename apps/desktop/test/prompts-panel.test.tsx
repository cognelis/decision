// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptsPanel, matchesPrompt, type PromptsApi } from "../src/renderer/components/pages/prompts/PromptsPanel.js";
import { PROMPT_EXAMPLES } from "../src/shared/prompt-examples.js";
import type { PromptItem } from "../src/shared/renderer-api.js";

const AT = "2026-11-17T09:00:00.000Z";
const examples = (): PromptItem[] =>
  PROMPT_EXAMPLES.map((example, index) => ({ id: `00000000-0000-4000-8000-00000000000${index + 1}`, ...example, createdAt: AT, updatedAt: AT }));

/** An in-memory library behind the page's four calls, each a spy that can be made to fail. */
const setup = (overrides: Partial<PromptsApi> = {}, initial = examples()) => {
  let prompts = structuredClone(initial);
  const api: PromptsApi = {
    listPrompts: vi.fn(async () => structuredClone(prompts)),
    createPrompt: vi.fn(async (input) => {
      const prompt = { id: "00000000-0000-4000-8000-000000000009", ...input, createdAt: AT, updatedAt: AT };
      prompts = [prompt, ...prompts];
      return prompt;
    }),
    updatePrompt: vi.fn(async ({ id, title, body }) => {
      const next = { ...prompts.find((prompt) => prompt.id === id)!, title, body, updatedAt: "2026-11-17T09:00:01.000Z" };
      prompts = prompts.map((prompt) => (prompt.id === id ? next : prompt));
      return next;
    }),
    deletePrompt: vi.fn(async (id) => {
      prompts = prompts.filter((prompt) => prompt.id !== id);
    }),
    ...overrides,
  };
  render(<PromptsPanel api={api} />);
  return { api, user: userEvent.setup() };
};

const detail = () => screen.getByRole("region", { name: "提示词详情" });

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("提示词 page", () => {
  it("lists the three examples and shows the first one's body", async () => {
    setup();
    for (const example of PROMPT_EXAMPLES) expect(await screen.findByRole("button", { name: new RegExp(example.title) })).toBeVisible();
    expect(within(detail()).getByRole("heading", { name: "检查分支改动" })).toBeVisible();
    expect(within(detail()).getByText(PROMPT_EXAMPLES[0]!.body)).toBeVisible();
  });

  it("searches titles and bodies, and says when nothing matches", async () => {
    const { user } = setup();
    const search = await screen.findByRole("searchbox", { name: "搜索提示词" });
    await user.type(search, "redis");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(within(detail()).getByRole("heading", { name: "查询技术选型历史" })).toBeVisible();
    await user.clear(search);
    await user.type(search, "评审方案");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await user.type(search, "不存在");
    expect(screen.getByText("没有匹配的提示词")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(search).toHaveFocus();
  });

  it("matches every word, whatever the case", () => {
    const [, , redis] = examples();
    expect(matchesPrompt(redis!, "REDIS 调整")).toBe(true);
    expect(matchesPrompt(redis!, "redis 否决")).toBe(false);
    expect(matchesPrompt(redis!, "  ")).toBe(true);
  });

  it("creates a prompt, keeping the body exactly as typed", async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole("button", { name: "新建" }));
    const dialog = screen.getByRole("dialog", { name: "新建提示词" });
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("标题"), "发布前检查");
    await user.type(within(dialog).getByLabelText("正文"), "  缩进{Enter}第二行");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(api.createPrompt).toHaveBeenCalledWith({ title: "发布前检查", body: "  缩进\n第二行" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(detail()).getByRole("heading", { name: "发布前检查" })).toBeVisible();
  });

  it("keeps what was typed when a save fails, and saves it on retry", async () => {
    let fail = true;
    const { api, user } = setup({
      updatePrompt: vi.fn(async (input) => {
        if (fail) throw new Error("磁盘已满");
        return { ...input, createdAt: AT, updatedAt: "2026-11-17T09:00:02.000Z" };
      }),
    });
    await user.click(await within(await screen.findByRole("region", { name: "提示词详情" })).findByRole("button", { name: "编辑" }));
    const dialog = screen.getByRole("dialog", { name: "编辑提示词" });
    const body = within(dialog).getByLabelText("正文");
    await user.clear(body);
    await user.type(body, "新的正文");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("保存失败：磁盘已满");
    expect(body).toHaveValue("新的正文");
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.updatePrompt).toHaveBeenLastCalledWith({ id: examples()[0]!.id, expectedUpdatedAt: AT, title: "检查分支改动", body: "新的正文" });
    expect(within(detail()).getByText("新的正文")).toBeVisible();
  });

  it("after an edit refused because the prompt changed elsewhere, keeps the input and edits the new version when reopened", async () => {
    let stored = examples();
    const outside = { ...stored[0]!, body: "别处改过的正文", updatedAt: "2026-11-17T09:05:00.000Z" };
    const updatePrompt = vi.fn(async (input: Parameters<PromptsApi["updatePrompt"]>[0]) => {
      const current = stored.find((prompt) => prompt.id === input.id)!;
      if (current.updatedAt !== input.expectedUpdatedAt) throw new Error("这条提示词在别处被修改过");
      const next = { ...current, title: input.title, body: input.body, updatedAt: "2026-11-17T09:06:00.000Z" };
      stored = stored.map((prompt) => (prompt.id === input.id ? next : prompt));
      return next;
    });
    const { user } = setup({ listPrompts: vi.fn(async () => structuredClone(stored)), updatePrompt });
    await user.click(await within(await screen.findByRole("region", { name: "提示词详情" })).findByRole("button", { name: "编辑" }));
    // Saved from another window while this edit was open.
    stored = [outside, ...stored.slice(1)];
    let dialog = screen.getByRole("dialog", { name: "编辑提示词" });
    await user.clear(within(dialog).getByLabelText("正文"));
    await user.type(within(dialog).getByLabelText("正文"), "我的改动");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("在别处被修改过");
    expect(within(dialog).getByLabelText("正文")).toHaveValue("我的改动");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(within(dialog).getByRole("button", { name: "放弃" }));
    expect(within(detail()).getByText("别处改过的正文")).toBeVisible();

    await user.click(within(detail()).getByRole("button", { name: "编辑" }));
    dialog = screen.getByRole("dialog", { name: "编辑提示词" });
    expect(within(dialog).getByLabelText("正文")).toHaveValue("别处改过的正文");
    await user.type(within(dialog).getByLabelText("正文"), "，再补一句");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(updatePrompt).toHaveBeenLastCalledWith(expect.objectContaining({ expectedUpdatedAt: outside.updatedAt, body: "别处改过的正文，再补一句" }));
  });

  it("asks before throwing away an unsaved edit, and Escape alone does not", async () => {
    const { user } = setup();
    await user.click(await within(await screen.findByRole("region", { name: "提示词详情" })).findByRole("button", { name: "编辑" }));
    const dialog = screen.getByRole("dialog", { name: "编辑提示词" });
    await user.type(within(dialog).getByLabelText("标题"), "（改）");
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(within(dialog).getByText("放弃未保存的修改？")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "继续编辑" }));
    expect(within(dialog).getByLabelText("标题")).toHaveValue("检查分支改动（改）");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await user.click(within(dialog).getByRole("button", { name: "放弃" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(detail()).getByRole("heading", { name: "检查分支改动" })).toBeVisible();
  });

  it("continuing to edit after asking to cancel neither closes the form nor saves it", async () => {
    // The button under the pointer was 继续编辑; were it the same element as 保存 once the footer turns back, the
    // click's default action would submit the form (CUA found it saving a new prompt this way).
    for (const mode of ["create", "edit"] as const) {
      const { api, user } = setup();
      if (mode === "create") await user.click(await screen.findByRole("button", { name: "新建" }));
      else await user.click(await within(await screen.findByRole("region", { name: "提示词详情" })).findByRole("button", { name: "编辑" }));
      const name = mode === "create" ? "新建提示词" : "编辑提示词";
      await user.type(within(screen.getByRole("dialog", { name })).getByLabelText("标题"), "不应自动保存");
      if (mode === "create") await user.type(within(screen.getByRole("dialog", { name })).getByLabelText("正文"), "正文");
      await user.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "取消" }));
      await user.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "继续编辑" }));
      // Asked of the document afresh, not of the dialog element found before.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByRole("dialog", { name })).toBeVisible();
      expect(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "保存" })).toBeVisible();
      expect(api.createPrompt).not.toHaveBeenCalled();
      expect(api.updatePrompt).not.toHaveBeenCalled();
      // And 放弃 still only throws the edit away.
      await user.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "取消" }));
      await user.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "放弃" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.createPrompt).not.toHaveBeenCalled();
      expect(api.updatePrompt).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("deletes only once confirmed, and keeps the prompt when deleting fails", async () => {
    let fail = true;
    const { api, user } = setup({
      deletePrompt: vi.fn(async () => {
        if (fail) throw new Error("写入被拒绝");
      }),
    });
    await user.click(await within(await screen.findByRole("region", { name: "提示词详情" })).findByRole("button", { name: "删除" }));
    let dialog = screen.getByRole("dialog", { name: "删除提示词「检查分支改动」？" });
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.deletePrompt).not.toHaveBeenCalled();

    await user.click(within(detail()).getByRole("button", { name: "删除" }));
    dialog = screen.getByRole("dialog", { name: "删除提示词「检查分支改动」？" });
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("删除失败：写入被拒绝");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(within(detail()).getByRole("heading", { name: "评审方案" })).toBeVisible();
  });

  it("shows an empty library with a way to start one", async () => {
    setup({}, []);
    expect(await screen.findByRole("heading", { name: "还没有提示词" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "新建" })).toHaveLength(2);
  });

  it("copies the body, and says so when the clipboard refuses", async () => {
    const { user } = setup();
    // After userEvent.setup, which puts a clipboard of its own in place.
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await user.click(await within(await screen.findByRole("region", { name: "提示词详情" })).findByRole("button", { name: "复制" }));
    expect(writeText).toHaveBeenCalledWith(PROMPT_EXAMPLES[0]!.body);
    expect(await within(detail()).findByText("已复制")).toBeVisible();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(within(detail()).getByRole("button", { name: "复制" }));
    expect(await within(detail()).findByText("复制失败，可以选中正文手动复制")).toBeVisible();
  });

  it("says when the library cannot be read instead of showing it empty", async () => {
    setup({ listPrompts: vi.fn(async () => { throw new Error("提示词文件损坏"); }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("读取提示词失败：提示词文件损坏");
    expect(screen.queryByText("还没有提示词")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建" })).toBeDisabled();
  });
});
