import {
  legacyRecorded,
  todoListKey,
  todoListNameKey,
  todoListPending,
  type TodoItemRecord,
  type TodoListNote,
  type TodoListRecord,
} from "@cognelis/decision-core";
import {
  TODO_LIMITS,
  TODO_TAG_SOURCE,
  isCalendarDate,
  isTodoTag,
  sourceClientSchema,
  splitTitleTags,
  todoDependencyIdSchema,
  todoEventSchema,
  uniqueTodoTags,
  type TodoEvent,
  type TodoItemStatus,
  type TodoPriority,
} from "@cognelis/decision-protocol";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { assertVaultPresent, collectMarkdown, inFormOf, normalizedNote, type NoteDiagnostic } from "./markdown.js";
import { escapeNoteText, notePropertiesYaml, ownTitleHeading, unescapeNoteText } from "./markdown-markers.js";
import { NoteCache } from "./note-cache.js";
import { canonical, existingNote, noteChangedMeanwhile, replaceNote, rewrittenNote } from "./note-rewrite.js";
import { TodoHistoryStore, type TodoHistory } from "./todo-history.js";

const DEFAULT_FOLDER = "Decision Journal";
export const TODO_FOLDER = "todos";
const NOTE_TYPE = "decision-todo-list";
const NOTE_VERSION = 1;
const MARKERS = {
  summary: ["<!-- decision:todo-summary-start -->", "<!-- decision:todo-summary-end -->"],
  items: ["<!-- decision:todo-items-start -->", "<!-- decision:todo-items-end -->"],
} as const;
/**
 * What a note held before IMP-185: the history of changes, as a list for the reader and as JSON. It is kept by the App
 * on this machine now (TodoHistoryStore); a note that still has it is read without it, and has it taken out once moved.
 */
const LEGACY_HISTORY_FENCE = "decision-todo-history";
const LEGACY_MARKERS = {
  log: ["<!-- decision:todo-log-start -->", "<!-- decision:todo-log-end -->"],
  history: ["<!-- decision:todo-history-start -->", "<!-- decision:todo-history-end -->"],
} as const;
const MARKER_STARTS = [...Object.values(MARKERS), ...Object.values(LEGACY_MARKERS)].map(([start]) => start);
const OWN_KEYS = ["type", "version", "id", "title", "created", "updated", "revision", "project", "source_kind", "source_client", "long_term", "archived", "tags", "dependency_titles"];

/**
 * Each status as a checkbox, as the Obsidian Tasks plugin writes them: Obsidian shows any mark but a space as ticked,
 * and the plugin (or a theme) tells in progress and cancelled apart.
 */
const BOX: Readonly<Record<TodoItemStatus, string>> = { open: " ", in_progress: "/", done: "x", dropped: "-" };
const STATUS_OF_BOX: ReadonlyMap<string, TodoItemStatus> = new Map([
  [" ", "open"],
  ["/", "in_progress"],
  ["x", "done"],
  ["X", "done"],
  ["-", "dropped"],
]);
/**
 * 优先级 and 截止日期 as the Obsidian Tasks plugin writes them, after the title: 🔺 P0, ⏫ P1, 🔼 P2, 🔽 P3, 📅 and the
 * day. ⏬ (lowest) reads as P3. A note from before P0–P3 read ⏫ as 高, 🔼 as 中 and 🔽 as 低: they stand as P1, P2 and P3
 * without being rewritten. Any other mark of the plugin (🔁 ⏳ 🛫 …) is not read: it stays in the title.
 */
const PRIORITY_MARK: Readonly<Record<TodoPriority, string>> = { p0: "🔺", p1: "⏫", p2: "🔼", p3: "🔽" };
const PRIORITY_OF_MARK: ReadonlyMap<string, TodoPriority> = new Map([
  ["🔺", "p0"],
  ["⏫", "p1"],
  ["🔼", "p2"],
  ["🔽", "p3"],
  ["⏬", "p3"],
]);
const TRAILING_PRIORITY = /[ \t]+(⏫|🔼|🔽|🔺|⏬)\uFE0F?$/u;
const TRAILING_DAY = /[ \t]+📅\uFE0F?[ \t]+(\d{4}-\d{2}-\d{2})$/u;
const DAY_MARK = "📅";
// 标签 as Obsidian reads them, `#name`, after the title (a `#123` is no tag, and one in the middle of a title is the title's).
const TRAILING_TAG = new RegExp(`[ \\t]+#(${TODO_TAG_SOURCE})$`, "u");

/**
 * An item's text without the 优先级, 截止日期 and 标签 marks at its end, and what they said. Only marks that end the line
 * count (the way the plugin writes them, in any order); anything else, a mark in the middle of a title, a date that is
 * not one, a `#123`, two priorities that disagree, stays in the title as written and is never an error.
 */
