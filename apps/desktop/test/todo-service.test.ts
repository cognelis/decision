import { RationaleQueue } from "@cognelis/decision-core";
import { TODO_SHAPE, TODO_SHAPE_HEADER, TODO_VERSION } from "@cognelis/decision-protocol";
import { TodoHistoryStore, TodoListRepository } from "@cognelis/decision-storage";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { LocalCaptureServer } from "../src/main/local-server.js";
import { TodoService } from "../src/main/todo-service.js";

const token = "todo-token-".padEnd(64, "x");

const setup = async () => {
  const vault = await mkdtemp(join(tmpdir(), "paraself-todo-service-"));
  await mkdir(join(vault, "Decision Journal"), { recursive: true });
  let ids = 0;
  let minutes = 0;
  const onWritten = vi.fn();
  const service = new TodoService({
    repository: new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(`${vault}-history`) }),
    idFactory: () => `list-${++ids}`,
    clock: () => new Date(Date.UTC(2026, 10, 9, 9, minutes++)),
    onWritten,
  });
  return { vault, service, onWritten };
};

const research = {
  todoVersion: TODO_VERSION,
  requestId: "request-1",
  sourceClient: "codex",
  title: "遗留问题调研",
  summary: "三项，按影响排序。",
  project: "paraself",
  items: [
    { title: "取消后残留临时目录", detail: "local-review-service.ts" },
    { title: "托盘提示没有区分复盘" },
    { title: "README 缺少 todos" },
  ],
};

/** Two lists, the first with a prioritised, dated, tagged item in progress; the repository can be made to fail a write to one list. */
const twoLists = async () => {
  const vault = await mkdtemp(join(tmpdir(), "paraself-todo-move-"));
  await mkdir(join(vault, "Decision Journal"), { recursive: true });
  const repository = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(`${vault}-history`) });
  const fail: { listId: string | null; after: number } = { listId: null, after: 0 };
  const guarded = {
    scan: () => repository.scan(),
    create: (list: Parameters<typeof repository.create>[0]) => repository.create(list),
    relativePath: (path: string) => repository.relativePath(path),
    migrateLegacy: () => repository.migrateLegacy(),
    trash: (id: string, trash: (path: string) => Promise<void>) => repository.trash(id, trash),
    update: ((id: string, change: Parameters<typeof repository.update>[1]) => {
      // A write that would change the list fails (the read-only look the move starts with does not).
      return repository.update(id, (current) => {
        const result = change(current);
        if (fail.listId === id && result.list !== null) throw new Error("磁盘写入失败");
        return result;
      });
    }) as typeof repository.update,
  };
  let ids = 0;
  let minutes = 0;
  const service = new TodoService({ repository: guarded, idFactory: () => `list-${++ids}`, clock: () => new Date(Date.UTC(2026, 10, 9, 9, minutes++)) });
  await service.recordManual({
    title: "来源",
    items: [{ title: "写周报", detail: "第一段\n- 子项", priority: "p1", due: "2026-11-12", tags: ["本周"] }, { title: "买菜" }, { title: "交水费" }],
  });
  await service.recordManual({ title: "目标", longTerm: true, items: [{ title: "已有一项" }] });
  await service.changeItem({ listId: "list-1", item: 1, status: "in_progress", expectedStatus: "open" });
  return { service, fail, vault };
};

