import { z } from "zod";

import { sourceClientSchema } from "./capture.js";

/**
 * 待办清单：一次调研或一次整理得到的一组要逐项处理的事项。清单写在仓库的 Markdown 里，事项是其中的复选框；
 * 这里是 App、bridge 与页面之间传递它的形状。
 */
export const TODO_VERSION = 1 as const;

/** What each part may hold: the bridge tells an agent these, and the App and the note keep to them. */
export const TODO_LIMITS = {
  title: 200,
  summary: 8_000,
  project: 500,
  itemTitle: 300,
  itemDetail: 4_000,
  /** An item's 处置备注: the reader's opinion for an agent. */
  itemDisposition: 2_000,
  note: 2_000,
  /** Items one call may add. */
  itemsPerCall: 50,
  /** Items one list may hold, added over every call. */
  itemsPerList: 200,
  tags: 12,
  /** Tags one item may carry. */
  itemTags: 10,
  /** Changes a list keeps; the oldest go first. */
  history: 1_000,
  /** Lists one page of a query returns. */
  page: 200,
} as const;

const text = (maximum: number) => z.string().trim().min(1).max(maximum);
// Each a line of its own in the note: the list's title is its heading, an item's its checkbox line.
const line = (maximum: number) => text(maximum).regex(/^[^\r\n]*$/u, "must be a single line");

export const todoItemStatusSchema = z.enum(["open", "in_progress", "done", "dropped"]);

/** Obsidian Tasks ids are vault-wide, preserved when an item moves between lists. */
export const todoDependencyIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/u);
export const todoDependencyIdsSchema = z.array(todoDependencyIdSchema);
export const todoDependencyTargetSchema = z.object({ listId: text(200), item: z.number().int().positive() }).strict();
export const todoDependencyChangesShape = {
  addDependencies: z.array(todoDependencyTargetSchema).min(1).max(50).optional(),
  removeDependencies: todoDependencyIdsSchema.min(1).max(200).optional(),
};
export const todoDependencyViewSchema = z.object({
  id: todoDependencyIdSchema.nullable(),
  listId: text(200).nullable(),
  listTitle: line(TODO_LIMITS.title).nullable(),
  item: z.number().int().positive().nullable(),
  title: line(TODO_LIMITS.itemTitle),
  status: todoItemStatusSchema.nullable(),
  issue: z.enum(["missing", "ambiguous"]).nullable(),
});
export type TodoDependencyView = z.infer<typeof todoDependencyViewSchema>;
export type TodoDependencyTarget = z.infer<typeof todoDependencyTargetSchema>;

/** 优先级 p0 (most urgent) to p3; null is 无. */
export const TODO_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;

/**
 * The words before P0–P3 (high, medium, low) are still read, as p1, p2 and p3: a bridge or a history file from before
 * says them, and they come out as the new ones.
 */
const LEGACY_PRIORITY = { high: "p1", medium: "p2", low: "p3" } as const;
export const todoPrioritySchema = z.union([
  z.enum(TODO_PRIORITIES),
  z.enum(["high", "medium", "low"]).transform((value) => LEGACY_PRIORITY[value]),
]);

/**
 * An item's 标签 as Obsidian reads one after a `#`: letters (中文 included), digits, `_`, `-` and `/`, at least one of
 * them not a digit (so 「#123」, an issue's number, is no tag). Kept here without the `#`.
 */
const TAG_CHARACTERS = "\\p{L}\\p{M}\\p{N}_/-";
export const TODO_TAG_SOURCE = `[${TAG_CHARACTERS}]*[\\p{L}\\p{M}_/-][${TAG_CHARACTERS}]*`;
const TAG_PATTERN = new RegExp(`^${TODO_TAG_SOURCE}$`, "u");
export const isTodoTag = (value: string): boolean => value.length <= 50 && TAG_PATTERN.test(value);

/** Each tag once (Obsidian's tags are case-blind: the first spelling stays), in the order given. */
export const uniqueTodoTags = (tags: readonly string[]): string[] => {
  const seen = new Set<string>();
  return tags.filter((tag) => {
    const key = tag.toLocaleLowerCase("zh-CN");
    return seen.has(key) ? false : (seen.add(key), true);
  });
};

