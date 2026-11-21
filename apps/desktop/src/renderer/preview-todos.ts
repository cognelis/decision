import {
  appendTodoItems,
  changeTodoItem,
  changeTodoItems,
  deleteTodoItems,
  receiveTodoItems,
  removeMovedTodoItems,
  createTodoList,
  moveTodoItem,
  todoCounts,
  todoItemView,
  todoListNameKey,
  todoListPending,
  todoListView,
  updateTodoListSettings,
  type TodoListRecord,
} from "@cognelis/decision-core/todo";
import { TODO_VERSION, todoItemInputSchema, type TodoListSummary } from "@cognelis/decision-protocol";
import { TodoDependencies } from "@cognelis/decision-core/todo-dependencies";

import type { DecisionApi } from "../shared/renderer-api.js";
import { addDays, localDay } from "./components/pages/todos/todo-dates.js";

/** A day relative to today, so the views have something overdue, due today and coming up whenever it is opened. */
const inDays = (days: number): string => addDays(localDay(new Date()), days);
const at = (time: string): Date => new Date(`2026-11-09T${time}:00.000Z`);
const codex = { kind: "agent", client: "codex" } as const;
const saved = (outcome: ReturnType<typeof changeTodoItem>): TodoListRecord => {
  if (outcome.status !== "saved") throw new Error(`preview todo change was ${outcome.status}`);
  return outcome.list;
};

/**
 * Every form a list and an item take on the page: each status, a note from an agent and one from the reader, a box
 * ticked in Obsidian, a detail long enough to wrap, a list from another project, one closed (shown only under 全部),
 * a long-term list with items done and to do, and an empty long-term one made to be added to.
 */
const samples = (): TodoListRecord[] => {
  let research = createTodoList(
    {
      title: "Paraself 遗留问题调研",
      summary: "按影响从大到小排列。前两项会让用户的数据或接入出错，其余是体验问题。每项都附了代码位置和复现方式。",
      project: "paraself",
      items: [
        { title: "本地审阅取消后残留私有副本目录", priority: "p1", due: inDays(-2), detail: "证据：local-review-service.ts 的取消路径只停了 worker，没有删除 jobs/<id>/tree。\n建议：取消落盘后清理 tree/，保留 git/ 里的对象供重试。" },
        { title: "Windows 上 bridge 路径含空格时接入失败", priority: "p1", due: inDays(0), tags: ["windows", "本周"], detail: "证据：安装命令拼接 hook 时没有给路径加引号。\n复现：把 %LOCALAPPDATA% 换到带空格的目录后点「全部修复」。" },
        { title: "托盘提示没有区分复盘", priority: "p2", due: inDays(2), tags: ["ui"] },
        { title: "设置页「重建索引」没有进度" },
        { title: "README 的数据目录表缺少 todos", due: inDays(5) },
        {
          title: "日志页的用途筛选在最小窗口下换行错位",
          priority: "p2",
          due: inDays(-1),
          tags: ["windows", "ui"],
          detail: "最小窗口（960×640）下，用途筛选和刷新按钮挤在同一行，筛选的标签被截成两行，按钮的文字也被裁掉一半。\n建议：工具栏允许换行，筛选占满一行时按钮落到下一行；顺带检查深色主题下的对比度。\n参考：check-surface-overflow.cjs 已经能报出这一类截断。",
        },
      ],
    },
    { kind: "agent_capture", client: "codex" },
    "preview-todo-research",
    at("01:00"),
  );
  research = saved(changeTodoItem(research, { item: 1, status: "in_progress" }, codex, at("01:30")));
  research = saved(changeTodoItem(research, { item: 1, status: "done", note: "已在 7c1e2a4 修复：取消后删除 tree/；新增单测覆盖取消与重试，npm test 通过。" }, codex, at("02:10")));
  research = saved(changeTodoItem(research, { item: 2, status: "in_progress", note: "已定位到 hook 命令的拼接，正在补引号和 Windows 路径的测试。" }, codex, at("02:40")));
  research = saved(changeTodoItem(research, { item: 4, status: "dropped", note: "重建通常两秒内完成，暂不做进度条。" }, { kind: "user" }, at("03:05")));
  // Ticked in Obsidian: the box says done, nothing recorded it yet.
  research = { ...research, items: research.items.map((item) => (item.number === 5 ? { ...item, status: "done" as const } : item)) };
  // 处置备注, as the reader writes it under an item in the note (or on the page): kept for the agent.
  const dispositions: Record<number, string> = { 2: "先只修引号，不要改安装目录结构；改完在我的 Windows 虚拟机上验证", 6: "改成横向滚动，不要换行" };
  research = { ...research, items: research.items.map((item) => ({ ...item, disposition: dispositions[item.number] ?? item.disposition })) };

  const site = createTodoList(
    {
      title: "官网首页加载性能调研",
      summary: "首屏 LCP 在 4G 下约 3.8 秒，主要卡在字体和首屏大图。",
      project: "paraself-site",
      items: [
        { title: "首屏大图改用 AVIF 并加尺寸", tags: ["本周"], detail: "hero.png 1.9 MB，改 AVIF 约 240 KB；同时写上 width/height 避免布局抖动。" },
        { title: "中文字体按需子集化", priority: "p3", due: inDays(1) },
        { title: "移除未使用的动画库" },
      ],
    },
    { kind: "agent_capture", client: "claude-code" },
    "preview-todo-site",
    at("00:20"),
  );

  let release = createTodoList(
    { title: "1.3.0 发布前检查", items: [{ title: "更新发布说明" }, { title: "核对两个平台的 SHA-256" }] },
    { kind: "app_manual", client: null },
    "preview-todo-release",
    new Date("2026-11-02T08:00:00.000Z"),
  );
  release = saved(changeTodoItem(release, { item: 1, status: "done" }, { kind: "user" }, new Date("2026-11-02T09:00:00.000Z")));
  release = saved(changeTodoItem(release, { item: 2, status: "done", note: "两个平台的哈希都已核对。" }, { kind: "user" }, new Date("2026-11-02T09:10:00.000Z")));

  let learning = createTodoList(
    {
      title: "学习",
      longTerm: true,
      items: [
        { title: "读完 DDIA 第 5 章（复制）", detail: "重点看单主复制的复制滞后和读己之写。" },
        { title: "整理 MCP 规范里 tool annotations 的含义" },
        { title: "试一下 Obsidian Bases 的表格视图", due: inDays(3), tags: ["本周"] },
      ],
    },
    { kind: "app_manual", client: null },
    "preview-todo-learning",
    new Date("2026-11-05T12:00:00.000Z"),
  );
  learning = saved(changeTodoItem(learning, { item: 2, status: "done", note: "readOnlyHint、idempotentHint 等都只是提示，客户端不一定遵守。" }, { kind: "user" }, new Date("2026-11-06T13:00:00.000Z")));
  const daily = createTodoList({ title: "日常", items: [] }, { kind: "app_manual", client: null }, "preview-todo-daily", new Date("2026-11-08T23:30:00.000Z"));
  const extra = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("todos") === "long" ? [longList()] : [];
  return [research, site, release, learning, daily, ...extra];
};

