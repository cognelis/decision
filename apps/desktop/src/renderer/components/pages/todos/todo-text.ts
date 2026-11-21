import { TODO_STATUS_LABELS, todoItemPending } from "@cognelis/decision-core/todo";
import type {
  TodoActor,
  TodoCounts,
  TodoEvent,
  TodoItemStatus,
  TodoItemView,
  TodoListView,
} from "@cognelis/decision-protocol";

import { zonedFormatter } from "../../../calendar-date.js";
import { sourceLabel } from "../../../client-labels.js";
import { dayText, localDay, PRIORITY_LABELS, WEEKDAY_NAMES, weekdayOf, daysBetween } from "./todo-dates.js";

export const statusLabel = (status: TodoItemStatus): string => TODO_STATUS_LABELS[status];

export const dependencyLabel = (item: Pick<TodoItemView, "prerequisites" | "dependencyCycle">): string | null => {
  if ((item.dependencyCycle?.length ?? 0) > 0) return "前置需确认 · 循环依赖";
  const prerequisites = item.prerequisites ?? [];
  if (prerequisites.length === 0) return null;
  if (prerequisites.some(entry => entry.issue !== null || entry.status === "dropped")) return "前置需确认";
  const waiting = prerequisites.filter(entry => entry.status !== "done").length;
  return waiting === 0 ? "前置已完成" : `等待 ${waiting} 项`;
};

export const listDependencySummary = (list: Pick<TodoListView, "id" | "items">): { count: number; description: string } => {
  const waiting = new Set<string>();
  const external = new Set<string>();
  let prerequisites = 0;
  for (const item of list.items) {
    if (!todoItemPending(item.status) || (item.dependencyCycle?.length ?? 0) > 0) continue;
    let hasWaiting = false;
    for (const dependent of item.dependents ?? []) {
      if (dependent.issue !== null || dependent.listId === null || dependent.item === null || dependent.status === null || !todoItemPending(dependent.status)) continue;
      const key = JSON.stringify([dependent.listId, dependent.item]);
      waiting.add(key);
      if (dependent.listId !== list.id) external.add(key);
      hasWaiting = true;
    }
    if (hasWaiting) prerequisites += 1;
  }
  return {
    count: waiting.size,
    description: `后续 ${waiting.size} 项等待。本清单有 ${prerequisites} 项未完成前置，其中 ${external.size} 个后续事项来自其他清单。请先查看这些事项各自的前置条件。`,
  };
};

/** Who made a change, as the page says it: the reader is 你, an agent goes by its client's name. */
export const actorLabel = (actor: TodoActor): string =>
  actor.kind === "user" ? "你" : actor.kind === "obsidian" ? "Obsidian" : sourceLabel(actor.client);

/** A name and the Chinese after it, a space between them when the name ends in a Latin letter or digit: Codex 的说明, 你的说明. */
export const joinedLabel = (name: string, rest: string): string => `${name}${/[A-Za-z0-9]$/u.test(name) ? " " : ""}${rest}`;

/** Where a list came from: the agent that saved it, or the reader on this page. */
export const listSourceLabel = (list: Pick<TodoListView, "sourceKind" | "sourceClient">): string =>
  list.sourceKind === "agent_capture" && list.sourceClient !== null ? sourceLabel(list.sourceClient) : "手动创建";

export const itemTotal = (counts: TodoCounts): number => counts.open + counts.inProgress + counts.done + counts.dropped;

/** Items still to be handled: not started, or under way. */
export const unfinished = (counts: TodoCounts): number => counts.open + counts.inProgress;

/** Items done with, one way or the other. */
export const handled = (counts: TodoCounts): number => counts.done + counts.dropped;