export const todoTagSchema = z.string().trim().refine(isTodoTag, "must be a tag: letters, digits, _ - / and not only digits");
/**
 * An item's tags as they are read (the note, the history, an answer) and as the page changes them: no limit on how many.
 * Obsidian can hold any number on one line, and a limit here made such a note unreadable, then its history with it.
 */
export const todoTagsSchema = z.array(todoTagSchema).transform(uniqueTodoTags);

/** Tags a caller adds to an item (an agent, a new item): at most TODO_LIMITS.itemTags. The only place the number is kept to. */
export const todoTagsInputSchema = z.array(todoTagSchema).max(TODO_LIMITS.itemTags).transform(uniqueTodoTags);

const TRAILING_TAG_WORD = new RegExp(`\\s+#(${TODO_TAG_SOURCE})$`, "u");

/**
 * A title without the `#tags` that end it, and those tags (first spelling of each, in the order written): the way the note
 * reads them. Used wherever a written title is compared or kept, so 「修 bug #urgent」 is the same finding however it was sent.
 * A title that is nothing but tags is left whole.
 */
export const splitTitleTags = (title: string): { title: string; tags: string[] } => {
  let rest = title.trim();
  const tags: string[] = [];
  for (let match = TRAILING_TAG_WORD.exec(rest); match !== null && isTodoTag(match[1]!); match = TRAILING_TAG_WORD.exec(rest)) {
    tags.unshift(match[1]!);
    rest = rest.slice(0, match.index).trimEnd();
  }
  return rest.length === 0 ? { title: title.trim(), tags: [] } : { title: rest, tags: uniqueTodoTags(tags) };
};

/** Whether `YYYY-MM-DD` names a day that exists (no 2026-02-30). */
export const isCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** 截止日期: a day, no time. */
export const todoDueSchema = z.string().refine(isCalendarDate, "must be a date as YYYY-MM-DD");

const fieldChange = <T extends z.ZodType>(value: T) => z.object({ from: value, to: value }).strict();

/** Who made a change: the reader in the App, an agent (its client's id), or the note's checkbox changed in Obsidian. */
export const todoActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z.object({ kind: z.literal("agent"), client: sourceClientSchema }).strict(),
  z.object({ kind: z.literal("obsidian") }).strict(),
]);

const todoEventShape = {
  item: z.number().int().positive(),
  at: z.iso.datetime(),
  previous: todoItemStatusSchema,
  status: todoItemStatusSchema,
  note: text(TODO_LIMITS.note).nullable(),
  by: todoActorSchema,
  /** Set when the change moved the item's 优先级 or 截止日期. */
  priority: fieldChange(todoPrioritySchema.nullable()).optional(),
  due: fieldChange(todoDueSchema.nullable()).optional(),
  /** Set when the change added or took off tags: the item's tags before and after. */
  tags: fieldChange(todoTagsSchema).optional(),
  dependencies: fieldChange(todoDependencyIdsSchema).optional(),
  /** Set when the change rewrote the item's 补充说明 (the page does; the text itself is not kept in the history). */
  detail: z.literal(true).optional(),
  /** Set when the change rewrote the item's 处置备注 (the text itself is not kept in the history). */
  disposition: z.literal(true).optional(),
  /** The item was deleted on the page: its line is gone from the note, its number is not given again. */
  deleted: z.literal(true).optional(),
  /**
   * The item was moved between lists: out (this list's line is gone, as for a deleted one) or in (this list's line is the
   * new one). `list` and `item` are the other side: where it went, or where it came from, and its number there.
   */
  moved: z.object({ direction: z.enum(["out", "in"]), listId: text(200), listTitle: line(TODO_LIMITS.title), item: z.number().int().positive() }).strict().optional(),
};

/**
 * One change to one item: its status before and after (the same for a note alone), and what was said about it. Strict:
 * a note's history holding a field this version does not know is not read, rather than written back without it.
 */
export const todoEventSchema = z.object(todoEventShape).strict();

/*
 * What the App answers with, read leniently: a field a newer App adds is left out, not refused. Strict, a bridge still
 * running in an agent's session took a newer App's every answer for none (IMP-184). Requests stay strict.
 */
