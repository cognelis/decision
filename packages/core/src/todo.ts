import {
  TODO_LIMITS,
  type TodoActor,
  type TodoCounts,
  type TodoEvent,
  type TodoItemInput,
  type TodoItemStatus,
  type TodoPriority,
  type TodoItemView,
  type TodoListView,
  type TodoSourceKind,
  splitTitleTags,
  uniqueTodoTags,
} from "@cognelis/decision-protocol";

/** An item as its note holds it: the status is its checkbox, whoever changed it last. */
export interface TodoItemRecord {
  number: number;
  id?: string | undefined;
  dependsOn?: string[] | undefined;
  /** Last recorded titles let a deleted prerequisite remain recognisable. */
  dependencyTitles?: Record<string, string> | undefined;
  title: string;
  detail: string | null;
  /** 处置备注: the reader's opinion for an agent, kept in the note as `处置：` lines under the item. */
  disposition: string | null;
  status: TodoItemStatus;
  priority: TodoPriority | null;
  /** A day, `YYYY-MM-DD`. */
  due: string | null;
  /** 标签, without the `#`: written after the title in the note. */
  tags: string[];
}

/** An item's 优先级, 截止日期 and 标签 as the App last wrote them (see TodoListRecord.recordedFields). */
export interface TodoItemFields {
  priority: TodoPriority | null;
  due: string | null;
  /** Absent in a history from before tags were kept: taken as it stands. */
  tags?: string[];
  dependsOn?: string[] | undefined;
  /**
   * The priority was recorded as 「high」, from before P0–P3: that was a ⏫ or a 🔺, and now P1 or P0. The note saying P0
   * is then no change made in Obsidian.
   */
  legacyHigh?: true;
}

const sameTags = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((tag, index) => tag === right[index]);

/**
 * 待办清单: what its note holds (the items and their checkboxes are what the list is), with what the App keeps of it
 * on this machine alone (IMP-185): the history of changes and the status it last wrote for each item, by which a box
 * ticked in Obsidian since is told apart from one the App ticked. Neither is written into the note.
 */
export interface TodoListRecord {
  id: string;
  title: string;
  summary: string | null;
  project: string | null;
  tags: string[];
  sourceKind: TodoSourceKind;
  sourceClient: string | null;
  /**
   * 长期清单 (日常, 学习): stays with the unfinished lists however many of its items are done, for those added next.
   * Otherwise a list is done with once every item is done or dropped, as an investigation's findings are.
   */
  longTerm: boolean;
  /** Put away (`archived: true` in the note): not among the unfinished lists, nor in the views. */
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  /** Moves by one with every write the App makes. */
  revision: number;
  items: TodoItemRecord[];
  history: TodoEvent[];
  /**
   * The status the App last wrote for each item, by its number. An item missing here is one this machine has not
   * written (a list from another device, or from before this was kept): its box is taken as it stands, not as changed.
   */
  recorded: Readonly<Record<string, TodoItemStatus>>;
  /** The same for 优先级 and 截止日期: one changed in Obsidian since reads as a change made there. Missing: taken as it stands. */
  recordedFields: Readonly<Record<string, TodoItemFields>>;
}

/** What a list's note holds: the list without what the App keeps of it on this machine. */
export type TodoListNote = Omit<TodoListRecord, "history" | "recorded" | "recordedFields">;

export interface TodoListDraft {
  title: string;
  summary?: string | null | undefined;
  project?: string | null | undefined;
  tags?: readonly string[] | undefined;
  /** Left out: a list made without items is long-term (a list to add to), one made with them is not. */
  longTerm?: boolean | undefined;
  items: readonly TodoItemInput[];
}

export interface TodoListSource {
  kind: TodoSourceKind;
  /** The agent's client; null for a list the reader wrote in the App. */
  client: string | null;
}

export const TODO_STATUS_LABELS: Readonly<Record<TodoItemStatus, string>> = {
  open: "待处理",
  in_progress: "处理中",
  done: "已完成",
  dropped: "已放弃",
};

