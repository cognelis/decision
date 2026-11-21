import {
  TODO_VERSION,
  todoItemChangeSchema,
  todoItemMoveSchema,
  todoItemsChangeSchema,
  todoItemsDeleteSchema,
  todoItemsMoveSchema,
  todoListDeleteSchema,
  todoItemUpdateRequestSchema,
  todoListQuerySchema,
  todoListSettingsSchema,
  todoManualRecordSchema,
  todoRecordRequestSchema,
  type TodoActor,
  type TodoDependencyTarget,
  type TodoItemChange,
  type TodoItemInput,
  type TodoItemMove,
  type TodoItemsChange,
  type TodoItemsDelete,
  type TodoItemsMove,
  type TodoItemsMoveResult,
  type TodoItemsResult,
  type TodoListDelete,
  type TodoListDeleteResult,
  type TodoItemUpdateRequest,
  type TodoItemUpdateResult,
  type TodoListQuery,
  type TodoListResponse,
  type TodoListSettings,
  type TodoListSettingsResult,
  type TodoListSummary,
  type TodoManualRecord,
  type TodoRecordRequest,
  type TodoRecordResult,
} from "@cognelis/decision-protocol";
import {
  appendTodoItems,
  TodoDependencies,
  changeTodoItem,
  changeTodoItems,
  createTodoList,
  deleteTodoItems,
  moveTodoItem,
  receiveTodoItems,
  removeMovedTodoItems,
  todoCounts,
  todoItemView,
  todoListPending,
  todoListView,
  updateTodoListSettings,
  type TodoItemChangeInput,
  type TodoItemRecord,
  type TodoListRecord,
  type TodoListSource,
} from "@cognelis/decision-core";
import { foldedText, searchTokens, type StoredTodoList, type TodoLegacyMigration, type TodoListRepository } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";

interface TodoServiceOptions {
  repository: Pick<TodoListRepository, "scan" | "create" | "update" | "relativePath" | "migrateLegacy" | "trash">;
  /** Puts a list's note in the system wastebasket (Electron's shell.trashItem); never a plain delete. */
  trash?: (path: string) => Promise<void>;
  idFactory: () => string;
  clock?: () => Date;
  /** After each write, by an agent or on the page: the list in view reads again. */
  onWritten?: () => void;
}

type TodoRepository = TodoServiceOptions["repository"];

interface RecordInput {
  listId?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  project?: string | undefined;
  tags?: readonly string[] | undefined;
  longTerm?: boolean | undefined;
  items: readonly TodoItemInput[];
}

const summaryOf = (stored: StoredTodoList): TodoListSummary => ({
  id: stored.list.id,
  title: stored.list.title,
  project: stored.list.project,
  longTerm: stored.list.longTerm,
  revision: stored.list.revision,
  updatedAt: stored.list.updatedAt,
  relativePath: stored.relativePath,
  counts: todoCounts(stored.list.items),
});

const numbered = (items: readonly TodoItemRecord[]) => items.map((item) => ({ number: item.number, title: item.title }));

/**
 * What a search looks through: the words a person reads on a list, its items and what was said of them, and its id,
 * which a jump finds it by. Statuses, dates and field names are not in it, so a common word does not match them all.
 */
const searchable = (list: TodoListRecord): string =>
  foldedText(
    [
      list.id,
      list.title,
      list.summary,
      list.project,
      ...list.tags,
      ...list.items.flatMap((item) => [item.title, item.detail, item.disposition, ...item.tags.map((tag) => `#${tag}`), ...item.tags]),
      ...list.history.map((event) => event.note),
    ]
      .filter((part): part is string => typeof part === "string")
      .join("\n"),
  );

/**
 * 待办清单 for the page and for agents: one way to read them, one way to change them. Every write waits for the one
 * before it, so an agent's change and the reader's on the page are both made on the note as the other left it.
 */
export class TodoService {
  readonly #repository: TodoServiceOptions["repository"];
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #onWritten: () => void;
  readonly #trash: ((path: string) => Promise<void>) | undefined;
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(options: TodoServiceOptions) {
    this.#repository = options.repository;
    this.#idFactory = options.idFactory;
    this.#clock = options.clock ?? (() => new Date());
    this.#onWritten = options.onWritten ?? (() => undefined);
    this.#trash = options.trash;
  }