const todoEventViewSchema = z.object(todoEventShape);

export const todoItemInputSchema = z
  .object({
    title: line(TODO_LIMITS.itemTitle),
    detail: text(TODO_LIMITS.itemDetail).optional(),
    priority: todoPrioritySchema.optional(),
    due: todoDueSchema.optional(),
    tags: todoTagsInputSchema.optional(),
  })
  .strict();

export const todoItemViewSchema = z
  .object({
    number: z.number().int().positive(),
    title: line(TODO_LIMITS.itemTitle),
    detail: text(TODO_LIMITS.itemDetail).nullable(),
    /** The reader's 处置备注 for an agent: read-only to agents; absent in an answer from before it was kept. */
    disposition: text(TODO_LIMITS.itemDisposition).nullable().default(null),
    status: todoItemStatusSchema,
    /** 优先级 and 截止日期, kept in the note as the Obsidian Tasks plugin writes them; the item's place in the note is its order. */
    priority: todoPrioritySchema.nullable().default(null),
    due: todoDueSchema.nullable().default(null),
    /** 标签, as the note keeps them after the title; absent in an answer from before they were kept. */
    tags: todoTagsSchema.default([]),
    id: todoDependencyIdSchema.optional(),
    dependsOn: todoDependencyIdsSchema.optional(),
    prerequisites: z.array(todoDependencyViewSchema).optional(),
    dependents: z.array(todoDependencyViewSchema).optional(),
    unmetPrerequisites: z.array(todoDependencyViewSchema).optional(),
    dependencyCycle: z.array(z.string()).optional(),
    /** The latest note written on it, and when. */
    note: text(TODO_LIMITS.note).nullable(),
    notedAt: z.iso.datetime().nullable(),
    /** Its latest recorded change; null when none was made since it was added. */
    changedAt: z.iso.datetime().nullable(),
    changedBy: todoActorSchema.nullable(),
    /** Its checkbox was ticked or cleared in Obsidian after its latest recorded change. */
    changedInObsidian: z.boolean(),
  });

export const todoCountsSchema = z.object({
  open: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
});

export const todoSourceKindSchema = z.enum(["agent_capture", "app_manual"]);

export const todoListViewSchema = z
  .object({
    id: text(200),
    title: line(TODO_LIMITS.title),
    summary: text(TODO_LIMITS.summary).nullable(),
    project: text(TODO_LIMITS.project).nullable(),
    tags: z.array(text(100)).max(TODO_LIMITS.tags),
    sourceKind: todoSourceKindSchema,
    sourceClient: sourceClientSchema.nullable(),
    /**
     * 长期清单 (日常, 学习): kept with the unfinished lists however many of its items are done, for the ones added next.
     * Otherwise the list is done with once every item is done or dropped. Absent in an answer from before it was kept.
     */
    longTerm: z.boolean().default(false),
    /** Put away: not among the unfinished lists nor in the views; still listed under 全部, where it is taken out again. */
    archived: z.boolean().default(false),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().positive(),
    /** The note, from the vault's root, with `/` between folders. */
    relativePath: text(2_000),
    items: z.array(todoItemViewSchema).max(TODO_LIMITS.itemsPerList),
    history: z.array(todoEventViewSchema).max(TODO_LIMITS.history),
    counts: todoCountsSchema,
  });

/** A list named without its items: what a write answers with. */
export const todoListSummarySchema = todoListViewSchema.pick({
  id: true,
  title: true,
  project: true,
  longTerm: true,
  revision: true,
  updatedAt: true,
  relativePath: true,
  counts: true,
});

/**
 * A new list needs a title and may start with no items (日常, 学习: added to as they come). Items added to a list need
 * at least one: an empty call there would say it added something.
 */
const recordRules = (value: { listId?: string | undefined; title?: string | undefined; items: unknown[] }, context: z.RefinementCtx): void => {
  if (value.listId === undefined && value.title === undefined) {
    context.addIssue({ code: "custom", path: ["title"], message: "a new todo list needs a title" });
  }
  if (value.listId !== undefined && value.items.length === 0) {
    context.addIssue({ code: "custom", path: ["items"], message: "items to add are needed" });
  }
};