/** Still to be handled: not yet started, or under way. */
export const todoItemPending = (status: TodoItemStatus): boolean => status === "open" || status === "in_progress";

/** A title as compared for sameness: one width and case, its spaces collapsed. */
export const todoTitleKey = (title: string): string =>
  title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");

/**
 * What makes two lists the same list: the project, the title and the items, in their order. An agent that sends its
 * list again (its call timed out, the answer never came) finds the one it wrote, not a second copy beside it.
 */
export const todoListKey = (list: Pick<TodoListDraft, "project" | "title"> & { items: readonly { title: string }[] }): string =>
  [list.project ?? "", list.title, ...list.items.map((item) => splitTitleTags(item.title).title)].map(todoTitleKey).join("\n");

/**
 * A list by its project and title alone: an empty one made again (「建一个学习清单」 twice, an answer lost) is the one
 * already there, whatever has been added to it since, not a second 学习 beside it.
 */
export const todoListNameKey = (list: Pick<TodoListDraft, "project" | "title">): string =>
  [list.project ?? "", list.title].map(todoTitleKey).join("\n");

// Line breaks as \n, and no spaces at a line's end: an editor that strips them (Obsidian can) changes nothing a reader
// sees, and the text still reads back as the App wrote it.
const lines = (value: string): string =>
  value.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n");
const optional = (value: string | null | undefined): string | null => {
  const text = value === null || value === undefined ? "" : lines(value).trim();
  return text.length === 0 ? null : text;
};

/** A 处置备注 is one paragraph in the note (its lines run on until a blank one), so blank lines are not kept in it. */
const optionalDisposition = (value: string | null | undefined): string | null =>
  optional(value === null || value === undefined ? value : value.replace(/\r\n?/gu, "\n").split("\n").filter((line) => line.trim().length > 0).join("\n"));

/** A title as the note keeps it: the `#tags` that end it are the item's tags, not part of its words (see splitTitleTags). */
const newItem = (input: TodoItemInput, number: number): TodoItemRecord => {
  const { title, tags } = splitTitleTags(input.title);
  return {
    number,
    title,
    detail: optional(input.detail),
    disposition: null,
    status: "open",
    priority: input.priority ?? null,
    due: input.due ?? null,
    tags: uniqueTodoTags([...(input.tags ?? []), ...tags]),
  };
};

/** One more than any number the list has used, its history's included: a number an item had is never given again. */
export const nextTodoNumber = (list: Pick<TodoListRecord, "items" | "history">): number =>
  Math.max(0, ...list.items.map((item) => item.number), ...list.history.map((event) => event.item)) + 1;

/**
 * What a list's history from before IMP-185 (written into its note) says the App last wrote for each item: an item's
 * latest change, or open for one never changed, as that version read it. Kept so the move changes nothing shown.
 */
export const legacyRecorded = (items: readonly Pick<TodoItemRecord, "number">[], history: readonly TodoEvent[]): Record<string, TodoItemStatus> => {
  const recorded: Record<string, TodoItemStatus> = Object.fromEntries(items.map((item) => [String(item.number), "open" as TodoItemStatus]));
  for (const event of history) if (String(event.item) in recorded) recorded[String(event.item)] = event.status;
  return recorded;
};

export const createTodoList = (draft: TodoListDraft, source: TodoListSource, id: string, now: Date): TodoListRecord => {
  const at = now.toISOString();
  const seen = new Set<string>();
  const items: TodoItemRecord[] = [];
  // The same finding twice in one call is kept once.
  for (const input of draft.items) {
    const key = todoTitleKey(splitTitleTags(input.title).title);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(newItem(input, items.length + 1));
  }
  return {
    id,
    title: draft.title.trim(),
    summary: optional(draft.summary),
    project: optional(draft.project),
    tags: [...new Set((draft.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))],
    sourceKind: source.kind,
    sourceClient: source.client,
    longTerm: draft.longTerm ?? items.length === 0,
    archived: false,
    createdAt: at,
    updatedAt: at,
    revision: 1,
    items,
    history: [],
    recorded: statusesOf(items),
    recordedFields: fieldsOf(items),
  };
};

