import { describe, expect, it } from "vitest";

import { dayOfWord, matchList, parseQuickAdd } from "../src/renderer/components/pages/todos/quick-add.js";
import { dueLabel, localDay } from "../src/renderer/components/pages/todos/todo-dates.js";

// 2026-11-09 is a Monday.
const MONDAY = "2026-11-09";

describe("quick add: days", () => {
  it("reads 今天, 明天 and 后天, across a month and a year", () => {
    expect(dayOfWord("今天", MONDAY)).toBe(MONDAY);
    expect(dayOfWord("明天", "2026-11-30")).toBe("2026-12-01");
    expect(dayOfWord("后天", "2026-12-31")).toBe("2027-01-02");
    expect(dayOfWord("明天", "2028-02-28")).toBe("2028-02-29");
  });

  it("takes 周X as the nearest one from today on, today included, and 下周X as that day of next week", () => {
    // On a Monday, 周一 is today; the rest of the week is ahead; 下周一 is a week later.
    expect(dayOfWord("周一", MONDAY)).toBe("2026-11-09");
    expect(dayOfWord("周三", MONDAY)).toBe("2026-11-11");
    expect(dayOfWord("周日", MONDAY)).toBe("2026-11-15");
    expect(dayOfWord("下周一", MONDAY)).toBe("2026-11-16");
    expect(dayOfWord("下周日", MONDAY)).toBe("2026-11-22");
    // On a Wednesday a 周一 already gone by is next week's.
    expect(dayOfWord("周一", "2026-11-11")).toBe("2026-11-16");
    // The week runs Monday to Sunday: on a Sunday, 周日 is today and 下周一 tomorrow.
    expect(dayOfWord("周日", "2026-11-15")).toBe("2026-11-15");
    expect(dayOfWord("下周一", "2026-11-15")).toBe("2026-11-16");
    // Across the year's end.
    expect(dayOfWord("下周三", "2026-12-30")).toBe("2027-01-06");
    expect(dayOfWord("周五", "2026-12-31")).toBe("2027-01-01");
  });

  it("reads M-D as this year's, or next year's once it has gone by, and YYYY-MM-DD as written", () => {
    expect(dayOfWord("11-9", MONDAY)).toBe("2026-11-09");
    expect(dayOfWord("11-20", MONDAY)).toBe("2026-11-20");
    expect(dayOfWord("11-08", MONDAY)).toBe("2027-11-08");
    expect(dayOfWord("1-3", "2026-12-30")).toBe("2027-01-03");
    expect(dayOfWord("2/29", "2026-03-01")).toBe("2028-02-29");
    expect(dayOfWord("2026-11-01", MONDAY)).toBe("2026-11-01");
    expect(dayOfWord("2027-2-3", MONDAY)).toBe("2027-02-03");
  });

  it("does not read what is not a day", () => {
    for (const word of ["2-30", "13-1", "2026-02-30", "周八", "下下周一", "明日", "11", "周一例会", "1.5"]) {
      expect(dayOfWord(word, MONDAY)).toBeNull();
    }
  });

  it("says a due date as 今天, 明天, a weekday within the week, or a date", () => {
    expect(dueLabel("2026-11-09", MONDAY)).toBe("今天");
    expect(dueLabel("2026-11-10", MONDAY)).toBe("明天");
    expect(dueLabel("2026-11-11", MONDAY)).toBe("后天");
    expect(dueLabel("2026-11-08", MONDAY)).toBe("昨天");
    expect(dueLabel("2026-11-13", MONDAY)).toBe("周五");
    expect(dueLabel("2026-11-20", MONDAY)).toBe("11月20日");
    expect(dueLabel("2027-01-03", MONDAY)).toBe("2027年1月3日");
    expect(localDay(new Date(2026, 10, 9, 23, 59))).toBe("2026-11-09");
  });
});