/** The counts in words, those at zero left out: 待处理 2 · 处理中 1 · 已完成 2 · 已放弃 1. */
export const countsText = (counts: TodoCounts): string =>
  ([
    ["open", counts.open],
    ["in_progress", counts.inProgress],
    ["done", counts.done],
    ["dropped", counts.dropped],
  ] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${statusLabel(status)} ${count}`)
    .join(" · ");

const dayTime = zonedFormatter({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const yearDayTime = zonedFormatter({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A moment as the knowledge page writes one: 11月9日 09:30, with the year when it is not this one. */
export const momentLabel = (at: string, now: Date = new Date()): string => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.getFullYear() === now.getFullYear() ? dayTime.format(date) : yearDayTime.format(date);
};

/** What one change did: moved the item to another status, changed its priority, due date or tags, moved it, or added a note alone. */
export const eventText = (
  event: Pick<TodoEvent, "previous" | "status"> & Partial<Pick<TodoEvent, "priority" | "due" | "tags" | "moved" | "detail" | "disposition" | "dependencies">>,
  today: string = localDay(new Date()),
): string => {
  const priority = (value: TodoEvent["priority"] extends infer C ? (C extends { from: infer F } ? F : never) : never): string =>
    value === null ? "无" : PRIORITY_LABELS[value];
  if (event.moved !== undefined) {
    return event.moved.direction === "out"
      ? `移到清单「${event.moved.listTitle}」（那边是第 ${event.moved.item} 项）`
      : `从清单「${event.moved.listTitle}」移来（原第 ${event.moved.item} 项）`;
  }
  const tagParts = (() => {
    if (event.tags === undefined) return [];
    const added = event.tags.to.filter((tag) => !event.tags!.from.includes(tag));
    const removed = event.tags.from.filter((tag) => !event.tags!.to.includes(tag));
    return [...(added.length === 0 ? [] : [`加标签 ${added.map((tag) => `#${tag}`).join(" ")}`]), ...(removed.length === 0 ? [] : [`去标签 ${removed.map((tag) => `#${tag}`).join(" ")}`])];
  })();
  const parts = [
    ...(event.previous === event.status ? [] : [`从「${statusLabel(event.previous)}」改为「${statusLabel(event.status)}」`]),
    ...(event.priority === undefined ? [] : [`优先级从「${priority(event.priority.from)}」改为「${priority(event.priority.to)}」`]),
    ...(event.due === undefined
      ? []
      : [
          event.due.to === null
            ? `清除了截止日期（原为 ${dayText(event.due.from ?? "", today)}）`
            : event.due.from === null
              ? `截止日期设为 ${dayText(event.due.to, today)}`
              : `截止日期从 ${dayText(event.due.from, today)} 改为 ${dayText(event.due.to, today)}`,
        ]),
  ];
  parts.push(...tagParts, ...(event.detail === true ? ["修改了补充说明"] : []), ...(event.disposition === true ? ["修改了处置备注"] : []));
  if (event.dependencies !== undefined) {
    const added = event.dependencies.to.filter(id => !event.dependencies!.from.includes(id)).length;
    const removed = event.dependencies.from.filter(id => !event.dependencies!.to.includes(id)).length;
    if (added > 0) parts.push(`添加 ${added} 项前置`);
    if (removed > 0) parts.push(`解除 ${removed} 项前置`);
  }
  return parts.length === 0 ? "添加了说明" : parts.join("；");
};

/** Who made a change in the timeline's own column: the reader is 我 there (elsewhere 你), an agent goes by its client's name. */
export const historyActorLabel = (actor: TodoActor): string => (actor.kind === "user" ? "我" : actorLabel(actor));

const hourMinute = zonedFormatter({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A moment as HH:mm. */
export const clockLabel = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : hourMinute.format(date);
};

/** A group's heading in the timeline: 今天, 昨天, otherwise 11 月 9 日 周一 (with the year when it is not this one). */
export const historyDayLabel = (day: string, today: string): string => {
  const days = daysBetween(today, day);
  if (days === 0) return "今天";
  if (days === -1) return "昨天";
  const [year = "", month = "0", date = "0"] = day.split("-");
  const base = `${Number(month)} 月 ${Number(date)} 日 ${WEEKDAY_NAMES[weekdayOf(day)]}`;
  return year === today.slice(0, 4) ? base : `${year} 年 ${base}`;
};

/** An item's changes grouped by the day they were made (the reader's own), the latest day and the latest change first. */
export const historyByDay = <T extends { at: string }>(events: readonly T[], today: string): { day: string; label: string; events: T[] }[] => {
  const groups: { day: string; label: string; events: T[] }[] = [];
  for (const event of [...events].sort((left, right) => right.at.localeCompare(left.at))) {
    const day = localDay(new Date(event.at));
    const group = groups.find((candidate) => candidate.day === day);
    if (group === undefined) groups.push({ day, label: historyDayLabel(day, today), events: [event] });
    else group.events.push(event);
  }
  return groups;
};

/** Markdown's marks taken out of a line: what a card's second line shows of a detail (plain text). */
export const plainMarkdown = (text: string): string =>
  text
    .replace(/```[^\n]*\n?/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu, "")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])([*_])([^*_\n]+)\2(?![\w*])/gu, "$1$3")
    .replace(/~~(.+?)~~/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1");

/** An item's changes, the latest first. */
export const itemHistory = (list: Pick<TodoListView, "history">, number: number): TodoEvent[] =>
  list.history.filter((event) => event.item === number).reverse();

/** The status the history last recorded for an item: what a box ticked in Obsidian since was ticked from. */
export const recordedStatus = (list: Pick<TodoListView, "history">, number: number): TodoItemStatus =>
  itemHistory(list, number)[0]?.status ?? "open";

const AGENT_RULES =
  "先核对前置事项；未完成的前置应先处理，已放弃、缺失或循环的前置先确认，不要自动跳过。开始时用 update_todo_item 把它标为 in_progress；完成后标为 done，并在 note 里写明做了什么、怎么验证的；决定不做就标为 dropped 并写明原因。";

const DISPOSITION_RULE = "有「我的处置意见」的，按意见办；意见和实际情况冲突时先停下来问我。";

/** An item's 处置备注 as lines of a prompt: the words, and the lines after the first indented under them. */
const dispositionLines = (disposition: string, indent: string): string =>
  `${indent}我的处置意见：${disposition.split("\n").join(`\n${indent}  `)}`;

type PromptItem = Pick<TodoItemView, "number" | "title" | "status" | "priority" | "disposition" | "prerequisites" | "dependencyCycle">;

/** One entry of what is copied: an item and the list it is in. */
export interface PromptEntry {
  list: Pick<TodoListView, "id" | "title">;
  item: PromptItem;
}

/**
 * What to paste to have an agent take up the items picked (and only them): each as 「#编号 [P?] 标题」 with the reader's
 * 处置备注 under it, grouped by list with each list's id. Items already done or dropped are left out and counted;
 * null when nothing is left to copy.
 */
export const pickedPrompt = (entries: readonly PromptEntry[]): { text: string; count: number; skipped: number } | null => {
  const pending = entries.filter((entry) => todoItemPending(entry.item.status));
  if (pending.length === 0) return null;
  const groups = new Map<string, { list: PromptEntry["list"]; items: PromptItem[] }>();
  for (const { list, item } of pending) {
    const group = groups.get(list.id);
    if (group === undefined) groups.set(list.id, { list, items: [item] });
    else group.items.push(item);
  }
  const lines = (items: readonly PromptItem[]): string =>
    items
      .map((item) =>
        [
          `- #${item.number}${item.priority === null ? "" : ` [${PRIORITY_LABELS[item.priority]}]`} ${item.title}`,
          ...((item.prerequisites ?? []).map(entry => `  前置：${entry.title}（${entry.issue === null && entry.status !== null ? statusLabel(entry.status) : "需确认"}；${entry.listId ?? "未知清单"} #${entry.item ?? "?"}）`)),
          ...(item.disposition === null ? [] : [dispositionLines(item.disposition, "  ")]),
        ].join("\n"),
      )
      .join("\n");
  const [only, ...more] = [...groups.values()];
  const head =
    only !== undefined && more.length === 0
      ? `请处理 Paraself 待办清单「${only.list.title}」（listId: ${only.list.id}）里的下面 ${pending.length} 项，清单里其它事项不要动：\n\n${lines(only.items)}`
      : `请处理 Paraself 待办里的下面 ${pending.length} 项（分属 ${groups.size} 份清单），清单里其它事项不要动：\n\n${[...groups.values()]
          .map((group) => `清单「${group.list.title}」（listId: ${group.list.id}）：\n${lines(group.items)}`)
          .join("\n\n")}`;
  const read = groups.size === 1 ? "这份清单" : "这几份清单（每份用各自的 listId）";
  return {
    text: `${head}\n\n先用 list_todo_lists 读${read}，拿到每项的补充说明和最新进展。一次处理一项：${AGENT_RULES}${DISPOSITION_RULE}`,
    count: pending.length,
    skipped: entries.length - pending.length,
  };
};

/** What to paste into an agent's conversation to have it take one item on. */
export const itemPrompt = (list: Pick<TodoListView, "id" | "title">, item: PromptItem): string =>
  pickedPrompt([{ list, item }])?.text ?? "";

/** What the page says once items are copied: how many, and how many picked were left out as already handled. */
export const copiedNotice = (count: number, skipped: number): string =>
  `已复制 ${count} 项，粘贴到 Claude Code 或 Codex 即可${skipped === 0 ? "" : `（跳过 ${skipped} 项已处理的）`}`;

/**
 * What to paste to have an agent work through a list's unfinished items, one at a time. A long-term list (日常) keeps
 * being added to, by the reader as well: the agent is held to the items there now, not to whatever arrives meanwhile.
 * The reader's 处置备注 on those items go with it.
 */
export const listPrompt = (list: Pick<TodoListView, "id" | "title" | "items" | "longTerm">): string => {
  const pending = list.items.filter((item) => todoItemPending(item.status));
  const open = pending.map((item) => item.number);
  const advised = pending.filter((item) => item.disposition !== null);
  return [
    `请逐项处理 Paraself 待办「${list.title}」（清单编号 ${list.id}）里未完成的事项${
      open.length === 0 ? "" : `（目前是第 ${open.join("、")} 项）`
    }。${list.longTerm && open.length > 0 ? "这是一份长期清单，之后还会往里加事项，这次只处理这几项。" : ""}`,
    ...(advised.length === 0 ? [] : [advised.map((item) => `- #${item.number} ${item.title}\n${dispositionLines(item.disposition!, "  ")}`).join("\n")]),
    `先用 list_todo_lists 读取这份清单（listId 填 ${list.id}），然后一次只处理一项：${AGENT_RULES}一项处理完再开始下一项。${advised.length === 0 ? "" : DISPOSITION_RULE}`,
  ].join("\n\n");
};

/** The agents an empty page names: one or two by name, more as 「A、B 等 agent」. */
export const agentNames = (names: readonly string[]): string =>
  names.length === 0 ? "agent" : names.length <= 2 ? names.join(" 或 ") : `${names.slice(0, 2).join("、")} 等 agent`;

/** The lines of the 新建清单 dialog's items field that are items: trimmed, the blank ones left out. */
export const typedItems = (text: string): string[] =>
  text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