const touched = (list: TodoListRecord, now: Date): TodoListRecord => ({
  ...list,
  updatedAt: now.toISOString(),
  revision: list.revision + 1,
});

/**
 * The history kept within its limit: the oldest changes go first, but never an item's latest, which says what the
 * App last recorded of it (without it, a box the App ticked would read as ticked in Obsidian).
 */
const withinLimit = (history: readonly TodoEvent[]): TodoEvent[] => {
  if (history.length <= TODO_LIMITS.history) return [...history];
  const latest = new Set<number>();
  const seen = new Set<number>();
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]!.item;
    if (!seen.has(item)) {
      seen.add(item);
      latest.add(index);
    }
  }
  let excess = history.length - TODO_LIMITS.history;
  return history.filter((_event, index) => {
    if (excess > 0 && !latest.has(index)) {
      excess -= 1;
      return false;
    }
    return true;
  });
};

/** The status the App last wrote for an item; null for one this machine has not written. */
export const recordedTodoStatus = (list: Pick<TodoListRecord, "recorded">, number: number): TodoItemStatus | null =>
  list.recorded[String(number)] ?? null;

/** Each item's status as the note now has it: what the App records once it has written the note. */
function statusesOf(items: readonly TodoItemRecord[]): Record<string, TodoItemStatus> {
  return Object.fromEntries(items.map((item) => [String(item.number), item.status]));
}

function fieldsOf(items: readonly TodoItemRecord[]): Record<string, TodoItemFields> {
  return Object.fromEntries(items.map((item) => [String(item.number), { priority: item.priority, due: item.due, tags: [...item.tags], dependsOn: [...(item.dependsOn ?? [])] }]));
}

/**
 * Each checkbox ticked or cleared in Obsidian since the App last wrote it, put in the history as a change of its own
 * (when it was noticed, by Obsidian), so that the next change made here does not read as made from the wrong status.
 * An item this machine never wrote is taken as it stands; the statuses recorded are the note's from here on.
 */
export const withObsidianChanges = (list: TodoListRecord, now: Date): TodoListRecord => {
  const at = now.toISOString();
  const events: TodoEvent[] = [];
  for (const item of list.items) {
    const recorded = recordedTodoStatus(list, item.number);
    const fields = list.recordedFields[String(item.number)];
    const statusChanged = recorded !== null && recorded !== item.status;
    const priorityChanged = fields !== undefined && fields.priority !== item.priority && !(fields.legacyHigh === true && item.priority === "p0");
    const dueChanged = fields !== undefined && fields.due !== item.due;
    const tagsChanged = fields?.tags !== undefined && !sameTags(fields.tags, item.tags);
    const dependenciesChanged = fields?.dependsOn !== undefined && !sameTags(fields.dependsOn, item.dependsOn ?? []);
    if (!statusChanged && !priorityChanged && !dueChanged && !tagsChanged && !dependenciesChanged) continue;
    events.push({
      item: item.number,
      at,
      previous: recorded ?? item.status,
      status: item.status,
      note: null,
      by: { kind: "obsidian" },
      ...(priorityChanged ? { priority: { from: fields.priority, to: item.priority } } : {}),
      ...(dueChanged ? { due: { from: fields.due, to: item.due } } : {}),
      ...(tagsChanged ? { tags: { from: [...fields!.tags!], to: [...item.tags] } } : {}),
      ...(dependenciesChanged ? { dependencies: { from: [...fields!.dependsOn!], to: [...(item.dependsOn ?? [])] } } : {}),
    });
  }
  return {
    ...list,
    history: events.length === 0 ? list.history : withinLimit([...list.history, ...events]),
    recorded: statusesOf(list.items),
    recordedFields: fieldsOf(list.items),
  };
};

export interface TodoAppendResult {
  list: TodoListRecord;
  added: TodoItemRecord[];
  /** Items the list already had, by the same title: the ones there, not added again. */
  skipped: TodoItemRecord[];
  /** A full long-term list's oldest finished items, taken out of it to make room (their history stays). */
  removed: TodoItemRecord[];
  /** Adding them would take the list past its item limit: nothing was added. */
  full: boolean;
}