const splitMarks = (text: string): { title: string; priority: TodoPriority | null; due: string | null; tags: string[]; id?: string; dependsOn?: string[] } => {
  let rest = text;
  let priority: TodoPriority | null = null;
  let due: string | null = null;
  const tags: string[] = [];
  let id: string | undefined;
  let dependsOn: string[] | undefined;
  for (;;) {
    const identity = /[ \t]+🆔\uFE0F?[ \t]+([a-zA-Z0-9_-]{1,200})$/u.exec(rest);
    if (identity !== null) {
      if (id !== undefined && id !== identity[1]) return { title: text.trim(), priority: null, due: null, tags: [] };
      id = identity[1]!;
      rest = rest.slice(0, identity.index);
      continue;
    }
    const dependencies = /[ \t]+⛔\uFE0F?[ \t]+([a-zA-Z0-9_-]{1,200}(?:[ \t]*,[ \t]*[a-zA-Z0-9_-]{1,200})*)$/u.exec(rest);
    if (dependencies !== null) {
      dependsOn = [...new Set([...dependencies[1]!.split(/\s*,\s*/u), ...(dependsOn ?? [])])];
      rest = rest.slice(0, dependencies.index);
      continue;
    }
    const day: RegExpExecArray | null = due === null ? TRAILING_DAY.exec(rest) : null;
    if (day !== null && isCalendarDate(day[1]!)) {
      due = day[1]!;
      rest = rest.slice(0, day.index);
      continue;
    }
    const tag = TRAILING_TAG.exec(rest);
    if (tag !== null && isTodoTag(tag[1]!)) {
      tags.unshift(tag[1]!);
      rest = rest.slice(0, tag.index);
      continue;
    }
    const mark = TRAILING_PRIORITY.exec(rest);
    if (mark === null) break;
    const found = PRIORITY_OF_MARK.get(mark[1]!)!;
    if (priority !== null && priority !== found) {
      // Marks that disagree are not read: the title keeps the whole line, dates included.
      return { title: text.trim(), priority: null, due: null, tags: [] };
    }
    priority = found;
    rest = rest.slice(0, mark.index);
  }
  return { title: rest.trim(), priority, due, tags: uniqueTodoTags(tags), ...(id === undefined ? {} : { id }), ...(dependsOn === undefined ? {} : { dependsOn }) };
};

/** An agent's or the page's title that ends in `#tag` words reads back as those tags: they are lifted out of it. */
const withTagsLifted = (item: TodoItemRecord): TodoItemRecord => {
  const { title, tags } = splitTitleTags(item.title);
  return tags.length > 0 ? { ...item, title, tags: uniqueTodoTags([...item.tags, ...tags]) } : item;
};

// An item's line: its box, its number (one added in Obsidian has none yet), its title. Its detail is indented below.
const ITEM_LINE = /^[-*+] \[(.)\](?: (?:(\d{1,6})\. )?(.*))?$/u;

export interface StoredTodoList {
  list: TodoListRecord;
  path: string;
  /** From the vault's root, with `/` between folders. */
  relativePath: string;
}

export interface TodoListScan {
  /** Each list once, the one whose items are still to be handled first, then by when it last changed. */
  lists: StoredTodoList[];
  /** Notes that could not be read: what they hold is missing from `lists`. */
  diagnostics: NoteDiagnostic[];
}

export type TodoListUpdate<T> =
  | { found: false }
  | { found: true; stored: StoredTodoList; value: T; written: boolean };

interface TodoListRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
  /** The vault folder must already exist: a write never makes it up (see assertVaultPresent). */
  existingVault?: boolean;
  /** Where the history of each list is kept, on this machine and not in the vault. */
  history: TodoHistoryStore;
}

const requiredText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string") throw new Error(`${label}必须是文字`);
  const text = value.trim();
  if (text.length === 0) throw new Error(`${label}不能是空的`);
  if (text.length > maximum) throw new Error(`${label}最多 ${maximum} 个字，现在有 ${text.length} 个`);
  return text;
};

const optionalText = (value: unknown, label: string, maximum: number): string | null =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "")
    ? null
    : requiredText(value, label, maximum);