describe("TodoService: review fixes", () => {
  it("a client from before P0–P3 saying high leaves a P0 item P0; one that knows P0–P3 means P1", async () => {
    const { service } = await setup();
    await service.record({ ...research, tags: [] });
    await service.updateItem({ todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1, priority: "p0" });
    const server = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      listTodos: (query) => service.list(query),
      recordTodos: (request) => service.record(request),
      updateTodoItem: (request, context) => service.updateItem(request, context),
    });
    const { host, port } = await server.start();
    const post = (body: unknown, shape: string | null) =>
      fetch(`http://${host}:${port}/v1/todos/item`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(shape === null ? {} : { [TODO_SHAPE_HEADER]: shape }) },
        body: JSON.stringify(body),
      });
    const priorityOf = async () => (await service.list({ listId: "list-1" })).lists[0]!.items[0]!.priority;
    try {
      const update = { todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1 };
      // It was told 「high」 for the P0 it reads back (its shape is 3, or none): echoing it is no change.
      expect(await (await post({ ...update, priority: "high" }, "3")).json()).toMatchObject({ status: "unchanged" });
      expect(await (await post({ ...update, priority: "high" }, null)).json()).toMatchObject({ status: "unchanged" });
      expect(await priorityOf()).toBe("p0");
      // Another priority from it is a change, and a bridge that knows P0–P3 says what it means.
      expect(await (await post({ ...update, priority: "low" }, "3")).json()).toMatchObject({ status: "saved", item: { priority: "low" } });
      expect(await priorityOf()).toBe("p3");
      await service.updateItem({ ...update, priority: "p0" } as never);
      expect(await (await post({ ...update, priority: "high" }, "4")).json()).toMatchObject({ status: "saved", item: { priority: "p1" } });
      expect(await priorityOf()).toBe("p1");
    } finally {
      await server.stop();
    }
  });

  it("refuses a change of the detail made on a detail that has changed since the page showed it, and keeps it", async () => {
    const { service } = await setup();
    await service.record({ ...research, tags: [] });
    const first = { listId: "list-1", item: 1, expectedStatus: "open" as const };
    // The page showed 「local-review-service.ts」; an agent (or Obsidian) changed it meanwhile.
    expect(await service.changeItem({ ...first, detail: "我改的", expectedDetail: "local-review-service.ts" })).toMatchObject({ status: "saved", item: { detail: "我改的" } });
    expect(await service.changeItem({ ...first, detail: "另一个人改的", expectedDetail: "local-review-service.ts" })).toMatchObject({ status: "status_changed", item: { detail: "我改的" } });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[0]!.detail).toBe("我改的");
    // An item that had none: expectedDetail null.
    expect(await service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", detail: "新说明", expectedDetail: null })).toMatchObject({ status: "saved" });
    expect(await service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", detail: "再改", expectedDetail: null })).toMatchObject({ status: "status_changed" });
  });

  it("keeps the reader's 处置备注 in the note, hands it to agents read-only, and takes it along when an item moves", async () => {
    const { service, vault } = await setup();
    await service.record({ ...research, tags: [] });
    const first = { listId: "list-1", item: 1, expectedStatus: "open" as const };
    expect(await service.changeItem({ ...first, disposition: "先只修引号\n别动目录", expectedDisposition: null })).toMatchObject({ status: "saved", item: { disposition: "先只修引号\n别动目录" } });
    expect(await service.changeItem({ ...first, disposition: "又改了", expectedDisposition: null })).toMatchObject({ status: "status_changed", item: { disposition: "先只修引号\n别动目录" } });
    const read = (await service.list({ listId: "list-1" })).lists[0]!;
    expect(read.items[0]).toMatchObject({ detail: "local-review-service.ts", disposition: "先只修引号\n别动目录" });
    expect(read.history.at(-1)).toMatchObject({ item: 1, by: { kind: "user" }, disposition: true });
    const folder = join(vault, "Decision Journal", "todos", "2026", "11");
    const note = await readFile(join(folder, (await readdir(folder))[0]!), "utf8");
    expect(note).toContain("  local-review-service.ts\n\n  处置：先只修引号\n  别动目录");
    // An agent's request cannot carry one (strict), and its change leaves the reader's words as they are.
    await expect(service.updateItem({ todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1, disposition: "我来写" } as never)).rejects.toThrow();
    await service.updateItem({ todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1, status: "in_progress" });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[0]!.disposition).toBe("先只修引号\n别动目录");
  });

  it("an agent sending 「修 bug #urgent」 again finds the item it saved, not a second one", async () => {
    const { service } = await setup();
    const asked = { todoVersion: TODO_VERSION, sourceClient: "codex", tags: [] };
    const created = await service.record({ ...asked, requestId: "a", title: "清单", items: [{ title: "修 bug #urgent" }] });
    expect(created).toMatchObject({ status: "created", added: [{ number: 1, title: "修 bug" }] });
    expect(await service.record({ ...asked, requestId: "b", title: "清单", items: [{ title: "修 bug #urgent" }] })).toMatchObject({ status: "duplicate" });
    const again = await service.record({ ...asked, requestId: "c", listId: "list-1", items: [{ title: "修 bug  #urgent" }, { title: "修 bug #other" }, { title: "修 bug" }] });
    expect(again).toMatchObject({ status: "duplicate", added: [], skipped: [{ number: 1 }] });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items).toMatchObject([{ number: 1, title: "修 bug", tags: ["urgent"] }]);
  });
});