export const appendTodoItems = (current: TodoListRecord, inputs: readonly TodoItemInput[], now: Date): TodoAppendResult => {
  const list = withObsidianChanges(current, now);
  // The same title is the same item in a list of findings, whatever became of it. In a long-term list only one still to
  // be handled is: 交水费 comes round again once the last one is done.
  const comparable = list.longTerm ? list.items.filter((item) => todoItemPending(item.status)) : list.items;
  const byTitle = new Map(comparable.map((item) => [todoTitleKey(item.title), item]));
  const added: TodoItemRecord[] = [];
  const skipped: TodoItemRecord[] = [];
  let number = nextTodoNumber(list);
  for (const input of inputs) {
    // Compared as the note will keep it: 「修 bug #urgent」 sent again is the item 「修 bug」 already there.
    const key = todoTitleKey(splitTitleTags(input.title).title);
    const existing = byTitle.get(key);
    if (existing !== undefined) {
      if (!skipped.includes(existing) && !added.includes(existing)) skipped.push(existing);
      continue;
    }
    const item = newItem(input, number);
    number += 1;
    byTitle.set(key, item);
    added.push(item);
  }
  if (added.length === 0) return { list: current, added, skipped, removed: [], full: false };
  // Full, a long-term list lets its oldest finished items go to make room, their numbers never given again and their
  // history kept: added to for months (日常), it would otherwise refuse the next todo for good. A list of findings is
  // refused as it was. Stable ids may be referenced by another list, so those items are never auto-evicted.
  const overflow = list.items.length + added.length - TODO_LIMITS.itemsPerList;
  const removed = overflow <= 0 || !list.longTerm
    ? []
    : list.items.filter((item) => !todoItemPending(item.status) && item.id === undefined).sort((left, right) => left.number - right.number).slice(0, overflow);
  if (overflow > 0 && removed.length < overflow) return { list: current, added: [], skipped, removed: [], full: true };
  const gone = new Set(removed.map((item) => item.number));
  const items = [...list.items.filter((item) => !gone.has(item.number)), ...added];
  return { list: touched({ ...list, items, recorded: statusesOf(items), recordedFields: fieldsOf(items) }, now), added, skipped, removed, full: false };
};

export interface TodoItemChangeInput {
  item: number;
  dependsOn?: readonly string[] | undefined;
  dependencyTitles?: Record<string, string> | undefined;
  status?: TodoItemStatus | undefined;
  note?: string | undefined;
  /** null clears it; left out, it stays. */
  priority?: TodoPriority | null | undefined;
  due?: string | null | undefined;
  /** The item's whole set of tags afterwards; left out, they stay. */
  tags?: readonly string[] | undefined;
  /** The item's 补充说明 afterwards (null clears it); left out, it stays. */
  detail?: string | null | undefined;
  /** The item's 处置备注 afterwards (null clears it); left out, it stays. Only the page sets it. */
  disposition?: string | null | undefined;
  /** The status the reader saw: changed since, nothing is written. Likewise the priority, due date and tags, when given. */
  expectedStatus?: TodoItemStatus | undefined;
  expectedPriority?: TodoPriority | null | undefined;
  expectedDue?: string | null | undefined;
  expectedTags?: readonly string[] | undefined;
  /** The 补充说明 the reader saw; changed since, nothing is written. */
  expectedDetail?: string | null | undefined;
  expectedDisposition?: string | null | undefined;
  /**
   * A client from before P0–P3 said 「high」 (it was told so for P0 and P1 alike): on an item that is P0 that is no change.
   * Only set for such a client's request, which cannot tell the two apart.
   */
  highKeepsP0?: boolean | undefined;
  /**
   * The whole item as the caller last read it, checked on the item as the note holds it now (title and all, which the
   * expected* fields leave out): false, nothing is written (status_changed). The App's own callers only (IMP-191).
   */
  precondition?: ((item: TodoItemRecord, list: TodoListRecord) => boolean) | undefined;
}

