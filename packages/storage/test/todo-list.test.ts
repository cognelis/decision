import {
  appendTodoItems,
  changeTodoItem,
  createTodoList,
  setTodoListLongTerm,
  todoListView,
  withObsidianChanges,
  type TodoListRecord,
} from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { todoListViewSchema } from "@cognelis/decision-protocol";
import { TodoHistoryStore, TodoListRepository, parseTodoList, serializeTodoList, withoutLegacyHistory } from "../src/index.js";

const NOW = new Date("2026-11-09T09:00:00.000Z");
const LATER = new Date("2026-11-09T10:00:00.000Z");

const research = (id = "list-1"): TodoListRecord =>
  createTodoList(
    {
      title: "Paraself 遗留问题调研",
      summary: "共发现三项，按影响从大到小排列。",
      project: "paraself",
      items: [
        { title: "本地审阅取消后残留临时目录", detail: "证据：local-review-service.ts 第 420 行\n\n建议：取消时清理 jobs/<id>/tree" },
        { title: "托盘提示没有区分复盘" },
        { title: "README 的数据目录表缺少 todos" },
      ],
    },
    { kind: "agent_capture", client: "codex" },
    id,
    NOW,
  );

const withObsidian = (current: TodoListRecord) => { const { history, recorded, recordedFields } = withObsidianChanges(current, LATER); return { history, recorded, recordedFields }; };

const noteOf = ({ history: _history, recorded: _recorded, recordedFields: _fields, ...note }: TodoListRecord) => note;

/** A vault, and the App's own data folder beside it where the history is kept. */
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-todo-"));
  await mkdir(join(root, "vault", "Decision Journal"), { recursive: true });
  const historyRoot = join(root, "app", "todo-history");
  const vault = join(root, "vault");
  const repository = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(historyRoot) });
  return { vault, historyRoot, repository };
};

const notePath = async (vault: string): Promise<string> => {
  const month = join(vault, "Decision Journal", "todos", "2026", "11");
  const [name] = await readdir(month);
  return join(month, name!);
};

const saved = (outcome: ReturnType<typeof changeTodoItem>): TodoListRecord => {
  if (outcome.status !== "saved") throw new Error(`expected a save, got ${outcome.status}`);
  return outcome.list;
};

/** The history section a note carried before IMP-185, as that version wrote it, after its items. */
const legacySections = (events: unknown[]): string =>
  [
    "",
    "## 处理记录",
    "",
    "<!-- decision:todo-log-start -->",
    "- 2026-11-09T10:00:00.000Z · 第 1 项「本地审阅取消后残留临时目录」：待处理 → 已完成 · codex",
    "",
    "  已在 abc123 修复",
    "<!-- decision:todo-log-end -->",
    "",
    "<!-- decision:todo-history-start -->",
    "```decision-todo-history",
    JSON.stringify(events, null, 2),
    "```",
    "<!-- decision:todo-history-end -->",
    "",
  ].join("\n");

const legacyEvents = [
  { item: 1, at: "2026-11-09T10:00:00.000Z", previous: "open", status: "done", note: "已在 abc123 修复", by: { kind: "agent", client: "codex" } },
];