const requiredDate = (value: unknown, label: string): string => {
  // A date Obsidian's property editor wrote back as a date (no quotes) reads as a Date.
  const text = value instanceof Date ? value.toISOString() : requiredText(value, label, 100);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label}不是有效的时间`);
  return new Date(text).toISOString();
};

/**
 * Whether a list is long-term, as its `long_term` property says: Obsidian's checkbox property writes true or false, and
 * one typed by hand may be the word. Left out, it is not, as a note from before the property was kept.
 */
const flagProperty = (value: unknown, name: string): boolean => {
  if (value === undefined || value === null || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new Error(`属性 ${name} 的值「${String(value)}」无效，只能是 true 或 false`);
};

const singleLine = (value: string, label: string): string => {
  if (/[\r\n]/u.test(value)) throw new Error(`${label}只能写一行`);
  return value;
};

/**
 * Text as the note keeps it: each reading of escaped text takes a backslash off one before a marker it once escaped
 * (see unescapeNoteText), so text is taken as it reads back once that has settled. Written as given, an agent's text
 * holding such a run would not read back as written, and the list would be refused.
 */
const kept = (text: string): string => {
  const once = (value: string): string => unescapeNoteText(escapeNoteText(value));
  let read = text;
  for (let next = once(read); next !== read && next.length < read.length; next = once(read)) read = next;
  return read;
};
const keptOrNull = (text: string | null): string | null => (text === null ? null : kept(text));

/** The list as its note will read back: its text as kept, its own fields in the note's order. */
export const asKeptTodoList = (list: TodoListRecord): TodoListRecord => ({
  ...list,
  title: kept(list.title),
  summary: keptOrNull(list.summary),
  items: list.items.map((item) => withTagsLifted({ ...item, title: kept(item.title), detail: keptOrNull(item.detail), disposition: keptOrNull(item.disposition) })),
});

// A marker counts only where a line begins with it (spaces an editor left around it aside), as the journal's do.
const lineMarker = (marker: string): RegExp =>
  new RegExp(`\\n[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

const markedSection = (body: string, [start, end]: readonly [string, string], label: string): string => {
  const opened = lineMarker(start).exec(body);
  const rest = opened === null ? "" : body.slice(opened.index + opened[0].length);
  const closed = opened === null ? null : lineMarker(end).exec(rest);
  if (closed === null) throw new Error(`这篇待办笔记少了 App 写的「${label}」分节标记，请在 Obsidian 里恢复它`);
  return rest.slice(0, closed.index);
};

const marked = ([start, end]: readonly [string, string], content: string): string =>
  content.length === 0 ? `${start}\n${end}` : `${start}\n${content}\n${end}`;

const splitDocument = (markdown: string): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) throw new Error("待办笔记要以属性（YAML frontmatter）开头");
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) throw new Error("待办笔记的属性没有结束");
  const parsed = parseYaml(markdown.slice(4, boundary), { maxAliasCount: 20 }) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("待办笔记的属性读不出来");
  }
  return { properties: parsed as Record<string, unknown>, body: markdown.slice(boundary + 5) };
};

const stringArray = (value: unknown, label: string, maximum: number): string[] => {
  if (value === null || value === undefined) return [];
  // One value, as Obsidian writes a list property holding one.
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`${label}最多 ${maximum} 个`);
  return [...new Set(values.map((item) => requiredText(item, label, 100)))];
};

const indented = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `  ${line}`))
    .join("\n");

// A detail's line as written (two spaces in), or as an editor left it: a tab, or some other run of spaces.
const dedented = (line: string): string =>
  line.startsWith("  ") ? line.slice(2) : line.startsWith("\t") ? line.slice(1) : line.replace(/^[ \t]+/u, "");

/**
 * An item's 处置备注 as lines under it: `处置：` and the text, its further lines indented the same. It is the item's last
 * paragraph (the App writes it last; a blank line ends it) and nothing indented follows it: a `处置：` paragraph anywhere
 * else is the 补充说明's (an agent's detail may hold one). A line of a detail or of a 处置备注's further lines that begins
 * so is written with one backslash before it (one more where it already had some), and read back without it.
 */
const DISPOSITION_PREFIX = /^处置[：:][ \t]*/u;
const escapedLine = (line: string): string => (/^\\*处置[：:]/u.test(line) ? `\\${line}` : line);
const unescapedLine = (line: string): string => (/^\\+处置[：:]/u.test(line) ? line.slice(1) : line);
const escapedLines = (text: string): string => text.split("\n").map(escapedLine).join("\n");

const itemsMarkdown = (items: readonly TodoItemRecord[]): string =>
  items
    .map((item) => {
      const marks = `${item.id === undefined ? "" : ` 🆔 ${item.id}`}${item.dependsOn?.length ? ` ⛔ ${item.dependsOn.join(",")}` : ""}${item.priority === null ? "" : ` ${PRIORITY_MARK[item.priority]}`}${item.due === null ? "" : ` ${DAY_MARK} ${item.due}`}${item.tags.map((tag) => ` #${tag}`).join("")}`;
      const head = `- [${BOX[item.status]}] ${item.number}. ${escapeNoteText(item.title)}${marks}`;
      const detail = item.detail === null ? [] : [indented(escapedLines(escapeNoteText(item.detail)))];
      const disposition = item.disposition === null ? [] : [indented(`处置：${escapedLines(escapeNoteText(item.disposition))}`)];
      return [head, ...detail, ...disposition].join("\n\n");
    })
    .join("\n\n");

interface ReadItem {
  number: number | null;
  id?: string;
  dependsOn?: string[];
  dependencyTitles?: Record<string, string>;
  status: TodoItemStatus;
  title: string;
  detail: string | null;
  disposition: string | null;
  priority: TodoPriority | null;
  due: string | null;
  tags: string[];
}

/** An item's indented lines split into its 补充说明 and its 处置备注 (see DISPOSITION_PREFIX). */
const splitDisposition = (lines: readonly string[]): { detail: string[]; disposition: string[] } => {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim().length === 0) end -= 1;
  let start = end;
  while (start > 0 && lines[start - 1]!.trim().length > 0) start -= 1;
  const first = start < end ? DISPOSITION_PREFIX.exec(lines[start]!) : null;
  if (first === null) return { detail: lines.map(unescapedLine), disposition: [] };
  return {
    detail: lines.slice(0, start).map(unescapedLine),
    disposition: [lines[start]!.slice(first[0].length), ...lines.slice(start + 1, end).map(unescapedLine)],
  };
};

