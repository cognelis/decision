import { todoItemPending } from "@cognelis/decision-core/todo";
import type { TodoItemView, TodoListView } from "@cognelis/decision-protocol";

import { addDays, dayHeading, daysBetween, priorityRank } from "./todo-dates.js";

/** An item with the list it belongs to: what the views list across lists. */
export interface ViewEntry {
  list: TodoListView;
  item: TodoItemView;
}

export interface ViewGroup {
  /** Stable, for keys and tests: overdue, today, in_progress, a day, or a list's id. */
  key: string;
  title: string;
  entries: ViewEntry[];
}

export type TodoViewId = "today" | "upcoming" | "all";

export const VIEW_TITLES: Readonly<Record<TodoViewId, string>> = { today: "今天", upcoming: "即将到期", all: "全部未完成" };

/** Days ahead 即将到期 looks, counted from tomorrow. */
export const UPCOMING_DAYS = 7;

/** Higher priority first, then the earlier due date (none last), then the order the lists and notes give. */
const byUrgency = (left: ViewEntry, right: ViewEntry): number =>
  priorityRank(left.item.priority) - priorityRank(right.item.priority) ||
  (left.item.due ?? "9999-99-99").localeCompare(right.item.due ?? "9999-99-99");

const pendingEntries = (lists: readonly TodoListView[]): ViewEntry[] =>
  lists.filter((list) => !list.archived).flatMap((list) => list.items.filter((item) => todoItemPending(item.status)).map((item) => ({ list, item })));

const nonEmpty = (groups: ViewGroup[]): ViewGroup[] => groups.filter((group) => group.entries.length > 0);

/**
 * 今天: everything still to handle that is overdue, due today, or under way; an item counts once, in the first of those
 * that fits (an overdue one that is also under way is overdue).
 */
export const todayGroups = (lists: readonly TodoListView[], today: string): ViewGroup[] => {
  const entries = pendingEntries(lists);
  const days = (entry: ViewEntry): number | null => (entry.item.due === null ? null : daysBetween(today, entry.item.due));
  const overdue = entries.filter((entry) => (days(entry) ?? 0) < 0);
  const due = entries.filter((entry) => days(entry) === 0);
  const rest = entries.filter((entry) => entry.item.status === "in_progress" && !overdue.includes(entry) && !due.includes(entry));
  return nonEmpty([
    { key: "overdue", title: "已逾期", entries: overdue.sort(byUrgency) },
    { key: "today", title: "今天到期", entries: due.sort(byUrgency) },
    { key: "in_progress", title: "处理中", entries: rest.sort(byUrgency) },
  ]);
};

/** 即将到期: due in the next seven days after today, by day. */
export const upcomingGroups = (lists: readonly TodoListView[], today: string): ViewGroup[] => {
  const last = addDays(today, UPCOMING_DAYS);
  const soon = pendingEntries(lists).filter((entry) => entry.item.due !== null && entry.item.due > today && entry.item.due <= last);
  const days = [...new Set(soon.map((entry) => entry.item.due!))].sort();
  return days.map((day) => ({
    key: day,
    title: dayHeading(day, today),
    entries: soon.filter((entry) => entry.item.due === day).sort(byUrgency),
  }));
};

/** 全部未完成: by list, each in the order of its note. */
export const allGroups = (lists: readonly TodoListView[]): ViewGroup[] =>
  nonEmpty(
    lists
      .filter((list) => !list.archived)
      .map((list) => ({ key: list.id, title: list.title, entries: pendingEntries([list]) })),
  );

/** A view of one tag: `tag:本周`. */
export const TAG_VIEW = "tag:";
export const tagViewOf = (tag: string): string => `${TAG_VIEW}${tag}`;
export const tagOfView = (view: string): string | null => (view.startsWith(TAG_VIEW) ? view.slice(TAG_VIEW.length) : null);

const tagKey = (tag: string): string => tag.toLocaleLowerCase("zh-CN");

/** Every tag on an item still to be handled, in lists still worked on: the first spelling seen, the count, the most used first. */
export const tagCounts = (lists: readonly TodoListView[]): { name: string; count: number }[] => {
  const counts = new Map<string, { name: string; count: number }>();
  for (const entry of pendingEntries(lists)) {
    for (const tag of entry.item.tags) {
      const known = counts.get(tagKey(tag));
      if (known === undefined) counts.set(tagKey(tag), { name: tag, count: 1 });
      else known.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"));
};

/** 一个标签: the unfinished items carrying it across every list, grouped by list, each in the order of its note. */
export const tagGroups = (lists: readonly TodoListView[], tag: string): ViewGroup[] =>
  nonEmpty(
    lists
      .filter((list) => !list.archived)
      .map((list) => ({
        key: list.id,
        title: list.title,
        entries: pendingEntries([list]).filter((entry) => entry.item.tags.some((candidate) => tagKey(candidate) === tagKey(tag))),
      })),
  );

export const viewGroups = (view: string, lists: readonly TodoListView[], today: string): ViewGroup[] => {
  const tag = tagOfView(view);
  if (tag !== null) return tagGroups(lists, tag);
  return view === "today" ? todayGroups(lists, today) : view === "upcoming" ? upcomingGroups(lists, today) : allGroups(lists);
};

export const groupCount = (groups: readonly ViewGroup[]): number => groups.reduce((sum, group) => sum + group.entries.length, 0);

export type ItemSort = "manual" | "priority" | "due";

export const SORT_LABELS: Readonly<Record<ItemSort, string>> = { manual: "手动", priority: "优先级", due: "截止日期" };

/** Items in the order to show: the note's own, or by priority or due date (stable, so ties keep the note's order). Display only. */
export const sortedItems = (items: readonly TodoItemView[], sort: ItemSort): TodoItemView[] => {
  if (sort === "manual") return [...items];
  const key = (item: TodoItemView): [number, string] =>
    sort === "priority" ? [priorityRank(item.priority), item.due ?? "9999-99-99"] : [0, item.due ?? "9999-99-99"];
  return [...items].sort((left, right) => {
    const [leftRank, leftDue] = key(left);
    const [rightRank, rightDue] = key(right);
    return sort === "priority"
      ? leftRank - rightRank || leftDue.localeCompare(rightDue)
      : leftDue.localeCompare(rightDue) || priorityRank(left.priority) - priorityRank(right.priority);
  });
};