describe("quick add: the line", () => {
  it("lifts a day, a priority, a list and tags out of the words and leaves the title", () => {
    expect(parseQuickAdd("下周三 !p1 写周报 @工作 #本周 #文档", MONDAY)).toEqual({
      title: "写周报",
      due: "2026-11-18",
      priority: "p1",
      listName: "工作",
      legacyList: false,
      tags: ["本周", "文档"],
      tokens: [
        { kind: "due", text: "下周三", key: "due" },
        { kind: "priority", text: "!p1", key: "priority" },
        { kind: "list", text: "@工作", key: "list" },
        { kind: "tag", text: "#本周", key: "tag:#本周" },
        { kind: "tag", text: "#文档", key: "tag:#文档" },
      ],
    });
    expect(parseQuickAdd("  交水费   明天 ", MONDAY)).toMatchObject({ title: "交水费", due: "2026-11-10", priority: null, listName: null, tags: [] });
    expect(parseQuickAdd("！低 整理桌面", MONDAY)).toMatchObject({ title: "整理桌面", priority: "p3" });
  });

  it("reads #name as the list it names when it is exactly a list's name and no tag has it (the old way), otherwise as a tag", () => {
    const lists = { listTitles: ["日常", "Work Notes"] };
    expect(parseQuickAdd("买菜 #日常", MONDAY, new Set(), lists)).toMatchObject({ title: "买菜", listName: "日常", legacyList: true, tags: [] });
    expect(parseQuickAdd("买菜 #日常", MONDAY, new Set(), { ...lists, knownTags: ["日常"] })).toMatchObject({ title: "买菜", listName: null, tags: ["日常"] });
    expect(parseQuickAdd("买菜 #家务", MONDAY, new Set(), lists)).toMatchObject({ listName: null, tags: ["家务"] });
    // @ always names a list, found or not; a second list word stays in the title.
    expect(parseQuickAdd("买菜 @家务 #日常", MONDAY, new Set(), lists)).toMatchObject({ listName: "家务", legacyList: false, title: "买菜 #日常" });
  });

  it("does not take #123, a lone #, or a word with # inside as a tag; the same tag twice is one", () => {
    expect(parseQuickAdd("修复 #123 #", MONDAY)).toMatchObject({ title: "修复 #123 #", tags: [] });
    expect(parseQuickAdd("C# 与 a#b", MONDAY)).toMatchObject({ title: "C# 与 a#b", tags: [] });
    expect(parseQuickAdd("x #Work #work #a/b", MONDAY)).toMatchObject({ title: "x #work", tags: ["Work", "a/b"] });
  });

  it("reads !p0 to !p3 in either case, and !高 !中 !低 from before as P1 to P3", () => {
    for (const [word, priority] of [["!p0", "p0"], ["!P1", "p1"], ["！p2", "p2"], ["!P3", "p3"], ["!高", "p1"], ["!中", "p2"], ["!低", "p3"]] as const) {
      expect(parseQuickAdd(`${word} 写周报`, MONDAY)).toMatchObject({ title: "写周报", priority, tokens: [{ kind: "priority", text: word }] });
    }
    expect(parseQuickAdd("!p4 写周报", MONDAY)).toMatchObject({ title: "!p4 写周报", priority: null });
    expect(parseQuickAdd("p0 写周报", MONDAY)).toMatchObject({ title: "p0 写周报", priority: null });
  });

  it("takes whole words only, and the first of each kind", () => {
    expect(parseQuickAdd("周一例会 准备材料", MONDAY)).toMatchObject({ title: "周一例会 准备材料", due: null });
    expect(parseQuickAdd("明天 提醒 周五 开会", MONDAY)).toMatchObject({ title: "提醒 周五 开会", due: "2026-11-10" });
    expect(parseQuickAdd("买菜 @日常 @学习", MONDAY)).toMatchObject({ title: "买菜 @学习", listName: "日常" });
    expect(parseQuickAdd("!高 !低 x", MONDAY)).toMatchObject({ title: "!低 x", priority: "p1" });
    expect(parseQuickAdd("@", MONDAY)).toMatchObject({ title: "@", listName: null });
  });

  it("gives a word back to the title once its tag is taken off", () => {
    const parsed = parseQuickAdd("明天 开会 #a", MONDAY, new Set(["due", "tag:#a"]));
    expect(parsed).toMatchObject({ title: "明天 开会 #a", due: null, tags: [], tokens: [] });
  });

  it("matches a list by name, case and width aside, and says none when there is none", () => {
    const lists = [{ title: "日常" }, { title: "Work Notes" }, { title: "学习１" }];
    expect(matchList("日常", lists)).toBe(lists[0]);
    expect(matchList("work notes", lists)).toBe(lists[1]);
    expect(matchList("ＷＯＲＫnotes", lists)).toBe(lists[1]);
    expect(matchList("学习1", lists)).toBe(lists[2]);
    expect(matchList("工作", lists)).toBeNull();
  });
});
