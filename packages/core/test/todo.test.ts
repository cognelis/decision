import { TODO_LIMITS } from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import {
  appendTodoItems,
  changeTodoItem,
  changeTodoItems,
  createTodoList,
  deleteTodoItems,
  moveTodoItem,
  setTodoListLongTerm,
  updateTodoListSettings,
  todoItemView,
  todoListKey,
  todoListNameKey,
  todoListPending,
  withObsidianChanges,
  type TodoListRecord,
} from "../src/index.js";

const NOW = new Date("2026-11-09T09:00:00.000Z");
const LATER = new Date("2026-11-09T10:00:00.000Z");
const codex = { kind: "agent", client: "codex" } as const;

const list = (): TodoListRecord =>
  createTodoList(
    {
      title: " 调研 ",
      summary: "  摘要  \r\n第二行   ",
      project: "paraself",
      items: [{ title: "第一项", detail: "说明" }, { title: "第二项" }, { title: "第一项" }],
    },
    { kind: "agent_capture", client: "codex" },
    "list-1",
    NOW,
  );

const saved = (outcome: ReturnType<typeof changeTodoItem>): TodoListRecord => {
  if (outcome.status !== "saved") throw new Error(`expected saved, got ${outcome.status}`);
  return outcome.list;
};

describe("todo lists", () => {
  it("numbers the items from one, keeping the same finding once and the text as written", () => {
    const created = list();
    expect(created).toMatchObject({ title: "调研", summary: "摘要\n第二行", revision: 1, history: [] });
    expect(created.items).toEqual([
      { number: 1, title: "第一项", detail: "说明", disposition: null, status: "open", priority: null, due: null, tags: [] },
      { number: 2, title: "第二项", detail: null, disposition: null, status: "open", priority: null, due: null, tags: [] },
    ]);
    expect(todoListKey(created)).toBe(todoListKey({ project: "paraself", title: "调研", items: [{ title: "第一项" }, { title: "第二项" }] }));
  });

  it("adds items after every number used, skipping those the list has", () => {
    const created = list();
    const dropped = saved(changeTodoItem({ ...created, items: created.items.slice(0, 1), history: [{ item: 2, at: NOW.toISOString(), previous: "open", status: "dropped", note: "不做", by: { kind: "user" } }] }, { item: 1, status: "done" }, { kind: "user" }, NOW));
    const appended = appendTodoItems(dropped, [{ title: "第一项" }, { title: " 第三项 " }], LATER);

    expect(appended.skipped.map((item) => item.number)).toEqual([1]);
    // Number 2 went with an item removed in Obsidian; its history still names it, so it is not given again.
    expect(appended.added).toEqual([{ number: 3, title: "第三项", detail: null, disposition: null, status: "open", priority: null, due: null, tags: [] }]);
    expect(appended.list.revision).toBe(dropped.revision + 1);
    expect(appendTodoItems(appended.list, [{ title: "第三项" }], LATER).list).toBe(appended.list);
  });

  it("refuses to take a list past its item limit", () => {
    const full = { ...list(), items: Array.from({ length: TODO_LIMITS.itemsPerList }, (_, index) => ({ number: index + 1, title: `第 ${index + 1} 项`, detail: null, disposition: null, status: "open" as const, priority: null, due: null, tags: [] })) };
    expect(appendTodoItems(full, [{ title: "再多一项" }], LATER)).toMatchObject({ full: true, added: [] });
  });

  it("asks an agent to say what was done before an item is finished or dropped, and nothing of the reader", () => {
    const created = list();
    expect(changeTodoItem(created, { item: 1, status: "done" }, codex, LATER)).toEqual({ status: "note_required" });
    expect(changeTodoItem(created, { item: 1, status: "dropped", note: "  " }, codex, LATER)).toEqual({ status: "note_required" });
    expect(changeTodoItem(created, { item: 1, status: "in_progress" }, codex, LATER).status).toBe("saved");
    expect(changeTodoItem(created, { item: 1, status: "done" }, { kind: "user" }, LATER).status).toBe("saved");
    expect(changeTodoItem(created, { item: 9, status: "done" }, { kind: "user" }, LATER)).toEqual({ status: "item_not_found" });
  });

  it("writes nothing for the same status and note again, and nothing over a status the reader did not see", () => {
    const done = saved(changeTodoItem(list(), { item: 1, status: "done", note: "修好了" }, codex, LATER));
    expect(changeTodoItem(done, { item: 1, status: "done", note: "修好了" }, codex, LATER).status).toBe("unchanged");
    expect(changeTodoItem(done, { item: 1, status: "done" }, codex, LATER).status).toBe("unchanged");
    expect(changeTodoItem(done, { item: 1, status: "open", expectedStatus: "in_progress" }, { kind: "user" }, LATER).status).toBe("status_changed");
    const noted = saved(changeTodoItem(done, { item: 1, note: "补一句验证方式" }, codex, LATER));
    expect(noted.history.at(-1)).toMatchObject({ item: 1, previous: "done", status: "done", note: "补一句验证方式" });
  });

  it("records a box ticked in Obsidian before the change that follows it", () => {
    const created = list();
    const ticked = { ...created, items: created.items.map((item) => (item.number === 2 ? { ...item, status: "done" as const } : item)) };
    expect(todoItemView(ticked, ticked.items[1]!)).toMatchObject({ status: "done", changedInObsidian: true, changedAt: null });

    const changed = saved(changeTodoItem(ticked, { item: 1, status: "in_progress" }, codex, LATER));
    expect(changed.history).toEqual([
      { item: 2, at: LATER.toISOString(), previous: "open", status: "done", note: null, by: { kind: "obsidian" } },
      { item: 1, at: LATER.toISOString(), previous: "open", status: "in_progress", note: null, by: codex },
    ]);
    expect(todoItemView(changed, changed.items[1]!).changedInObsidian).toBe(false);
    // Nothing changed in Obsidian since: no change recorded.
    expect(withObsidianChanges(changed, LATER)).toEqual(changed);
  });

  it("shows the note said with an item's latest change, not one a later change left behind", () => {
    const done = saved(changeTodoItem(list(), { item: 1, status: "done", note: "修好了" }, codex, NOW));
    expect(todoItemView(done, done.items[0]!)).toMatchObject({ status: "done", note: "修好了", changedBy: codex });
    const reopened = saved(changeTodoItem(done, { item: 1, status: "open" }, { kind: "user" }, LATER));
    expect(todoItemView(reopened, reopened.items[0]!)).toMatchObject({ status: "open", note: null, changedBy: { kind: "user" } });
    expect(todoListPending(reopened)).toBe(true);
  });

  it("keeps each item's latest change when the history outgrows its limit", () => {
    let current = list();
    for (let index = 0; index < TODO_LIMITS.history + 5; index += 1) {
      current = saved(changeTodoItem(current, { item: 1, note: `第 ${index} 次` }, { kind: "user" }, LATER));
    }
    current = saved(changeTodoItem(current, { item: 2, status: "done" }, { kind: "user" }, LATER));
    expect(current.history).toHaveLength(TODO_LIMITS.history);
    expect(current.history.filter((event) => event.item === 2)).toHaveLength(1);
    expect(todoItemView(current, current.items[0]!).note).toBe(`第 ${TODO_LIMITS.history + 4} 次`);
  });

  it("makes a list started without items a long-term one, kept with the unfinished lists however much of it is done", () => {
    const daily = createTodoList({ title: "日常", items: [] }, { kind: "app_manual", client: null }, "daily", NOW);
    expect(daily).toMatchObject({ longTerm: true, items: [], revision: 1 });
    expect(todoListPending(daily)).toBe(true);
    expect(list().longTerm).toBe(false);
    expect(createTodoList({ title: "发布前检查", items: [], longTerm: false }, { kind: "app_manual", client: null }, "release", NOW).longTerm).toBe(false);

    const added = appendTodoItems(daily, [{ title: "交电费" }], LATER).list;
    const paid = saved(changeTodoItem(added, { item: 1, status: "done" }, { kind: "user" }, LATER));
    expect(todoListPending(paid)).toBe(true);
    // A one-off list is done with once every item is; one with no items yet is not.
    expect(todoListPending({ ...paid, longTerm: false })).toBe(false);
    expect(todoListPending({ ...daily, longTerm: false })).toBe(true);
  });

  it("switches a list between long-term and one-off as a change of its own", () => {
    const research = list();
    expect(setTodoListLongTerm(research, false, LATER)).toBe(research);
    expect(setTodoListLongTerm(research, true, LATER)).toMatchObject({ longTerm: true, revision: research.revision + 1, updatedAt: LATER.toISOString(), history: [] });
  });

  it("names a list by its project and title alone for one made again without items", () => {
    expect(todoListNameKey({ project: null, title: " 学习 " })).toBe(todoListNameKey({ project: undefined, title: "学习" }));
    expect(todoListNameKey({ project: "paraself", title: "学习" })).not.toBe(todoListNameKey({ project: null, title: "学习" }));
  });

  it("lets a long-term list take a todo again once the last one like it is done, and keeps a list of findings from it", () => {
    const daily = appendTodoItems(createTodoList({ title: "日常", items: [] }, { kind: "app_manual", client: null }, "daily", NOW), [{ title: "交水费" }], NOW).list;
    expect(appendTodoItems(daily, [{ title: "交水费" }], LATER)).toMatchObject({ added: [], skipped: [{ number: 1 }] });
    const paid = saved(changeTodoItem(daily, { item: 1, status: "done" }, { kind: "user" }, LATER));
    expect(appendTodoItems(paid, [{ title: " 交水费 " }], LATER)).toMatchObject({ added: [{ number: 2, title: "交水费" }], skipped: [] });

    const findings = saved(changeTodoItem(list(), { item: 1, status: "done" }, { kind: "user" }, LATER));
    expect(appendTodoItems(findings, [{ title: "第一项" }], LATER)).toMatchObject({ added: [], skipped: [{ number: 1 }] });
  });

  it("makes room in a full long-term list by its oldest finished items, and refuses when there are none to let go", () => {
    const item = (number: number, status: "open" | "done" | "dropped") => ({ number, title: `第 ${number} 项`, detail: null, disposition: null, status, priority: null, due: null, tags: [] });
    const full = (statuses: ("open" | "done" | "dropped")[], longTerm: boolean): TodoListRecord => {
      const items = statuses.map((status, index) => item(index + 1, status));
      return { ...list(), longTerm, items, recorded: Object.fromEntries(items.map((entry) => [String(entry.number), entry.status])), recordedFields: {} };
    };
    const statuses = Array.from({ length: TODO_LIMITS.itemsPerList }, (_, index) => (index === 1 ? "done" : index === 4 ? "dropped" : index === 7 ? "done" : "open"));

    const made = appendTodoItems(full(statuses, true), [{ title: "新的一项" }, { title: "又一项" }], LATER);
    expect(made.full).toBe(false);
    expect(made.removed.map((entry) => entry.number)).toEqual([2, 5]);
    expect(made.list.items).toHaveLength(TODO_LIMITS.itemsPerList);
    expect(made.added.map((entry) => entry.number)).toEqual([TODO_LIMITS.itemsPerList + 1, TODO_LIMITS.itemsPerList + 2]);
    expect(Object.keys(made.list.recorded)).not.toContain("2");

    expect(appendTodoItems(full(statuses, false), [{ title: "新的一项" }], LATER)).toMatchObject({ full: true, added: [], removed: [] });
    const nothingDone = Array.from({ length: TODO_LIMITS.itemsPerList }, () => "open" as const);
    expect(appendTodoItems(full(nothingDone, true), [{ title: "新的一项" }], LATER)).toMatchObject({ full: true, added: [], removed: [] });
  });

  it("changes priority and due date without a note, records them, and refuses on what the page did not see", () => {
    const created = list();
    const agent = saved(changeTodoItem(created, { item: 1, priority: "p1", due: "2026-11-12" }, codex, LATER));
    expect(agent.items[0]).toMatchObject({ priority: "p1", due: "2026-11-12", status: "open" });
    expect(agent.history.at(-1)).toMatchObject({
      item: 1, previous: "open", status: "open", note: null,
      priority: { from: null, to: "p1" }, due: { from: null, to: "2026-11-12" },
    });
    expect(changeTodoItem(agent, { item: 1, priority: "p1", due: "2026-11-12" }, codex, LATER).status).toBe("unchanged");
    // Cleared with null; the page's view of them is checked like the status.
    expect(changeTodoItem(agent, { item: 1, priority: null, expectedPriority: "p3" }, { kind: "user" }, LATER).status).toBe("status_changed");
    const cleared = saved(changeTodoItem(agent, { item: 1, priority: null, due: null, expectedDue: "2026-11-12" }, { kind: "user" }, LATER));
    expect(todoItemView(cleared, cleared.items[0]!)).toMatchObject({ priority: null, due: null });
  });

  it("changes the tags as a whole, records them, and refuses on tags the page did not see", () => {
    const created = list();
    const tagged = saved(changeTodoItem(created, { item: 1, tags: ["本周", "文档", "本周"] }, { kind: "user" }, LATER));
    expect(tagged.items[0]!.tags).toEqual(["本周", "文档"]);
    expect(tagged.history.at(-1)).toMatchObject({ item: 1, note: null, tags: { from: [], to: ["本周", "文档"] } });
    expect(changeTodoItem(tagged, { item: 1, tags: ["本周", "文档"] }, { kind: "user" }, LATER).status).toBe("unchanged");
    expect(changeTodoItem(tagged, { item: 1, tags: [], expectedTags: ["本周"] }, { kind: "user" }, LATER).status).toBe("status_changed");
    const cleared = saved(changeTodoItem(tagged, { item: 1, tags: ["文档"], expectedTags: ["本周", "文档"] }, { kind: "user" }, LATER));
    expect(todoItemView(cleared, cleared.items[0]!).tags).toEqual(["文档"]);
    // New items carry theirs, each once.
    expect(appendTodoItems(created, [{ title: "新的一项", tags: ["a", "A", "b"] }], LATER).added[0]!.tags).toEqual(["a", "b"]);
  });

  it("compares titles as the note keeps them: the #tags that end one are the item's tags, not its words", () => {
    const created = createTodoList({ title: "t", items: [{ title: "修 bug #urgent" }, { title: "修 bug  #urgent" }] }, { kind: "agent_capture", client: "codex" }, "l", NOW);
    // The same finding twice in one call is one item, with its tag.
    expect(created.items).toMatchObject([{ number: 1, title: "修 bug", tags: ["urgent"] }]);
    const sent = appendTodoItems(created, [{ title: "修 bug #urgent" }, { title: "修 bug\t#urgent  #urgent" }, { title: "修 bug" }, { title: "修 bug #other" }], LATER);
    expect(sent.added).toEqual([]);
    expect(sent.skipped.map((item) => item.number)).toEqual([1]);
    expect(todoListKey({ title: "t", items: [{ title: "修 bug #urgent" }] })).toBe(todoListKey({ title: "t", items: [{ title: "修 bug" }] }));
    // A title that is only a tag stays whole; # in the middle is the title's.
    expect(appendTodoItems(created, [{ title: "#solo" }, { title: "把 #x 改成 y #z" }], LATER).added).toMatchObject([
      { title: "#solo", tags: [] },
      { title: "把 #x 改成 y", tags: ["z"] },
    ]);
  });

  it("refuses a change of the detail made on one that is not the detail the reader saw", () => {
    const created = list();
    const first = created.items[0]!.detail;
    expect(changeTodoItem(created, { item: 1, detail: "新", expectedDetail: "不是原来的" }, { kind: "user" }, LATER).status).toBe("status_changed");
    expect(changeTodoItem(created, { item: 1, detail: "新", expectedDetail: null }, { kind: "user" }, LATER).status).toBe("status_changed");
    expect(changeTodoItem(created, { item: 2, detail: "新", expectedDetail: "不是空的" }, { kind: "user" }, LATER).status).toBe("status_changed");
    expect(changeTodoItem(created, { item: 1, detail: "新", expectedDetail: first }, { kind: "user" }, LATER).status).toBe("saved");
    expect(changeTodoItem(created, { item: 2, detail: "新", expectedDetail: null }, { kind: "user" }, LATER).status).toBe("saved");
  });

  it("rewrites an item's detail from the page, records that it was, and clears it with null", () => {
    const created = list();
    const edited = saved(changeTodoItem(created, { item: 2, detail: "新的说明\n\n- 一条" }, { kind: "user" }, LATER));
    expect(edited.items[1]!.detail).toBe("新的说明\n\n- 一条");
    expect(edited.history.at(-1)).toMatchObject({ item: 2, note: null, detail: true });
    expect(changeTodoItem(edited, { item: 2, detail: "新的说明\n\n- 一条" }, { kind: "user" }, LATER).status).toBe("unchanged");
    expect(saved(changeTodoItem(edited, { item: 2, detail: null }, { kind: "user" }, LATER)).items[1]!.detail).toBeNull();
  });

  it("reads a priority or due date changed in Obsidian as a change made there", () => {
    const created = list();
    const edited = { ...created, items: created.items.map((item) => (item.number === 2 ? { ...item, priority: "p3" as const, due: "2026-12-01" } : item)) };
    const reconciled = withObsidianChanges(edited, LATER);
    expect(reconciled.history.at(-1)).toMatchObject({
      item: 2, by: { kind: "obsidian" }, priority: { from: null, to: "p3" }, due: { from: null, to: "2026-12-01" },
    });
    expect(withObsidianChanges(reconciled, LATER).history).toHaveLength(reconciled.history.length);
    // A list whose fields this machine never recorded is taken as it stands.
    expect(withObsidianChanges({ ...edited, recordedFields: {} }, LATER).history).toEqual([]);
  });

  it("moves an item before another or to the end, keeping the rest in order and writing no history", () => {
    const three = appendTodoItems(list(), [{ title: "第三项" }], LATER).list;
    const order = (moved: ReturnType<typeof moveTodoItem>) => (typeof moved === "string" ? moved : moved.items.map((item) => item.number));
    expect(order(moveTodoItem(three, 3, 1, LATER))).toEqual([3, 1, 2]);
    expect(order(moveTodoItem(three, 1, null, LATER))).toEqual([2, 3, 1]);
    expect(order(moveTodoItem(three, 2, 3, LATER))).toBe("unchanged");
    expect(order(moveTodoItem(three, 9, 1, LATER))).toBe("item_not_found");
    expect(order(moveTodoItem(three, 1, 9, LATER))).toBe("item_not_found");
    expect((moveTodoItem(three, 3, 1, LATER) as TodoListRecord).history).toEqual(three.history);
  });

  it("renames and archives a list, and an archived list is not among the unfinished ones", () => {
    const created = list();
    expect(updateTodoListSettings(created, {}, LATER)).toBe(created);
    const archived = updateTodoListSettings(created, { archived: true, title: " 新名字 " }, LATER);
    expect(archived).toMatchObject({ archived: true, title: "新名字", revision: created.revision + 1 });
    expect(todoListPending(created)).toBe(true);
    expect(todoListPending(archived)).toBe(false);
    expect(todoListPending(updateTodoListSettings(archived, { archived: false }, LATER))).toBe(true);
  });

  it("changes several items in one write, leaving alone the ones that moved on", () => {
    const three = appendTodoItems(list(), [{ title: "第三项" }], LATER).list;
    const user = { kind: "user" } as const;
    const batch = changeTodoItems(three, [
      { item: 1, status: "done", expectedStatus: "open" },
      { item: 2, status: "open", expectedStatus: "open" },
      { item: 3, priority: "p1", expectedStatus: "dropped" },
      { item: 9, status: "done", expectedStatus: "open" },
    ], user, LATER);
    expect(batch.results).toEqual([
      { item: 1, status: "saved" }, { item: 2, status: "unchanged" }, { item: 3, status: "status_changed" }, { item: 9, status: "item_not_found" },
    ]);
    expect(batch.list.revision).toBe(three.revision + 1);
    expect(batch.list.items.map((item) => item.status)).toEqual(["done", "open", "open"]);
    expect(batch.list.history.filter((event) => event.item === 1)).toHaveLength(1);
    expect(changeTodoItems(three, [{ item: 1, status: "open", expectedStatus: "open" }], user, LATER)).toMatchObject({ written: false, list: three });
  });

  it("deletes items on the status the page showed, keeps a record, and never gives their numbers again", () => {
    const three = appendTodoItems(list(), [{ title: "第三项" }], LATER).list;
    const user = { kind: "user" } as const;
    const gone = deleteTodoItems(three, [{ item: 2, expectedStatus: "open" }, { item: 3, expectedStatus: "done" }, { item: 8, expectedStatus: "open" }], user, LATER);
    expect(gone.results).toEqual([{ item: 2, status: "saved" }, { item: 3, status: "status_changed" }, { item: 8, status: "item_not_found" }]);
    expect(gone.list.items.map((item) => item.number)).toEqual([1, 3]);
    expect(gone.list.history.at(-1)).toMatchObject({ item: 2, by: { kind: "user" }, deleted: true });
    expect(gone.list.revision).toBe(three.revision + 1);
    expect(appendTodoItems(gone.list, [{ title: "新的" }], LATER).added[0]!.number).toBe(4);
    expect(deleteTodoItems(three, [{ item: 8, expectedStatus: "open" }], user, LATER).written).toBe(false);
  });
});

it("never automatically evicts a finished item with a stable identity from a full long-term list", () => {
  const current = list();
  current.longTerm = true;
  current.items = Array.from({ length: TODO_LIMITS.itemsPerList }, (_, i) => ({ ...current.items[0]!, number: i + 1, title: `项目 ${i}`, id: `id-${i}`, status: "done" as const }));
  expect(appendTodoItems(current, [{ title: "新增" }], LATER)).toMatchObject({ full: true, removed: [] });
});