/** An agent's list, or items it adds to one (listId). */
export const todoRecordRequestSchema = z
  .object({
    todoVersion: z.literal(TODO_VERSION),
    requestId: text(200),
    sourceClient: sourceClientSchema,
    listId: text(200).optional(),
    title: line(TODO_LIMITS.title).optional(),
    summary: text(TODO_LIMITS.summary).optional(),
    project: text(TODO_LIMITS.project).optional(),
    tags: z.array(text(100)).max(TODO_LIMITS.tags).default([]),
    /** For a new list; left out, a list made without items is a 长期清单 and one made with them is not. */
    longTerm: z.boolean().optional(),
    items: z.array(todoItemInputSchema).max(TODO_LIMITS.itemsPerCall).default([]),
  })
  .strict()
  .superRefine(recordRules);

/** The reader's list from the page, or items added to one. */
export const todoManualRecordSchema = z
  .object({
    listId: text(200).optional(),
    title: line(TODO_LIMITS.title).optional(),
    summary: text(TODO_LIMITS.summary).optional(),
    project: text(TODO_LIMITS.project).optional(),
    longTerm: z.boolean().optional(),
    items: z.array(todoItemInputSchema).max(TODO_LIMITS.itemsPerCall).default([]),
  })
  .strict()
  .superRefine(recordRules);

/** Several items of one list changed at once from the page, each on the status (and fields) the page showed. No notes. */
export const todoItemsChangeSchema = z
  .object({
    listId: text(200),
    changes: z
      .array(
        z
          .object({
            item: z.number().int().positive(),
            status: todoItemStatusSchema.optional(),
            priority: todoPrioritySchema.nullable().optional(),
            due: todoDueSchema.nullable().optional(),
            /** The item's whole set of tags afterwards (the page works it out from the tags it showed). */
            tags: todoTagsSchema.optional(),
            expectedStatus: todoItemStatusSchema,
            expectedPriority: todoPrioritySchema.nullable().optional(),
            expectedDue: todoDueSchema.nullable().optional(),
            expectedTags: todoTagsSchema.optional(),
          })
          .strict()
          .refine((value) => value.status !== undefined || value.priority !== undefined || value.due !== undefined || value.tags !== undefined, "Provide a change"),
      )
      .min(1)
      .max(TODO_LIMITS.itemsPerList),
  })
  .strict();

/** Items deleted from one list, each on the status the page showed. */
export const todoItemsDeleteSchema = z
  .object({
    listId: text(200),
    items: z.array(z.object({ item: z.number().int().positive(), expectedStatus: todoItemStatusSchema }).strict()).min(1).max(TODO_LIMITS.itemsPerList),
  })
  .strict();