export type TodoChangeOutcome =
  | { status: "saved"; list: TodoListRecord; item: TodoItemRecord }
  | { status: "unchanged"; list: TodoListRecord; item: TodoItemRecord }
  | { status: "status_changed"; list: TodoListRecord; item: TodoItemRecord }
  | { status: "item_not_found" }
  | { status: "note_required" };

/** The latest change recorded for an item, and the latest with a note. */
const latestEvents = (list: Pick<TodoListRecord, "history">, number: number): { changed: TodoEvent | null; noted: TodoEvent | null } => {
  let changed: TodoEvent | null = null;
  let noted: TodoEvent | null = null;
  for (const event of list.history) {
    if (event.item !== number) continue;
    changed = event;
    noted = event.note === null ? noted : event;
  }
  return { changed, noted };
};

/**
 * One item moved to a status, a note written on it, its 优先级 or 截止日期 changed, or several of these. An agent that
 * finishes or drops an item says what was done and how it was checked, or why it was dropped (note_required): a box
 * ticked with nothing said is a claim the reader cannot check. Priority and due date need no note. Asked again with the
 * same values and the same note, nothing is written (an agent's retry).
 */
export const changeTodoItem = (
  list: TodoListRecord,
  change: TodoItemChangeInput,
  actor: TodoActor,
  now: Date,
): TodoChangeOutcome => {
  const item = list.items.find((candidate) => candidate.number === change.item);
  if (item === undefined) return { status: "item_not_found" };
  if (
    (change.expectedStatus !== undefined && change.expectedStatus !== item.status) ||
    (change.expectedPriority !== undefined && change.expectedPriority !== item.priority) ||
    (change.expectedDue !== undefined && change.expectedDue !== item.due) ||
    (change.expectedTags !== undefined && !sameTags(uniqueTodoTags(change.expectedTags), item.tags)) ||
    (change.expectedDetail !== undefined && (change.expectedDetail === null ? item.detail !== null : optional(change.expectedDetail) !== item.detail)) ||
    (change.expectedDisposition !== undefined && optionalDisposition(change.expectedDisposition) !== item.disposition) ||
    (change.precondition !== undefined && !change.precondition(item, list))
  ) {
    return { status: "status_changed", list, item };
  }
  const status = change.status ?? item.status;
  const priority = change.priority === undefined ? item.priority : change.highKeepsP0 === true && change.priority === "p1" && item.priority === "p0" ? "p0" : change.priority;
  const due = change.due === undefined ? item.due : change.due;
  const tags = change.tags === undefined ? item.tags : uniqueTodoTags(change.tags);
  const detail = change.detail === undefined ? item.detail : optional(change.detail);
  const disposition = change.disposition === undefined ? item.disposition : optionalDisposition(change.disposition);
  const dependsOn = change.dependsOn === undefined ? item.dependsOn ?? [] : [...change.dependsOn];
  const dependenciesChanged = !sameTags(dependsOn, item.dependsOn ?? []);
  const note = optional(change.note);
  if (actor.kind === "agent" && status !== item.status && (status === "done" || status === "dropped") && note === null) {
    return { status: "note_required" };
  }
  const fieldsChanged = priority !== item.priority || due !== item.due || !sameTags(tags, item.tags) || detail !== item.detail || disposition !== item.disposition || dependenciesChanged;
  if (status === item.status && !fieldsChanged && (note === null || note === latestEvents(list, item.number).noted?.note)) {
    return { status: "unchanged", list, item };
  }
  const reconciled = withObsidianChanges(list, now);
  const event: TodoEvent = {
    item: item.number,
    at: now.toISOString(),
    previous: item.status,
    status,
    note,
    by: actor,
    ...(priority === item.priority ? {} : { priority: { from: item.priority, to: priority } }),
    ...(due === item.due ? {} : { due: { from: item.due, to: due } }),
    ...(sameTags(tags, item.tags) ? {} : { tags: { from: [...item.tags], to: tags } }),
    ...(detail === item.detail ? {} : { detail: true as const }),
    ...(disposition === item.disposition ? {} : { disposition: true as const }),
    ...(dependenciesChanged ? { dependencies: { from: [...(item.dependsOn ?? [])], to: dependsOn } } : {}),
  };
  const changed = { ...item, status, priority, due, tags, detail, disposition };
  if (dependenciesChanged) {
    if (dependsOn.length === 0) {
      delete changed.dependsOn;
      delete changed.dependencyTitles;
    } else {
      changed.dependsOn = dependsOn;
      const titles = Object.fromEntries(dependsOn.flatMap(id => {
        const title = change.dependencyTitles?.[id] ?? item.dependencyTitles?.[id];
        return title === undefined ? [] : [[id, title]];
      }));
      if (Object.keys(titles).length > 0) changed.dependencyTitles = titles;
      else delete changed.dependencyTitles;
    }
  }
  const items = reconciled.items.map((candidate) => (candidate.number === item.number ? changed : candidate));
  return {
    status: "saved",
    list: touched(
      { ...reconciled, items, history: withinLimit([...reconciled.history, event]), recorded: statusesOf(items), recordedFields: fieldsOf(items) },
      now,
    ),
    item: changed,
  };
};