describe("TodoService: moving items to another list", () => {
  it("makes the items new in the target with every field, takes them out of the source, and notes both sides", async () => {
    const { service } = await twoLists();
    await service.changeItem({ listId: "list-1", item: 1, disposition: "别动 CI", expectedStatus: "in_progress" });
    const moved = await service.moveItemsToList({
      fromListId: "list-1", toListId: "list-2",
      items: [{ item: 1, expectedStatus: "in_progress", expectedPriority: "p1", expectedDue: "2026-11-12", expectedTags: ["本周"] }, { item: 2, expectedStatus: "open" }],
    });
    expect(moved).toMatchObject({ status: "saved", results: [{ item: 1, status: "saved", number: 2 }, { item: 2, status: "saved", number: 3 }], from: { counts: { open: 1 } }, to: { counts: { open: 2, inProgress: 1 } } });

    const [source, target] = (await service.list({ includeClosed: true, listId: "list-1" })).lists.concat((await service.list({ listId: "list-2" })).lists);
    expect(source!.items.map((item) => item.number)).toEqual([3]);
    expect(target!.items.slice(1)).toMatchObject([
      { number: 2, title: "写周报", detail: "第一段\n- 子项", disposition: "别动 CI", status: "in_progress", priority: "p1", due: "2026-11-12", tags: ["本周"] },
      { number: 3, title: "买菜", status: "open", priority: null, tags: [] },
    ]);
    expect(source!.history.filter((event) => event.moved !== undefined)).toMatchObject([
      { item: 1, deleted: true, moved: { direction: "out", listId: "list-2", listTitle: "目标", item: 2 } },
      { item: 2, deleted: true, moved: { direction: "out", listId: "list-2", item: 3 } },
    ]);
    expect(target!.history.filter((event) => event.moved !== undefined)).toMatchObject([
      { item: 2, moved: { direction: "in", listId: "list-1", listTitle: "来源", item: 1 } },
      { item: 3, moved: { direction: "in", listId: "list-1", item: 2 } },
    ]);
  });

  it("leaves an item changed since the page showed it, and nothing else is lost", async () => {
    const { service } = await twoLists();
    const moved = await service.moveItemsToList({
      fromListId: "list-1", toListId: "list-2",
      items: [{ item: 1, expectedStatus: "open" }, { item: 2, expectedStatus: "open", expectedPriority: "p0" }, { item: 9, expectedStatus: "open" }, { item: 3, expectedStatus: "open" }],
    });
    expect(moved.results).toEqual([
      { item: 1, status: "status_changed" }, { item: 2, status: "status_changed" }, { item: 9, status: "item_not_found" }, { item: 3, status: "saved", number: 2 },
    ]);
    expect((await service.list({ listId: "list-1" })).lists[0]!.items.map((item) => item.number)).toEqual([1, 2]);
    // Nothing movable: nothing is written to the target.
    const none = await service.moveItemsToList({ fromListId: "list-1", toListId: "list-2", items: [{ item: 1, expectedStatus: "done" }] });
    expect(none).toMatchObject({ status: "saved", to: null, results: [{ item: 1, status: "status_changed" }] });
    expect((await service.list({ listId: "list-2" })).lists[0]!.revision).toBe(2);
  });

  it("writes the target first: when that fails nothing is lost, and the source is untouched", async () => {
    const { service, fail } = await twoLists();
    fail.listId = "list-2";
    await expect(service.moveItemsToList({ fromListId: "list-1", toListId: "list-2", items: [{ item: 2, expectedStatus: "open" }] })).rejects.toThrow("磁盘写入失败");
    const source = (await service.list({ listId: "list-1" })).lists[0]!;
    expect(source.items.map((item) => item.number)).toEqual([1, 2, 3]);
    expect((await service.list({ listId: "list-2" })).lists[0]!.items).toHaveLength(1);
  });

  it("says so, and keeps the copy, when the original cannot be taken out afterwards", async () => {
    const { service, fail } = await twoLists();
    fail.listId = "list-1";
    await expect(service.moveItemsToList({ fromListId: "list-1", toListId: "list-2", items: [{ item: 2, expectedStatus: "open" }] })).rejects.toThrow(
      /已复制到「目标」，但没能从「来源」删掉原项：磁盘写入失败。这些事项现在两边各有一份/u,
    );
    expect((await service.list({ listId: "list-1" })).lists[0]!.items.map((item) => item.number)).toEqual([1, 2, 3]);
    expect((await service.list({ listId: "list-2" })).lists[0]!.items.map((item) => item.title)).toEqual(["已有一项", "买菜"]);
  });

  it("refuses the same list, a missing list, and a target that would be over its limit", async () => {
    const { service } = await twoLists();
    const asked = { items: [{ item: 2, expectedStatus: "open" as const }] };
    expect(await service.moveItemsToList({ fromListId: "list-1", toListId: "list-1", ...asked })).toMatchObject({ status: "same_list" });
    expect(await service.moveItemsToList({ fromListId: "nope", toListId: "list-2", ...asked })).toMatchObject({ status: "list_not_found" });
    expect(await service.moveItemsToList({ fromListId: "list-1", toListId: "nope", ...asked })).toMatchObject({ status: "target_not_found" });
    // 1 + 50 + 50 + 50 + 48 = 199 items: one more fits, two do not.
    for (const [batch, size] of [50, 50, 50, 48].entries()) await service.recordManual({ listId: "list-2", items: Array.from({ length: size }, (_, index) => ({ title: `填充 ${batch}-${index}` })) });
    expect(await service.moveItemsToList({ fromListId: "list-1", toListId: "list-2", items: [{ item: 2, expectedStatus: "open" }, { item: 3, expectedStatus: "open" }] })).toMatchObject({ status: "target_full" });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items).toHaveLength(3);
  });
});

