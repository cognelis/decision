import { isTodoTag, type TodoPriority } from "@cognelis/decision-protocol";

import { addDays, isRealDay, makeDay, weekdayOf, WEEKDAY_NAMES } from "./todo-dates.js";

/**
 * 快速添加: one line of words turned into an item. Words it knows are lifted out of the line, whole words only (so
 * 「周一例会」 stays a title): a day (今天 明天 后天, 周一…周日, 下周一…下周日, M-D, YYYY-MM-DD), a priority (!p0 … !p3)
 * a list (@清单名) and tags (#标签, as many as are written; `#清单名` still names a list when it is exactly a list\u2019s name and no tag of that name is in use). The first of each other kind counts; a later one stays in the title. Pure: "today" is given, as a
 * `YYYY-MM-DD` day.
 *
 * 周X is the nearest X from today on, today included: 周一 typed on a Monday means that same day (写下「周一」的人
 * 多半是在说这个周一，下周的写「下周一」). 下周X is X of next week, a week running Monday to Sunday, so on a Sunday
 * 下周一 is tomorrow. M-D is this year's, or next year's once this year's has gone by; a day written in full is taken as
 * written, past or not.
 */
export type QuickAddKind = "due" | "priority" | "list" | "tag";

export interface QuickAddToken {
  kind: QuickAddKind;
  /** The word as typed. */
  text: string;
  /** What taking it off is called: its kind, or `tag:#name` (a line holds several tags). */
  key: string;
}

export interface QuickAddParse {
  /** What is left once the known words are out. */
  title: string;
  due: string | null;
  priority: TodoPriority | null;
  /** The name after `@`, as typed; matched to a list by `matchList`. */
  listName: string | null;
  /** The list was named the old way, `#name`: said in its chip. */
  legacyList: boolean;
  /** The `#tags`, without the `#`, each once. */
  tags: string[];
  tokens: QuickAddToken[];
}

// !p0 … !p3 in either case; !高 !中 !低 from before P0–P3 still mean P1, P2, P3.
const PRIORITY_OF_WORD: Readonly<Record<string, TodoPriority>> = { 高: "p1", 中: "p2", 低: "p3", p0: "p0", p1: "p1", p2: "p2", p3: "p3" };
const priorityOfWord = (word: string): TodoPriority | null => {
  const match = /^[!！](.+)$/u.exec(word);
  return match === null ? null : (PRIORITY_OF_WORD[match[1]!.toLowerCase()] ?? null);
};

const weekdayIndex = (name: string): number => WEEKDAY_NAMES.indexOf(`周${name}` as (typeof WEEKDAY_NAMES)[number]);

/** The day a word names, or null when it names none. */
export const dayOfWord = (word: string, today: string): string | null => {
  if (word === "今天") return today;
  if (word === "明天") return addDays(today, 1);
  if (word === "后天") return addDays(today, 2);
  const week = /^(下?)周([一二三四五六日])$/u.exec(word);
  if (week !== null) {
    const target = weekdayIndex(week[2]!);
    const here = weekdayOf(today);
    if (week[1] === "下") return addDays(today, 7 - here + target);
    return addDays(today, (target - here + 7) % 7);
  }
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(word);
  if (full !== null) {
    const [year, month, date] = [Number(full[1]), Number(full[2]), Number(full[3])];
    return isRealDay(year, month, date) ? makeDay(year, month, date) : null;
  }
  const short = /^(\d{1,2})[-/](\d{1,2})$/u.exec(word);
  if (short !== null) {
    const [month, date] = [Number(short[1]), Number(short[2])];
    const thisYear = Number(today.slice(0, 4));
    // The first year from this one in which the day exists and is not behind us (29 February waits for a leap year).
    for (let year = thisYear; year <= thisYear + 8; year += 1) {
      if (!isRealDay(year, month, date)) continue;
      const day = makeDay(year, month, date);
      if (day >= today) return day;
    }
  }
  return null;
};

/**
 * What the line may be read against: the lists (a `#name` that is exactly one of their names, with no tag of that name
 * in use, still means the list, as before `@`) and the tags in use.
 */
export interface QuickAddContext {
  listTitles?: readonly string[];
  knownTags?: readonly string[];
}

/** `dismissed`: tokens the reader took off; their words stay in the title. A kind (due, priority, list) or `tag:#name`. */
export const parseQuickAdd = (
  input: string,
  today: string,
  dismissed: ReadonlySet<string> = new Set(),
  context: QuickAddContext = {},
): QuickAddParse => {
  const words = input.trim().split(/\s+/u).filter((word) => word.length > 0);
  const kept: string[] = [];
  const tokens: QuickAddToken[] = [];
  const tags: string[] = [];
  let due: string | null = null;
  let priority: TodoPriority | null = null;
  let listName: string | null = null;
  let legacyList = false;
  const titles = new Set((context.listTitles ?? []).map(nameKey));
  const known = new Set((context.knownTags ?? []).map((tag) => tag.toLocaleLowerCase("zh-CN")));
  for (const word of words) {
    const day: string | null = due === null && !dismissed.has("due") ? dayOfWord(word, today) : null;
    const level: TodoPriority | null = priority === null && !dismissed.has("priority") ? priorityOfWord(word) : null;
    const at = /^[@＠](.+)$/u.exec(word);
    const hash = /^[#＃](.+)$/u.exec(word);
    const tag = hash !== null && isTodoTag(hash[1]!) ? hash[1]! : null;
    // The old way to name a list: `#name` that is a list's name and no tag in use.
    const oldList = tag !== null && titles.has(nameKey(tag)) && !known.has(tag.toLocaleLowerCase("zh-CN"));
    const name: string | null =
      listName === null && !dismissed.has("list") ? (at !== null ? at[1]! : oldList ? tag : null) : null;
    if (day !== null) {
      due = day;
      tokens.push({ kind: "due", text: word, key: "due" });
    } else if (level !== null) {
      priority = level;
      tokens.push({ kind: "priority", text: word, key: "priority" });
    } else if (name !== null) {
      listName = name;
      legacyList = at === null;
      tokens.push({ kind: "list", text: word, key: "list" });
    } else if (tag !== null && !oldList && !dismissed.has(`tag:#${tag}`)) {
      if (!tags.some((existing) => existing.toLocaleLowerCase("zh-CN") === tag.toLocaleLowerCase("zh-CN"))) {
        tags.push(tag);
        tokens.push({ kind: "tag", text: word, key: `tag:#${tag}` });
      } else {
        kept.push(word);
      }
    } else {
      kept.push(word);
    }
  }
  return { title: kept.join(" "), due, priority, listName, legacyList, tags, tokens };
};

/** A list name as compared: one width and case, spaces out. */
const nameKey = (name: string): string => name.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");

/** The list a `#name` means, among the lists to choose from: the same name, case and width aside; null when none. */
export const matchList = <T extends { title: string }>(name: string, lists: readonly T[]): T | null => {
  const key = nameKey(name);
  return lists.find((list) => nameKey(list.title) === key) ?? null;
};