export interface TodoBatchChange extends TodoItemChangeInput {}

export interface TodoBatchResult {
  list: TodoListRecord;
  results: { item: number; status: "saved" | "unchanged" | "status_changed" | "item_not_found" }[];
  /** Whether any item was written (the list is then one revision on). */
  written: boolean;
}

/**
 * Several items changed in one pass, each on what the page showed of it (an item moved on meanwhile is left alone and
 * said). The list is written once: one revision on, whatever the number of items. No notes: the page asks none of a
 * quick change.
 */
export const changeTodoItems = (list: TodoListRecord, changes: readonly TodoBatchChange[], actor: TodoActor, now: Date): TodoBatchResult => {
  let current = list;
  const results: TodoBatchResult["results"] = [];
  for (const change of changes) {
    const outcome = changeTodoItem(current, change, actor, now);
    if (outcome.status === "saved") current = outcome.list;
    results.push({ item: change.item, status: outcome.status === "note_required" ? "unchanged" : outcome.status });
  }
  const written = current !== list;
  return { list: written ? { ...current, revision: list.revision + 1 } : list, results, written };
};

/** Items deleted, each on the status the page showed; one write. Their numbers stay in the history, so none is given again. */
export const deleteTodoItems = (
  list: TodoListRecord,
  items: readonly { item: number; expectedStatus: TodoItemStatus }[],
  actor: TodoActor,
  now: Date,
): TodoBatchResult => {
  const reconciled = withObsidianChanges(list, now);
  const results: TodoBatchResult["results"] = [];
  const gone = new Set<number>();
  const events: TodoEvent[] = [];
  for (const { item: number, expectedStatus } of items) {
    const item = list.items.find((candidate) => candidate.number === number);
    if (item === undefined) results.push({ item: number, status: "item_not_found" });
    else if (item.status !== expectedStatus) results.push({ item: number, status: "status_changed" });
    else {
      gone.add(number);
      events.push({ item: number, at: now.toISOString(), previous: item.status, status: item.status, note: null, by: actor, deleted: true });
      results.push({ item: number, status: "saved" });
    }
  }
  if (gone.size === 0) return { list, results, written: false };
  const remaining = reconciled.items.filter((item) => !gone.has(item.number));
  return {
    list: touched({ ...reconciled, items: remaining, history: withinLimit([...reconciled.history, ...events]), recorded: statusesOf(remaining), recordedFields: fieldsOf(remaining) }, now),
    results,
    written: true,
  };
};

/** An item as the list it leaves hands it over: everything but its number, which the other list gives. */
export interface MovedTodoItem {
  id?: string | undefined;
  dependsOn?: string[] | undefined;
  dependencyTitles?: Record<string, string> | undefined;
  title: string;
  detail: string | null;
  disposition: string | null;
  status: TodoItemStatus;
  priority: TodoPriority | null;
  due: string | null;
  tags: readonly string[];
  /** Where it came from: that list, and its number there. */
  from: { listId: string; listTitle: string; item: number };
}