  async list(input: TodoListQuery = {}): Promise<TodoListResponse> {
    const query = todoListQuerySchema.parse(input);
    const scan = await this.#repository.scan();
    const tokens = searchTokens(query.query ?? "");
    const project = query.project === undefined ? null : foldedText(query.project.trim());
    const matched = scan.lists.filter((stored) =>
      (query.listId === undefined || stored.list.id === query.listId) &&
      // Asked for by its id, a list is found however far it has got.
      (query.includeClosed || query.listId !== undefined || todoListPending(stored.list)) &&
      (project === null || foldedText(stored.list.project ?? "") === project) &&
      (tokens.length === 0 || tokens.every((token) => searchable(stored.list).includes(token))));
    const page = matched.slice(query.offset, query.offset + query.limit);
    const dependencies = new TodoDependencies(scan.lists.map(stored => stored.list));
    const next = query.offset + page.length;
    return {
      todoVersion: TODO_VERSION,
      lists: page.map((stored) => {
        const view = todoListView(stored.list, stored.relativePath);
        return { ...view, items: view.items.map(item => dependencies.enrich(view.id, item)) };
      }),
      total: matched.length,
      nextOffset: next < matched.length ? next : null,
      unreadable: scan.diagnostics.slice(0, 50).map((diagnostic) => ({
        relativePath: this.#repository.relativePath(diagnostic.path),
        message: diagnostic.message.slice(0, 1_000),
      })),
    };
  }

  // Each is async so that input refused by its schema is a rejected promise, as a failed write is, never a throw.

  /** An agent's list, or the items it adds to one. */
  async record(input: TodoRecordRequest): Promise<TodoRecordResult> {
    const request = todoRecordRequestSchema.parse(input);
    return this.#record(request, { kind: "agent_capture", client: request.sourceClient });
  }

  /** The reader's list, written on the page, or the items they add to one. */
  async recordManual(input: TodoManualRecord): Promise<TodoRecordResult> {
    return this.#record(todoManualRecordSchema.parse(input), { kind: "app_manual", client: null });
  }