/** A real-looking long list (91 items, long titles, P0–P3 and tags on some, no due date): `?todos=long` on the preview page adds it. */
const longList = (): TodoListRecord => {
  const topics = ["把评审意见里提到的命名不一致统一成同一个说法，并检查文档、界面文案和测试里的旧名字是否都已经改掉", "排查发版流程里 changelog 与 VERSION 不同步的原因，写清楚是哪一步漏了以及怎么在脚本里拦住它", "给设置页的模型选择补上读不到本机模型时的说明，别让用户面对一个空列表不知道下一步做什么", "核对知识页搜索在中文标点和全半角混用时是否还能命中，补一条能复现的测试"];
  const items = Array.from({ length: 91 }, (_, index) => ({
    title: `${topics[index % topics.length]}（第 ${index + 1} 条）`,
    ...(index % 7 < 4 ? { priority: (["p0", "p1", "p2", "p3"] as const)[index % 7]! } : {}),
    ...(index % 5 === 0 ? { tags: index % 10 === 0 ? ["本周", "设置页"] : ["本周"] } : index % 11 === 0 ? { tags: ["等回复"] } : {}),
    ...(index % 3 === 0 ? { detail: "证据：见上次调研的第 " + (index + 1) + " 条记录。先复现，再改，最后补测试；改完在 PR 里写明怎么核对的。" } : {}),
  }));
  let list = createTodoList({ title: "日常整理（长清单）", longTerm: true, items: items.slice(0, 50) }, { kind: "app_manual", client: null }, "preview-todo-long", new Date("2026-11-09T07:00:00.000Z"));
  list = appendTodoItems(list, items.slice(50), new Date("2026-11-09T07:05:00.000Z")).list;
  const started = changeTodoItem(list, { item: 2, status: "in_progress" }, { kind: "agent", client: "codex" }, new Date("2026-11-10T01:00:00.000Z"));
  return started.status === "saved" ? started.list : list;
};

const pathOf = (list: TodoListRecord): string => `Decision Journal/todos/${list.createdAt.slice(0, 4)}/${list.createdAt.slice(5, 7)}/${list.id}.md`;