describe("RSI-15: todo note and history failures", () => {
  const failingAfterNote = (vault: string, historyRoot: string) => new TodoListRepository(vault, {
    existingVault: true, history: new TodoHistoryStore(historyRoot),
    rename: async (from, to) => {
      await rename(from, to);
      await mkdir(historyRoot, { recursive: true });
      await rename(historyRoot, `${historyRoot}-backup`);
      await writeFile(historyRoot, "synthetic disk fault");
    },
  });
  const restoreHistory = async (root: string) => { await rm(root); await rename(`${root}-backup`, root); };
  it("keeps a completion report recoverable when its history write fails", async () => {
    const { vault, historyRoot, repository } = await setup();
    const { stored } = await repository.create(research());
    const before = await readFile(stored.path, "utf8");
    const report = "合成执行回执：仅测试环境验证，用户尚未批准发布。";
    const failing = failingAfterNote(vault, historyRoot);
    await expect(failing.update("list-1", current => ({ list: saved(changeTodoItem(current, { item: 1, status: "done", note: report }, { kind: "agent", client: "codex" }, LATER)), value: null }))).rejects.toThrow();
    await restoreHistory(historyRoot);
    const restarted = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(historyRoot) });
    const recovered = (await restarted.scan()).lists[0]!.list;
    expect((await readFile(stored.path, "utf8")) === before || recovered.history.some(event => event.note === report), "a changed status must not lose its only completion report").toBe(true);
  });
  it("preserves old inline history when updating its note cannot save local history", async () => {
    const { vault, historyRoot, repository } = await setup();
    const { stored } = await repository.create(research());
    for (const file of await readdir(historyRoot)) await rm(join(historyRoot, file));
    await writeFile(stored.path, (await readFile(stored.path, "utf8")) + legacySections(legacyEvents));
    expect((await repository.scan()).lists[0]!.list.history.some(event => event.note === "已在 abc123 修复")).toBe(true);
    const failing = failingAfterNote(vault, historyRoot);
    await expect(failing.update("list-1", current => ({ list: saved(changeTodoItem(current, { item: 2, status: "done" }, { kind: "user" }, LATER)), value: null }))).rejects.toThrow();
    await restoreHistory(historyRoot);
    const restarted = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(historyRoot) });
    expect((await restarted.scan()).lists[0]!.list.history.some(event => event.note === "已在 abc123 修复")).toBe(true);
  });
  it("recovers a newly created list's full history after its final history write fails", async () => {
    const { vault, historyRoot } = await setup();
    const list = saved(changeTodoItem(research(), { item: 1, status: "done", note: "新清单的合成执行说明" }, { kind: "user" }, LATER));
    await expect(failingAfterNote(vault, historyRoot).create(list)).rejects.toThrow();
    await restoreHistory(historyRoot);
    const restarted = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(historyRoot) });
    const scan = await restarted.scan(); expect(scan.diagnostics).toEqual([]);
    expect(scan.lists[0]!.list.history).toEqual(list.history);
    expect((await restarted.create(list)).created).toBe(false);
  });
  it("does not settle a pending history against a duplicate, an unreadable note or an external edit", async () => {
    const { vault, historyRoot, repository } = await setup();
    const { stored } = await repository.create(research());
    const before = await readFile(stored.path, "utf8");
    const failing = failingAfterNote(vault, historyRoot);
    await expect(failing.update("list-1", current => ({ list: saved(changeTodoItem(current, { item: 1, status: "done", note: "必须保留的合成说明" }, { kind: "user" }, LATER)), value: null }))).rejects.toThrow();
    await restoreHistory(historyRoot);
    const after = await readFile(stored.path, "utf8");
    const file = join(historyRoot, (await readdir(historyRoot))[0]!); const pending = await readFile(file, "utf8");
    expect(JSON.parse(pending).version).toBe(2);
    const other = stored.path.replace(/\.md$/u, "-copy.md"); await writeFile(other, before);
    const restarted = new TodoListRepository(vault, { existingVault: true, history: new TodoHistoryStore(historyRoot) });
    expect((await restarted.scan()).diagnostics.some(d => d.message.includes("同一个编号"))).toBe(true);
    expect(await readFile(file, "utf8")).toBe(pending); await rm(other);
    await writeFile(other, "unreadable synthetic note");
    expect((await restarted.scan()).diagnostics.length).toBeGreaterThan(0);
    expect(await readFile(file, "utf8")).toBe(pending); await rm(other);
    await writeFile(stored.path, `${after}\n合成的外部补充\n`);
    expect((await restarted.scan()).diagnostics.some(d => d.message.includes("中断后又被修改"))).toBe(true);
    expect(await readFile(file, "utf8")).toBe(pending);
    await writeFile(stored.path, after); expect((await restarted.scan()).diagnostics).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
  });
  it("waits for an active transaction and returns its matching note, revision and report", async () => {
    const { vault, historyRoot, repository } = await setup();
    const { stored } = await repository.create(research());
    const before = await readFile(stored.path, "utf8");
    const next = saved(changeTodoItem(stored.list, { item: 1, status: "done", note: "并发读取的合成说明" }, { kind: "user" }, LATER));
    const after = serializeTodoList(next), hash = (text: string) => createHash("sha256").update(text).digest("hex");
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; }); const pause = new Promise<void>(resolve => { release = resolve; });
    let readRequested!: () => void;
    const readEntered = new Promise<void>(resolve => { readRequested = resolve; });
    class ObservedHistory extends TodoHistoryStore {
      override read(...args: Parameters<TodoHistoryStore["read"]>) { readRequested(); return super.read(...args); }
    }
    const history = new ObservedHistory(historyRoot);
    const writer = history.writeWithNote(next.id, { recorded: next.recorded, recordedFields: next.recordedFields, events: next.history }, { before: hash(before), after: hash(after) }, async () => { entered(); await pause; await writeFile(stored.path, after); throw new Error("synthetic lost receipt"); }, async () => hash(await readFile(stored.path, "utf8"))).catch(error => error);
    await inside; let completed = false;
    const reader = new TodoListRepository(vault, { existingVault: true, history });
    const reading = reader.scan().then(value => { completed = true; return value; });
    await readEntered;
    await new Promise(resolve => setTimeout(resolve, 20)); expect(completed).toBe(false);
    release(); expect((await writer).message).toBe("synthetic lost receipt");
    const scan = await reading; expect(scan.diagnostics).toEqual([]);
    expect(scan.lists[0]!.list.revision).toBe(next.revision);
    expect(scan.lists[0]!.list.items[0]!.status).toBe("done");
    expect(scan.lists[0]!.list.history).toEqual(next.history);
    expect(todoListView(scan.lists[0]!.list, "synthetic.md").items[0]!.changedInObsidian).toBe(false);
  });
  it("keeps an ambiguous missing new note's intent and refuses an oversized history before writing a note", async () => {
    const { historyRoot } = await setup(); const history = new TodoHistoryStore(historyRoot);
    const original = research(); const value = { recorded: original.recorded, recordedFields: original.recordedFields, events: original.history };
    await expect(history.writeWithNote("list-1", value, { before: null, after: "a".repeat(64) }, async () => { throw new Error("synthetic create interrupted"); }, async () => null)).rejects.toThrow("interrupted");
    const file = join(historyRoot, (await readdir(historyRoot))[0]!); const pending = await readFile(file, "utf8");
    await expect(history.read("list-1", async () => null)).rejects.toThrow("停止覆盖");
    await expect(history.write("list-1", value)).rejects.toThrow("未完成");
    expect(await readFile(file, "utf8")).toBe(pending);
    let written = false;
    const large = { ...value, events: Array.from({ length: 1000 }, () => ({ item: 1, at: LATER.toISOString(), previous: "open" as const, status: "done" as const, note: "合".repeat(2000), by: { kind: "user" as const } })) };
    await expect(history.writeWithNote("too-large", large, { before: null, after: "b".repeat(64) }, async () => { written = true; }, async () => null)).rejects.toThrow("大小上限");
    expect(written).toBe(false); expect(await readdir(historyRoot)).toHaveLength(1);
  });

  it("restores the original legacy priority encoding when an interrupted note was not written", async () => {
    const { historyRoot } = await setup(); const history = new TodoHistoryStore(historyRoot);
    const list = research(), value = { recorded: list.recorded, recordedFields: list.recordedFields, events: list.history };
    await history.write(list.id, value);
    const file = join(historyRoot, (await readdir(historyRoot))[0]!);
    const old = JSON.parse(await readFile(file, "utf8")); old.recordedFields = { "1": { priority: "high", due: null } };
    await writeFile(file, JSON.stringify(old));
    await expect(history.writeWithNote(list.id, value, { before: "a".repeat(64), after: "b".repeat(64) }, async () => { throw new Error("synthetic pre-note interruption"); }, async () => "a".repeat(64))).rejects.toThrow();
    expect((await history.read(list.id, async () => "a".repeat(64)))!.recordedFields["1"]?.legacyHigh).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(old);
  });
  it("does not settle an unknown pending field and silently discard it", async () => {
    const { historyRoot } = await setup(); const history = new TodoHistoryStore(historyRoot);
    const list = research(), value = { recorded: list.recorded, recordedFields: list.recordedFields, events: list.history };
    await expect(history.writeWithNote(list.id, value, { before: null, after: "b".repeat(64) }, async () => { throw new Error("synthetic interruption"); }, async () => null)).rejects.toThrow();
    const file = join(historyRoot, (await readdir(historyRoot))[0]!);
    const extended = { ...JSON.parse(await readFile(file, "utf8")), futureRecoveryField: "must not discard" };
    await writeFile(file, JSON.stringify(extended));
    await expect(history.read(list.id, async () => "b".repeat(64))).rejects.toThrow("停止写入");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(extended);
  });

});