/** Items of one list moved to another, each on the status (and fields) the page showed. */
export const todoItemsMoveSchema = z
  .object({
    fromListId: text(200),
    toListId: text(200),
    items: z
      .array(
        z
          .object({
            item: z.number().int().positive(),
            expectedStatus: todoItemStatusSchema,
            expectedPriority: todoPrioritySchema.nullable().optional(),
            expectedDue: todoDueSchema.nullable().optional(),
            expectedTags: todoTagsSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(TODO_LIMITS.itemsPerList),
  })
  .strict();

/**
 * saved: the call went through (see each item). same_list, list_not_found, target_not_found: nothing was written.
 * target_full: the other list would pass its item limit, and nothing was written.
 * Per item: saved (new in the other list, gone from this one; `number` is its number there); status_changed (changed since
 * the page showed it, left alone); item_not_found; kept (copied to the other list, but changed here meanwhile, so left in
 * place: it stands in both).
 */
export const todoItemsMoveResultSchema = z.object({
  todoVersion: z.literal(TODO_VERSION),
  status: z.enum(["saved", "same_list", "list_not_found", "target_not_found", "target_full"]),
  from: todoListSummarySchema.nullable(),
  to: todoListSummarySchema.nullable(),
  results: z.array(z.object({ item: z.number().int().positive(), status: z.enum(["saved", "status_changed", "item_not_found", "kept"]), number: z.number().int().positive().optional() })),
});

/** A list deleted, the reader having typed its title. */
export const todoListDeleteSchema = z.object({ listId: text(200), title: text(TODO_LIMITS.title) }).strict();

export const todoItemsResultSchema = z.object({
  todoVersion: z.literal(TODO_VERSION),
  status: z.enum(["saved", "list_not_found"]),
  list: todoListSummarySchema.nullable(),
  /** What became of each item: saved; unchanged (already so); status_changed (moved on since the page showed it, left alone); item_not_found. */
  results: z.array(z.object({ item: z.number().int().positive(), status: z.enum(["saved", "unchanged", "status_changed", "item_not_found"]) })),
});

export const todoListDeleteResultSchema = z.object({
  todoVersion: z.literal(TODO_VERSION),
  status: z.enum(["deleted", "list_not_found", "title_mismatch"]),
});

const skippedItemSchema = z.object({ number: z.number().int().positive(), title: line(TODO_LIMITS.itemTitle) });

export const todoRecordResultSchema = z
  .object({
    todoVersion: z.literal(TODO_VERSION),
    /**
     * created: a new list. appended: items added to the list named. duplicate: the same list (title and items) is
     * already there, and nothing was written. list_not_found: no list has that id. list_full: adding them would take
     * the list past its item limit, and nothing was written.
     */
    status: z.enum(["created", "appended", "duplicate", "list_not_found", "list_full"]),
    list: todoListSummarySchema.nullable(),
    /** The items written by this call, with the numbers they were given. */
    added: z.array(skippedItemSchema).max(TODO_LIMITS.itemsPerCall),
    /** Items the list already had (the same title), not added again. */
    skipped: z.array(skippedItemSchema).max(TODO_LIMITS.itemsPerCall),
    /** A full long-term list's oldest finished items, taken out to make room; their history stays in the App. Left out: none. */
    removed: z.array(skippedItemSchema).max(TODO_LIMITS.itemsPerCall).optional(),
  });

export const todoListQuerySchema = z
  .object({
    listId: text(200).optional(),
    query: text(200).optional(),
    project: text(TODO_LIMITS.project).optional(),
    /** Lists whose every item is done or dropped as well. */
    includeClosed: z.boolean().default(false),
    limit: z.number().int().min(1).max(TODO_LIMITS.page).default(20),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export const todoUnreadableNoteSchema = z.object({
  relativePath: text(2_000),
  message: text(1_000),
});

export const todoListResponseSchema = z
  .object({
    todoVersion: z.literal(TODO_VERSION),
    lists: z.array(todoListViewSchema).max(TODO_LIMITS.page),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    /** Todo notes that could not be read this time: what they hold is missing from the answer. */
    unreadable: z.array(todoUnreadableNoteSchema).max(50),
  });

const changesSomething = (value: { status?: unknown; note?: unknown; priority?: unknown; due?: unknown; tags?: unknown; detail?: unknown; disposition?: unknown; addDependencies?: unknown; removeDependencies?: unknown }): boolean =>
  value.status !== undefined || value.note !== undefined || value.priority !== undefined || value.due !== undefined || value.tags !== undefined || value.detail !== undefined || value.disposition !== undefined || value.addDependencies !== undefined || value.removeDependencies !== undefined;

/** An agent's change to one item. */
export const todoItemUpdateRequestSchema = z
  .object({
    todoVersion: z.literal(TODO_VERSION),
    sourceClient: sourceClientSchema,
    listId: text(200),
    item: z.number().int().positive(),
    ...todoDependencyChangesShape,
    expectedStatus: todoItemStatusSchema.optional(),
    status: todoItemStatusSchema.optional(),
    note: text(TODO_LIMITS.note).optional(),
    /** null clears it. Changing them needs no note. */
    priority: todoPrioritySchema.nullable().optional(),
    due: todoDueSchema.nullable().optional(),
    /** The item's whole set of tags (replaces the ones it has). */
    tags: todoTagsInputSchema.optional(),
  })
  .strict()
  .refine(changesSomething, "Provide a status, a note, a priority, a due date or tags");

/** The reader's change to one item, against the status the page showed (expectedStatus). */
export const todoItemChangeSchema = z
  .object({
    listId: text(200),
    item: z.number().int().positive(),
    ...todoDependencyChangesShape,
    status: todoItemStatusSchema.optional(),
    note: text(TODO_LIMITS.note).optional(),
    priority: todoPrioritySchema.nullable().optional(),
    due: todoDueSchema.nullable().optional(),
    tags: todoTagsSchema.optional(),
    /** The item's 补充说明 as it should read; null clears it. */
    detail: text(TODO_LIMITS.itemDetail).nullable().optional(),
    /** The 补充说明 the page was showing; changed since, nothing is written (status_changed). null: it had none. */
    expectedDetail: text(TODO_LIMITS.itemDetail).nullable().optional(),
    /** The item's 处置备注 as it should read; null clears it. Only the reader writes it: an agent's request has no such field. */
    disposition: text(TODO_LIMITS.itemDisposition).nullable().optional(),
    expectedDisposition: text(TODO_LIMITS.itemDisposition).nullable().optional(),
    expectedStatus: todoItemStatusSchema,
    /** Left out: not checked. Changed since the page showed it, nothing is written (status_changed). */
    expectedPriority: todoPrioritySchema.nullable().optional(),
    expectedDue: todoDueSchema.nullable().optional(),
    expectedTags: todoTagsSchema.optional(),
  })
  .strict()
  .refine(changesSomething, "Provide a status, a note, a priority, a due date or tags");

export const todoItemUpdateResultSchema = z
  .object({
    todoVersion: z.literal(TODO_VERSION),
    /**
     * saved: written. unchanged: it already stood so, the same note included. list_not_found, item_not_found: no such
     * list or item. note_required: an agent finished or dropped it without saying what was done or why.
     * status_changed: the item moved on since the page showed it (expectedStatus), and nothing was written.
     */
    status: z.enum(["saved", "unchanged", "list_not_found", "item_not_found", "note_required", "status_changed", "invalid_dependency", "dependency_cycle"]),
    message: z.string().optional(),
    list: todoListSummarySchema.nullable(),
    item: todoItemViewSchema.nullable(),
  });

/** The reader's settings for one list, from the page: whether it is a 长期清单, its title (not its file's name), archived. */
export const todoListSettingsSchema = z
  .object({
    listId: text(200),
    longTerm: z.boolean().optional(),
    title: line(TODO_LIMITS.title).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.longTerm !== undefined || value.title !== undefined || value.archived !== undefined, "Provide a setting");

/** One item moved before another (null: to the end) in the note's order. */
export const todoItemMoveSchema = z
  .object({ listId: text(200), item: z.number().int().positive(), before: z.number().int().positive().nullable() })
  .strict();

/** What a change to a list itself (settings, an item's place) answers with. */
export const todoListSettingsResultSchema = z.object({
  todoVersion: z.literal(TODO_VERSION),
  status: z.enum(["saved", "unchanged", "list_not_found", "item_not_found"]),
  list: todoListSummarySchema.nullable(),
});

/**
 * The shape of the App's answers a bridge reads, sent as a request header. A bridge from IMP-183 sends none and reads
 * every answer strictly: it is answered without what was added since (todoAnswerFor). Answered in full, each todo call
 * of a session started before an update failed as unknown, until the session was restarted. "2" (IMP-184) knows
 * longTerm and removed; "3" also knows priority, due, archived and the changes to them in the history; "4" knows the
 * priorities P0–P3 (high, medium and low before) and the tags of an item; "5" adds stable ids and dependencies.
 */
export const TODO_SHAPE_HEADER = "x-decision-todo-shape";
export const TODO_SHAPE = "5";

const omit = <T extends object>(value: T, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/** What a bridge before P0–P3 reads for a priority: P0 and P1 were the one high. */
const OLD_PRIORITY = { p0: "high", p1: "high", p2: "medium", p3: "low" } as const;
const oldPriority = (value: TodoPriority | null): "high" | "medium" | "low" | null => (value === null ? null : OLD_PRIORITY[value]);

/** The App's todo answers as a bridge that sent this shape header reads them (none: IMP-183's). */
export const todoAnswerFor = (shape: string | undefined) => {
  const level = shape === "5" ? 5 : shape === "4" ? 4 : shape === "3" ? 3 : shape === "2" ? 2 : 1;
  const summary = (list: TodoListSummary | null): Record<string, unknown> | null =>
    list === null ? null : level >= 2 ? list : omit(list, ["longTerm"]);
  const item = (view: TodoItemView): Record<string, unknown> => {
    if (level >= 5) return view;
    const kept = omit(view, ["id", "dependsOn", "prerequisites", "dependents", "unmetPrerequisites", "dependencyCycle"]);
    return level >= 4 ? kept : level >= 3
      ? { ...omit(kept, ["tags", "disposition"]), priority: oldPriority(view.priority) }
      : omit(kept, ["priority", "due", "tags", "disposition"]);
  };
  const event = (value: TodoEvent): Record<string, unknown> => {
    if (level >= 5) return value;
    if (level >= 4) return omit(value, ["dependencies"]);
    const kept = level >= 3 ? omit(value, ["moved", "tags", "detail", "disposition", "dependencies"]) : omit(value, ["priority", "due", "deleted", "moved", "tags", "detail", "disposition", "dependencies"]);
    return value.priority === undefined || level < 3
      ? kept
      : { ...kept, priority: { from: oldPriority(value.priority.from), to: oldPriority(value.priority.to) } };
  };
  const full = (list: TodoListView): Record<string, unknown> => {
    const kept = omit(list, level >= 3 ? [] : level >= 2 ? ["archived"] : ["archived", "longTerm"]);
    return level >= 5 ? kept : { ...kept, items: list.items.map(item), history: list.history.map(event) };
  };
  return {
    list: (response: TodoListResponse): Record<string, unknown> => ({ ...response, lists: response.lists.map(full) }),
    record: (result: TodoRecordResult): Record<string, unknown> => {
      const kept = level >= 2 ? result : omit(result, ["removed"]);
      return { ...kept, list: summary(result.list) };
    },
    item: (result: TodoItemUpdateResult): Record<string, unknown> => ({
      ...result,
      list: summary(result.list),
      item: result.item === null ? null : item(result.item),
    }),
  };
};

export type TodoPriority = z.infer<typeof todoPrioritySchema>;
export type TodoItemsChange = z.infer<typeof todoItemsChangeSchema>;
export type TodoItemsMove = z.infer<typeof todoItemsMoveSchema>;
export type TodoItemsMoveResult = z.infer<typeof todoItemsMoveResultSchema>;
export type TodoItemsDelete = z.infer<typeof todoItemsDeleteSchema>;
export type TodoListDelete = z.infer<typeof todoListDeleteSchema>;
export type TodoItemsResult = z.infer<typeof todoItemsResultSchema>;
export type TodoListDeleteResult = z.infer<typeof todoListDeleteResultSchema>;
export type TodoItemMove = z.infer<typeof todoItemMoveSchema>;
export type TodoItemStatus = z.infer<typeof todoItemStatusSchema>;
export type TodoActor = z.infer<typeof todoActorSchema>;
export type TodoEvent = z.infer<typeof todoEventSchema>;
export type TodoItemInput = z.infer<typeof todoItemInputSchema>;
export type TodoItemView = z.infer<typeof todoItemViewSchema>;
export type TodoCounts = z.infer<typeof todoCountsSchema>;
export type TodoSourceKind = z.infer<typeof todoSourceKindSchema>;
export type TodoListView = z.infer<typeof todoListViewSchema>;
export type TodoListSummary = z.infer<typeof todoListSummarySchema>;
export type TodoRecordRequest = z.input<typeof todoRecordRequestSchema>;
export type TodoManualRecord = z.input<typeof todoManualRecordSchema>;
export type TodoRecordResult = z.infer<typeof todoRecordResultSchema>;
export type TodoListQuery = z.input<typeof todoListQuerySchema>;
export type TodoListResponse = z.infer<typeof todoListResponseSchema>;
export type TodoUnreadableNote = z.infer<typeof todoUnreadableNoteSchema>;
export type TodoItemUpdateRequest = z.infer<typeof todoItemUpdateRequestSchema>;
export type TodoItemChange = z.infer<typeof todoItemChangeSchema>;
export type TodoItemUpdateResult = z.infer<typeof todoItemUpdateResultSchema>;
export type TodoListSettings = z.infer<typeof todoListSettingsSchema>;
export type TodoListSettingsResult = z.infer<typeof todoListSettingsResultSchema>;