const readItems = (section: string): ReadItem[] => {
  const items: ReadItem[] = [];
  let current: { head: Omit<ReadItem, "detail" | "disposition">; detail: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    let split = splitDisposition(current.detail);
    // One too long for a 处置备注 (an old note's 补充说明 that happens to end so) is read as the 补充说明 it was.
    if (unescapeNoteText(split.disposition.join("\n")).trim().length > TODO_LIMITS.itemDisposition) split = { detail: current.detail.map(unescapedLine), disposition: [] };
    const detail = unescapeNoteText(split.detail.join("\n")).trim();
    const disposition = unescapeNoteText(split.disposition.join("\n")).trim();
    const label = current.head.number === null ? `「${current.head.title}」` : `第 ${current.head.number} 项`;
    // The empty box Obsidian starts when Enter is pressed after the last item: nothing, and gone at the next save.
    if (current.head.title.length === 0) {
      if (detail.length > 0 || disposition.length > 0) throw new Error(`${current.head.number === null ? "有一项" : label}没有标题，只有补充说明或处置备注；请在 Obsidian 里给它写上标题`);
      return;
    }
    items.push({
      ...current.head,
      detail: optionalText(detail, `${label}的补充说明`, TODO_LIMITS.itemDetail),
      disposition: optionalText(disposition, `${label}的处置备注`, TODO_LIMITS.itemDisposition),
    });
  };
  for (const line of section.split("\n")) {
    const match = ITEM_LINE.exec(line);
    if (match !== null) {
      close();
      const [, box = "", digits, rest = ""] = match;
      const number = digits === undefined ? null : Number(digits);
      const label = number === null ? "一项" : `第 ${number} 项`;
      const status = STATUS_OF_BOX.get(box);
      if (status === undefined) {
        throw new Error(`${label}的复选框里是「${box}」，App 认不出；只能是空格（待处理）、/（处理中）、x（已完成）或 -（已放弃）`);
      }
      if (number === 0) throw new Error("事项的编号要从 1 开始");
      const marked = splitMarks(unescapeNoteText(rest).trim());
      const title = marked.title.length === 0 ? "" : requiredText(marked.title, `${label}的标题`, TODO_LIMITS.itemTitle);
      current = { head: { ...marked, number, status, title }, detail: [] };
    } else if (line.trim().length === 0) {
      current?.detail.push("");
    } else if (/^[ \t]/u.test(line) && current !== null) {
      current.detail.push(dedented(line));
    } else {
      throw new Error(`事项列表里有一行 App 读不懂：「${line.trim().slice(0, 60)}」。每一项以「- [ ] 」开头，补充说明缩进写在它下面`);
    }
  }
  close();
  return items;
};

/** What a note held before IMP-185, as history moved out of it: its events, why they could not be read, or none. */
type LegacyHistory = { events: TodoEvent[] } | { problem: string } | null;

const legacyHistoryOf = (note: string): LegacyHistory => {
  const markdown = normalizedNote(note);
  const opened = lineMarker(LEGACY_MARKERS.history[0]).exec(markdown);
  if (opened === null) return null;
  const problem = { problem: "这篇待办笔记里旧版的处理记录读不出来，没有移到 App 里，笔记保持原样；请在 Obsidian 里检查笔记末尾的 decision-todo-history" };
  const rest = markdown.slice(opened.index + opened[0].length);
  const closed = lineMarker(LEGACY_MARKERS.history[1]).exec(rest);
  const fence = closed === null ? null : new RegExp("```" + LEGACY_HISTORY_FENCE + "\\n([\\s\\S]*?)\\n```", "u").exec(rest.slice(0, closed.index));
  if (fence === null) return problem;
  try {
    const value = JSON.parse(fence[1]!) as unknown;
    if (!Array.isArray(value)) return problem;
    const events: TodoEvent[] = [];
    for (const event of value) {
      const parsed = todoEventSchema.safeParse(event);
      if (!parsed.success) return problem;
      events.push({ ...parsed.data, at: new Date(parsed.data.at).toISOString() });
    }
    // The newest, as many as the App keeps: the oldest went first there too.
    return { events: events.slice(-TODO_LIMITS.history) };
  } catch {
    return problem;
  }
};

/**
 * The note without what it held before IMP-185: the 处理记录 section and the JSON after it. What the reader wrote
 * around them stays, in the line endings and BOM the note had.
 */
