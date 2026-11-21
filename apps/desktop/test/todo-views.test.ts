import type { TodoItemView, TodoListView } from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import { allGroups, groupCount, sortedItems, todayGroups, upcomingGroups } from "../src/renderer/components/pages/todos/todo-views.js";

const TODAY = "2026-11-09";

const item = (number: number, overrides: Partial<TodoItemView> = {}): TodoItemView => ({
  number, title: `第 ${number} 项`, detail: null, disposition: null, status: "open", priority: null, due: null, tags: [], note: null, notedAt: null,
  changedAt: null, changedBy: null, changedInObsidian: false, ...overrides,
});

const list = (id: string, items: TodoItemView[], overrides: Partial<TodoListView> = {}): TodoListView => ({
  id, title: `清单 ${id}`, summary: null, project: null, tags: [], sourceKind: "app_manual", sourceClient: null, longTerm: false, archived: false,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", revision: 1, relativePath: `${id}.md`, items, history: [],
  counts: { open: 0, inProgress: 0, done: 0, dropped: 0 }, ...overrides,
});

describe("todo views", () => {
  const lists = [
    list("a", [
      item(1, { due: "2026-11-07" }),
      item(2, { due: "2026-11-09", priority: "p3" }),
      item(3, { status: "in_progress" }),
      item(4, { status: "in_progress", due: "2026-11-08" }),
      item(5, { status: "done", due: "2026-11-08" }),
      item(6, { due: "2026-11-10", priority: "p1" }),
      item(7, { due: "2026-11-16" }),
      item(8, { due: "2026-11-17" }),
    ]),
    list("b", [item(1, { due: "2026-11-09", priority: "p1" }), item(2, { due: "2026-11-10" })]),
    list("old", [item(1, { due: "2026-11-07" })], { archived: true }),
  ];

  it("today: overdue, due today and under way, an item once, the finished and archived left out", () => {
    const groups = todayGroups(lists, TODAY);
    expect(groups.map((group) => [group.key, group.entries.map((entry) => `${entry.list.id}${entry.item.number}`)])).toEqual([
      ["overdue", ["a1", "a4"]],
      ["today", ["b1", "a2"]],
      ["in_progress", ["a3"]],
    ]);
  });

  it("upcoming: the seven days after today, by day, the highest priority first", () => {
    const groups = upcomingGroups(lists, TODAY);
    expect(groups.map((group) => [group.key, group.entries.map((entry) => `${entry.list.id}${entry.item.number}`)])).toEqual([
      ["2026-11-10", ["a6", "b2"]],
      ["2026-11-16", ["a7"]],
    ]);
    expect(groups[0]!.title).toBe("明天 · 11月10日 周二");
    expect(groupCount(groups)).toBe(3);
  });

  it("all: by list, in each note's order, without finished items or archived lists", () => {
    const groups = allGroups(lists);
    expect(groups.map((group) => [group.key, group.entries.length])).toEqual([["a", 7], ["b", 2]]);
  });

  it("sorts for display by priority or due date, keeping the note's order among equals", () => {
    const items = [item(1), item(2, { priority: "p3", due: "2026-11-20" }), item(3, { priority: "p1" }), item(4, { due: "2026-11-10" }), item(5, { priority: "p1", due: "2026-11-12" })];
    expect(sortedItems(items, "manual").map((entry) => entry.number)).toEqual([1, 2, 3, 4, 5]);
    expect(sortedItems(items, "priority").map((entry) => entry.number)).toEqual([5, 3, 2, 4, 1]);
    expect(sortedItems(items, "due").map((entry) => entry.number)).toEqual([4, 5, 2, 3, 1]);
  });
});