/**
 * Items arriving from another list, each a new item with the next number, the same title, detail, status, priority, due
 * date and tags, and a history entry that names where it came from. null when they would take the list past its limit.
 */
export const receiveTodoItems = (
  list: TodoListRecord,
  arriving: readonly MovedTodoItem[],
  actor: TodoActor,
  now: Date,
): { list: TodoListRecord; numbers: number[] } | null => {
  if (list.items.length + arriving.length > TODO_LIMITS.itemsPerList) return null;
  const reconciled = withObsidianChanges(list, now);
  let number = nextTodoNumber(reconciled);
  const numbers: number[] = [];
  const added: TodoItemRecord[] = [];
  const events: TodoEvent[] = [];
  for (const moved of arriving) {
    const item: TodoItemRecord = {
      number,
      ...(moved.id === undefined ? {} : { id: moved.id }),
      ...(moved.dependsOn === undefined ? {} : { dependsOn: [...moved.dependsOn] }),
      ...(moved.dependencyTitles === undefined ? {} : { dependencyTitles: { ...moved.dependencyTitles } }),
      title: moved.title,
      detail: moved.detail,
      disposition: moved.disposition,
      status: moved.status,
      priority: moved.priority,
      due: moved.due,
      tags: uniqueTodoTags(moved.tags),
    };
    added.push(item);
    numbers.push(number);
    events.push({
      item: number,
      at: now.toISOString(),
      previous: moved.status,
      status: moved.status,
      note: null,
      by: actor,
      moved: { direction: "in", listId: moved.from.listId, listTitle: moved.from.listTitle, item: moved.from.item },
    });
    number += 1;
  }
  const items = [...reconciled.items, ...added];
  return {
    list: touched({ ...reconciled, items, history: withinLimit([...reconciled.history, ...events]), recorded: statusesOf(items), recordedFields: fieldsOf(items) }, now),
    numbers,
  };
};

/**
 * Items that went to another list, taken out of this one: like a deletion (the line is gone, the number is not given
 * again), but the history entry says where each went. Each only if it is still what was copied (`same`); one changed
 * meanwhile is kept and reported.
 */
export const removeMovedTodoItems = (
  list: TodoListRecord,
  gone: readonly { item: number; same(item: TodoItemRecord): boolean; to: { listId: string; listTitle: string; item: number } }[],
  actor: TodoActor,
  now: Date,
): { list: TodoListRecord; results: { item: number; status: "saved" | "kept" | "item_not_found" }[]; written: boolean } => {
  const reconciled = withObsidianChanges(list, now);
  const results: { item: number; status: "saved" | "kept" | "item_not_found" }[] = [];
  const removed = new Set<number>();
  const events: TodoEvent[] = [];
  for (const entry of gone) {
    const item = reconciled.items.find((candidate) => candidate.number === entry.item);
    if (item === undefined) results.push({ item: entry.item, status: "item_not_found" });
    else if (!entry.same(item)) results.push({ item: entry.item, status: "kept" });
    else {
      removed.add(entry.item);
      events.push({
        item: entry.item,
        at: now.toISOString(),
        previous: item.status,
        status: item.status,
        note: null,
        by: actor,
        deleted: true,
        moved: { direction: "out", listId: entry.to.listId, listTitle: entry.to.listTitle, item: entry.to.item },
      });
      results.push({ item: entry.item, status: "saved" });
    }
  }
  if (removed.size === 0) return { list, results, written: false };
  const items = reconciled.items.filter((item) => !removed.has(item.number));
  return {
    list: touched({ ...reconciled, items, history: withinLimit([...reconciled.history, ...events]), recorded: statusesOf(items), recordedFields: fieldsOf(items) }, now),
    results,
    written: true,
  };
};