export const withoutLegacyHistory = (raw: string): string => {
  const markdown = normalizedNote(raw);
  const block = ([start, end]: readonly [string, string]) =>
    `[ \\t]*${start.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n[\\s\\S]*?\\n[ \\t]*${end.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`;
  const stripped = markdown
    .replace(new RegExp(`\\n*## 处理记录\\n+${block(LEGACY_MARKERS.log)}`, "u"), "")
    .replace(new RegExp(`\\n*${block(LEGACY_MARKERS.log)}`, "u"), "")
    .replace(new RegExp(`\\n*${block(LEGACY_MARKERS.history)}`, "u"), "")
    .replace(/\n*$/u, "\n");
  return stripped === markdown ? raw : inFormOf(raw, stripped);
};

export const serializeTodoList = (list: TodoListNote): string => {
  const frontmatter = notePropertiesYaml(
    {
      type: NOTE_TYPE,
      version: NOTE_VERSION,
      id: list.id,
      // Which heading is the app's title, wherever headings of the reader's stand beside it (namedTitleHeading).
      title: escapeNoteText(list.title),
      created: list.createdAt,
      updated: list.updatedAt,
      revision: list.revision,
      project: list.project,
      source_kind: list.sourceKind,
      source_client: list.sourceClient,
      // Left out for a list that is done with once its items are: such a note reads as it did before the property.
      long_term: list.longTerm ? true : undefined,
      archived: list.archived ? true : undefined,
      tags: list.tags,
      dependency_titles: list.items.some(item => item.dependencyTitles !== undefined)
        ? Object.fromEntries(list.items.filter(item => item.dependencyTitles !== undefined).map(item => [String(item.number), item.dependencyTitles]))
        : undefined,
    },
    { lineWidth: 0 },
  ).trimEnd();
  // No history: the App keeps it on this machine (IMP-185); the note is the list itself.
  return [
    `---\n${frontmatter}\n---`,
    `# ${escapeNoteText(list.title)}`,
    `## 摘要\n\n${marked(MARKERS.summary, list.summary === null ? "" : escapeNoteText(list.summary))}`,
    `## 事项\n\n${marked(MARKERS.items, itemsMarkdown(list.items))}\n`,
  ].join("\n\n");
};

/** A note read, its items' numbers as written: one added in Obsidian without a number is numbered once its history is known. */
interface TodoNoteRead {
  note: Omit<TodoListNote, "items">;
  items: ReadItem[];
}

const readTodoNote = (note: string): TodoNoteRead => {
  // Saved with Windows line endings (git's autocrlf) or a BOM, the same note.
  const markdown = normalizedNote(note);
  const { properties, body } = splitDocument(markdown);
  if (properties.type !== NOTE_TYPE || properties.version !== NOTE_VERSION) {
    throw new Error("这不是 App 能读的待办笔记（type 或 version 不对）");
  }
  const heading = ownTitleHeading(body, MARKER_STARTS, properties.title);
  if (heading === null) throw new Error("这篇待办笔记少了标题");
  const title = singleLine(requiredText(unescapeNoteText(heading.text), "清单标题", TODO_LIMITS.title), "清单标题");
  const summary = optionalText(unescapeNoteText(markedSection(body, MARKERS.summary, "摘要")), "摘要", TODO_LIMITS.summary);
  const items = readItems(markedSection(body, MARKERS.items, "事项"));
  if (properties.dependency_titles !== undefined) {
    const titles = properties.dependency_titles;
    if (titles === null || typeof titles !== "object" || Array.isArray(titles)) throw new Error("dependency_titles 必须是事项编号对应的标题表");
    for (const item of items) {
      const labels = (titles as Record<string, unknown>)[String(item.number)];
      if (labels === undefined) continue;
      if (labels === null || typeof labels !== "object" || Array.isArray(labels)) throw new Error("前置事项标题表无效");
      item.dependencyTitles = Object.fromEntries(Object.entries(labels).map(([id, title]) => [
        todoDependencyIdSchema.parse(id), singleLine(requiredText(title, "前置事项标题", TODO_LIMITS.itemTitle), "前置事项标题"),
      ]));
    }
  }
  const numbers = new Set<number>();
  for (const item of items) {
    if (item.number === null) continue;
    if (numbers.has(item.number)) throw new Error(`第 ${item.number} 项出现了不止一次，请在 Obsidian 里把重复的编号改掉`);
    numbers.add(item.number);
  }
  if (items.length > TODO_LIMITS.itemsPerList) throw new Error(`一份待办清单最多 ${TODO_LIMITS.itemsPerList} 项`);
  const revision = properties.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1) throw new Error("待办笔记的 revision 属性要是正整数");
  const sourceKind = properties.source_kind;
  if (sourceKind !== "agent_capture" && sourceKind !== "app_manual") {
    throw new Error(`属性 source_kind 的值「${String(sourceKind)}」无效，只能是 agent_capture 或 app_manual`);
  }
  const client = optionalText(properties.source_client, "source_client", 40);
  if (client !== null && !sourceClientSchema.safeParse(client).success) throw new Error(`属性 source_client 的值「${client}」无效`);
  return {
    note: {
      id: requiredText(properties.id, "待办清单编号", 200),
      title,
      summary,
      project: optionalText(properties.project, "project", TODO_LIMITS.project),
      tags: stringArray(properties.tags, "tags", TODO_LIMITS.tags),
      sourceKind,
      sourceClient: client,
      longTerm: flagProperty(properties.long_term, "long_term"),
      archived: flagProperty(properties.archived, "archived"),
      createdAt: requiredDate(properties.created, "created"),
      updatedAt: requiredDate(properties.updated, "updated"),
      revision: revision as number,
    },
    items,
  };
};