  /** An agent's change to one item. */
  async updateItem(input: TodoItemUpdateRequest, context: { oldHigh?: boolean } = {}): Promise<TodoItemUpdateResult> {
    const request = todoItemUpdateRequestSchema.parse(input);
    return this.#change(
      request.listId,
      { item: request.item, status: request.status, expectedStatus: request.expectedStatus, note: request.note, priority: request.priority, due: request.due, tags: request.tags, highKeepsP0: context.oldHigh },
      { kind: "agent", client: request.sourceClient },
      request,
    );
  }

  /** The reader's change to one item, made only on the status the page showed. */
  async changeItem(input: TodoItemChange): Promise<TodoItemUpdateResult> {
    const change = todoItemChangeSchema.parse(input);
    return this.#change(
      change.listId,
      {
        item: change.item,
        status: change.status,
        note: change.note,
        priority: change.priority,
        due: change.due,
        tags: change.tags,
        detail: change.detail,
        disposition: change.disposition,
        expectedDetail: change.expectedDetail,
        expectedDisposition: change.expectedDisposition,
        expectedStatus: change.expectedStatus,
        expectedPriority: change.expectedPriority,
        expectedDue: change.expectedDue,
        expectedTags: change.expectedTags,
      },
      { kind: "user" },
      change,
    );
  }

  /**
   * The App's own change to one item (an adopted organization suggestion, IMP-191): as the reader's, and only while
   * `precondition` holds of the item as the note has it at the write, inside the one queue every write waits in.
   */
  async changeItemWhere(input: TodoItemChange, precondition: (item: TodoItemRecord, list: TodoListRecord) => boolean): Promise<TodoItemUpdateResult> {
    const change = todoItemChangeSchema.parse(input);
    return this.#change(
      change.listId,
      {
        item: change.item, status: change.status, note: change.note, priority: change.priority, due: change.due, tags: change.tags, detail: change.detail,
        disposition: change.disposition, expectedDetail: change.expectedDetail, expectedDisposition: change.expectedDisposition, expectedStatus: change.expectedStatus,
        expectedPriority: change.expectedPriority, expectedDue: change.expectedDue, expectedTags: change.expectedTags, precondition,
      },
      { kind: "user" },
      change,
    );
  }

  /**
   * Notes from before IMP-185 have their history moved to this machine and taken out of them, once, in turn with the
   * other writes. What was left as it was is said, never thrown: the lists read as they did either way.
   */
  async migrateLegacy(): Promise<TodoLegacyMigration> {
    return this.#enqueue(async () => {
      const result = await this.#repository.migrateLegacy();
      if (result.migrated.length > 0) this.#onWritten();
      return result;
    });
  }

  /** The reader's settings for one list, from the page: 长期清单 or not, its title, archived. */
  async updateList(input: TodoListSettings): Promise<TodoListSettingsResult> {
    const settings = todoListSettingsSchema.parse(input);
    return this.#enqueue(async (): Promise<TodoListSettingsResult> => {
      const updated = await this.#repository.update(settings.listId, (current) => {
        const next = updateTodoListSettings(current, settings, this.#clock());
        return { list: next === current ? null : next, value: next === current ? ("unchanged" as const) : ("saved" as const) };
      });
      if (!updated.found) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null };
      if (updated.written) this.#onWritten();
      return { todoVersion: TODO_VERSION, status: updated.value, list: summaryOf(updated.stored) };
    });
  }

  /** The reader moves an item in the list's order: before another item, or to the end. */
  async moveItem(input: TodoItemMove): Promise<TodoListSettingsResult> {
    const move = todoItemMoveSchema.parse(input);
    return this.#enqueue(async (): Promise<TodoListSettingsResult> => {
      const updated = await this.#repository.update(move.listId, (current) => {
        const moved = moveTodoItem(current, move.item, move.before, this.#clock());
        return typeof moved === "string" ? { list: null, value: moved } : { list: moved, value: "saved" as const };
      });
      if (!updated.found) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null };
      if (updated.written) this.#onWritten();
      return { todoVersion: TODO_VERSION, status: updated.value, list: summaryOf(updated.stored) };
    });
  }

  /** Several items changed at once from the page: one write, each item on what the page showed of it. */
  async changeItems(input: TodoItemsChange): Promise<TodoItemsResult> {
    const request = todoItemsChangeSchema.parse(input);
    return this.#enqueue(async (): Promise<TodoItemsResult> => {
      const updated = await this.#repository.update(request.listId, (current) => {
        const batch = changeTodoItems(current, request.changes, { kind: "user" }, this.#clock());
        return { list: batch.written ? batch.list : null, value: batch.results };
      });
      if (!updated.found) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, results: [] };
      if (updated.written) this.#onWritten();
      return { todoVersion: TODO_VERSION, status: "saved", list: summaryOf(updated.stored), results: updated.value };
    });
  }

  /** Items deleted from a list on the page: their lines and details leave the note, the history stays here. */
  async deleteItems(input: TodoItemsDelete): Promise<TodoItemsResult> {
    const request = todoItemsDeleteSchema.parse(input);
    return this.#enqueue(async (): Promise<TodoItemsResult> => {
      const updated = await this.#repository.update(request.listId, (current) => {
        const batch = deleteTodoItems(current, request.items, { kind: "user" }, this.#clock());
        return { list: batch.written ? batch.list : null, value: batch.results };
      });
      if (!updated.found) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, results: [] };
      if (updated.written) this.#onWritten();
      return { todoVersion: TODO_VERSION, status: "saved", list: summaryOf(updated.stored), results: updated.value };
    });
  }

  /**
   * Items moved from one list to another on the page. Written in the order that cannot lose one: the new items first,
   * in the target (same title, detail, status, priority, due date and tags, new numbers, a history entry naming where
   * they came from), and only once that is saved the originals are taken out of the source (a history entry naming where
   * they went). An item changed since the page showed it is not moved. When the originals cannot be taken out, the
   * failure is thrown, saying the items now stand in both lists: the copy is never undone.
   */
  async moveItemsToList(input: TodoItemsMove): Promise<TodoItemsMoveResult> {
    const request = todoItemsMoveSchema.parse(input);
    return this.#enqueue(async (): Promise<TodoItemsMoveResult> => {
      const answer = (status: TodoItemsMoveResult["status"], from: TodoListSummary | null = null, to: TodoListSummary | null = null, results: TodoItemsMoveResult["results"] = []): TodoItemsMoveResult => ({
        todoVersion: TODO_VERSION,
        status,
        from,
        to,
        results,
      });
      if (request.fromListId === request.toListId) return answer("same_list");
      const source = await this.#repository.update(request.fromListId, (current) => ({ list: null, value: current }));
      if (!source.found) return answer("list_not_found");
      const results: TodoItemsMoveResult["results"] = [];
      const movable: { item: TodoItemRecord }[] = [];
      for (const asked of request.items) {
        const item = source.value.items.find((candidate) => candidate.number === asked.item);
        if (item === undefined) results.push({ item: asked.item, status: "item_not_found" });
        else if (
          item.status !== asked.expectedStatus ||
          (asked.expectedPriority !== undefined && asked.expectedPriority !== item.priority) ||
          (asked.expectedDue !== undefined && asked.expectedDue !== item.due) ||
          (asked.expectedTags !== undefined && asked.expectedTags.join("\n") !== item.tags.join("\n"))
        ) {
          results.push({ item: asked.item, status: "status_changed" });
        } else movable.push({ item });
      }
      if (movable.length === 0) return answer("saved", summaryOf(source.stored), null, results);

      // 1. The target first.
      let full = false;
      const received = await this.#repository.update(request.toListId, (current) => {
        const arrival = receiveTodoItems(
          current,
          movable.map(({ item }) => ({ ...item, from: { listId: source.stored.list.id, listTitle: source.stored.list.title, item: item.number } })),
          { kind: "user" },
          this.#clock(),
        );
        if (arrival === null) full = true;
        return { list: arrival === null ? null : arrival.list, value: arrival === null ? [] : arrival.numbers };
      });
      if (!received.found) return answer("target_not_found", summaryOf(source.stored), null, results);
      if (full) return answer("target_full", summaryOf(source.stored), summaryOf(received.stored), results);
      this.#onWritten();

      // 2. Only then the originals.
      const numberOf = new Map(movable.map(({ item }, index) => [item.number, received.value[index]!]));
      let removed: Awaited<ReturnType<TodoRepository["update"]>>;
      try {
        removed = await this.#repository.update(request.fromListId, (current) => {
          const taken = removeMovedTodoItems(
            current,
            movable.map(({ item }) => ({
              item: item.number,
              same: (now) =>
                now.title === item.title && now.detail === item.detail && now.disposition === item.disposition && now.status === item.status && now.priority === item.priority &&
                now.due === item.due && now.tags.join("\n") === item.tags.join("\n") && now.id === item.id &&
                JSON.stringify(now.dependsOn) === JSON.stringify(item.dependsOn) && JSON.stringify(now.dependencyTitles) === JSON.stringify(item.dependencyTitles),
              to: { listId: received.stored.list.id, listTitle: received.stored.list.title, item: numberOf.get(item.number)! },
            })),
            { kind: "user" },
            this.#clock(),
          );
          return { list: taken.written ? taken.list : null, value: taken.results };
        });
      } catch (error) {
        throw new Error(
          `已复制到「${received.stored.list.title}」，但没能从「${source.stored.list.title}」删掉原项：${error instanceof Error ? error.message : String(error)}。这些事项现在两边各有一份，请手动删掉重复的那份。`,
          { cause: error },
        );
      }
      if (!removed.found) {
        throw new Error(`已复制到「${received.stored.list.title}」，但「${source.stored.list.title}」找不到了，原项没有删除。这些事项现在两边各有一份，请手动删掉重复的那份。`);
      }
      if (removed.written) this.#onWritten();
      for (const entry of removed.value as { item: number; status: "saved" | "kept" | "item_not_found" }[]) {
        results.push({ item: entry.item, status: entry.status === "item_not_found" ? "saved" : entry.status, number: numberOf.get(entry.item)! });
      }
      return answer("saved", summaryOf(removed.stored), summaryOf(received.stored), results);
    });
  }

  /**
   * A list deleted on the page, once its title is typed: the note goes to the wastebasket, and when that fails the
   * failure is thrown, not answered by deleting it for good. Its change history stays on this machine.
   */
  async deleteList(input: TodoListDelete): Promise<TodoListDeleteResult> {
    const request = todoListDeleteSchema.parse(input);
    return this.#enqueue(async (): Promise<TodoListDeleteResult> => {
      const trash = this.#trash;
      if (trash === undefined) throw new Error("这台电脑上没有可用的废纸篓，没有删除清单");
      const found = (await this.#repository.scan()).lists.find((stored) => stored.list.id === request.listId);
      if (found === undefined) return { todoVersion: TODO_VERSION, status: "list_not_found" };
      if (found.list.title.trim() !== request.title.trim()) return { todoVersion: TODO_VERSION, status: "title_mismatch" };
      if (!(await this.#repository.trash(request.listId, trash))) return { todoVersion: TODO_VERSION, status: "list_not_found" };
      this.#onWritten();
      return { todoVersion: TODO_VERSION, status: "deleted" };
    });
  }

  #record(request: RecordInput, source: TodoListSource): Promise<TodoRecordResult> {
    return this.#enqueue(async (): Promise<TodoRecordResult> => {
      if (request.listId === undefined) {
        const list = createTodoList(
          { title: request.title ?? "", summary: request.summary, project: request.project, tags: request.tags, longTerm: request.longTerm, items: request.items },
          source,
          this.#idFactory(),
          this.#clock(),
        );
        const { stored, created } = await this.#repository.create(list);
        if (created) this.#onWritten();
        return {
          todoVersion: TODO_VERSION,
          status: created ? "created" : "duplicate",
          list: summaryOf(stored),
          added: created ? numbered(stored.list.items) : [],
          skipped: created ? [] : numbered(stored.list.items).slice(0, 50),
          removed: [],
        };
      }
      const updated = await this.#repository.update(request.listId, (current) => {
        const appended = appendTodoItems(current, request.items, this.#clock());
        return { list: appended.full || appended.added.length === 0 ? null : appended.list, value: appended };
      });
      if (!updated.found) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, added: [], skipped: [], removed: [] };
      const { value, stored } = updated;
      if (updated.written) this.#onWritten();
      // As the note now has them: the numbers they were given, the titles as they read back.
      const added = new Set(value.added.map((item) => item.number));
      return {
        todoVersion: TODO_VERSION,
        status: value.full ? "list_full" : value.added.length === 0 ? "duplicate" : "appended",
        list: summaryOf(stored),
        added: numbered(stored.list.items.filter((item) => added.has(item.number))),
        skipped: numbered(value.skipped),
        removed: numbered(value.removed),
      };
    });
  }

  #change(listId: string, change: TodoItemChangeInput, actor: TodoActor, dependencies: { addDependencies?: TodoDependencyTarget[] | undefined; removeDependencies?: string[] | undefined } = {}): Promise<TodoItemUpdateResult> {
    return this.#enqueue(async (): Promise<TodoItemUpdateResult> => {
      if (dependencies.addDependencies !== undefined || dependencies.removeDependencies !== undefined) {
        const prepared = await this.#prepareDependencies(listId, change, actor, dependencies);
        if ("todoVersion" in prepared) return prepared;
        change = prepared;
      }
      const updated = await this.#repository.update(listId, (current) => {
        const outcome = changeTodoItem(current, change, actor, this.#clock());
        return { list: outcome.status === "saved" ? outcome.list : null, value: outcome.status };
      });
      if (!updated.found) return { todoVersion: TODO_VERSION, status: "list_not_found", list: null, item: null };
      if (updated.written) this.#onWritten();
      const { list } = updated.stored;
      const item = list.items.find((candidate) => candidate.number === change.item);
      const graph = new TodoDependencies((await this.#repository.scan()).lists.map(stored => stored.list));
      return {
        todoVersion: TODO_VERSION,
        status: updated.value,
        list: summaryOf(updated.stored),
        item: item === undefined || updated.value === "item_not_found" ? null : graph.enrich(list.id, todoItemView(list, item)),
      };
    });
  }

  async #prepareDependencies(
    listId: string, change: TodoItemChangeInput, actor: TodoActor,
    request: { addDependencies?: TodoDependencyTarget[] | undefined; removeDependencies?: string[] | undefined },
  ): Promise<TodoItemChangeInput | TodoItemUpdateResult> {
    const scan = await this.#repository.scan();
    const graph = new TodoDependencies(scan.lists.map(stored => stored.list));
    const stored = scan.lists.find(entry => entry.list.id === listId);
    const source = graph.find(listId, change.item);
    const refused = (status: TodoItemUpdateResult["status"], message: string): TodoItemUpdateResult => ({
      todoVersion: TODO_VERSION, status, message, list: stored === undefined ? null : summaryOf(stored),
      item: stored === undefined || source === undefined ? null : graph.enrich(listId, todoItemView(stored.list, source.item as TodoItemRecord)),
    });
    if (stored === undefined) return refused("list_not_found", "找不到清单");
    if (source === undefined) return refused("item_not_found", "找不到事项");
    const preflight = changeTodoItem(stored.list, change, actor, this.#clock());
    if (preflight.status !== "saved" && preflight.status !== "unchanged") return refused(preflight.status, "事项已变化或缺少完成说明，请重新读取后再试");
    // An unreadable note could hide a duplicate id or a path back to this item.
    if (request.addDependencies?.length && scan.diagnostics.length > 0) return refused("invalid_dependency", "有待办笔记无法读取，暂不能安全添加依赖；现有依赖仍可解除");
    const targets = (request.addDependencies ?? []).map(target => graph.find(target.listId, target.item));
    if (targets.some(target => target === undefined)) return refused("invalid_dependency", "前置事项已不存在，请重新选择");
    const seen = new Set<string>();
    for (const target of targets) {
      const targetKey = `${target!.list.id}#${target!.item.number}`;
      if (seen.has(targetKey)) return refused("invalid_dependency", "同一前置事项不能重复添加");
      seen.add(targetKey);
      if (graph.wouldCycle(source, target!)) return refused("dependency_cycle", "不能依赖自己或形成循环依赖");
      if (target!.item.id !== undefined && !graph.unique(target!.item.id)) return refused("invalid_dependency", "前置事项的稳定编号重复，请先修正笔记中的 🆔");
    }
    const remove = new Set(request.removeDependencies ?? []);
    const dependsOn = [...(source.item.dependsOn ?? [])].filter(id => !remove.has(id));
    const titles = { ...source.item.dependencyTitles };
    if (dependsOn.length + targets.filter(target => !target!.item.id || !dependsOn.includes(target!.item.id)).length > 200) return refused("invalid_dependency", "一项最多关联 200 项前置");
    for (const target of targets) {
      let id = target!.item.id;
      if (id === undefined) {
        id = randomUUID();
        // Assign the target first. An interrupted link write leaves only a harmless stable id, never a dangling link.
        const identity = id;
        const updated = await this.#repository.update(target!.list.id, current => {
          const item = current.items.find(item => item.number === target!.item.number);
          if (item === undefined || item.id !== undefined || item.title !== target!.item.title) return { list: null, value: false };
          return { list: { ...current, revision: current.revision + 1, updatedAt: this.#clock().toISOString(), items: current.items.map(item => item.number === target!.item.number ? { ...item, id: identity } : item) }, value: true };
        });
        if (!updated.found || !updated.value) return refused("status_changed", "前置事项已变化，请重新读取后再试");
        this.#onWritten();
      }
      if (!dependsOn.includes(id)) dependsOn.push(id);
      titles[id] = target!.item.title;
    }
    const before = JSON.stringify(source.item.dependsOn ?? []);
    const originalPrecondition = change.precondition;
    return {
      ...change, dependsOn, dependencyTitles: titles,
      precondition: (item, list) => item.title === source.item.title && item.id === source.item.id && JSON.stringify(item.dependsOn ?? []) === before && (originalPrecondition?.(item, list) ?? true),
    };
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