const summaryOf = (list: TodoListRecord): TodoListSummary => ({
  id: list.id,
  title: list.title,
  project: list.project,
  longTerm: list.longTerm,
  revision: list.revision,
  updatedAt: list.updatedAt,
  relativePath: pathOf(list),
  counts: todoCounts(list.items),
});

const fold = (text: string): string => text.normalize("NFKC").toLowerCase();

/** The todo page's calls, answered from lists held in memory: the preview and the tests change them as the App would. */
export function createTodoPreview(): Pick<DecisionApi, "listTodoLists" | "recordTodoList" | "changeTodoItem" | "updateTodoList" | "moveTodoItem" | "changeTodoItems" | "moveTodoItemsToList" | "deleteTodoItems" | "deleteTodoList"> {
  let lists = samples();
  const ordered = (): TodoListRecord[] =>
    [...lists].sort((left, right) =>
      Number(todoListPending(right)) - Number(todoListPending(left)) || right.updatedAt.localeCompare(left.updatedAt));
  return {
    listTodoLists: async (query = {}) => {
      const words = fold(query.query ?? "").split(/\s+/u).filter((word) => word.length > 0);
      const matched = ordered().filter((list) =>
        (query.listId === undefined || list.id === query.listId) &&
        (query.includeClosed === true || query.listId !== undefined || todoListPending(list)) &&
        (query.project === undefined || list.project === query.project) &&
        words.every((word) => fold([list.title, list.summary ?? "", ...list.items.map((item) => `${item.title}\n${item.detail ?? ""}`)].join("\n")).includes(word)));
      const offset = query.offset ?? 0;
      const page = matched.slice(offset, offset + (query.limit ?? 20));
      return {
        todoVersion: TODO_VERSION,
        lists: page.map((list) => {
          const view = todoListView(list, pathOf(list));
          const graph = new TodoDependencies(lists);
          return { ...view, items: view.items.map(item => graph.enrich(list.id, item)) };
        }),
        total: matched.length,
        nextOffset: offset + page.length < matched.length ? offset + page.length : null,
        unreadable: [],
      };
    },
    recordTodoList: async (input) => {
      const items = (input.items ?? []).map((item) => todoItemInputSchema.parse(item));
      if (input.listId === undefined) {
        const list = createTodoList({ title: input.title ?? "", summary: input.summary, project: input.project, longTerm: input.longTerm, items }, { kind: "app_manual", client: null }, crypto.randomUUID(), new Date());
        // Made again empty, as the App answers: the list with that project and title, whatever it holds now.
        const same = items.length === 0 ? lists.find((candidate) => todoListNameKey(candidate) === todoListNameKey(list)) : undefined;
        if (same !== undefined) {
          return { todoVersion: TODO_VERSION, status: "duplicate", list: summaryOf(same), added: [], skipped: [] };
        }
        lists = [list, ...lists];
        return { todoVersion: TODO_VERSION, status: "created", list: summaryOf(list), added: list.items.map(({ number, title }) => ({ number, title })), skipped: [] };
      }
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, added: [], skipped: [] };
      const appended = appendTodoItems(current, items, new Date());
      lists = lists.map((list) => (list.id === current.id ? appended.list : list));
      return {
        todoVersion: TODO_VERSION,
        status: appended.full ? "list_full" : appended.added.length === 0 ? "duplicate" : "appended",
        list: summaryOf(appended.list),
        added: appended.added.map(({ number, title }) => ({ number, title })),
        skipped: appended.skipped.map(({ number, title }) => ({ number, title })),
        removed: appended.removed.map(({ number, title }) => ({ number, title })),
      };
    },
    updateTodoList: async (input) => {
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null };
      const next = updateTodoListSettings(current, input, new Date());
      lists = lists.map((list) => (list.id === current.id ? next : list));
      return { todoVersion: TODO_VERSION, status: next === current ? "unchanged" : "saved", list: summaryOf(next) };
    },
    moveTodoItem: async (input) => {
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null };
      const moved = moveTodoItem(current, input.item, input.before, new Date());
      if (typeof moved === "string") return { todoVersion: TODO_VERSION, status: moved, list: summaryOf(current) };
      lists = lists.map((list) => (list.id === current.id ? moved : list));
      return { todoVersion: TODO_VERSION, status: "saved", list: summaryOf(moved) };
    },
    changeTodoItems: async (input) => {
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, results: [] };
      const batch = changeTodoItems(current, input.changes, { kind: "user" }, new Date());
      lists = lists.map((list) => (list.id === current.id ? batch.list : list));
      return { todoVersion: TODO_VERSION, status: "saved", list: summaryOf(batch.list), results: batch.results };
    },
    moveTodoItemsToList: async (input) => {
      const answer = (status: "saved" | "same_list" | "list_not_found" | "target_not_found" | "target_full", from: TodoListRecord | null = null, to: TodoListRecord | null = null, results: { item: number; status: "saved" | "status_changed" | "item_not_found" | "kept"; number?: number }[] = []) => ({
        todoVersion: TODO_VERSION,
        status,
        from: from === null ? null : summaryOf(from),
        to: to === null ? null : summaryOf(to),
        results,
      });
      const source = lists.find((list) => list.id === input.fromListId);
      const target = lists.find((list) => list.id === input.toListId);
      if (input.fromListId === input.toListId) return answer("same_list");
      if (source === undefined) return answer("list_not_found");
      if (target === undefined) return answer("target_not_found", source);
      const results: { item: number; status: "saved" | "status_changed" | "item_not_found" | "kept"; number?: number }[] = [];
      const movable = [];
      for (const asked of input.items) {
        const item = source.items.find((candidate) => candidate.number === asked.item);
        if (item === undefined) results.push({ item: asked.item, status: "item_not_found" });
        else if (item.status !== asked.expectedStatus) results.push({ item: asked.item, status: "status_changed" });
        else movable.push(item);
      }
      if (movable.length === 0) return answer("saved", source, null, results);
      const arrival = receiveTodoItems(target, movable.map((item) => ({ ...item, from: { listId: source.id, listTitle: source.title, item: item.number } })), { kind: "user" }, new Date());
      if (arrival === null) return answer("target_full", source, target, results);
      const taken = removeMovedTodoItems(
        source,
        movable.map((item, index) => ({ item: item.number, same: () => true, to: { listId: target.id, listTitle: target.title, item: arrival.numbers[index]! } })),
        { kind: "user" },
        new Date(),
      );
      lists = lists.map((list) => (list.id === target.id ? arrival.list : list.id === source.id ? taken.list : list));
      movable.forEach((item, index) => results.push({ item: item.number, status: "saved", number: arrival.numbers[index]! }));
      return answer("saved", taken.list, arrival.list, results);
    },
    deleteTodoItems: async (input) => {
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, results: [] };
      const batch = deleteTodoItems(current, input.items, { kind: "user" }, new Date());
      lists = lists.map((list) => (list.id === current.id ? batch.list : list));
      return { todoVersion: TODO_VERSION, status: "saved", list: summaryOf(batch.list), results: batch.results };
    },
    deleteTodoList: async (input) => {
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found" };
      if (current.title.trim() !== input.title.trim()) return { todoVersion: TODO_VERSION, status: "title_mismatch" };
      lists = lists.filter((list) => list.id !== current.id);
      return { todoVersion: TODO_VERSION, status: "deleted" };
    },
    changeTodoItem: async (input) => {
      const current = lists.find((list) => list.id === input.listId);
      if (current === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, item: null };
      const change: Parameters<typeof changeTodoItem>[1] = { ...input };
      if (input.addDependencies !== undefined || input.removeDependencies !== undefined) {
        const graph = new TodoDependencies(lists);
        const source = graph.find(current.id, input.item);
        if (source === undefined) return { todoVersion: TODO_VERSION, status: "item_not_found", list: summaryOf(current), item: null };
        if (source.item.status !== input.expectedStatus) return { todoVersion: TODO_VERSION, status: "status_changed", list: summaryOf(current), item: null };
        const targets = (input.addDependencies ?? []).map(target => graph.find(target.listId, target.item));
        if (targets.some(target => target === undefined)) return { todoVersion: TODO_VERSION, status: "invalid_dependency", list: summaryOf(current), item: null };
        if (targets.some(target => graph.wouldCycle(source, target!))) return { todoVersion: TODO_VERSION, status: "dependency_cycle", list: summaryOf(current), item: null };
        const ids = (source.item.dependsOn ?? []).filter(id => !input.removeDependencies?.includes(id));
        const titles = { ...source.item.dependencyTitles };
        for (const target of targets) {
          target!.item.id ??= crypto.randomUUID();
          if (!ids.includes(target!.item.id)) ids.push(target!.item.id);
          titles[target!.item.id] = target!.item.title;
        }
        change.dependsOn = ids;
        change.dependencyTitles = titles;
      }
      const outcome = changeTodoItem(current, change, { kind: "user" }, new Date());
      if (outcome.status === "item_not_found" || outcome.status === "note_required") {
        return { todoVersion: TODO_VERSION, status: outcome.status, list: summaryOf(current), item: null };
      }
      lists = lists.map((list) => (list.id === current.id ? outcome.list : list));
      return { todoVersion: TODO_VERSION, status: outcome.status, list: summaryOf(outcome.list), item: new TodoDependencies(lists).enrich(current.id, todoItemView(outcome.list, outcome.item)) };
    },
  };
}