/**
 * The items numbered: one added in Obsidian without a number takes the next after every number the note and its
 * history have used (`used`), in the order it stands, and is written so at the next save. A number an item had is never
 * given again, or the new one would take the history of an item deleted in Obsidian.
 */
const numberedNote = (read: TodoNoteRead, used: number): TodoListNote => {
  let next = Math.max(used, ...read.items.map((item) => item.number ?? 0)) + 1;
  const items: TodoItemRecord[] = read.items.map((item) => ({
    number: item.number ?? next++,
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.dependsOn === undefined ? {} : { dependsOn: item.dependsOn }),
    ...(item.dependencyTitles === undefined ? {} : { dependencyTitles: item.dependencyTitles }),
    title: item.title,
    detail: item.detail,
    disposition: item.disposition,
    status: item.status,
    priority: item.priority,
    due: item.due,
    tags: item.tags,
  }));
  return { ...read.note, items };
};

/** A todo list's note, as the note alone says it: no history, which the App keeps on this machine. */
export const parseTodoList = (note: string): TodoListNote => numberedNote(readTodoNote(note), 0);

const noteOf = ({ history: _history, recorded: _recorded, recordedFields: _fields, ...note }: TodoListRecord): TodoListNote => note;

/** The note for a list, refused rather than written when it would not read back as that list. */
const faithfulNote = (note: TodoListNote): string => {
  const markdown = serializeTodoList(note);
  if (canonical(parseTodoList(markdown)) !== canonical(note)) {
    throw new Error("这份待办清单写进笔记后读回来会变样，这次没有写入");
  }
  return markdown;
};

/**
 * The list as the note and what is kept of it on this machine say it together. Nothing kept here, a note from before
 * IMP-185 lends the history it held, as that version read it, until it is moved.
 */
const composed = (read: TodoNoteRead, legacy: LegacyHistory, kept: TodoHistory | null): TodoListRecord => {
  const lent = kept === null && legacy !== null && "events" in legacy ? legacy.events : null;
  const history = kept?.events ?? lent ?? [];
  const used = Math.max(0, ...history.map((event) => event.item), ...Object.keys(kept?.recorded ?? {}).map(Number));
  const note = numberedNote(read, used);
  const recorded = kept?.recorded ?? (lent === null ? {} : legacyRecorded(note.items, lent));
  return { ...note, history, recorded, recordedFields: kept?.recordedFields ?? {} };
};

const safeSlug = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "") || "todo";

const duplicateId = (id: string): string =>
  `有不止一篇待办笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`;

/** The vault's own path of a note, for the page and an agent: from its root, with `/`. */
const vaultRelative = (vaultPath: string, path: string): string => relative(vaultPath, path).split(sep).join("/");

/** Lists still to be worked on first (todoListPending), then the one that changed last. */
const ordered = (left: StoredTodoList, right: StoredTodoList): number => {
  const pending = (stored: StoredTodoList): number => (todoListPending(stored.list) ? 0 : 1);
  return pending(left) - pending(right) ||
    right.list.updatedAt.localeCompare(left.list.updatedAt) ||
    left.list.id.localeCompare(right.list.id);
};

export interface TodoLegacyMigration {
  /** Notes whose history was moved out to this machine and taken out of the note. */
  migrated: string[];
  /** Notes left as they were, and why. */
  left: NoteDiagnostic[];
}

/**
 * 待办清单, one Markdown note each under `Decision Journal/todos/<year>/<month>/`. The note is the list: its
 * checkboxes are the items' status, ticked in the App, by an agent or in Obsidian alike; what the reader adds around
 * the App's sections is kept when the App writes it again. The history of changes is the App's, kept on this machine
 * (TodoHistoryStore), not in the note.
 */
export class TodoListRepository {
  readonly #vaultPath: string;
  readonly #folder: string;
  readonly #rename: typeof rename;
  readonly #existingVault: boolean;
  readonly #history: TodoHistoryStore;
  // Every list, lookup and write read all the notes again: an agent per call, the page per refresh.
  readonly #notes = new NoteCache<{ read: TodoNoteRead; legacy: LegacyHistory; hash: string } | { message: string }>(undefined, (read) => "read" in read);

  constructor(vaultPath: string, options: TodoListRepositoryOptions) {
    this.#vaultPath = vaultPath;
    this.#folder = options.folder ?? DEFAULT_FOLDER;
    this.#rename = options.rename ?? rename;
    this.#existingVault = options.existingVault ?? false;
    this.#history = options.history;
  }