describe("todo list notes", () => {
  it("round-trips the list, its items as checkboxes, and keeps no history in the note", () => {
    const list = saved(changeTodoItem(research(), { item: 1, status: "done", note: "已在 abc123 修复" }, { kind: "agent", client: "codex" }, LATER));
    const markdown = serializeTodoList(list);

    expect(markdown).toContain("type: decision-todo-list");
    expect(markdown).toContain("- [x] 1. 本地审阅取消后残留临时目录");
    expect(markdown).toContain("- [ ] 2. 托盘提示没有区分复盘");
    // The detail sits in the item, indented, so Obsidian shows it under its box.
    expect(markdown).toContain("\n\n  证据：local-review-service.ts 第 420 行\n\n  建议：取消时清理 jobs/\\<id>/tree");
    expect(markdown).not.toMatch(/处理记录|decision-todo-history|已在 abc123 修复/u);
    expect(markdown.trimEnd().endsWith("<!-- decision:todo-items-end -->")).toBe(true);
    expect(parseTodoList(markdown)).toEqual(noteOf(list));
  });

  it("keeps text that looks like the note's own structure as text", () => {
    const list = createTodoList(
      {
        title: "## 不是标题 <!-- decision:todo-items-end -->",
        summary: "```js\nalert(1)\n```\n<img src=x onerror=alert(1)> $=dv.page() <% tp.file %>",
        items: [
          { title: "- [x] 9. 看起来像一项", detail: "<!-- decision:todo-history-end -->\n## 小节\n- [ ] 嵌套的勾选框\n\t缩进" },
        ],
      },
      { kind: "app_manual", client: null },
      "list-escape",
      NOW,
    );
    const markdown = serializeTodoList(list);
    expect(markdown.match(/^<!-- decision:todo-items-end -->$/gmu)).toHaveLength(1);
    expect(markdown).not.toMatch(/^```js$/mu);
    // Taken apart, each is shown as the text it is: no tag Obsidian would fetch, no Templater command.
    expect(markdown).not.toMatch(/(?<!\\)<img/u);
    expect(markdown).not.toContain("<%");
    expect(parseTodoList(markdown)).toEqual(noteOf(list));
  });

  it("reads a box ticked, an item added and an empty box left in Obsidian", () => {
    const markdown = serializeTodoList(research())
      .replace("- [ ] 2. 托盘提示没有区分复盘", "- [x] 2. 托盘提示没有区分复盘")
      .replace("- [ ] 3. README 的数据目录表缺少 todos", "- [/] 3. README 的数据目录表缺少 todos\n- [ ] 在 Obsidian 里加的一项\n\t用 Tab 缩进的说明\n- [ ] ");
    const read = parseTodoList(markdown);

    expect(read.items.map((item) => [item.number, item.status, item.title])).toEqual([
      [1, "open", "本地审阅取消后残留临时目录"],
      [2, "done", "托盘提示没有区分复盘"],
      [3, "in_progress", "README 的数据目录表缺少 todos"],
      [4, "open", "在 Obsidian 里加的一项"],
    ]);
    expect(read.items[3]!.detail).toBe("用 Tab 缩进的说明");
    // Against what the App last wrote (open, open, open), the ticked box reads as changed in Obsidian.
    const view = todoListView({ ...read, history: [], recorded: research().recorded, recordedFields: {} }, "x.md");
    expect(view.items[1]).toMatchObject({ status: "done", changedInObsidian: true, changedBy: null });
    expect(view.counts).toEqual({ open: 2, inProgress: 1, done: 1, dropped: 0 });
  });

  it("refuses what it cannot read, and says what to change", () => {
    const markdown = serializeTodoList(research());
    expect(() => parseTodoList(markdown.replace("- [ ] 2.", "- [?] 2."))).toThrow("复选框里是「?」");
    expect(() => parseTodoList(markdown.replace("- [ ] 3.", "- [ ] 2."))).toThrow("第 2 项出现了不止一次");
    expect(() => parseTodoList(markdown.replace("- [ ] 2. 托盘提示没有区分复盘", "- [ ] 2. 托盘提示没有区分复盘\n随手写的一行"))).toThrow("读不懂");
    expect(() => parseTodoList(markdown.replace("<!-- decision:todo-items-end -->", ""))).toThrow("事项");
  });

  it("takes out what a note held before IMP-185 and nothing the reader wrote", () => {
    const note = `${serializeTodoList(research())}${legacySections(legacyEvents)}\n## 我自己的笔记\n\n留着。\n`;
    const stripped = withoutLegacyHistory(note.replaceAll("\n", "\r\n"));
    expect(stripped).toContain("\r\n");
    expect(stripped).not.toMatch(/处理记录|decision-todo-(log|history)|abc123/u);
    expect(stripped).toContain("## 我自己的笔记\r\n\r\n留着。");
    expect(parseTodoList(stripped)).toEqual(parseTodoList(note));
    const plain = serializeTodoList(research());
    expect(withoutLegacyHistory(plain)).toBe(plain);
  });
});

describe("TodoListRepository", () => {
  it("writes a list under todos/<year>/<month>/, its history beside the App, and finds the same list again instead of a copy", async () => {
    const { vault, historyRoot, repository } = await setup();
    const first = await repository.create(research("list-1"));
    const again = await repository.create(research("list-2"));

    expect(first.created).toBe(true);
    expect(first.stored.relativePath).toMatch(/^Decision Journal\/todos\/2026\/11\/paraself-遗留问题调研-[0-9a-f]{12}\.md$/u);
    expect(again).toMatchObject({ created: false, stored: { list: { id: "list-1" } } });
    expect((await repository.scan()).lists.map((stored) => stored.list.id)).toEqual(["list-1"]);
    expect(await readdir(historyRoot)).toHaveLength(1);
    expect(await readdir(join(vault, "Decision Journal", "todos", "2026", "11"))).toHaveLength(1);
  });

  it("records a box ticked in Obsidian before the change made next, in the App's history and never in the note", async () => {
    const { vault, repository } = await setup();
    await repository.create(research());
    const path = await notePath(vault);
    const edited = (await readFile(path, "utf8"))
      .replace("- [ ] 2. 托盘提示没有区分复盘", "- [x] 2. 托盘提示没有区分复盘")
      .concat("\n## 我自己的笔记\n\n这里写的东西要留着。\n");
    await writeFile(path, edited.replaceAll("\n", "\r\n"));

    const ticked = (await repository.scan()).lists[0]!.list;
    expect(todoListView(ticked, "x.md").items[1]).toMatchObject({ status: "done", changedInObsidian: true });

    const result = await repository.update("list-1", (current) => {
      const changed = changeTodoItem(current, { item: 1, status: "in_progress", note: "开始处理" }, { kind: "user" }, LATER);
      return changed.status === "saved" ? { list: changed.list, value: changed.status } : { list: null, value: changed.status };
    });

    expect(result).toMatchObject({ found: true, written: true, value: "saved" });
    const written = await readFile(path, "utf8");
    expect(written).toContain("\r\n");
    expect(written).toContain("这里写的东西要留着。");
    expect(written).toContain("- [/] 1. 本地审阅取消后残留临时目录");
    expect(written).toContain("- [x] 2. 托盘提示没有区分复盘");
    expect(written).not.toMatch(/开始处理|处理记录|decision-todo-history/u);
    expect(parseTodoList(written).revision).toBe(2);
    const list = (await repository.scan()).lists[0]!.list;
    expect(list.history.map((event) => [event.item, event.previous, event.status, event.by.kind, event.note])).toEqual([
      [2, "open", "done", "obsidian", null],
      [1, "open", "in_progress", "user", "开始处理"],
    ]);
    expect(todoListView(list, "x.md").items[1]!.changedInObsidian).toBe(false);
  });

  it("makes the change again on the note as saved meanwhile", async () => {
    const { vault, repository } = await setup();
    await repository.create(research());
    const path = await notePath(vault);
    let calls = 0;
    const result = await repository.update("list-1", (current) => {
      calls += 1;
      // Saved in Obsidian between the App's read and its write, the first time only.
      if (calls === 1) writeFileSync(path, serializeTodoList(current).replace("- [ ] 3.", "- [-] 3."));
      const appended = appendTodoItems(current, [{ title: "补一项" }], LATER);
      return { list: appended.list, value: appended.added.map((item) => item.number) };
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({ found: true, written: true, value: [4] });
    const read = parseTodoList(await readFile(path, "utf8"));
    expect(read.items.map((item) => [item.number, item.status, item.title])).toEqual([
      [1, "open", "本地审阅取消后残留临时目录"],
      [2, "open", "托盘提示没有区分复盘"],
      [3, "dropped", "README 的数据目录表缺少 todos"],
      [4, "open", "补一项"],
    ]);
  });

  it("takes the boxes of a list this machine never wrote as they stand, and gives a number used before to no new item", async () => {
    const { vault, historyRoot, repository } = await setup();
    // A list from another device: its note synced, nothing of it kept here.
    const elsewhere = saved(changeTodoItem(research(), { item: 3, status: "done", note: "别处做完的" }, { kind: "user" }, LATER));
    const folder = join(vault, "Decision Journal", "todos", "2026", "11");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "别处来的.md"), serializeTodoList(elsewhere));
    const list = (await repository.scan()).lists[0]!.list;
    expect(list).toMatchObject({ history: [], recorded: {} });
    expect(todoListView(list, "x.md").items[2]).toMatchObject({ status: "done", changedInObsidian: false });

    // Its item 3 deleted in Obsidian after the App recorded a change to it: a new line takes 4, not 3.
    await repository.update("list-1", (current) => ({ list: saved(changeTodoItem(current, { item: 3, status: "open" }, { kind: "user" }, LATER)), value: null }));
    const path = join(folder, "别处来的.md");
    await writeFile(path, (await readFile(path, "utf8")).replace("- [ ] 3. README 的数据目录表缺少 todos", "- [ ] 新加的一项"));
    const renumbered = (await repository.scan()).lists[0]!.list;
    expect(renumbered.items.map((item) => [item.number, item.title])).toContainEqual([4, "新加的一项"]);
    expect(await readdir(historyRoot)).toHaveLength(1);
  });

  it("shows a list whose history cannot be read, and refuses to write over that history", async () => {
    const { historyRoot, repository } = await setup();
    await repository.create(research());
    const [file] = await readdir(historyRoot);
    await writeFile(join(historyRoot, file!), "{ not json");

    const listed = await repository.scan();
    expect(listed.lists.map((stored) => [stored.list.id, stored.list.history.length])).toEqual([["list-1", 0]]);
    await expect(repository.update("list-1", (current) => ({ list: saved(changeTodoItem(current, { item: 1, status: "done" }, { kind: "user" }, LATER)), value: null })))
      .rejects.toThrow("变更记录读不出来，已停止写入以保护现有记录");
    expect(await readFile(join(historyRoot, file!), "utf8")).toBe("{ not json");
  });

  it("moves the history a note held before IMP-185 to this machine, as that version read it, and takes it out of the note", async () => {
    const { vault, repository } = await setup();
    const folder = join(vault, "Decision Journal", "todos", "2026", "11");
    await mkdir(folder, { recursive: true });
    // Saved by the earlier version: item 1 done by codex with its note, item 2 ticked in Obsidian since.
    const old = saved(changeTodoItem(research(), { item: 1, status: "done" }, { kind: "user" }, LATER));
    const ticked = serializeTodoList(old).replace("- [ ] 2. 托盘提示没有区分复盘", "- [x] 2. 托盘提示没有区分复盘");
    const path = join(folder, "旧版.md");
    await writeFile(path, `${ticked}${legacySections(legacyEvents)}\n## 我自己的笔记\n\n留着。\n`);

    const before = (await repository.scan()).lists[0]!.list;
    expect(before.history).toEqual(legacyEvents);
    expect(todoListView(before, "x.md").items.map((item) => [item.number, item.note, item.changedInObsidian])).toEqual([
      [1, "已在 abc123 修复", false],
      [2, null, true],
      [3, null, false],
    ]);

    expect(await repository.migrateLegacy()).toEqual({ migrated: ["Decision Journal/todos/2026/11/旧版.md"], left: [] });
    const note = await readFile(path, "utf8");
    expect(note).not.toMatch(/处理记录|decision-todo-(log|history)|abc123/u);
    expect(note).toContain("## 我自己的笔记\n\n留着。");
    expect(parseTodoList(note).revision).toBe(old.revision);
    const after = (await repository.scan()).lists[0]!.list;
    expect(after.history).toEqual(before.history);
    expect(after.recorded).toEqual(before.recorded);
    // Once is enough.
    expect(await repository.migrateLegacy()).toEqual({ migrated: [], left: [] });
  });

  it("leaves a note whose earlier history cannot be read as it is, and says so", async () => {
    const { vault, repository } = await setup();
    const folder = join(vault, "Decision Journal", "todos", "2026", "11");
    await mkdir(folder, { recursive: true });
    const content = `${serializeTodoList(research())}${legacySections(legacyEvents).replace('"status": "done"', '"status": "finished"')}`;
    await writeFile(join(folder, "坏的历史.md"), content);

    const result = await repository.migrateLegacy();
    expect(result.migrated).toEqual([]);
    expect(result.left).toEqual([expect.objectContaining({ message: expect.stringContaining("旧版的处理记录读不出来") })]);
    expect(await readFile(join(folder, "坏的历史.md"), "utf8")).toBe(content);
    expect((await repository.scan()).lists.map((stored) => stored.list.id)).toEqual(["list-1"]);
  });

  it("lists a sync conflict's copy once, says so, and refuses to write either", async () => {
    const { vault, repository } = await setup();
    await repository.create(research());
    const path = await notePath(vault);
    await writeFile(path.replace(/\.md$/u, " 2.md"), await readFile(path, "utf8"));

    const scan = await repository.scan();
    expect(scan.lists).toHaveLength(1);
    expect(scan.diagnostics[0]?.message).toContain("不止一篇待办笔记使用同一个编号");
    await expect(repository.update("list-1", (current) => ({ list: null, value: current.id }))).rejects.toThrow("同一个编号");
  });

  it("says which note it could not read, and lists the others", async () => {
    const { vault, repository } = await setup();
    await repository.create(research());
    const folder = join(vault, "Decision Journal", "todos", "2026", "10");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "坏的.md"), "---\ntype: decision-todo-list\nversion: 1\n---\n# 坏的\n");

    const scan = await repository.scan();
    expect(scan.lists.map((stored) => stored.list.id)).toEqual(["list-1"]);
    expect(scan.diagnostics).toEqual([expect.objectContaining({ path: join(folder, "坏的.md"), message: expect.stringContaining("分节标记") })]);
  });

  it("does not make up a vault that is gone", async () => {
    const repository = new TodoListRepository(join(tmpdir(), "paraself-todo-missing-vault"), { existingVault: true, history: new TodoHistoryStore(join(tmpdir(), "paraself-todo-missing-history")) });
    await expect(repository.create(research())).rejects.toThrow("找不到仓库目录");
  });

  it("keeps a long-term list as a property, finds an empty one made again by its name, and lists it with the unfinished ones", async () => {
    const { vault, repository } = await setup();
    const learning = createTodoList({ title: "学习", items: [] }, { kind: "app_manual", client: null }, "learning", NOW);
    const made = await repository.create(learning);
    const note = await readFile(join(vault, made.stored.relativePath), "utf8");
    expect(note).toMatch(/^long_term: true$/mu);
    expect(note).toContain("<!-- decision:todo-items-start -->\n<!-- decision:todo-items-end -->");
    expect(parseTodoList(note)).toEqual(noteOf(learning));

    // Something added and finished: still the one list made again by the same name, and still listed first.
    await repository.update("learning", (current) => {
      const added = appendTodoItems(current, [{ title: "读完第 5 章" }], LATER).list;
      const done = saved(changeTodoItem(added, { item: 1, status: "done" }, { kind: "user" }, LATER));
      // Two changes in one write: the note moves on by one revision.
      return { list: { ...done, revision: current.revision + 1 }, value: null };
    });
    await repository.create(research("closed"));
    await repository.update("closed", (current) => {
      let next = current;
      for (const number of [1, 2, 3]) next = saved(changeTodoItem(next, { item: number, status: "done" }, { kind: "user" }, LATER));
      return { list: { ...next, revision: current.revision + 1 }, value: null };
    });
    expect(await repository.create(createTodoList({ title: "学习", items: [] }, { kind: "agent_capture", client: "codex" }, "again", LATER)))
      .toMatchObject({ created: false, stored: { list: { id: "learning", items: [{ title: "读完第 5 章", status: "done" }] } } });
    expect((await repository.scan()).lists.map((stored) => stored.list.id)).toEqual(["learning", "closed"]);
  });

  it("reads long_term as Obsidian or a hand writes it, and takes it out when the list is made one-off", async () => {
    const markdown = serializeTodoList(research());
    expect(markdown).not.toContain("long_term");
    const withProperty = (value: string) => markdown.replace("tags: []", `long_term: ${value}\ntags: []`);
    expect(parseTodoList(withProperty("true")).longTerm).toBe(true);
    expect(parseTodoList(withProperty('"true"')).longTerm).toBe(true);
    expect(parseTodoList(withProperty("false")).longTerm).toBe(false);
    expect(() => parseTodoList(withProperty("sometimes"))).toThrow("属性 long_term 的值「sometimes」无效");

    const { vault, repository } = await setup();
    await repository.create({ ...research(), longTerm: true });
    const path = await notePath(vault);
    expect(await readFile(path, "utf8")).toMatch(/^long_term: true$/mu);
    await repository.update("list-1", (current) => ({ list: setTodoListLongTerm(current, false, LATER), value: null }));
    expect(await readFile(path, "utf8")).not.toContain("long_term");
  });

  it("keeps priority, due date, order and archive in the note as Obsidian Tasks writes them", async () => {
    const created = createTodoList(
      { title: "待办", items: [{ title: "写周报", priority: "p1", due: "2026-11-12" }, { title: "买菜", priority: "p3" }, { title: "交水费", due: "2026-11-30" }] },
      { kind: "app_manual", client: null },
      "list-p",
      NOW,
    );
    const markdown = serializeTodoList(noteOf({ ...created, archived: true }));
    expect(markdown).toContain("- [ ] 1. 写周报 ⏫ 📅 2026-11-12");
    expect(markdown).toContain("- [ ] 2. 买菜 🔽");
    expect(markdown).toContain("- [ ] 3. 交水费 📅 2026-11-30");
    expect(markdown).toMatch(/^archived: true$/mu);
    expect(parseTodoList(markdown)).toEqual(noteOf({ ...created, archived: true }));

    // Read as Obsidian users write them: other order, 🔺 (P0) and ⏬ (P3), a mark the App does not know stays in the title.
    const edited = markdown
      .replace("写周报 ⏫ 📅 2026-11-12", "写周报 📅 2026-11-13 🔺")
      .replace("买菜 🔽", "买菜 🔁 every week ⏬")
      .replace(/^archived: true\n/mu, "");
    const parsed = parseTodoList(edited);
    expect(parsed.archived).toBe(false);
    expect(parsed.items.map((item) => [item.title, item.priority, item.due])).toEqual([
      ["写周报", "p0", "2026-11-13"],
      ["买菜 🔁 every week", "p3", null],
      ["交水费", null, "2026-11-30"],
    ]);
    expect(serializeTodoList(parsed)).toContain("- [ ] 1. 写周报 🔺 📅 2026-11-13");
  });

  it("reads only the marks that end a line, and leaves everything else in the title", () => {
    const base = serializeTodoList(noteOf(createTodoList({ title: "待办", items: [{ title: "占位" }] }, { kind: "app_manual", client: null }, "list-q", NOW)));
    const read = (title: string) => {
      const [item] = parseTodoList(base.replace("占位", title)).items;
      return [item!.title, item!.priority, item!.due];
    };
    // Not marks at the end, or not readable ones: the title as written, no error.
    for (const title of ["📅 周会", "整理 📅 日历", "会议 📅 2026-11-12。", "Q4 ⏬ 🔺", "准备 ⏫ 方案", "用 `⏫`", "写 📅 2026-02-30", "x 📅 明天"]) {
      expect(read(title)).toEqual([title, null, null]);
      const roundTrip = parseTodoList(serializeTodoList(parseTodoList(base.replace("占位", title)))).items[0]!;
      expect(roundTrip.title).toBe(title);
    }
    // At the end, in either order, they are read; other Tasks marks stay.
    expect(read("写周报 ⏫ 📅 2026-11-12")).toEqual(["写周报", "p1", "2026-11-12"]);
    expect(read("写周报 📅 2026-11-13 🔺")).toEqual(["写周报", "p0", "2026-11-13"]);
    expect(read("买菜 🔁 every week ⏬")).toEqual(["买菜 🔁 every week", "p3", null]);
    expect(read("发版 ⏳ 2026-11-01 🛫 2026-11-02 ✅ 2026-11-03")).toEqual(["发版 ⏳ 2026-11-01 🛫 2026-11-02 ✅ 2026-11-03", null, null]);
    // Disagreeing priorities: the whole line is the title, the date with it, and the list still writes back.
    expect(read("Q4 ⏬ 🔺 📅 2026-12-01")).toEqual(["Q4 ⏬ 🔺 📅 2026-12-01", null, null]);
    expect(read("x ⏫ 📅 2026-01-01 🔽")).toEqual(["x ⏫ 📅 2026-01-01 🔽", null, null]);
  });

  it("keeps tags after the title, read as Obsidian reads them: #123 and a # in the middle of a title are not tags", () => {
    const base = serializeTodoList(noteOf(createTodoList({ title: "待办", items: [{ title: "占位" }] }, { kind: "app_manual", client: null }, "list-t", NOW)));
    const read = (title: string) => {
      const [item] = parseTodoList(base.replace("占位", title)).items;
      return [item!.title, item!.tags];
    };
    expect(read("写周报 #本周 #work/日常_2-a")).toEqual(["写周报", ["本周", "work/日常_2-a"]]);
    // In any order with the other marks, and written back after them.
    expect(read("写周报 #本周 📅 2026-11-12 ⏫ #文档")).toEqual(["写周报", ["本周", "文档"]]);
    expect(read("修复 #123")).toEqual(["修复 #123", []]);
    expect(read("修复 #123 #bug")).toEqual(["修复 #123", ["bug"]]);
    expect(read("把 #x 改成 y")).toEqual(["把 #x 改成 y", []]);
    expect(read("C# 和 F#")).toEqual(["C# 和 F#", []]);
    expect(read("a#b")).toEqual(["a#b", []]);
    expect(read("写周报 #Work #work")).toEqual(["写周报", ["Work"]]);

    const created = createTodoList(
      { title: "待办", items: [{ title: "写周报", priority: "p1", due: "2026-11-12", tags: ["本周", "文档"] }, { title: "买菜" }] },
      { kind: "app_manual", client: null },
      "list-t2",
      NOW,
    );
    const markdown = serializeTodoList(noteOf(created));
    expect(markdown).toContain("- [ ] 1. 写周报 ⏫ 📅 2026-11-12 #本周 #文档");
    expect(parseTodoList(markdown).items.map((item) => item.tags)).toEqual([["本周", "文档"], []]);
  });

  it("lifts #tags that end a written title out of it, so the list reads back as written", async () => {
    const { repository } = await setup();
    const { stored } = await repository.create(
      createTodoList({ title: "待办", items: [{ title: "整理书单 #学习" }, { title: "修复 #123" }] }, { kind: "agent_capture", client: "codex" }, "list-lift", NOW),
    );
    expect(stored.list.items.map((item) => [item.title, item.tags])).toEqual([["整理书单", ["学习"]], ["修复 #123", []]]);
  });

  it("records a tag changed in Obsidian, and takes a recorded item from before tags were kept as it stands", async () => {
    const { repository, historyRoot } = await setup();
    const history = new TodoHistoryStore(historyRoot);
    const { stored } = await repository.create(research("list-obs"));
    const note = await readFile(stored.path, "utf8");
    await writeFile(stored.path, note.replace("托盘提示没有区分复盘", "托盘提示没有区分复盘 #ui"), "utf8");
    const changed = await repository.update("list-obs", (current) => ({
      list: { ...current, revision: current.revision + 1, ...withObsidian(current) },
      value: current.items.find((item) => item.number === 2)!.tags,
    }));
    expect(changed.found && changed.value).toEqual(["ui"]);
    const events = (await history.read("list-obs"))!.events;
    expect(events.at(-1)).toMatchObject({ item: 2, by: { kind: "obsidian" }, tags: { from: [], to: ["ui"] } });
    // A history from before tags were kept has no tags in its recorded fields: read, and nothing counts as changed.
    const old = (await history.read("list-obs"))!;
    await history.write("list-obs", { ...old, recordedFields: { "1": { priority: null, due: null } } });
    expect((await history.read("list-obs"))!.recordedFields["1"]).toEqual({ priority: null, due: null });
    const after = await repository.update("list-obs", (current) => ({ list: null, value: withObsidianChanges(current, LATER).history.length - current.history.length }));
    expect(after.found && after.value).toBe(0);
  });

  it("reads, writes and keeps a history for an item that has more tags than a caller may add (Obsidian writes as many as it likes)", async () => {
    const { repository, historyRoot } = await setup();
    const { stored } = await repository.create(research("list-many"));
    const raw = await readFile(stored.path, "utf8");
    const tags = Array.from({ length: 12 }, (_, index) => `t${index + 1}`);
    await writeFile(stored.path, raw.replace("托盘提示没有区分复盘", `托盘提示没有区分复盘 ${tags.map((tag) => `#${tag}`).join(" ")}`), "utf8");

    const [read] = (await repository.scan()).lists;
    expect(read!.list.items[1]!.tags).toEqual(tags);
    // What the page and an agent are answered with parses, however many tags there are.
    expect(() => todoListViewSchema.parse(todoListView(read!.list, read!.relativePath))).not.toThrow();
    // A write to the list (another field) goes through, and the history it keeps can be read again.
    const changed = await repository.update("list-many", (current) => {
      const outcome = changeTodoItem(current, { item: 2, status: "in_progress" }, { kind: "user" }, LATER);
      return { list: outcome.status === "saved" ? outcome.list : null, value: outcome.status };
    });
    expect(changed.found && changed.value).toBe("saved");
    const history = await new TodoHistoryStore(historyRoot).read("list-many");
    expect(history!.recordedFields["2"]!.tags).toEqual(tags);
    const [again] = (await repository.scan()).lists;
    expect(again!.list.items[1]!.tags).toHaveLength(12);
    expect(again!.list.items[1]!.status).toBe("in_progress");
    // And a tag taken off in the page leaves eleven, which the page may write.
    const fewer = await repository.update("list-many", (current) => {
      const outcome = changeTodoItem(current, { item: 2, tags: tags.slice(1), expectedTags: tags }, { kind: "user" }, LATER);
      return { list: outcome.status === "saved" ? outcome.list : null, value: outcome.status };
    });
    expect(fewer.found && fewer.value).toBe("saved");
    expect(((await new TodoHistoryStore(historyRoot).read("list-many"))!.events.at(-1))).toMatchObject({ tags: { from: tags, to: tags.slice(1) } });
  });

  it("lifts the #tags that end a title however many spaces stand before them, and reads it back unchanged", async () => {
    const { repository } = await setup();
    const { stored } = await repository.create(
      createTodoList({ title: "待办", items: [{ title: "foo  #bar" }, { title: "baz\t#q  #r" }] }, { kind: "agent_capture", client: "codex" }, "list-sp", NOW),
    );
    expect(stored.list.items.map((item) => [item.title, item.tags])).toEqual([["foo", ["bar"]], ["baz", ["q", "r"]]]);
    // Nothing changed since the App wrote it: nothing is taken for a change made in Obsidian.
    const [read] = (await repository.scan()).lists;
    expect(withObsidianChanges(read!.list, LATER).history).toEqual(read!.list.history);
  });

  it("does not take a priority recorded as 「high」 (before P0–P3) for a change when the note says P0 (🔺)", async () => {
    const { repository, historyRoot } = await setup();
    const created = createTodoList({ title: "待办", items: [{ title: "甲", priority: "p1" }, { title: "乙", priority: "p1" }] }, { kind: "agent_capture", client: "codex" }, "list-leg", NOW);
    const { stored } = await repository.create(created);
    // The history as the version before P0–P3 wrote it: high for both, whichever mark the note had.
    const file = join(historyRoot, `${createHash("sha256").update("list-leg", "utf8").digest("hex")}.json`);
    await writeFile(
      file,
      JSON.stringify({ version: 1, listId: "list-leg", recorded: { "1": "open", "2": "open" }, recordedFields: { "1": { priority: "high", due: null }, "2": { priority: "high", due: null } }, events: [] }),
      "utf8",
    );
    const note = await readFile(stored.path, "utf8");
    // 甲 was a 🔺 (read as high then, P0 now); 乙 was a ⏫ and still is.
    await writeFile(stored.path, note.replace("甲 ⏫", "甲 🔺"), "utf8");
    const [read] = (await repository.scan()).lists;
    const reconciled = withObsidianChanges(read!.list, LATER);
    expect(reconciled.history).toEqual([]);
    // Written once, the history holds P0 and P1 as they are, and a later change to P0 → P3 is a change.
    const written = await repository.update("list-leg", (current) => {
      const outcome = changeTodoItem(current, { item: 2, status: "in_progress" }, { kind: "user" }, LATER);
      return { list: outcome.status === "saved" ? outcome.list : null, value: outcome.status };
    });
    expect(written.found && written.value).toBe("saved");
    expect((await new TodoHistoryStore(historyRoot).read("list-leg"))!.recordedFields["1"]).toEqual({ priority: "p0", due: null, tags: [], dependsOn: [] });
    await writeFile(stored.path, (await readFile(stored.path, "utf8")).replace("甲 🔺", "甲 🔽"), "utf8");
    const [after] = (await repository.scan()).lists;
    expect(withObsidianChanges(after!.list, LATER).history.at(-1)).toMatchObject({ item: 1, priority: { from: "p0", to: "p3" } });
  });

  it("writes a list back whose title ends in disagreeing marks", async () => {
    const { repository } = await setup();
    const { stored } = await repository.create(research());
    const note = await readFile(stored.path, "utf8");
    await writeFile(stored.path, note.replace("2. 托盘提示没有区分复盘", "2. x ⏫ 📅 2026-01-01 🔽"), "utf8");
    const changed = await repository.update("list-1", (current) => ({
      list: saved(changeTodoItem(current, { item: 1, status: "in_progress" }, { kind: "user" }, LATER)),
      value: null,
    }));
    if (!changed.found) throw new Error("list vanished");
    expect(changed.stored.list.items[1]).toMatchObject({ title: "x ⏫ 📅 2026-01-01 🔽", priority: null, due: null });
    expect(await readFile(stored.path, "utf8")).toContain("- [ ] 2. x ⏫ 📅 2026-01-01 🔽\n");
  });

  it("notes a due date edited in Obsidian in the history at the next write, and moves items by rewriting the lines", async () => {
    const { repository } = await setup();
    const { stored } = await repository.create(research());
    const path = stored.path;
    const note = await readFile(path, "utf8");
    await writeFile(path, note.replace("1. 本地审阅取消后残留临时目录", "1. 本地审阅取消后残留临时目录 📅 2026-12-24"), "utf8");
    const changed = await repository.update("list-1", (current) => ({
      list: saved(changeTodoItem(current, { item: 2, priority: "p2" }, { kind: "user" }, LATER)),
      value: null,
    }));
    if (!changed.found) throw new Error("list vanished");
    expect(changed.stored.list.history.map((event) => [event.item, event.by.kind, event.due?.to ?? null, event.priority?.to ?? null])).toEqual([
      [1, "obsidian", "2026-12-24", null],
      [2, "user", null, "p2"],
    ]);
    const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.startsWith("- ["));
    expect(lines[0]).toContain("📅 2026-12-24");
    expect(lines[1]).toContain("🔼");
  });
  describe("处置备注", () => {
    const withDisposition = (text: string | null, number = 1): TodoListRecord =>
      saved(changeTodoItem(research(), { item: number, disposition: text }, { kind: "user" }, LATER));

    it("sits under the item beside its detail, and reads back apart from it", () => {
      const list = withDisposition("按这个思路改，别动 worker");
      const markdown = serializeTodoList(list);
      expect(markdown).toContain("\n\n  建议：取消时清理 jobs/\\<id>/tree\n\n  处置：按这个思路改，别动 worker");
      const read = parseTodoList(markdown);
      expect(read.items[0]).toMatchObject({ detail: "证据：local-review-service.ts 第 420 行\n\n建议：取消时清理 jobs/<id>/tree", disposition: "按这个思路改，别动 worker" });
      expect(read.items[1]!.disposition).toBeNull();
      expect(read).toEqual(noteOf(list));
    });

    it("keeps further lines with the first, and a line of the detail that follows after a blank one", () => {
      const list = withDisposition("先修 A\n再修 B\n\n别碰 C");
      expect(list.items[0]!.disposition).toBe("先修 A\n再修 B\n别碰 C");
      expect(serializeTodoList(list)).toContain("  处置：先修 A\n  再修 B\n  别碰 C");
      expect(parseTodoList(serializeTodoList(list))).toEqual(noteOf(list));
      // Anything indented after it makes it part of the 补充说明 instead (the App writes it last).
      const edited = serializeTodoList(withDisposition("先修 A")).replace("  处置：先修 A", "  处置：先修 A\n  再修 B\n\n  Obsidian 里补的说明");
      const read = parseTodoList(edited).items[0]!;
      expect(read.disposition).toBeNull();
      expect(read.detail).toMatch(/处置：先修 A\n再修 B\n\nObsidian 里补的说明$/u);
    });

    it("reads one added or changed in Obsidian, with either colon and a tab, and none where there is no such line", () => {
      const markdown = serializeTodoList(research()).replace("- [ ] 2. 托盘提示没有区分复盘", "- [ ] 2. 托盘提示没有区分复盘\n\t处置: 先不做")
        .replace("- [ ] 3. README 的数据目录表缺少 todos", "- [ ] 3. README 的数据目录表缺少 todos\n  处理：不是处置行");
      const read = parseTodoList(markdown);
      expect(read.items[1]!).toMatchObject({ detail: null, disposition: "先不做" });
      expect(read.items[2]!).toMatchObject({ detail: "处理：不是处置行", disposition: null });
      expect(read.items[0]!.disposition).toBeNull();
    });

    it("is written back around what the reader kept, and clearing it takes the lines away", async () => {
      const { repository } = await setup();
      const { stored } = await repository.create(research());
      const note = await readFile(stored.path, "utf8");
      await writeFile(stored.path, note.replace("# Paraself 遗留问题调研", "# Paraself 遗留问题调研\n\n我在 Obsidian 里写的一段话。"), "utf8");
      const set = await repository.update("list-1", (current) => ({ list: saved(changeTodoItem(current, { item: 1, disposition: "按我说的办" }, { kind: "user" }, LATER)), value: null }));
      if (!set.found) throw new Error("list vanished");
      expect(set.stored.list.items[0]!.disposition).toBe("按我说的办");
      expect(set.stored.list.history.at(-1)).toMatchObject({ item: 1, by: { kind: "user" }, disposition: true });
      const after = await readFile(stored.path, "utf8");
      expect(after).toContain("我在 Obsidian 里写的一段话。");
      expect(after).toContain("  处置：按我说的办");
      const cleared = await repository.update("list-1", (current) => ({ list: saved(changeTodoItem(current, { item: 1, disposition: null }, { kind: "user" }, LATER)), value: null }));
      if (!cleared.found) throw new Error("list vanished");
      expect(await readFile(stored.path, "utf8")).not.toContain("处置");
    });

    it("is refused for a page that saw another one (expectedDisposition), and an agent's change cannot carry it", () => {
      const list = withDisposition("旧意见");
      expect(changeTodoItem(list, { item: 1, disposition: "新意见", expectedDisposition: null }, { kind: "user" }, LATER).status).toBe("status_changed");
      expect(changeTodoItem(list, { item: 1, disposition: "新意见", expectedDisposition: "旧意见" }, { kind: "user" }, LATER).status).toBe("saved");
      expect(changeTodoItem(list, { item: 1, disposition: "旧意见" }, { kind: "user" }, LATER).status).toBe("unchanged");
      const viewed = todoListView(list, "x.md");
      expect(viewed.items[0]!.disposition).toBe("旧意见");
      expect(todoListViewSchema.parse(viewed).items[0]!.disposition).toBe("旧意见");
    });

    const oldNote = (itemBlock: string): string => serializeTodoList(research()).replace("- [ ] 2. 托盘提示没有区分复盘", `- [ ] 2. 托盘提示没有区分复盘\n\n${itemBlock}`);

    it("leaves a 处置： paragraph in the middle of an old detail to the detail", () => {
      const read = parseTodoList(oldNote("  背景：X\n\n  处置：建议回滚\n  继续\n\n  结论：Y")).items[1]!;
      expect(read.disposition).toBeNull();
      expect(read.detail).toBe("背景：X\n\n处置：建议回滚\n继续\n\n结论：Y");
      // Written back, it stays where it was (and is not moved to the end as the reader's).
      const list = parseTodoList(oldNote("  背景：X\n\n  处置：建议回滚\n  继续\n\n  结论：Y"));
      expect(parseTodoList(serializeTodoList(list))).toEqual(list);
      expect(todoListView({ ...list, history: [], recorded: {}, recordedFields: {} }, "x.md").items[1]!.disposition).toBeNull();
    });

    it("writes a detail with 处置 lines, and reads it back as written, apart from the reader's 处置备注", () => {
      const detail = "背景：X\n\n处置：建议回滚\n继续\n处置:半角\n\\处置：反斜杠开头\n\n结论：Y";
      const base = research();
      const list = saved(changeTodoItem(base, { item: 1, detail, disposition: "按我说的\n处置：不是新的一块\n\\处置：带反斜杠" }, { kind: "user" }, LATER));
      const markdown = serializeTodoList(list);
      expect(markdown).toContain("  \\处置：建议回滚");
      const read = parseTodoList(markdown);
      expect(read.items[0]).toMatchObject({ detail, disposition: "按我说的\n处置：不是新的一块\n\\处置：带反斜杠" });
      expect(read).toEqual(noteOf(list));
      // A detail ending in such a paragraph still round-trips (the 处置备注 stays after it).
      const ending = saved(changeTodoItem(base, { item: 1, detail: "背景\n\n处置：最后一段", disposition: "我的" }, { kind: "user" }, LATER));
      expect(parseTodoList(serializeTodoList(ending))).toEqual(noteOf(ending));
      expect(parseTodoList(serializeTodoList(ending)).items[0]!.detail).toBe("背景\n\n处置：最后一段");
    });

    it("writes a list whose detail has a 处置 line to its note (it is not refused)", async () => {
      const { repository } = await setup();
      const list = research();
      const { stored } = await repository.create({ ...list, items: list.items.map((item) => (item.number === 2 ? { ...item, detail: "处置：建议回滚" } : item)) });
      expect(stored.list.items[1]!).toMatchObject({ detail: "处置：建议回滚", disposition: null });
    });

    it("reads a 处置 paragraph too long for a 处置备注 as the detail, and the list stays readable", () => {
      const long = "长".repeat(2100);
      const read = parseTodoList(oldNote(`  背景：X\n\n  处置：${long}`)).items[1]!;
      expect(read.disposition).toBeNull();
      expect(read.detail).toBe(`背景：X\n\n处置：${long}`);
    });
  });
});

describe("Obsidian Tasks dependencies", () => {
  it("round trips ids, comma-separated prerequisites and cached titles without affecting other fields", () => {
    const list = research();
    Object.assign(list.items[0]!, { id: "Ab_123-x", dependsOn: ["done", "missing"], dependencyTitles: { done: "完成的前置", missing: "找不到的前置" }, priority: "p1", due: "2026-11-18", tags: ["待办"] });
    const markdown = serializeTodoList(list);
    expect(markdown).toContain("🆔 Ab_123-x ⛔ done,missing");
    const parsed = parseTodoList(markdown.replace("⛔ done,missing", "⛔ done, missing, done"));
    expect(parsed.items[0]).toEqual(list.items[0]);
    expect(serializeTodoList(parsed)).toBe(markdown);
  });
});
