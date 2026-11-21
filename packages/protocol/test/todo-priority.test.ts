import { describe, expect, it } from "vitest";

import { TODO_SHAPE, isTodoTag, splitTitleTags, todoItemInputSchema, todoItemViewSchema, todoTagsInputSchema, todoTagsSchema, todoAnswerFor, todoEventSchema, todoItemChangeSchema, todoPrioritySchema, type TodoItemView } from "../src/index.js";

describe("todo priority P0–P3", () => {
  it("reads p0–p3, and the words before them as p1, p2, p3", () => {
    expect(["p0", "p1", "p2", "p3"].map((value) => todoPrioritySchema.parse(value))).toEqual(["p0", "p1", "p2", "p3"]);
    expect(["high", "medium", "low"].map((value) => todoPrioritySchema.parse(value))).toEqual(["p1", "p2", "p3"]);
    expect(todoPrioritySchema.safeParse("urgent").success).toBe(false);
    expect(todoPrioritySchema.nullable().parse(null)).toBeNull();
  });

  it("reads a history written before P0–P3 (high → P1)", () => {
    const event = todoEventSchema.parse({
      item: 1,
      at: "2026-11-09T01:00:00.000Z",
      previous: "open",
      status: "open",
      note: null,
      by: { kind: "user" },
      priority: { from: "medium", to: "high" },
    });
    expect(event.priority).toEqual({ from: "p2", to: "p1" });
    expect(todoItemChangeSchema.parse({ listId: "a", item: 1, priority: "low", expectedStatus: "open" }).priority).toBe("p3");
  });

  it("answers a bridge from before P0–P3 with the words it knows", () => {
    const item = { number: 1, title: "x", detail: null, status: "open", priority: "p0", due: null, note: null, notedAt: null, changedAt: null, changedBy: null, changedInObsidian: false } as unknown as TodoItemView;
    const answer = (shape: string | undefined) => todoAnswerFor(shape).item({ todoVersion: 1, status: "saved", list: null, item });
    expect(TODO_SHAPE).toBe("5");
    expect((answer("3").item as Record<string, unknown>).priority).toBe("high");
    expect((answer("4").item as Record<string, unknown>).priority).toBe("p0");
    expect(answer("2").item).not.toHaveProperty("priority");
  });

  it("takes tags as Obsidian does: letters, digits, _ - /, not only digits", () => {
    for (const tag of ["本周", "work", "a1", "项目/子项", "x_y-z", "2026年"]) expect(isTodoTag(tag)).toBe(true);
    for (const tag of ["123", "", "a b", "a#b", "💡", "x".repeat(51)]) expect(isTodoTag(tag)).toBe(false);
    expect(todoTagsSchema.parse(["Work", "work", "文档"])).toEqual(["Work", "文档"]);
    // Read without a limit (Obsidian writes as many as it likes); a caller adding them is held to ten.
    const eleven = Array.from({ length: 11 }, (_, index) => `t${index}`);
    expect(todoTagsSchema.parse(eleven)).toHaveLength(11);
    expect(todoTagsInputSchema.safeParse(eleven).success).toBe(false);
    expect(todoTagsInputSchema.safeParse(eleven.slice(1)).success).toBe(true);
    expect(todoItemInputSchema.safeParse({ title: "x", tags: eleven }).success).toBe(false);
    expect(todoItemViewSchema.safeParse({ number: 1, title: "x", detail: null, status: "open", tags: eleven, note: null, notedAt: null, changedAt: null, changedBy: null, changedInObsidian: false }).success).toBe(true);
    expect(splitTitleTags("修 bug  #urgent\t#b")).toEqual({ title: "修 bug", tags: ["urgent", "b"] });
    expect(splitTitleTags("修复 #123")).toEqual({ title: "修复 #123", tags: [] });
    expect(splitTitleTags("#only")).toEqual({ title: "#only", tags: [] });
  });
});

it("keeps dependency views and history out of old bridge responses", () => {
  const item = todoItemViewSchema.parse({ number: 1, title: "发布", status: "open", detail: null, note: null, notedAt: null, changedAt: null, changedBy: null, changedInObsidian: false, id: "pub", dependsOn: ["build"], prerequisites: [], dependents: [], unmetPrerequisites: [], dependencyCycle: [] });
  for (const shape of [undefined, "2", "3", "4"]) {
    const response = todoAnswerFor(shape).item({ todoVersion: 1, status: "saved", list: null, item });
    for (const field of ["id", "dependsOn", "prerequisites", "dependents", "unmetPrerequisites", "dependencyCycle"]) expect(response.item).not.toHaveProperty(field);
  }
  expect(todoAnswerFor("5").item({ todoVersion: 1, status: "saved", list: null, item }).item).toHaveProperty("dependsOn", ["build"]);
});
