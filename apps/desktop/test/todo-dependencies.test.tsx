// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTodoList, todoListView, TodoDependencies } from "@cognelis/decision-core";
import type { TodoItemChange, TodoItemView } from "@cognelis/decision-protocol";
import { TodoDependencySection } from "../src/renderer/components/pages/todos/TodoDependencySection.js";
import { dependencyLabel, eventText, itemPrompt, listDependencySummary } from "../src/renderer/components/pages/todos/todo-text.js";

afterEach(cleanup);
const setup = (extra: Partial<TodoItemView> = {}) => {
  const list = todoListView(createTodoList({ title: "本清单", items: [{ title: "发布" }, { title: "打包" }, { title: "验签" }] }, { kind: "app_manual", client: null }, "list", new Date()), "list.md");
  list.items[0]!.id = "publish";
  Object.assign(list.items[1]!, { id: "build", status: "done" });
  Object.assign(list.items[2]!, { id: "sign", dependsOn: ["publish"] });
  const graph = new TodoDependencies([list]);
  const item = { ...graph.enrich(list.id, list.items[0]!), ...extra };
  const api = {
    listTodoLists: vi.fn(async () => ({ todoVersion: 1 as const, lists: [list], total: 1, nextOffset: null, unreadable: [] })),
    changeTodoItem: vi.fn(async (_request: TodoItemChange) => ({ todoVersion: 1 as const, status: "saved" as const, list: null, item })),
  };
  const onOpen = vi.fn();
  const onChanged = vi.fn(async () => undefined);
  render(<TodoDependencySection api={api} list={list} item={item} busy={false} onOpen={onOpen} onChanged={onChanged} />);
  return { api, onOpen, onChanged, item, list };
};

describe("dependency drawer", () => {
  it("explains disabled self/cycle choices, includes completed items, supports keyboard picking and refreshes after saving", async () => {
    const { api, onChanged } = setup();
    fireEvent.click(screen.getByRole("button", { name: "添加前置" }));
    const choices = await screen.findAllByRole("option");
    expect(choices[0]).toHaveAttribute("aria-disabled", "true");
    expect(choices[0]).toHaveTextContent("不能依赖自己");
    expect(choices[2]).toHaveAttribute("aria-disabled", "true");
    expect(choices[2]).toHaveTextContent("会形成循环依赖");
    const search = screen.getByRole("combobox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(choices[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.change(search, { target: { value: "打包" } });
    expect(screen.getByRole("option")).toHaveTextContent("已完成");
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(api.changeTodoItem).toHaveBeenCalledWith({ listId: "list", item: 1, expectedStatus: "open", addDependencies: [{ listId: "list", item: 2 }] }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.listTodoLists).toHaveBeenCalledWith(expect.objectContaining({ includeClosed: true }));
  });

  it("keeps missing titles, unlinks by stable id and navigates to a dependent in its own list", async () => {
    const missing = { id: "missing", listId: null, listTitle: null, item: null, title: "曾经的前置", status: null, issue: "missing" as const };
    const { api, onOpen } = setup({ prerequisites: [missing], unmetPrerequisites: [missing] });
    expect(screen.getByRole("button", { name: "曾经的前置" })).toBeDisabled();
    expect(screen.getByText("找不到该事项 · 需确认")).toBeVisible();
    fireEvent.click(within(screen.getByRole("region", { name: "后续事项" })).getByRole("button", { name: "验签" }));
    expect(onOpen).toHaveBeenCalledWith("list", 3);
    fireEvent.click(screen.getByRole("button", { name: "解除前置：曾经的前置" }));
    await waitFor(() => expect(api.changeTodoItem).toHaveBeenCalledWith({ listId: "list", item: 1, expectedStatus: "open", removeDependencies: ["missing"] }));
  });

  it("derives warnings without inventing a status and carries prerequisites into agent instructions", () => {
    const { item, list } = setup({ prerequisites: [{ id: "p", listId: "other", listTitle: "前置", item: 2, title: "审批", status: "dropped", issue: null }] });
    expect(dependencyLabel(item)).toBe("前置需确认");
    expect(itemPrompt(list, item)).toContain("前置：审批（已放弃；other #2）");
    expect(eventText({ previous: "open", status: "open", dependencies: { from: ["a"], to: ["b", "c"] } })).toBe("添加 2 项前置；解除 1 项前置");
  });
});

describe("list dependency counts", () => {
  const fixture = () => {
    const make = (id: string, titles: string[]) => todoListView(createTodoList({ title: id, items: titles.map(title => ({ title })) }, { kind: "app_manual", client: null }, id, new Date()), `${id}.md`);
    const a = make("a", ["签名", "配置", "本地验收"]);
    const b = make("b", ["发布", "已完成后续", "已放弃后续", "间接后续"]);
    Object.assign(a.items[0]!, { id: "sign" });
    Object.assign(a.items[1]!, { id: "config", status: "in_progress" });
    Object.assign(a.items[2]!, { dependsOn: ["sign"] });
    Object.assign(b.items[0]!, { id: "release", dependsOn: ["sign", "config"] });
    Object.assign(b.items[1]!, { status: "done", dependsOn: ["sign"] });
    Object.assign(b.items[2]!, { status: "dropped", dependsOn: ["sign"] });
    Object.assign(b.items[3]!, { dependsOn: ["release"] });
    const read = () => { const graph = new TodoDependencies([a, b]); return { ...a, items: a.items.map(item => graph.enrich(a.id, item)) }; };
    return { a, b, read };
  };

  it("deduplicates direct local and cross-list dependents, excluding finished and indirect ones", () => {
    const { read } = fixture();
    expect(listDependencySummary(read())).toEqual({
      count: 2,
      description: "后续 2 项等待。本清单有 2 项未完成前置，其中 1 个后续事项来自其他清单。请先查看这些事项各自的前置条件。",
    });
  });

  it.each(["done", "dropped"] as const)("stops counting when prerequisites or dependents are %s", status => {
    const { a, b, read } = fixture();
    a.items[0]!.status = status;
    expect(listDependencySummary(read()).count).toBe(1);
    b.items[0]!.status = status;
    expect(listDependencySummary(read()).count).toBe(0);
    a.items[0]!.status = "open";
    expect(listDependencySummary(read()).count).toBe(1);
  });

  it("does not advertise ambiguous identities or cycles as actionable prerequisites", () => {
    const { a, b, read } = fixture();
    Object.assign(b.items[3]!, { id: "sign" });
    expect(read().items[0]!.dependents).toEqual([]);
    expect(listDependencySummary(read()).count).toBe(1);
    Object.assign(a.items[1]!, { dependsOn: ["release"] });
    expect(listDependencySummary(read()).count).toBe(0);
  });

  it("handles older responses without dependency fields", () => {
    const { a } = fixture();
    expect(listDependencySummary(a).count).toBe(0);
  });
});