/**
 * An item moved in the note's order: before another item, or to the end (null). The order is the note's lines, so this
 * rewrites them; it is no change of the item and leaves no history.
 */
export const moveTodoItem = (list: TodoListRecord, number: number, before: number | null, now: Date): TodoListRecord | "item_not_found" | "unchanged" => {
  const item = list.items.find((candidate) => candidate.number === number);
  if (item === undefined || (before !== null && !list.items.some((candidate) => candidate.number === before))) return "item_not_found";
  const rest = list.items.filter((candidate) => candidate !== item);
  const at = before === null ? rest.length : rest.findIndex((candidate) => candidate.number === before);
  const items = [...rest.slice(0, at), item, ...rest.slice(at)];
  if (items.every((candidate, index) => candidate === list.items[index])) return "unchanged";
  return touched({ ...withObsidianChanges(list, now), items }, now);
};

export const todoCounts = (items: readonly Pick<TodoItemRecord, "status">[]): TodoCounts => ({
  open: items.filter((item) => item.status === "open").length,
  inProgress: items.filter((item) => item.status === "in_progress").length,
  done: items.filter((item) => item.status === "done").length,
  dropped: items.filter((item) => item.status === "dropped").length,
});

/**
 * Still to be worked on, and so listed with the unfinished lists: a long-term list always, one with no items yet, or one
 * with an item still to be handled. Any other is closed, every item in it done or dropped.
 */
export const todoListPending = (list: Pick<TodoListRecord, "items" | "longTerm"> & { archived?: boolean }): boolean =>
  list.archived !== true && (list.longTerm || list.items.length === 0 || list.items.some((item) => todoItemPending(item.status)));

/** The list made long-term, or not: the same list when it already is so. */
export const setTodoListLongTerm = (list: TodoListRecord, longTerm: boolean, now: Date): TodoListRecord =>
  updateTodoListSettings(list, { longTerm }, now);

/** The list's title (not its file's name), 长期 and archived settings changed; the same list when nothing differs. */
export const updateTodoListSettings = (
  list: TodoListRecord,
  settings: { longTerm?: boolean | undefined; title?: string | undefined; archived?: boolean | undefined },
  now: Date,
): TodoListRecord => {
  const next = {
    longTerm: settings.longTerm ?? list.longTerm,
    archived: settings.archived ?? list.archived,
    title: settings.title === undefined ? list.title : settings.title.trim(),
  };
  return next.longTerm === list.longTerm && next.archived === list.archived && next.title === list.title
    ? list
    : touched({ ...withObsidianChanges(list, now), ...next }, now);
};

export const todoItemView = (list: Pick<TodoListRecord, "history" | "recorded">, item: TodoItemRecord): TodoItemView => {
  const { changed, noted } = latestEvents(list, item.number);
  const recorded = recordedTodoStatus(list, item.number);
  // The note said with the latest change; one said before a later change without a note belongs to that history.
  const current = changed !== null && noted === changed ? noted : null;
  return {
    number: item.number,
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.dependsOn === undefined ? {} : { dependsOn: [...item.dependsOn] }),
    title: item.title,
    detail: item.detail,
    disposition: item.disposition,
    status: item.status,
    priority: item.priority,
    due: item.due,
    tags: [...item.tags],
    note: current?.note ?? null,
    notedAt: current?.at ?? null,
    changedAt: changed?.at ?? null,
    changedBy: changed?.by ?? null,
    changedInObsidian: recorded !== null && recorded !== item.status,
  };
};

export const todoListView = (list: TodoListRecord, relativePath: string): TodoListView => ({
  id: list.id,
  title: list.title,
  summary: list.summary,
  project: list.project,
  tags: [...list.tags],
  sourceKind: list.sourceKind,
  sourceClient: list.sourceClient,
  longTerm: list.longTerm,
  archived: list.archived,
  createdAt: list.createdAt,
  updatedAt: list.updatedAt,
  revision: list.revision,
  relativePath,
  items: list.items.map((item) => todoItemView(list, item)),
  history: [...list.history],
  counts: todoCounts(list.items),
});