  async scan(): Promise<TodoListScan> {
    // A vault that is not there is not one without lists (see MethodologyRepository.list).
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    const diagnostics: NoteDiagnostic[] = [];
    // A month's folder it cannot list, or a note iCloud moved off this Mac, is said and passed over.
    const paths = await collectMarkdown(join(this.#vaultPath, this.#folder, TODO_FOLDER), diagnostics);
    const found: StoredTodoList[] = [];
    const notes: Array<{ path: string; value: { read: TodoNoteRead; legacy: LegacyHistory; hash: string } }> = [];
    const counts = new Map<string, number>();
    for (const path of paths) {
      const value = await this.#readNote(path);
      if (!("read" in value)) { diagnostics.push({ path, message: value.message }); continue; }
      notes.push({ path, value });
      counts.set(value.read.note.id, (counts.get(value.read.note.id) ?? 0) + 1);
    }
    for (const { path, value } of notes) {
      try {
        if (counts.get(value.read.note.id)! > 1) {
          // A duplicate must never choose which side of an unfinished write is authoritative.
          const kept = await this.#history.read(value.read.note.id).catch(() => null);
          found.push({ list: composed(value.read, value.legacy, kept), path, relativePath: vaultRelative(this.#vaultPath, path) });
        } else found.push(await this.#stored(path));
      } catch (error) {
        diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
        found.push({ list: composed(value.read, value.legacy, null), path, relativePath: vaultRelative(this.#vaultPath, path) });
      }
    }
    this.#notes.sweep();
    // A sync conflict's copy holds the same id: listed once and said, where it showed twice under one key.
    const listed = new Set<string>();
    const lists = found.filter((stored) => {
      if (!listed.has(stored.list.id)) return listed.add(stored.list.id);
      diagnostics.push({ path: stored.path, message: duplicateId(stored.list.id) });
      return false;
    });
    return { lists: lists.sort(ordered), diagnostics };
  }

  /** The note relative to the vault, for what is said about a note that could not be read. */
  relativePath(path: string): string {
    return vaultRelative(this.#vaultPath, path);
  }

  /**
   * The list written as given, or the same list already there, which is left as it is: for one with items, the list
   * with that project, title and items; for an empty one, the list with that project and title, whatever it holds now.
   */
  async create(input: TodoListRecord): Promise<{ stored: StoredTodoList; created: boolean }> {
    const list = asKeptTodoList(input);
    const { lists } = await this.scan();
    const key = list.items.length === 0 ? todoListNameKey(list) : todoListKey(list);
    const same = lists.find((stored) => (list.items.length === 0 ? todoListNameKey(stored.list) : todoListKey(stored.list)) === key);
    if (same !== undefined) return { stored: same, created: false };
    if (lists.some((stored) => stored.list.id === list.id)) throw new Error(duplicateId(list.id));
    const note = faithfulNote(noteOf(list));
    const path = this.#pathFor(list);
    await this.#writeWithHistory(path, null, note, list);
    return { stored: await this.#stored(path), created: true };
  }

  /**
   * One list read from its note and written back changed: `change` is given the list as the note holds it now, and
   * answers with the list to write (null: nothing to write) and what to tell the caller. Saved in Obsidian between
   * the read and the write, the note is read again and the change made again on what it then holds. The note is
   * preceded by a local recovery record; note and history can then be reconciled after an interrupted write.
   */
  async update<T>(id: string, change: (current: TodoListRecord) => { list: TodoListRecord | null; value: T }): Promise<TodoListUpdate<T>> {
    for (let attempt = 0; ; attempt += 1) {
      const path = await this.#locate(id);
      if (path === null) return { found: false };
      const raw = await existingNote(path);
      if (raw === null) return { found: false };
      const read = readTodoNote(raw);
      if (read.note.id !== id) return { found: false };
      // Unreadable, the history refuses the write here, before the note is changed without it.
      const current = composed(read, legacyHistoryOf(raw), await this.#history.read(id, () => this.#currentHash(id)));
      const { list, value } = change(current);
      const relativePath = vaultRelative(this.#vaultPath, path);
      if (list === null) return { found: true, stored: { list: current, path, relativePath }, value, written: false };
      const next = asKeptTodoList(list);
      if (next.id !== id || next.revision !== current.revision + 1) throw new Error("待办清单每次写入的 revision 要加一");
      // A note from before IMP-185 has its history taken out as the list is written here.
      const content = rewrittenNote(withoutLegacyHistory(raw), faithfulNote(noteOf(next)), {
        ownKeys: OWN_KEYS,
        markers: Object.values(MARKERS),
        parse: parseTodoList,
      });
      try {
        await this.#writeWithHistory(path, raw, content, next);
      } catch (error) {
        if (noteChangedMeanwhile(error) && attempt < 2) continue;
        throw error;
      }
      return { found: true, stored: await this.#stored(path), value, written: true };
    }
  }

  /**
   * A list's note handed to `trash` (the system's wastebasket): never unlinked here. A trash that fails throws, and the
   * note stays where it is. Its history file stays on this machine. False when no note holds the id.
   */
  async trash(id: string, trash: (path: string) => Promise<void>): Promise<boolean> {
    const path = await this.#locate(id);
    if (path === null) return false;
    await trash(path);
    return true;
  }

  /**
   * Notes from before IMP-185 that still hold their history: it is moved to this machine (unless something is kept
   * here already) and taken out of the note, which otherwise stays as it was, revision and all. One whose history
   * cannot be read, or that changes in any other way once it is taken out, is left as it is and said.
   */
  async migrateLegacy(): Promise<TodoLegacyMigration> {
    const migrated: string[] = [];
    const left: NoteDiagnostic[] = [];
    const { lists } = await this.scan();
    for (const stored of lists) {
      const raw = await existingNote(stored.path).catch(() => null);
      const legacy = raw === null ? null : legacyHistoryOf(raw);
      if (raw === null || legacy === null) continue;
      if ("problem" in legacy) {
        left.push({ path: stored.path, message: legacy.problem });
        continue;
      }
      try {
        const kept = await this.#history.read(stored.list.id, () => this.#currentHash(stored.list.id));
        if (kept === null) {
          const note = parseTodoList(raw);
          await this.#history.write(stored.list.id, { recorded: legacyRecorded(note.items, legacy.events), recordedFields: {}, events: legacy.events });
        }
        const stripped = withoutLegacyHistory(raw);
        if (canonical(parseTodoList(stripped)) !== canonical(parseTodoList(raw))) {
          left.push({ path: stored.path, message: "去掉旧版处理记录后笔记读起来会变样，这篇保持原样" });
          continue;
        }
        if (stripped !== raw) await this.#write(stored.path, raw, stripped);
        migrated.push(stored.relativePath);
      } catch (error) {
        left.push({ path: stored.path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { migrated, left };
  }

  async #readNote(path: string) {
    return this.#notes.read(path, async () => {
      try {
        const raw = await readFile(path, "utf8");
        return { read: readTodoNote(raw), legacy: legacyHistoryOf(raw), hash: createHash("sha256").update(raw).digest("hex") };
      } catch (error) { return { message: error instanceof Error ? error.message : String(error) }; }
    });
  }

  async #stored(path: string): Promise<StoredTodoList> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.#readNote(path);
      if (!("read" in before)) throw new Error(before.message);
      const kept = await this.#history.read(before.read.note.id, () => this.#currentHash(before.read.note.id));
      const after = await this.#readNote(path);
      if ("read" in after && after.hash === before.hash) return { list: composed(before.read, before.legacy, kept), path, relativePath: vaultRelative(this.#vaultPath, path) };
    }
    throw new Error("待办笔记仍在变化，未把不同版本的笔记与变更记录拼在一起，请稍后重试");
  }

  /** Where the list's note is now (moved or renamed in Obsidian, it is found by its id); null when none holds it. */
  async #locate(id: string): Promise<string | null> {
    const { lists, diagnostics } = await this.scan();
    const holders = lists.filter((stored) => stored.list.id === id);
    if (diagnostics.some((diagnostic) => diagnostic.message === duplicateId(id))) throw new Error(duplicateId(id));
    return holders[0]?.path ?? null;
  }

  #pathFor(list: TodoListRecord): string {
    const [year, month] = list.createdAt.slice(0, 10).split("-");
    if (year === undefined || month === undefined) throw new Error("待办清单的创建时间无效");
    const digest = createHash("sha256").update(list.id, "utf8").digest("hex").slice(0, 12);
    return join(this.#vaultPath, this.#folder, TODO_FOLDER, year, month, `${safeSlug(list.title)}-${digest}.md`);
  }

  async #currentHash(id: string): Promise<string | null> {
    // Only unfinished writes need this scan: moved notes, unreadable notes and duplicate IDs are distinct.
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    const diagnostics: NoteDiagnostic[] = [];
    const paths = await collectMarkdown(join(this.#vaultPath, this.#folder, TODO_FOLDER), diagnostics);
    const matches: string[] = [];
    for (const path of paths) {
      const raw = await existingNote(path);
      if (raw === null) throw new Error("有待办笔记正在移动，未结算恢复记录");
      if (readTodoNote(raw).note.id === id) matches.push(createHash("sha256").update(raw).digest("hex"));
    }
    if (diagnostics.length) throw new Error("部分待办笔记无法读取，未结算恢复记录");
    if (matches.length > 1) throw new Error(duplicateId(id));
    return matches[0] ?? null;
  }

  async #writeWithHistory(path: string, raw: string | null, content: string, list: TodoListRecord): Promise<void> {
    await this.#history.writeWithNote(list.id, { recorded: { ...list.recorded }, recordedFields: { ...list.recordedFields }, events: list.history }, {
      before: raw === null ? null : createHash("sha256").update(raw).digest("hex"), after: createHash("sha256").update(content).digest("hex"),
    }, () => this.#write(path, raw, content), () => this.#currentHash(list.id));
  }

  /** `raw`: the note as read before `content` was made from it (null for a new one); changed since, the write is refused. */
  async #write(path: string, raw: string | null, content: string): Promise<void> {
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    await replaceNote(path, raw, content, this.#rename);
  }
}