describe("TodoService", () => {
  it("saves an agent's findings once, adds items to the list, and says which were there", async () => {
    const { vault, service, onWritten } = await setup();
    const created = await service.record({ ...research, tags: [] });
    expect(created).toMatchObject({
      status: "created",
      list: { id: "list-1", project: "paraself", counts: { open: 3, inProgress: 0, done: 0, dropped: 0 } },
      added: [{ number: 1, title: "取消后残留临时目录" }, { number: 2, title: "托盘提示没有区分复盘" }, { number: 3, title: "README 缺少 todos" }],
    });
    expect(created.list?.relativePath).toMatch(/^Decision Journal\/todos\/2026\/11\/.+\.md$/u);

    // Sent again (its answer lost), the same list is found, not written twice.
    expect(await service.record({ ...research, requestId: "request-2", tags: [] })).toMatchObject({ status: "duplicate", list: { id: "list-1" }, added: [] });
    const appended = await service.record({
      todoVersion: TODO_VERSION, requestId: "request-3", sourceClient: "codex", listId: "list-1", tags: [],
      items: [{ title: "托盘提示没有区分复盘" }, { title: "日志页筛选换行错位" }],
    });
    expect(appended).toMatchObject({ status: "appended", added: [{ number: 4, title: "日志页筛选换行错位" }], skipped: [{ number: 2 }] });
    expect(await service.record({ todoVersion: TODO_VERSION, requestId: "r", sourceClient: "codex", listId: "nope", tags: [], items: [{ title: "x" }] }))
      .toMatchObject({ status: "list_not_found", list: null });
    expect(onWritten).toHaveBeenCalledTimes(2);
    expect((await readdir(join(vault, "Decision Journal", "todos", "2026", "11")))).toHaveLength(1);
  });

  it("asks an agent for a note before it finishes an item, and keeps who changed what", async () => {
    const { service } = await setup();
    await service.record({ ...research, tags: [] });
    const update = { todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1 } as const;

    // Refused, with the item as it stands, so the agent can say what it did and try again.
    expect(await service.updateItem({ ...update, status: "done" })).toMatchObject({ status: "note_required", item: { number: 1, status: "open" } });
    expect(await service.updateItem({ ...update, status: "done", note: "已在 abc123 修复，测试通过" })).toMatchObject({
      status: "saved",
      list: { counts: { open: 2, done: 1 } },
      item: { number: 1, status: "done", note: "已在 abc123 修复，测试通过", changedBy: { kind: "agent", client: "codex" } },
    });
    expect(await service.updateItem({ ...update, status: "done", note: "已在 abc123 修复，测试通过" })).toMatchObject({ status: "unchanged" });
    expect(await service.updateItem({ ...update, item: 9, note: "x" })).toMatchObject({ status: "item_not_found", item: null });
    expect(await service.updateItem({ ...update, listId: "nope", note: "x" })).toMatchObject({ status: "list_not_found" });

    // The page changes only what it showed: moved on meanwhile, the reader is told instead.
    expect(await service.changeItem({ listId: "list-1", item: 1, status: "open", expectedStatus: "in_progress" })).toMatchObject({ status: "status_changed", item: { status: "done" } });
    expect(await service.changeItem({ listId: "list-1", item: 2, status: "dropped", expectedStatus: "open" })).toMatchObject({
      status: "saved",
      item: { status: "dropped", note: null, changedBy: { kind: "user" } },
    });
  });

  it("lists those still to be handled, finds by words in items and notes, and says which notes it could not read", async () => {
    const { vault, service } = await setup();
    await service.record({ ...research, tags: [] });
    await service.record({ todoVersion: TODO_VERSION, requestId: "r2", sourceClient: "claude-code", title: "官网性能", project: "site", tags: [], items: [{ title: "图片改 AVIF" }] });
    await service.changeItem({ listId: "list-2", item: 1, status: "done", note: "上线后 LCP 降到 2.1 秒", expectedStatus: "open" });
    const broken = join(vault, "Decision Journal", "todos", "2026", "10");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "坏的.md"), "没有属性的笔记\n");

    const open = await service.list({});
    expect(open.lists.map((list) => list.id)).toEqual(["list-1"]);
    expect(open.unreadable).toEqual([{ relativePath: "Decision Journal/todos/2026/10/坏的.md", message: expect.stringContaining("属性") }]);
    expect((await service.list({ includeClosed: true })).lists.map((list) => list.id)).toEqual(["list-1", "list-2"]);
    expect((await service.list({ query: "LCP" })).lists).toEqual([]);
    expect((await service.list({ query: "LCP", includeClosed: true })).lists.map((list) => list.id)).toEqual(["list-2"]);
    expect((await service.list({ query: "托盘 复盘" })).lists.map((list) => list.id)).toEqual(["list-1"]);
    expect((await service.list({ project: "SITE", includeClosed: true })).lists.map((list) => list.id)).toEqual(["list-2"]);
    // Asked for by its id, a closed list is there all the same.
    expect((await service.list({ listId: "list-2" })).lists).toHaveLength(1);
    expect(await service.list({ limit: 1, includeClosed: true })).toMatchObject({ total: 2, nextOffset: 1 });
  });

  it("still takes items without a priority from a bridge that sends none (the new bridge requires it, the App does not)", async () => {
    const { service } = await setup();
    const server = new LocalCaptureServer({ queue: new RationaleQueue(), token, listTodos: (query) => service.list(query), recordTodos: (request) => service.record(request), updateTodoItem: (request) => service.updateItem(request) });
    const { host, port } = await server.start();
    try {
      const answer = await fetch(`http://${host}:${port}/v1/todos`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...research, requestId: "old-bridge", title: "旧 bridge 的清单", items: [{ title: "没写优先级的一项" }, { title: "写了的一项", priority: "p1" }] }),
      });
      expect(answer.status).toBe(200);
      const saved = (await answer.json()) as { status: string; list: { id: string } };
      expect(saved.status).toBe("created");
      const items = (await service.list({ listId: saved.list.id })).lists[0]!.items;
      expect(items.map((item) => item.priority)).toEqual([null, "p1"]);
    } finally {
      await server.stop();
    }
  });

  it("serves agents over the authenticated local routes", async () => {
    const { vault, service } = await setup();
    const server = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      listTodos: (query) => service.list(query),
      recordTodos: (request) => service.record(request),
      updateTodoItem: (request) => service.updateItem(request),
    });
    const { host, port } = await server.start();
    const post = (path: string, body: unknown, auth = true) =>
      fetch(`http://${host}:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    try {
      expect((await post("/v1/todos", research, false)).status).toBe(401);
      expect((await post("/v1/todos", { ...research, title: undefined })).status).toBe(400);
      const created = await post("/v1/todos", research);
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({ status: "created", list: { id: "list-1" } });
      const listed = await post("/v1/todos/query", { project: "paraself" });
      expect(await listed.json()).toMatchObject({ total: 1, lists: [{ id: "list-1", items: [{ number: 1 }, { number: 2 }, { number: 3 }] }] });
      const updated = await post("/v1/todos/item", { todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 3, status: "in_progress" });
      expect(await updated.json()).toMatchObject({ status: "saved", item: { status: "in_progress" } });
      expect((await post("/v1/todos/item", { todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 3 })).status).toBe(400);
    } finally {
      await server.stop();
    }
    const [name] = await readdir(join(vault, "Decision Journal", "todos", "2026", "11"));
    expect(await readFile(join(vault, "Decision Journal", "todos", "2026", "11", name!), "utf8")).toContain("- [/] 3. README 缺少 todos");
  });

  it("makes empty lists to collect todos in, finds them again by name, and switches them between long-term and one-off", async () => {
    const { service, onWritten } = await setup();
    const daily = await service.recordManual({ title: "日常" });
    expect(daily).toMatchObject({ status: "created", added: [], list: { id: "list-1", longTerm: true, project: null, counts: { open: 0, inProgress: 0, done: 0, dropped: 0 } } });
    expect(await service.recordManual({ title: "日常" })).toMatchObject({ status: "duplicate", list: { id: "list-1" } });
    expect(await service.record({ todoVersion: TODO_VERSION, requestId: "r", sourceClient: "codex", title: "日常" })).toMatchObject({ status: "duplicate", list: { id: "list-1" } });
    expect((await service.list({})).lists.map((list) => [list.id, list.longTerm])).toEqual([["list-1", true]]);

    await service.recordManual({ listId: "list-1", items: [{ title: "交电费" }] });
    await service.changeItem({ listId: "list-1", item: 1, status: "done", expectedStatus: "open" });
    expect((await service.list({})).lists.map((list) => list.id)).toEqual(["list-1"]);

    expect(await service.updateList({ listId: "list-1", longTerm: true })).toMatchObject({ status: "unchanged", list: { longTerm: true } });
    expect(await service.updateList({ listId: "list-1", longTerm: false })).toMatchObject({ status: "saved", list: { longTerm: false } });
    // One-off now, and every item done: done with, listed only with the finished ones.
    expect((await service.list({})).lists).toEqual([]);
    expect((await service.list({ includeClosed: true })).lists.map((list) => list.id)).toEqual(["list-1"]);
    expect(await service.updateList({ listId: "nope", longTerm: true })).toMatchObject({ status: "list_not_found", list: null });
    expect(onWritten).toHaveBeenCalledTimes(4);
    // Items added to a list need at least one.
    await expect(service.recordManual({ listId: "list-1", items: [] })).rejects.toThrow();
  });

  it("answers a bridge that sends no shape header as the IMP-183 bridge reads, and a newer one in full", async () => {
    const { service } = await setup();
    const server = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      listTodos: (query) => service.list(query),
      recordTodos: (request) => service.record(request),
      updateTodoItem: (request) => service.updateItem(request),
    });
    const { host, port } = await server.start();
    const post = async (path: string, body: unknown, shaped: boolean): Promise<Record<string, unknown>> => {
      const answer = await fetch(`http://${host}:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(shaped ? { [TODO_SHAPE_HEADER]: TODO_SHAPE } : {}) },
        body: JSON.stringify(body),
      });
      return (await answer.json()) as Record<string, unknown>;
    };
    // The keys the IMP-183 bridge's strict schemas allow: anything more and it took the whole answer for none.
    const released = ["id", "title", "project", "revision", "updatedAt", "relativePath", "counts"];
    try {
      const created = await post("/v1/todos", { todoVersion: TODO_VERSION, requestId: "r1", sourceClient: "codex", title: "日常" }, false);
      expect(Object.keys(created).sort()).toEqual(["added", "list", "skipped", "status", "todoVersion"]);
      expect(Object.keys(created.list as object).sort()).toEqual([...released].sort());
      const listed = (await post("/v1/todos/query", {}, false)) as { lists: Array<Record<string, unknown>> };
      expect(listed.lists[0]).not.toHaveProperty("longTerm");
      const item = await post("/v1/todos/item", { todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1, note: "x" }, false);
      expect(item).toMatchObject({ status: "item_not_found" });
      expect(item.list).not.toHaveProperty("longTerm");

      const full = (await post("/v1/todos/query", {}, true)) as { lists: Array<Record<string, unknown>> };
      expect(full.lists[0]).toMatchObject({ id: "list-1", longTerm: true });
      expect(await post("/v1/todos", { todoVersion: TODO_VERSION, requestId: "r2", sourceClient: "codex", listId: "list-1", items: [{ title: "交水费" }] }, true))
        .toMatchObject({ status: "appended", list: { longTerm: true } });
    } finally {
      await server.stop();
    }
  });

  it("leaves priority, due date and archive out of what an older bridge reads, and gives them to the current one", async () => {
    const { service } = await setup();
    const server = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      listTodos: (query) => service.list(query),
      recordTodos: (request) => service.record(request),
      updateTodoItem: (request) => service.updateItem(request),
    });
    const { host, port } = await server.start();
    const post = async (path: string, body: unknown, shape: string | null): Promise<any> =>
      (await fetch(`http://${host}:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(shape === null ? {} : { [TODO_SHAPE_HEADER]: shape }) },
        body: JSON.stringify(body),
      })).json();
    try {
      await post("/v1/todos", { ...research, tags: [], items: [{ title: "写周报", priority: "p1", due: "2026-11-12" }] }, TODO_SHAPE);
      const update = { todoVersion: TODO_VERSION, sourceClient: "codex", listId: "list-1", item: 1, priority: "p3", due: "2026-11-20" };
      const current = await post("/v1/todos/item", update, TODO_SHAPE);
      expect(current).toMatchObject({ status: "saved", item: { priority: "p3", due: "2026-11-20" } });
      const full = await post("/v1/todos/query", {}, TODO_SHAPE);
      expect(full.lists[0]).toMatchObject({ archived: false, items: [{ priority: "p3", due: "2026-11-20" }] });
      expect(full.lists[0].history[0]).toMatchObject({ priority: { from: "p1", to: "p3" }, due: { from: "2026-11-12", to: "2026-11-20" } });

      for (const shape of [null, "2"]) {
        const old = await post("/v1/todos/query", {}, shape);
        const [first] = old.lists;
        expect(first).not.toHaveProperty("archived");
        expect(first.items[0]).not.toHaveProperty("priority");
        expect(first.items[0]).not.toHaveProperty("due");
        expect(first.history[0]).not.toHaveProperty("priority");
        expect(first.history[0]).not.toHaveProperty("due");
        expect("longTerm" in first).toBe(shape === "2");
      }
    } finally {
      await server.stop();
    }
  });

  it("renames, archives and reorders for the page, and hides an archived list from the unfinished ones", async () => {
    const { service, onWritten } = await setup();
    await service.recordManual({ title: "日常", items: [{ title: "甲" }, { title: "乙" }, { title: "丙" }] });
    expect(await service.moveItem({ listId: "list-1", item: 3, before: 1 })).toMatchObject({ status: "saved" });
    expect((await service.list({})).lists[0]!.items.map((item) => item.title)).toEqual(["丙", "甲", "乙"]);
    expect(await service.moveItem({ listId: "list-1", item: 3, before: 1 })).toMatchObject({ status: "unchanged" });
    expect(await service.moveItem({ listId: "list-1", item: 8, before: null })).toMatchObject({ status: "item_not_found" });
    expect(await service.updateList({ listId: "list-1", title: "每日", archived: true })).toMatchObject({ status: "saved", list: { title: "每日" } });
    expect((await service.list({})).lists).toEqual([]);
    expect((await service.list({ includeClosed: true })).lists[0]).toMatchObject({ title: "每日", archived: true });
    expect((await service.list({ listId: "list-1" })).lists).toHaveLength(1);
    expect(await service.updateList({ listId: "list-1", archived: false })).toMatchObject({ status: "saved" });
    expect((await service.list({})).lists).toHaveLength(1);
    expect(onWritten).toHaveBeenCalledTimes(4);
    await expect(service.updateList({ listId: "list-1" })).rejects.toThrow();
  });

  it("changes and deletes several items in one write each, and moves a deleted list's note to the wastebasket", async () => {
    const trash = vi.fn(async (_path: string) => undefined);
    const vault = await mkdtemp(join(tmpdir(), "paraself-todo-trash-"));
    await mkdir(join(vault, "Decision Journal"), { recursive: true });
    const onWritten = vi.fn();
    const service = new TodoService({
      repository: new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(`${vault}-history`) }),
      idFactory: () => "list-1",
      onWritten,
      trash,
    });
    await service.recordManual({ title: "日常", items: [{ title: "甲", detail: "说明甲" }, { title: "乙" }, { title: "丙" }] });
    onWritten.mockClear();
    const changed = await service.changeItems({ listId: "list-1", changes: [
      { item: 1, status: "done", expectedStatus: "open" },
      { item: 2, priority: "p1", due: "2026-12-01", expectedStatus: "open" },
      { item: 3, status: "done", expectedStatus: "in_progress" },
    ] });
    expect(changed.results.map((entry) => entry.status)).toEqual(["saved", "saved", "status_changed"]);
    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(changed.list).toMatchObject({ revision: 2 });

    const deleted = await service.deleteItems({ listId: "list-1", items: [{ item: 1, expectedStatus: "done" }] });
    expect(deleted.results).toEqual([{ item: 1, status: "saved" }]);
    const [list] = (await service.list({})).lists;
    expect(list!.items.map((item) => item.number)).toEqual([2, 3]);
    expect(list!.history.at(-1)).toMatchObject({ item: 1, deleted: true });
    const note = await readFile(join(vault, list!.relativePath), "utf8");
    expect(note).not.toContain("说明甲");
    expect(note).toContain("- [ ] 2. 乙 ⏫ 📅 2026-12-01");

    expect(await service.deleteList({ listId: "list-1", title: "别的名字" })).toMatchObject({ status: "title_mismatch" });
    expect(trash).not.toHaveBeenCalled();
    trash.mockRejectedValueOnce(new Error("废纸篓不可用"));
    await expect(service.deleteList({ listId: "list-1", title: "日常" })).rejects.toThrow("废纸篓不可用");
    expect((await service.list({})).lists).toHaveLength(1);
    expect(await service.deleteList({ listId: "list-1", title: "日常" })).toMatchObject({ status: "deleted" });
    expect(trash).toHaveBeenLastCalledWith(join(vault, list!.relativePath));
    expect(await service.deleteList({ listId: "nope", title: "x" })).toMatchObject({ status: "list_not_found" });
  });
});

describe("todo dependencies", () => {
  it("resolves cross-list prerequisites in archived lists, keeps statuses independent and preserves identity on move", async () => {
    const { service } = await twoLists();
    const linked = await service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-2", item: 1 }] });
    expect(linked).toMatchObject({ status: "saved", item: { status: "open", prerequisites: [{ listId: "list-2", item: 1, title: "已有一项", status: "open" }], unmetPrerequisites: [{ item: 1 }] } });
    const id = linked.item!.dependsOn![0]!;
    expect(id).toMatch(/^[\w-]+$/u);
    expect(await service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-2", item: 1 }] })).toMatchObject({ status: "unchanged" });
    await service.changeItem({ listId: "list-2", item: 1, expectedStatus: "open", status: "dropped" });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]).toMatchObject({ unmetPrerequisites: [{ status: "dropped" }] });
    await service.changeItem({ listId: "list-2", item: 1, expectedStatus: "dropped", status: "done" });
    await service.updateList({ listId: "list-2", archived: true });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]).toMatchObject({ status: "open", prerequisites: [{ status: "done" }], unmetPrerequisites: [] });
    await service.recordManual({ title: "迁移目标", items: [{ title: "占位" }] });
    expect(await service.moveItemsToList({ fromListId: "list-2", toListId: "list-3", items: [{ item: 1, expectedStatus: "done" }] })).toMatchObject({ status: "saved" });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]).toMatchObject({ dependsOn: [id], prerequisites: [{ id, listId: "list-3", item: 2, status: "done" }] });
    expect((await service.list({ listId: "list-3" })).lists[0]!.items[1]).toMatchObject({ id, dependents: [{ listId: "list-1", item: 2 }] });
    await service.deleteItems({ listId: "list-3", items: [{ item: 2, expectedStatus: "done" }] });
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]).toMatchObject({ prerequisites: [{ id, title: "已有一项", issue: "missing", status: null }], unmetPrerequisites: [{ id }] });
    expect(await service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", removeDependencies: [id] })).toMatchObject({ status: "saved", item: { prerequisites: [], unmetPrerequisites: [] } });
  });

  it("rejects self, indirect cycles, duplicate batch targets and missing targets without changing status", async () => {
    const { service } = await twoLists();
    const add = (item: number, target: number) => service.changeItem({ listId: "list-1", item, expectedStatus: item === 1 ? "in_progress" : "open", addDependencies: [{ listId: "list-1", item: target }] });
    expect(await add(1, 1)).toMatchObject({ status: "dependency_cycle" });
    expect(await add(1, 2)).toMatchObject({ status: "saved" });
    expect(await add(2, 3)).toMatchObject({ status: "saved" });
    expect(await add(3, 1)).toMatchObject({ status: "dependency_cycle" });
    expect(await add(3, 99)).toMatchObject({ status: "invalid_dependency" });
    expect(await service.changeItem({ listId: "list-1", item: 3, expectedStatus: "open", addDependencies: [{ listId: "list-2", item: 1 }, { listId: "list-2", item: 1 }] })).toMatchObject({ status: "invalid_dependency" });
    expect(await service.changeItem({ listId: "list-1", item: 3, expectedStatus: "done", addDependencies: [{ listId: "list-2", item: 1 }] })).toMatchObject({ status: "status_changed" });
    expect((await service.list({ listId: "list-2" })).lists[0]!.items[0]).not.toHaveProperty("id");
  });

  it("serializes competing additions and rejects the reverse edge instead of introducing a cycle", async () => {
    const { service } = await twoLists();
    const results = await Promise.all([
      service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-2", item: 1 }] }),
      service.changeItem({ listId: "list-2", item: 1, expectedStatus: "open", addDependencies: [{ listId: "list-1", item: 2 }] }),
      service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-1", item: 3 }] }),
    ]);
    expect(results.map(result => result.status)).toEqual(["saved", "dependency_cycle", "saved"]);
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]!.prerequisites).toHaveLength(2);
  });

  it("does not create a dangling edge when target identity persistence fails", async () => {
    const { service, fail } = await twoLists();
    fail.listId = "list-2";
    await expect(service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-2", item: 1 }] })).rejects.toThrow("磁盘写入失败");
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]!.prerequisites).toEqual([]);
    fail.listId = "list-1";
    await expect(service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-2", item: 1 }] })).rejects.toThrow("磁盘写入失败");
    expect((await service.list({ listId: "list-2" })).lists[0]!.items[0]).toHaveProperty("id");
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]!.prerequisites).toEqual([]);
  });

  it("shows and allows removal of cycles introduced in Obsidian; ambiguous ids are never silently resolved", async () => {
    const { service, vault } = await twoLists();
    await service.changeItem({ listId: "list-1", item: 2, expectedStatus: "open", addDependencies: [{ listId: "list-1", item: 3 }] });
    const list = (await service.list({ listId: "list-1" })).lists[0]!;
    const path = join(vault, list.relativePath);
    const targetId = list.items[2]!.id!;
    let note = await readFile(path, "utf8");
    note = note.replace(`买菜 ⛔ ${targetId}`, `买菜 🆔 manual-source ⛔ ${targetId}`).replace(`交水费 🆔 ${targetId}`, `交水费 🆔 ${targetId} ⛔ manual-source`);
    await writeFile(path, note);
    expect((await service.list({ listId: "list-1" })).lists[0]!.items[1]!.dependencyCycle).toEqual(["买菜", "交水费", "买菜"]);
    expect(await service.changeItem({ listId: "list-1", item: 3, expectedStatus: "open", removeDependencies: ["manual-source"] })).toMatchObject({ status: "saved" });
    note = await readFile(path, "utf8");
    await writeFile(path, note.replace("🆔 manual-source", `🆔 ${targetId}`));
    const ambiguous = (await service.list({ listId: "list-1" })).lists[0]!.items[1]!;
    expect(ambiguous.prerequisites).toMatchObject([{ title: "交水费", issue: "ambiguous", listId: null }]);
    expect(await service.changeItem({ listId: "list-2", item: 1, expectedStatus: "open", addDependencies: [{ listId: "list-1", item: 3 }] })).toMatchObject({ status: "invalid_dependency" });
  });
});
