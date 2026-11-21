import { todoItemPending, todoListPending } from "@cognelis/decision-core/todo";
import {
  TODO_LIMITS,
  parseTodoItemSourceKey,
  uniqueTodoTags,
  type TodoItemStatus,
  type TodoPriority,
  type TodoItemView,
  type TodoListSummary,
  type TodoListView,
  type TodoRecordResult,
  type TodoUnreadableNote,
} from "@cognelis/decision-protocol";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { knownClients } from "../../../client-labels.js";
import { isClearShortcut } from "../../../keyboard.js";
import { navigateList } from "../../../list-navigation.js";
import { relativeTime } from "../../../relative-time.js";
import { useSlashToFocus } from "../../../use-slash-focus.js";
import { ActionIcon } from "../../IconButton.js";
import { ListWidthHandle } from "../../ListWidthHandle.js";
import { usePageShownAgain } from "../../ModalDialog.js";
import { Chevron } from "../decisions/DecisionFeedbackPanel.js";
import { parseQuickAdd } from "./quick-add.js";
import { TodoBatchBar } from "./TodoBatchBar.js";
import { TodoCreateDialog } from "./TodoCreateDialog.js";
import { TodoDeleteDialog } from "./TodoDeleteDialog.js";
import { TodoItemDrawer, type ItemPatch, type NoteDraft } from "./TodoItemDrawer.js";
import { CopyFallbackBlock, TodoItemRow, TodoMessageLine, type DropSide, type RowMenu, type TodoMessage } from "./TodoItemRow.js";
import { TodoListMenu } from "./TodoListMenu.js";
import { TodoMoveDialog } from "./TodoMoveDialog.js";
import { TodoDependencySection } from "./TodoDependencySection.js";
import { ShortcutHints } from "./TodoShortcuts.js";
import { quickAddItem, TodoQuickAddDialog } from "./TodoQuickAddDialog.js";
import { dayHeading, localDay } from "./todo-dates.js";
import { setTodoViewContext } from "./todo-quick-add-context.js";
import {
  agentNames,
  countsText,
  handled,
  itemPrompt,
  copiedNotice,
  pickedPrompt,
  itemTotal,
  listPrompt,
  listSourceLabel,
  listDependencySummary,
  momentLabel,
  statusLabel,
  unfinished,
} from "./todo-text.js";
import {
  groupCount,
  sortedItems,
  SORT_LABELS,
  tagCounts,
  tagOfView,
  tagViewOf,
  viewGroups,
  VIEW_TITLES,
  type ItemSort,
  type TodoViewId,
  type ViewEntry,
} from "./todo-views.js";
import { BeforeStart } from "../organization/BeforeStart.js";
import { OrganizationPanel, type OrganizationApi, type OrganizationContext } from "../organization/OrganizationPanel.js";
import { TodoGroups, useTodoAnnotations, type ReadingLayerApi } from "../organization/TodoReadingLayer.js";
import "./todos.css";

export type TodoApi = Pick<
  DecisionApi,
  "listTodoLists" | "recordTodoList" | "changeTodoItem" | "updateTodoList" | "moveTodoItem" | "changeTodoItems" | "moveTodoItemsToList" | "deleteTodoItems" | "deleteTodoList" | "openVaultDocument"
>;

/** 整理与记忆（IMP-191）的入口；没给就没有这个入口（别的页面嵌入待办时）。 */
export interface TodoOrganization {
  api: OrganizationApi & ReadingLayerApi;
  /** DashboardSnapshot.organizationRevision。 */
  revision: number;
  /** DashboardSnapshot.organizationPending：入口徽标，等于三个页签计数之和。 */
  pending: number;
  onOpenMethodology?: () => void;
}

interface TodoPanelProps {
  api: TodoApi;
  organization?: TodoOrganization;
  /** Moves whenever a list is written, by an agent or on this page: what is shown is read again. */
  todoRevision: number;
}

/** One answer of the lists, as the page shows it. */
interface Shown {
  /** In the order read, with the list in view kept in its place when a change took it out of the range. */
  lists: TodoListView[];
  /** Every list still being worked on, whatever is searched or chosen: what the views and their counts are made of. */
  viewLists: TodoListView[];
  total: number;
  unreadable: TodoUnreadableNote[];
  /** Some list there at all, finished ones included: tells 还没有清单 from 没有未完成的清单. */
  anyList: boolean;
  /** Items still to handle across every list, whatever is searched. */
  unfinishedItems: number;
  /** The search and range this answer is for. */
  words: string;
  includeClosed: boolean;
}

interface CopyState {
  key: string;
  /** What a copy of several items says once done (the batch bar's). */
  notice?: string;
  status: "copied" | "failed";
  text: string;
}

const itemKeyOf = (listId: string, number: number): string => `${listId}#${number}`;

const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

/** A list as a write left it, from the summary the write answered with: shown before the lists are read again. */
const summarized = (list: TodoListView, summary: TodoListSummary | null): TodoListView =>
  summary === null
    ? list
    : { ...list, title: summary.title, counts: summary.counts, revision: summary.revision, updatedAt: summary.updatedAt, longTerm: summary.longTerm };

const without = <T,>(record: Readonly<Partial<Record<string, T>>>, key: string): Partial<Record<string, T>> => {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

const attributeValue = (value: string): string => value.replace(/["\\]/gu, "\\$&");

/** The control an item, or the add field, falls back to when what had focus went: marked with data-todo-focus. */
const focusSelector = (key: string): string => `[data-todo-focus="${attributeValue(key)}"]`;

const NOT_FOUND = "这份清单找不到了，可能在 Obsidian 里移走或删掉了。";

/**
 * A line of where and when, each part kept whole (「更新于 7 小时前」 broke after 更新 in a narrow column): parts move
 * to the next line as a piece, and a part longer than the line ends in an ellipsis, its whole text the tooltip.
 */
const MetaParts = ({ parts, className, id }: { parts: readonly (string | null)[]; className: string; id?: string }) => (
  <span className={className} {...(id === undefined ? {} : { id })}>
    {parts
      .filter((part): part is string => part !== null && part.length > 0)
      .map((part, index) => (
        <span key={index} title={part}>{part}</span>
      ))}
  </span>
);

const ChecklistGlyph = () => (
  <svg className="todo-empty-glyph" viewBox="0 0 20 20" aria-hidden="true">
    <path d="m3.2 5.4 1.3 1.3 2.3-2.5" />
    <path d="M9.5 5.5H17M9.5 10.5H17M9.5 15.5H17" />
    <rect x="3.3" y="9" width="3" height="3" rx="0.8" />
    <rect x="3.3" y="14" width="3" height="3" rx="0.8" />
  </svg>
);

/** The share of a list's items that are handled, as a ring with the count in it. */
const ProgressRing = ({ done, total }: { done: number; total: number }) => {
  const radius = 15;
  const length = 2 * Math.PI * radius;
  return (
    <span className="todo-ring" role="img" aria-label={total === 0 ? "还没有事项" : `已处理 ${done}/${total}`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className="todo-ring-track" cx="18" cy="18" r={radius} />
        <circle
          className="todo-ring-value"
          cx="18"
          cy="18"
          r={radius}
          strokeDasharray={`${total === 0 ? 0 : (done / total) * length} ${length}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span aria-hidden="true">{total === 0 ? "—" : `${done}/${total}`}</span>
    </span>
  );
};

/** Items a group shows before its button asks for more. */
const SEGMENT = 30;

const fold = (text: string): string => text.normalize("NFKC").toLocaleLowerCase("zh-CN");

/** Entries by the list they are in, in the order they come. */
const byList = (entries: readonly ViewEntry[]): Map<string, ViewEntry[]> => {
  const groups = new Map<string, ViewEntry[]>();
  for (const entry of entries) groups.set(entry.list.id, [...(groups.get(entry.list.id) ?? []), entry]);
  return groups;
};

const BATCH_REASONS = { status_changed: "已被改过", item_not_found: "已不在清单里", unchanged: "没有变化", list_not_found: "清单找不到了" } as const;

/** What a batch came to, in words: 成功 N 项，跳过 M 项（原因）. */
const batchSummary = (saved: number, skipped: Readonly<Record<string, number>>): TodoMessage => {
  const total = Object.values(skipped).reduce((sum, count) => sum + count, 0);
  const reasons = Object.entries(skipped).map(([reason, count]) => `${count} 项${reason}`).join("，");
  return { tone: total === 0 ? "ok" : "warning", text: `成功 ${saved} 项${total === 0 ? "" : `，跳过 ${total} 项（${reasons}）`}。` };
};

const VIEW_ORDER: readonly TodoViewId[] = ["today", "upcoming", "all"];

/** A view's name: 今天, 即将到期, 全部未完成, or #标签. */
const viewTitle = (view: string): string => {
  const tag = tagOfView(view);
  return tag === null ? VIEW_TITLES[view as TodoViewId] : `#${tag}`;
};

const lowerTag = (tag: string): string => tag.toLocaleLowerCase("zh-CN");

/** What a move came to, in words: 已移到「X」N 项，跳过 M 项（…）. */
const moveSummary = (target: string, moved: number, skipped: Readonly<Record<string, number>>): TodoMessage => {
  const total = Object.values(skipped).reduce((sum, count) => sum + count, 0);
  const reasons = Object.entries(skipped).map(([reason, count]) => `${count} 项${reason}`).join("，");
  if (moved === 0) return { tone: "warning", text: `没有移动：跳过 ${total} 项（${reasons}）。` };
  return { tone: total === 0 ? "ok" : "warning", text: `已移到「${target}」${moved} 项${total === 0 ? "" : `，跳过 ${total} 项（${reasons}）`}。` };
};

/** The item after `number` in the note's order, or null at the end. */
const successorOf = (list: TodoListView, number: number): number | null => {
  const at = list.items.findIndex((item) => item.number === number);
  return list.items[at + 1]?.number ?? null;
};

/**
 * 待办: the lists agents saved from an investigation the reader asked for, and the reader's own, worked through one
 * item at a time. On the left the views across all lists (今天, 即将到期, 全部未完成) and the lists; on the right the one
 * chosen; an item opens in a drawer beside it. Every change is made on the status the page showed, and kept as history.
 */
export const TodoPanel = ({ api, todoRevision, organization }: TodoPanelProps) => {
  const idPrefix = useId();
  const [query, setQuery] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A view across the lists in place of a list; 今天 on opening.
  const [view, setView] = useState<string | null>("today");
  const [today, setToday] = useState(() => localDay(new Date()));
  const [sort, setSort] = useState<ItemSort>("manual");
  const [drawer, setDrawer] = useState<{ listId: string; number: number } | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Partial<Record<string, NoteDraft>>>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // Keyed by an item, `add:<list>` or `list:<list>`: said where it happened.
  const [messages, setMessages] = useState<Readonly<Partial<Record<string, TodoMessage>>>>({});
  const [addDrafts, setAddDrafts] = useState<Readonly<Partial<Record<string, string>>>>({});
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const [creating, setCreating] = useState(false);
  const [quickAdd, setQuickAdd] = useState<{ initialText: string } | null>(null);
  // Picked for a batch: item keys, across lists in a view.
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  // 在本清单中筛选: only what is shown is filtered.
  const [filter, setFilter] = useState("");
  // How many a group shows, by pane and group; SEGMENT when not set.
  const [limits, setLimits] = useState<Readonly<Partial<Record<string, number>>>>({});
  const [deleting, setDeleting] = useState<ViewEntry[] | null>(null);
  const [deletingList, setDeletingList] = useState<TodoListView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The menu (status or priority) open on a row, by its key; the keys E and P open them from the row in focus.
  const [rowMenu, setRowMenu] = useState<{ key: string; menu: RowMenu } | null>(null);
  const [moving, setMoving] = useState<ViewEntry[] | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ listId: string; draft: string } | null>(null);
  const [dragging, setDragging] = useState<{ listId: string; number: number } | null>(null);
  const [dropAt, setDropAt] = useState<{ number: number; side: DropSide } | null>(null);
  // Lists whose 已处理 items are unfolded: each kept as the reader left it while the page is open.
  const [handledShown, setHandledShown] = useState<ReadonlySet<string>>(() => new Set());
  // Said to a screen reader in passing: what was saved, copied or created.
  const [announcement, setAnnouncement] = useState("");
  // 整理面板：打开过就一直挂着（藏起来），没保存的编辑和选中的建议不会因为切回清单而丢。
  const [organizing, setOrganizing] = useState<"closed" | "open" | "hidden">("closed");

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useSlashToFocus(searchRef);

  // What the next read is for, as the reader has it now: read by a read that a write or a revision starts.
  const reading = useRef({ query, includeClosed });
  reading.current = { query, includeClosed };
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const selected = useRef<string | null>(null);
  const generation = useRef(0);
  // The newest read whose answer is on the page: an answer older than it is dropped, a newer one (even before the
  // latest read ends) is shown. Showing only the latest read's starved the page while writes kept coming faster than a read.
  const applied = useRef(0);
  const busyKeys = useRef(new Set<string>());
  // Where focus goes once the page has settled: the control first, else the first of these still there.
  const focusAfter = useRef<{ control: Element | null; selectors: string[] } | null>(null);
  // A list just made empty in the dialog: its add field takes focus once the list is in view.
  const focusAddOf = useRef<string | null>(null);
  /*
   * The items of the list in view that were already done or dropped when it was opened, and have stayed so: what a
   * list folds away under 已处理. One finished while the list is in view keeps its place until the reader moves on to
   * another list: nothing slides out from under the box just clicked, and focus stays on it. One opened again goes back
   * among the unfinished.
   */
  // The keys of the rows on screen in their order (shift-click picks between two of them), and all of the pane's.
  const visibleKeys = useRef<string[]>([]);
  const paneKeys = useRef<string[]>([]);
  const anchor = useRef<string | null>(null);
  const foldBasis = useRef<{ listId: string; numbers: Set<number> } | null>(null);

  const select = (id: string | null): void => {
    selected.current = id;
    setSelectedId(id);
    setView(null);
    setDrawer(null);
    clearSelection();
    setFilter("");
  };

  const clearSelection = (): void => {
    anchor.current = null;
    setSelection((current) => (current.size === 0 ? current : new Set()));
  };

  const load = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    const words = reading.current.query.trim().slice(0, 200);
    const closed = reading.current.includeClosed;
    setLoading(true);
    try {
      const response = await api.listTodoLists({
        includeClosed: closed,
        limit: TODO_LIMITS.page,
        ...(words.length === 0 ? {} : { query: words }),
      });
      const previous = shownRef.current;
      const current = selected.current;
      let lists = response.lists;
      // The list in view, taken out by a change (its last item finished, or made one-off with every item handled, while
      // 未完成 is shown) rather than by the reader's search or range: kept in its place until they move on, not
      // replaced by the next one under them.
      if (
        current !== null &&
        previous !== null &&
        previous.words === words &&
        previous.includeClosed === closed &&
        !lists.some((list) => list.id === current)
      ) {
        const kept = (await api.listTodoLists({ listId: current, includeClosed: true, limit: 1 })).lists[0];
        if (kept !== undefined) {
          const at = Math.max(0, previous.lists.findIndex((list) => list.id === current));
          lists = [...lists.slice(0, at), kept, ...lists.slice(at)];
        }
      }
      const anyList =
        lists.length > 0 ||
        response.total > 0 ||
        (words.length === 0 && !closed && (await api.listTodoLists({ includeClosed: true, limit: 1 })).total > 0);
      // The views and the header count every list still being worked on, not those a search or the range found.
      const working = words.length === 0 && !closed ? response.lists : (await api.listTodoLists({ limit: TODO_LIMITS.page })).lists;
      if (token < applied.current) return;
      applied.current = token;
      const chosen = current !== null && lists.some((list) => list.id === current) ? current : (lists[0]?.id ?? null);
      selected.current = chosen;
      setSelectedId(chosen);
      setToday(localDay(new Date()));
      setShown({
        lists,
        viewLists: working,
        total: response.total,
        unreadable: response.unreadable,
        anyList,
        unfinishedItems: working.reduce((sum, list) => sum + unfinished(list.counts), 0),
        words,
        includeClosed: closed,
      });
      setLoadError(null);
    } catch (caught) {
      if (token === generation.current) setLoadError(errorText(caught));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [api]);

  // On opening, and as the reader searches or changes the range.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 100);
    return () => clearTimeout(timer);
  }, [load, query, includeClosed]);
  // On every write (an agent's, Obsidian's, the page's own): at once, not after a pause that a window out of sight stretches.
  const readRevision = useRef(todoRevision);
  useEffect(() => {
    if (readRevision.current === todoRevision) return;
    readRevision.current = todoRevision;
    void load();
  }, [load, todoRevision]);
  // The window brought back (from another app, a hidden window): whatever changed meanwhile is read again.
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, [load]);
  // Kept mounted while a captured decision had the window: what was ticked meanwhile is read again.
  usePageShownAgain(() => void load());

  // What was picked and is gone (deleted, or moved out of the lists in view) is no longer picked.
  useEffect(() => {
    if (shown === null) return;
    const present = new Set([...shown.lists, ...shown.viewLists].flatMap((candidate) => candidate.items.map((item) => itemKeyOf(candidate.id, item.number))));
    setSelection((current) => {
      const kept = [...current].filter((key) => present.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [shown]);

  // The list in view is where a quick add from anywhere goes by default.
  useEffect(() => {
    setTodoViewContext(view === null ? selectedId : null);
    return () => setTodoViewContext(null);
  }, [view, selectedId]);

  // A copy's confirmation goes after a moment; a refused one stays until it is put away.
  useEffect(() => {
    if (copyState?.status !== "copied") return;
    const timer = setTimeout(() => setCopyState((current) => (current === copyState ? null : current)), 2500);
    return () => clearTimeout(timer);
  }, [copyState]);

  // A control disabled while its change was saved, or taken away by it (the drawer's note field once saved), left focus
  // on the page: it goes back to the control, or else to the item it acted on.
  useLayoutEffect(() => {
    const pending = focusAfter.current;
    if (pending === null || busyKeys.current.size > 0) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const usable = (element: Element | null | undefined): element is HTMLElement =>
      element instanceof HTMLElement && element.isConnected && !element.matches(":disabled");
    const target = [pending.control, ...pending.selectors.map((selector) => document.querySelector(selector))].find(usable);
    target?.focus();
  }, [busy, shown, drafts, drawer]);

  // A list made empty is made to be added to: once it is in view, its add field takes focus from where the dialog left
  // it. Run after the dialog's own cleanup has handed focus back to what opened it (a passive effect, as that is). A
  // list chosen in the lists pane is left alone: the arrow keys there move through the lists.
  useEffect(() => {
    const listId = focusAddOf.current;
    if (listId === null) return;
    if (selectedId !== listId || view !== null) {
      focusAddOf.current = null;
      return;
    }
    const field = document.querySelector(focusSelector(`add:${listId}:field`));
    if (!(field instanceof HTMLInputElement) || field.disabled) return;
    focusAddOf.current = null;
    field.focus();
  }, [shown, selectedId, view]);

  /** One write at a time per thing written to; its controls are disabled meanwhile. */
  const write = async (key: string, fallbackFocus: string, work: () => Promise<void>): Promise<void> => {
    if (busyKeys.current.has(key)) return;
    busyKeys.current.add(key);
    setBusy(new Set(busyKeys.current));
    const control = document.activeElement;
    try {
      await work();
    } finally {
      busyKeys.current.delete(key);
      focusAfter.current = { control, selectors: [focusSelector(fallbackFocus)] };
      setBusy(new Set(busyKeys.current));
    }
  };

  const patchList = (listId: string, change: (list: TodoListView) => TodoListView): void =>
    setShown((current) =>
      current === null
        ? current
        : {
            ...current,
            lists: current.lists.map((list) => (list.id === listId ? change(list) : list)),
            viewLists: current.viewLists.map((list) => (list.id === listId ? change(list) : list)),
          },
    );

  /** The item as the write left it, shown before the lists are read again. */
  const patchItem = (listId: string, item: TodoItemView, summary: TodoListSummary | null): void =>
    patchList(listId, (list) =>
      summarized({ ...list, items: list.items.map((candidate) => (candidate.number === item.number ? item : candidate)) }, summary),
    );

  const say = (key: string, message: TodoMessage | null): void =>
    setMessages((current) => (message === null ? without(current, key) : { ...current, [key]: message }));

  const changeItem = (list: TodoListView, item: TodoItemView, patch: ItemPatch, expected: TodoItemStatus = item.status, done?: (saved: boolean) => void): void => {
    const key = itemKeyOf(list.id, item.number);
    void write(key, key, async () => {
      say(key, null);
      say(`list:${list.id}`, null);
      try {
        const result = await api.changeTodoItem({
          listId: list.id,
          item: item.number,
          // Made only on the status the page showed: moved on meanwhile (an agent, Obsidian), nothing is written.
          expectedStatus: expected,
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.note === undefined ? {} : { note: patch.note }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority, expectedPriority: item.priority }),
          ...(patch.due === undefined ? {} : { due: patch.due, expectedDue: item.due }),
          ...(patch.tags === undefined ? {} : { tags: patch.tags, expectedTags: item.tags }),
          ...(patch.detail === undefined ? {} : { detail: patch.detail }),
          ...(patch.expectedDetail === undefined ? {} : { expectedDetail: patch.expectedDetail }),
          ...(patch.disposition === undefined ? {} : { disposition: patch.disposition }),
          ...(patch.expectedDisposition === undefined ? {} : { expectedDisposition: patch.expectedDisposition }),
        });
        done?.(result.status === "saved" || result.status === "unchanged");
        if (result.item !== null) patchItem(list.id, result.item, result.list);
        if (result.status === "saved" || result.status === "unchanged") {
          setDrafts((current) => (patch.note === undefined ? current : without(current, key)));
          const text =
            result.status === "unchanged"
              ? `第 ${item.number} 项没有变化。`
              : patch.status !== undefined && patch.status !== expected
                ? `第 ${item.number} 项已标为「${statusLabel(patch.status)}」。`
                : patch.note !== undefined
                  ? `已给第 ${item.number} 项添加说明。`
                  : patch.disposition !== undefined
                    ? `已更新第 ${item.number} 项的处置备注。`
                  : `已更新第 ${item.number} 项。`;
          setAnnouncement(text);
          if (result.status === "unchanged") say(key, { tone: "note", text });
        } else if (result.status === "status_changed" && patch.detail !== undefined && result.item !== null && result.item.detail !== (patch.expectedDetail ?? null)) {
          say(key, { tone: "warning", text: "补充说明已在别处改过，这次的修改没有保存；你写的内容还留在编辑框里，看过最新内容后可以再保存。" });
        } else if (result.status === "status_changed" && patch.disposition !== undefined && result.item !== null && result.item.disposition !== (patch.expectedDisposition ?? null)) {
          say(key, { tone: "warning", text: "处置备注已在别处改过，这次的修改没有保存；你写的内容还留在输入框里，看过最新内容后可以再保存。" });
        } else if (result.status === "status_changed") {
          // Told now: the note being written is kept, and a confirm from here on is made on the status just shown.
          const now = result.item?.status;
          if (now !== undefined) {
            setDrafts((current) => {
              const open = current[key];
              return open === undefined ? current : { ...current, [key]: { ...open, basis: now } };
            });
          }
          say(key, {
            tone: "warning",
            text: `第 ${item.number} 项在你看到之后被改过${
              result.item === null ? "" : `，现在是「${statusLabel(result.item.status)}」`
            }，这次的修改没有保存。看过最新状态后可以再操作。`,
          });
        } else if (result.status === "item_not_found") {
          say(key, { tone: "warning", text: `第 ${item.number} 项已经不在这份清单里，可能在 Obsidian 里删掉了。` });
        } else if (result.status === "list_not_found") {
          say(`list:${list.id}`, { tone: "warning", text: NOT_FOUND });
        } else {
          say(key, { tone: "warning", text: "这一项要写明说明才能保存。" });
        }
        await load();
      } catch (caught) {
        done?.(false);
        say(key, { tone: "error", text: `没有保存：${errorText(caught)}` });
      }
    });
  };

  /** The line typed under a list, or in the quick-add dialog's place: read by the same parser, added to the list. */
  const addItem = (list: TodoListView): void => {
    const draft = (addDrafts[list.id] ?? "").trim();
    const key = `add:${list.id}`;
    if (draft.length === 0) return;
    const parse = parseQuickAdd(draft, today);
    // Anything the parser would lift out (a day, a priority, a list) is shown first in the dialog, never taken silently.
    if (parse.tokens.length > 0) {
      setQuickAdd({ initialText: draft });
      return;
    }
    const target = list;
    const item = quickAddItem(parse);
    void write(key, `${key}:field`, async () => {
      say(key, null);
      try {
        const result = await api.recordTodoList({ listId: target.id, items: [item] });
        const same = result.skipped[0];
        // Done before in a one-off list (a long-term one takes the title again): doing it again is opening that one.
        const sameStatus = same === undefined ? undefined : target.items.find((candidate) => candidate.number === same.number)?.status;
        // A full long-term list lets its oldest handled items go to make room: said, as they are gone from the page.
        const removed = result.removed ?? [];
        const addedText = `已添加${target === list ? "" : `到「${target.title}」`}为第 ${result.added[0]?.number ?? target.items.length + 1} 项。`;
        const message: TodoMessage =
          result.status === "appended"
            ? removed.length === 0
              ? { tone: "ok", text: addedText }
              : {
                  tone: "note",
                  text: `${addedText}清单已满 ${TODO_LIMITS.itemsPerList} 项，移走了最早处理完的 ${removed.length} 项：${removed
                    .map((entry) => `第 ${entry.number} 项「${entry.title}」`)
                    .join("、")}。`,
                }
            : result.status === "duplicate"
              ? {
                  tone: "warning",
                  text: same === undefined
                    ? "这份清单里已经有这一项，没有重复添加。"
                    : sameStatus === undefined || todoItemPending(sameStatus)
                      ? `这份清单里已经有「${same.title}」（第 ${same.number} 项），没有重复添加。`
                      : `这份清单里已经有「${same.title}」（第 ${same.number} 项，${statusLabel(sameStatus)}），没有重复添加；要再做一次，可以把它重新打开。`,
                }
              : result.status === "list_full"
                ? { tone: "warning", text: `一份清单最多 ${TODO_LIMITS.itemsPerList} 项，这份已经满了，可以另建一份清单。` }
                : { tone: "warning", text: NOT_FOUND };
        if (result.status === "appended") {
          setAddDrafts((current) => ({ ...current, [list.id]: "" }));
          setAnnouncement(message.text);
        }
        say(key, message);
        await load();
      } catch (caught) {
        say(key, { tone: "error", text: `没有添加：${errorText(caught)}` });
      }
    });
  };

  /** A list's own settings: its 长期清单 setting, its title, archived. Saved at once, on the page's list as it stands. */
  const updateList = (list: TodoListView, settings: { longTerm?: boolean; title?: string; archived?: boolean }, done: string): void => {
    const key = `settings:${list.id}`;
    const messageKey = `list:${list.id}`;
    void write(key, key, async () => {
      say(messageKey, null);
      try {
        const result = await api.updateTodoList({ listId: list.id, ...settings });
        const summary = result.list;
        if (summary === null) {
          say(messageKey, { tone: "warning", text: NOT_FOUND });
        } else {
          patchList(list.id, (current) => summarized(current, summary));
          setAnnouncement(done);
          setRenaming(null);
        }
        await load();
      } catch (caught) {
        say(messageKey, { tone: "error", text: `没有保存：${errorText(caught)}` });
      }
    });
  };

  /** An item moved in the note's order: before another item, or to the end. */
  const moveItem = (list: TodoListView, number: number, before: number | null): void => {
    const key = `move:${list.id}`;
    const itemKey = itemKeyOf(list.id, number);
    void write(key, itemKey, async () => {
      say(`list:${list.id}`, null);
      try {
        const result = await api.moveTodoItem({ listId: list.id, item: number, before });
        if (result.status === "list_not_found") say(`list:${list.id}`, { tone: "warning", text: NOT_FOUND });
        else if (result.status === "item_not_found") say(`list:${list.id}`, { tone: "warning", text: "这一项已经不在这份清单里了，可能在 Obsidian 里改过，已重新读取。" });
        else if (result.status === "saved") setAnnouncement(`第 ${number} 项已移动。`);
        await load();
      } catch (caught) {
        say(`list:${list.id}`, { tone: "error", text: `没有移动：${errorText(caught)}` });
      }
    });
  };

  const entryOf = (key: string): ViewEntry | null => {
    const [listId = "", number = ""] = key.split("#");
    const owner = [...(shown?.lists ?? []), ...(shown?.viewLists ?? [])].find((candidate) => candidate.id === listId);
    const item = owner?.items.find((candidate) => candidate.number === Number(number));
    return owner === undefined || item === undefined ? null : { list: owner, item };
  };
  const picked = (): ViewEntry[] => [...selection].map(entryOf).filter((entry): entry is ViewEntry => entry !== null);

  /** An item's box: picked or not; with Shift, everything between the last one picked and this. */
  const check = (key: string, shift: boolean): void => {
    const keys = visibleKeys.current;
    const from = anchor.current === null ? -1 : keys.indexOf(anchor.current);
    const to = keys.indexOf(key);
    if (shift && from >= 0 && to >= 0) {
      const [low, high] = from < to ? [from, to] : [to, from];
      setSelection((current) => new Set([...current, ...keys.slice(low, high + 1)]));
    } else {
      setSelection((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    }
    anchor.current = key;
  };

  /** Each list's picked items changed in one write; what came of them said in one line. */
  const applyBatch = (patch: { status?: TodoItemStatus; priority?: TodoPriority | null; due?: string | null; addTag?: string; removeTag?: string }): void => {
    const entries = picked();
    if (entries.length === 0) return;
    void write("bulk", "bulk", async () => {
      say("bulk", null);
      let saved = 0;
      const skipped: Record<string, number> = {};
      const skip = (reason: string, count = 1): void => {
        skipped[reason] = (skipped[reason] ?? 0) + count;
      };
      try {
        for (const [listId, all] of byList(entries)) {
          // An item already holding the most tags is not given another (what Obsidian wrote beyond it is left as it is).
          const full = patch.addTag === undefined ? [] : all.filter(({ item }) => item.tags.length >= TODO_LIMITS.itemTags && !item.tags.some((tag) => lowerTag(tag) === lowerTag(patch.addTag!)));
          if (full.length > 0) skip(`已有 ${TODO_LIMITS.itemTags} 个标签`, full.length);
          const group = all.filter((entry) => !full.includes(entry));
          if (group.length === 0) continue;
          const result = await api.changeTodoItems({
            listId,
            changes: group.map(({ item }) => ({
              item: item.number,
              ...(patch.status === undefined ? {} : { status: patch.status }),
              ...(patch.priority === undefined ? {} : { priority: patch.priority, expectedPriority: item.priority }),
              ...(patch.due === undefined ? {} : { due: patch.due, expectedDue: item.due }),
              ...(patch.addTag === undefined ? {} : { tags: uniqueTodoTags([...item.tags, patch.addTag]), expectedTags: item.tags }),
              ...(patch.removeTag === undefined ? {} : { tags: item.tags.filter((tag) => lowerTag(tag) !== lowerTag(patch.removeTag!)), expectedTags: item.tags }),
              expectedStatus: item.status,
            })),
          });
          if (result.status === "list_not_found") skip(BATCH_REASONS.list_not_found, group.length);
          for (const entry of result.results) {
            if (entry.status === "saved") saved += 1;
            else skip(BATCH_REASONS[entry.status]);
          }
        }
        const message = batchSummary(saved, skipped);
        say("bulk", message);
        setAnnouncement(message.text);
        if (saved > 0) clearSelection();
      } catch (caught) {
        say("bulk", { tone: "error", text: `没有保存：${errorText(caught)}` });
      }
      await load();
    });
  };

  /** The items to delete, once the reader has said yes in the dialog. */
  const confirmDelete = async (): Promise<void> => {
    if (deleting === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    let saved = 0;
    const skipped: Record<string, number> = {};
    try {
      for (const [listId, group] of byList(deleting)) {
        const result = await api.deleteTodoItems({ listId, items: group.map(({ item }) => ({ item: item.number, expectedStatus: item.status })) });
        if (result.status === "list_not_found") skipped[BATCH_REASONS.list_not_found] = (skipped[BATCH_REASONS.list_not_found] ?? 0) + group.length;
        for (const entry of result.results) {
          if (entry.status === "saved") saved += 1;
          else skipped[BATCH_REASONS[entry.status]] = (skipped[BATCH_REASONS[entry.status]] ?? 0) + 1;
        }
      }
      const message = batchSummary(saved, skipped);
      const text = { ...message, text: `${message.text.replace("成功", "已删除")}` };
      say("bulk", text);
      setAnnouncement(text.text);
      setDeleting(null);
      if (drawer !== null && deleting.some((entry) => entry.list.id === drawer.listId && entry.item.number === drawer.number)) setDrawer(null);
      clearSelection();
      await load();
    } catch (caught) {
      setDeleteError(`没有删除：${errorText(caught)}`);
    } finally {
      setDeleteBusy(false);
    }
  };

  /** The picked items moved to another list, a list at a time; what came of them said in one line. */
  const moveEntries = async (entries: readonly ViewEntry[], target: TodoListView): Promise<void> => {
    setMoveBusy(true);
    setMoveError(null);
    let movedCount = 0;
    const skipped: Record<string, number> = {};
    const skip = (reason: string, count = 1): void => {
      skipped[reason] = (skipped[reason] ?? 0) + count;
    };
    try {
      for (const [listId, group] of byList(entries)) {
        if (listId === target.id) {
          skip("本来就在这份清单里", group.length);
          continue;
        }
        const result = await api.moveTodoItemsToList({
          fromListId: listId,
          toListId: target.id,
          items: group.map(({ item }) => ({ item: item.number, expectedStatus: item.status, expectedPriority: item.priority, expectedDue: item.due, expectedTags: item.tags })),
        });
        if (result.status === "list_not_found") skip("所在清单找不到了", group.length);
        else if (result.status === "target_not_found") skip("目标清单找不到了", group.length);
        else if (result.status === "target_full") skip(`目标清单已满 ${TODO_LIMITS.itemsPerList} 项`, group.length);
        else {
          for (const entry of result.results) {
            if (entry.status === "saved") movedCount += 1;
            else if (entry.status === "kept") skip("移动时被改过，两边各有一份");
            else skip(entry.status === "status_changed" ? "已被改过" : "已不在清单里");
          }
        }
      }
      const message = moveSummary(target.title, movedCount, skipped);
      say("bulk", message);
      setAnnouncement(message.text);
      setMoving(null);
      if (movedCount > 0) {
        clearSelection();
        if (drawer !== null && entries.some((entry) => entry.list.id === drawer.listId && entry.item.number === drawer.number)) setDrawer(null);
      }
      await load();
    } catch (caught) {
      // Written to the target but not taken out of the source: said as it is, and the page reads both lists again.
      setMoveError(errorText(caught));
      await load();
    } finally {
      setMoveBusy(false);
    }
  };

  const confirmDeleteList = async (): Promise<void> => {
    if (deletingList === null) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const result = await api.deleteTodoList({ listId: deletingList.id, title: deletingList.title });
      if (result.status === "deleted" || result.status === "list_not_found") {
        // Not there any more is said as that, not as moved to the wastebasket.
        const gone = result.status === "list_not_found";
        setAnnouncement(gone ? "这份清单已不存在，可能在 Obsidian 里移走了。" : `清单「${deletingList.title}」已移到废纸篓。`);
        if (gone) say("unreadable", { tone: "warning", text: "这份清单已不存在，可能在 Obsidian 里移走了。" });
        setDeletingList(null);
        setDrawer(null);
        clearSelection();
        setView("today");
        selected.current = null;
        setSelectedId(null);
        await load();
      } else {
        setDeleteError("清单名对不上，没有删除。");
      }
    } catch (caught) {
      // The wastebasket failed: said as it is, and the note stays where it was.
      setDeleteError(`没有删除，笔记还在原处：${errorText(caught)}`);
    } finally {
      setDeleteBusy(false);
    }
  };

  const copy = async (key: string, text: string, notice?: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState({ key, status: "copied", text, ...(notice === undefined ? {} : { notice }) });
      setAnnouncement(notice ?? "已复制，可以粘贴给 agent 了。");
    } catch {
      setCopyState({ key, status: "failed", text });
    }
  };

  /** The items asked for, as one prompt for an agent: those still to be handled, grouped by list. */
  const copyEntries = (key: string, entries: readonly ViewEntry[]): void => {
    const prompt = pickedPrompt(entries);
    if (prompt === null) {
      setCopyState(null);
      say("bulk", { tone: "note", text: "选中的事项都已处理，没有可复制的。" });
      return;
    }
    say("bulk", null);
    void copy(key, prompt.text, copiedNotice(prompt.count, prompt.skipped));
  };

  const openNote = (relativePath: string, messageKey: string): void => {
    say(messageKey, null);
    void api.openVaultDocument(relativePath).catch(() =>
      say(messageKey, { tone: "error", text: `没能在 Obsidian 中打开 ${relativePath}，笔记可能已移动或删除。` }),
    );
  };

  const recorded = (result: TodoRecordResult, empty: boolean): void => {
    setCreating(false);
    if (result.list === null) return;
    select(result.list.id);
    if (empty) focusAddOf.current = result.list.id;
    if (result.status === "duplicate") {
      // Made empty, the list found is the one of that name, whatever has been added to it since.
      const text = empty
        ? `已经有一份叫「${result.list.title}」的清单，已为你打开它。`
        : `已经有一份同样的清单「${result.list.title}」（标题和事项都一样），没有重复创建，已为你打开它。`;
      say(`list:${result.list.id}`, { tone: "note", text });
      setAnnouncement(text);
    } else {
      setAnnouncement(`已新建清单「${result.list.title}」。`);
    }
    void load();
  };

  const toggleHandled = (listId: string): void =>
    setHandledShown((current) => {
      const next = new Set(current);
      if (!next.delete(listId)) next.add(listId);
      return next;
    });

  const openDrawer = (listId: string, number: number): void =>
    setDrawer((current) => (current?.listId === listId && current.number === number ? null : { listId, number }));

  const closeDrawer = (): void => {
    if (drawer !== null) {
      focusAfter.current = { control: null, selectors: [focusSelector(itemKeyOf(drawer.listId, drawer.number))] };
    }
    setDrawer(null);
    // The focus effect runs on the next render, which this state change brings.
  };

  /** The items a key acts on: what is picked when the one in focus is among it, else the one in focus. */
  const targetsOf = (key: string): ViewEntry[] => {
    if (selection.has(key)) return picked();
    const entry = entryOf(key);
    return entry === null ? [] : [entry];
  };

  const focusRow = (key: string): void => {
    document.querySelector<HTMLElement>(focusSelector(key))?.focus();
  };

  /** The keys of the item list: arrows move focus, Shift extends the pick, Space picks, E P M ⌫ act on the item in focus. */
  const itemKeys = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.nativeEvent.isComposing || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("input:not([type=checkbox]), textarea, select, [contenteditable], [role=menu], [role=dialog], .todo-float") !== null) return;
    const row = target.closest<HTMLElement>("[data-todo-row]");
    const key = row?.dataset.todoRow;
    if (key === undefined) return;
    const keys = visibleKeys.current;
    const at = keys.indexOf(key);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = keys[Math.max(0, Math.min(keys.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next === undefined) return;
      event.preventDefault();
      if (event.shiftKey) {
        // Everything from where the pick began to the item reached.
        const from = anchor.current === null ? at : keys.indexOf(anchor.current);
        const to = keys.indexOf(next);
        const [low, high] = from < to ? [from, to] : [to, from];
        if (anchor.current === null) anchor.current = key;
        setSelection(new Set(keys.slice(low, high + 1)));
      }
      focusRow(next);
      return;
    }
    // On the box itself Space is the box's own; on anything else in the row it picks the item.
    if (event.key === " " && !(target instanceof HTMLInputElement)) {
      event.preventDefault();
      check(key, false);
    } else if ((event.key === "e" || event.key === "E") && !event.shiftKey) {
      event.preventDefault();
      setRowMenu({ key, menu: "status" });
    } else if ((event.key === "p" || event.key === "P") && !event.shiftKey) {
      event.preventDefault();
      setRowMenu({ key, menu: "priority" });
    } else if (event.key === "m" || event.key === "M") {
      event.preventDefault();
      const entries = targetsOf(key);
      if (entries.length > 0) {
        setMoveError(null);
        setMoving(entries);
      }
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      const entries = targetsOf(key);
      if (entries.length > 0) {
        setDeleteError(null);
        setDeleting(entries);
      }
    }
  };

  const moveInLists = (event: KeyboardEvent<HTMLUListElement>): void => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".todo-list-row")];
    if (!navigateList(event, rows, () => searchRef.current?.focus())) return;
    // As in the PR list: the list an arrow reaches is the one shown.
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && rows.includes(focused) && focused.dataset.listId !== undefined) {
      select(focused.dataset.listId);
    }
  };

  const allLists = shown?.lists ?? [];
  // 全部 holds the archived lists apart: shown on their own when asked for, left out otherwise.
  const lists = includeClosed ? allLists.filter((candidate) => candidate.archived === archivedOnly) : allLists;
  const archivedCount = allLists.filter((candidate) => candidate.archived).length;
  const list = view === null ? (allLists.find((candidate) => candidate.id === selectedId) ?? null) : null;
  const words = shown?.words ?? "";
  const listCopy = list !== null && copyState?.key === `list:${list.id}` ? copyState : null;
  const listMessage = list === null ? undefined : messages[`list:${list.id}`];
  const viewLists = shown?.viewLists ?? [];
  const tagsInUse = tagCounts(viewLists);
  const knownTags = tagsInUse.map((tag) => tag.name);

  // Taken as the list is opened, then only narrowed: an item seen unfinished since is not folded again while in view.
  if (list === null) {
    foldBasis.current = null;
  } else if (foldBasis.current?.listId !== list.id) {
    foldBasis.current = {
      listId: list.id,
      numbers: new Set(list.items.filter((item) => !todoItemPending(item.status)).map((item) => item.number)),
    };
  }
  for (const item of list?.items ?? []) {
    if (todoItemPending(item.status)) foldBasis.current?.numbers.delete(item.number);
  }

  const drawerList = drawer === null ? null : ([...allLists, ...viewLists].find((candidate) => candidate.id === drawer.listId) ?? null);
  const drawerItem = drawerList?.items.find((candidate) => candidate.number === drawer?.number) ?? null;

  // 整理的范围只来自此刻看到的：当前清单与勾选的事项；项目缺失就是缺失，不借别的清单的项目。
  const selectedKeys = [...selection].map((key) => `todo_item:${key}`);
  const selectedProjects = new Set([...selection].map((key) => viewLists.find((candidate) => key.startsWith(`${candidate.id}#`))?.project ?? null));
  const organizationProject: string | null = list !== null ? list.project : selectedProjects.size === 1 ? ([...selectedProjects][0] ?? null) : null;
  const organizationContext: OrganizationContext = {
    project: organizationProject,
    projects: [...new Set(viewLists.flatMap((candidate) => (candidate.project === null ? [] : [candidate.project])))],
    listId: list?.id ?? null,
    listTitle: list?.title ?? null,
    items: selectedKeys,
  };
  const readingListIds = viewLists.map((candidate) => candidate.id);
  const readingLayer = useTodoAnnotations(organization?.api, readingListIds, (organization?.revision ?? 0) + todoRevision);

  const visible: string[] = [];
  visibleKeys.current = visible;
  const paneId = view ?? list?.id ?? "";
  const limitOf = (groupKey: string): number => limits[`${paneId}:${groupKey}`] ?? SEGMENT;
  /** The button under a group that has more than it shows. */
  const moreButton = (groupKey: string, total: number) => {
    const limit = limitOf(groupKey);
    return total <= limit ? null : (
      <button type="button" className="todo-more" onClick={() => setLimits((current) => ({ ...current, [`${paneId}:${groupKey}`]: limit + SEGMENT }))}>
        再显示 {SEGMENT} 项（还有 {total - limit} 项）
      </button>
    );
  };

  const rowFor = (entry: ViewEntry, options: { showList: boolean; group?: readonly TodoItemView[] }) => {
    const { list: owner, item } = entry;
    const key = itemKeyOf(owner.id, item.number);
    const group = options.group;
    const at = group === undefined ? -1 : group.findIndex((candidate) => candidate.number === item.number);
    const reorderable = group !== undefined && sort === "manual";
    visible.push(key);
    const droppedOn = dropAt?.number === item.number && dragging?.listId === owner.id ? dropAt.side : null;
    return (
      <TodoItemRow
        key={key}
        list={owner}
        item={item}
        idPrefix={`${idPrefix}-${owner.id}`}
        itemKey={key}
        today={today}
        busy={busy.has(key)}
        selected={drawer?.listId === owner.id && drawer.number === item.number}
        checked={selection.has(key)}
        showList={options.showList}
        reorderable={reorderable}
        dropSide={droppedOn}
        message={messages[key] ?? null}
        menu={rowMenu?.key === key ? rowMenu.menu : null}
        onMenu={(menu) => setRowMenu(menu === null ? null : { key, menu })}
        onSetPriority={(priority) => changeItem(owner, item, { priority })}
        onMoveToList={() => {
          setMoveError(null);
          setMoving(targetsOf(key).length > 0 && selection.has(key) ? targetsOf(key) : [{ list: owner, item }]);
        }}
        onCopy={() => copyEntries("bulk", [{ list: owner, item }])}
        onOpen={() => openDrawer(owner.id, item.number)}
        onCheck={(shift) => check(key, shift)}
        onSetStatus={(status) => changeItem(owner, item, { status })}
        onDelete={() => {
          setDeleteError(null);
          setDeleting([{ list: owner, item }]);
        }}
        {...(reorderable
          ? {
              onMove: (direction: -1 | 1) => {
                const neighbour = group[at + direction];
                if (neighbour === undefined) return;
                moveItem(owner, item.number, direction === -1 ? neighbour.number : successorOf(owner, neighbour.number));
              },
              onDragStart: () => setDragging({ listId: owner.id, number: item.number }),
              onDragOver: (side: DropSide) => setDropAt((current) => (current?.number === item.number && current.side === side ? current : { number: item.number, side })),
              onDrop: (side: DropSide) => {
                const from = dragging;
                setDragging(null);
                setDropAt(null);
                if (from === null || from.listId !== owner.id || from.number === item.number) return;
                moveItem(owner, from.number, side === "before" ? item.number : successorOf(owner, item.number));
              },
              onDragEnd: () => {
                setDragging(null);
                setDropAt(null);
              },
            }
          : {})}
      />
    );
  };

  const emptyState = (() => {
    if (shown === null || lists.length > 0) return null;
    if (words.length > 0) {
      return (
        <div className="todo-empty">
          <h2>没有找到匹配「{words}」的清单</h2>
          <p>{shown.includeClosed ? "换个关键词试试。" : "换个关键词，或者到「全部」里找找已经处理完的清单。"}</p>
          <div className="todo-empty-actions">
            <button type="button" className="secondary-button" onClick={() => setQuery("")}>清除搜索</button>
            {shown.includeClosed ? null : (
              <button type="button" className="secondary-button" onClick={() => setIncludeClosed(true)}>查看全部</button>
            )}
          </div>
        </div>
      );
    }
    if (!shown.includeClosed && shown.anyList) {
      return (
        <div className="todo-empty">
          <ChecklistGlyph />
          <h2>没有未完成的清单</h2>
          <p>每份清单里的事项都已完成或放弃。</p>
          <div className="todo-empty-actions">
            <button type="button" className="secondary-button" onClick={() => setIncludeClosed(true)}>查看全部</button>
          </div>
        </div>
      );
    }
    if (shown.includeClosed && archivedOnly) {
      return (
        <div className="todo-empty">
          <ChecklistGlyph />
          <h2>没有归档的清单</h2>
          <p>在清单页头的「更多」里可以归档一份清单；归档后它不再出现在视图和「未完成」里。</p>
        </div>
      );
    }
    return (
      <div className="todo-empty">
        <ChecklistGlyph />
        <h2>还没有待办清单</h2>
        <p>
          让 {agentNames(knownClients().map((client) => client.name))} 调研或排查之后，把结果存成 Paraself 待办，清单就会出现在这里，由你逐项处理。比如对它说：「把这次发现的问题存成 Paraself 待办」。
        </p>
        <p className="todo-empty-tools">
          agent 用 <code>record_todo_list</code> 存清单，用 <code>list_todo_lists</code> 读取，用 <code>update_todo_item</code>{" "}
          更新每一项的进度。清单也是 Obsidian 里 Decision Journal/todos 下的笔记，在那里勾选同样算数。
        </p>
        <div className="todo-empty-actions">
          <button type="button" className="secondary-button" onClick={() => setCreating(true)}>新建清单</button>
        </div>
      </div>
    );
  })();

  const bulkMessage = messages.bulk;
  const bulkCopy = copyState?.key === "bulk" ? copyState : null;
  const batchBar =
    selection.size === 0 ? null : (
      <TodoBatchBar
        count={selection.size}
        busy={busy.has("bulk")}
        onCopy={() => copyEntries("bulk", picked())}
        onComplete={() => applyBatch({ status: "done" })}
        onStart={() => applyBatch({ status: "in_progress" })}
        onPriority={(priority) => applyBatch({ priority })}
        onDue={(due) => applyBatch({ due })}
        onDelete={() => {
          setDeleteError(null);
          setDeleting(picked());
        }}
        onClear={clearSelection}
        onMove={() => {
          setMoveError(null);
          setMoving(picked());
        }}
        onAddTag={(tag) => applyBatch({ addTag: tag })}
        onRemoveTag={(tag) => applyBatch({ removeTag: tag })}
        tagsOnChosen={uniqueTodoTags(picked().flatMap((entry) => entry.item.tags))}
        knownTags={knownTags}
      />
    );

  // Over the top of the items (the counts and filter row), out of the flow: it comes and goes without moving anything.
  const floating =
    batchBar === null && bulkMessage === undefined && bulkCopy === null ? null : (
      <div className="todo-float">
        <div className="todo-float-stack">
          {batchBar}
          {bulkCopy?.status === "copied" && bulkCopy.notice !== undefined ? <TodoMessageLine message={{ tone: "ok", text: bulkCopy.notice }} className="todo-float-message" /> : null}
          {bulkCopy?.status === "failed" ? <CopyFallbackBlock text={bulkCopy.text} onClose={() => setCopyState(null)} /> : null}
          {bulkMessage === undefined ? null : <TodoMessageLine message={bulkMessage} className="todo-float-message" />}
        </div>
      </div>
    );

  /** 今天, 即将到期 or 全部未完成: the items of every list still being worked on, grouped. */
  const viewPane = (() => {
    if (view === null) return null;
    const groups = viewGroups(view, viewLists, today);
    const count = groupCount(groups);
    paneKeys.current = groups.flatMap((group) => group.entries.map((entry) => itemKeyOf(entry.list.id, entry.item.number)));
    const tagName = tagOfView(view);
    const empty: Record<TodoViewId, string> = {
      today: "今天没有要处理的事项。已逾期、今天到期和处理中的事项会出现在这里。",
      upcoming: "未来 7 天没有到期的事项。给事项设上截止日期后，会按日期出现在这里。",
      all: "所有清单里的事项都处理完了。",
    };
    const emptyText = tagName !== null ? `没有带 #${tagName} 的未完成事项。` : empty[view as TodoViewId];
    return (
      <>
        <header className="todo-detail-head">
          <div className="todo-detail-heading">
            <p className="todo-detail-meta-line">
              <MetaParts className="todo-meta todo-detail-meta" parts={[view === "today" ? dayHeading(today, today) : null, `${count} 项`]} />
            </p>
            <h2>{viewTitle(view)}</h2>
          </div>
          <div className="todo-detail-actions">
          </div>
        </header>
        {floating}
        <div className="todo-detail-body">
          {count === 0 ? (
            <p className="todo-items-empty">{emptyText}</p>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="todo-group" aria-label={`${group.title}，${group.entries.length} 项`}>
                <h3 className="todo-group-title" data-group={group.key}>
                  {group.title}<span>{group.entries.length}</span>
                </h3>
                <ol className="todo-items" aria-label={group.title}>
                  {group.entries.slice(0, limitOf(group.key)).map((entry) => rowFor(entry, { showList: view !== "all" && tagName === null }))}
                </ol>
                {moreButton(group.key, group.entries.length)}
              </section>
            ))
          )}
          {count === 0 ? null : <ShortcutHints />}
        </div>
      </>
    );
  })();

  const detail = (() => {
    if (shown === null) return null;
    // With no list at all there is nothing for a view to gather: the page says where lists come from.
    if (view !== null && !(words.length === 0 && !shown.anyList)) return viewPane;
    if (list === null || view !== null) return emptyState;
    const counts = list.counts;
    const total = itemTotal(counts);
    const addKey = `add:${list.id}`;
    const adding = busy.has(addKey);
    const addDraft = addDrafts[list.id] ?? "";
    const addMessage = messages[addKey];
    const settingsKey = `settings:${list.id}`;
    const foldedNumbers = foldBasis.current?.numbers;
    // The filter only narrows what is shown (title, detail and tags); the list itself is untouched.
    const needle = fold(filter.trim());
    const matching = needle.length === 0 ? list.items : list.items.filter((item) => fold(`${item.title}\n${item.detail ?? ""}\n${item.tags.map((tag) => `#${tag}`).join(" ")} ${item.tags.join(" ")}`).includes(needle));
    paneKeys.current = matching.map((item) => itemKeyOf(list.id, item.number));
    const folded = matching.filter((item) => foldedNumbers?.has(item.number) === true);
    const inView = matching.filter((item) => foldedNumbers?.has(item.number) !== true);
    const working = sortedItems(inView.filter((item) => item.status === "in_progress"), sort);
    const waiting = sortedItems(inView.filter((item) => item.status !== "in_progress"), sort);
    // A filter shows the handled ones that match, unfolded.
    const foldedShown = handledShown.has(list.id) || needle.length > 0;
    const foldedId = `${idPrefix}-${list.id}-handled`;
    const entries = (items: readonly TodoItemView[], groupKey: string) =>
      items.slice(0, limitOf(groupKey)).map((item) => rowFor({ list, item }, { showList: false, group: items }));
    const group = (title: string, items: readonly TodoItemView[]) =>
      items.length === 0 ? null : (
        <section className="todo-group" aria-label={`${title}，${items.length} 项`}>
          <h3 className="todo-group-title">{title}<span>{items.length}</span></h3>
          <ol className="todo-items" aria-label={title}>{entries(items, title)}</ol>
          {moreButton(title, items.length)}
        </section>
      );
    return (
      <>
        <header className="todo-detail-head">
          <ProgressRing done={handled(counts)} total={total} />
          <div className="todo-detail-heading">
            <p className="todo-detail-meta-line">
              <MetaParts
                className="todo-meta todo-detail-meta"
                parts={[
                  list.project,
                  listSourceLabel(list),
                  list.longTerm ? "长期清单" : null,
                  list.archived ? "已归档" : null,
                  `创建于 ${momentLabel(list.createdAt)}`,
                  list.updatedAt === list.createdAt ? null : `更新于 ${relativeTime(list.updatedAt)}`,
                ]}
              />
            </p>
            {renaming?.listId === list.id ? (
              <form
                className="todo-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  const title = renaming.draft.trim();
                  if (title.length === 0) return;
                  if (title === list.title) setRenaming(null);
                  else updateList(list, { title }, `清单已改名为「${title}」。`);
                }}
              >
                <input
                  aria-label="清单名"
                  autoFocus
                  maxLength={TODO_LIMITS.title}
                  value={renaming.draft}
                  disabled={busy.has(settingsKey)}
                  onChange={(event) => setRenaming({ listId: list.id, draft: event.currentTarget.value })}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(null);
                  }}
                />
                <button type="submit" className="secondary-button" disabled={busy.has(settingsKey) || renaming.draft.trim().length === 0}>保存</button>
                <button type="button" className="text-button" onClick={() => setRenaming(null)}>取消</button>
              </form>
            ) : (
              <h2 id={`${idPrefix}-list-title`}>{list.title}</h2>
            )}
          </div>
          <div className="todo-detail-actions">
            {listCopy?.status === "copied" ? <span className="todo-copy-notice" aria-hidden="true">已复制</span> : null}
            {unfinished(counts) === 0 ? null : (
              <button type="button" className="secondary-button" onClick={() => void copy(`list:${list.id}`, listPrompt(list))}>
                <ActionIcon name="copy" />复制给 agent
              </button>
            )}
            <button type="button" className="secondary-button" onClick={() => openNote(list.relativePath, `list:${list.id}`)}>
              <ActionIcon name="open" />在 Obsidian 中打开
            </button>
            <TodoListMenu
              busy={busy.has(settingsKey)}
              entries={[
                { label: "改清单名", onSelect: () => setRenaming({ listId: list.id, draft: list.title }) },
                {
                  label: "长期清单",
                  checked: list.longTerm,
                  onSelect: () => updateList(list, { longTerm: !list.longTerm }, list.longTerm ? `「${list.title}」已改为一次性清单。` : `「${list.title}」已设为长期清单。`),
                },
                {
                  label: list.archived ? "取消归档" : "归档",
                  onSelect: () => updateList(list, { archived: !list.archived }, list.archived ? `「${list.title}」已取消归档。` : `「${list.title}」已归档。`),
                },
                {
                  label: "删除清单",
                  onSelect: () => {
                    setDeleteError(null);
                    setDeletingList(list);
                  },
                },
              ]}
            />
          </div>
        </header>
        {floating}
        <div className="todo-detail-body">
          {listMessage === undefined ? null : <TodoMessageLine message={listMessage} />}
          {listCopy?.status === "failed" ? <CopyFallbackBlock text={listCopy.text} onClose={() => setCopyState(null)} /> : null}
          {list.archived ? (
            <p className="todo-detail-closed" data-kind="archived">
              这份清单已归档，不在视图和「未完成」里。<button type="button" className="text-button" onClick={() => updateList(list, { archived: false }, `「${list.title}」已取消归档。`)}>取消归档</button>
            </p>
          ) : null}
          {/* Only a one-off list is put away: a long-term one, or one with nothing in it yet, stays with the unfinished. */}
          {!list.archived && !shown?.includeClosed && !todoListPending(list) ? (
            <p className="todo-detail-closed">这份清单的事项都处理完了。切到别的清单后，它会收进「全部」里。</p>
          ) : null}
          {list.summary === null ? null : <p className="todo-summary">{list.summary}</p>}
          {total === 0 ? null : (
            <div className="todo-detail-bar">
              <p className="todo-detail-counts">
                <strong>已处理 {handled(counts)}/{total}</strong>
                {countsText(counts).length === 0 ? null : <span>{countsText(counts)}</span>}
              </p>
              <input
                type="search"
                className="todo-filter-input"
                aria-label="在本清单中筛选"
                placeholder="在本清单中筛选"
                maxLength={200}
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
              <div className="todo-sort" role="group" aria-label="事项排序">
                {(["manual", "priority", "due"] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={sort === option} onClick={() => setSort(option)}>{SORT_LABELS[option]}</button>
                ))}
              </div>
            </div>
          )}
          {total === 0 ? (
            <p className="todo-items-empty">还没有事项，在下面添加第一项。</p>
          ) : inView.length === 0 ? (
            <p className="todo-items-empty">事项都处理完了，有新的随时在下面添加。</p>
          ) : (
            <>
              {group("处理中", working)}
              {group("待处理", waiting)}
            </>
          )}
          <form
            className="todo-add"
            onSubmit={(event) => {
              event.preventDefault();
              addItem(list);
            }}
          >
            <input
              aria-label="添加事项"
              placeholder="添加一项，回车保存，如：明天 !p1 写周报"
              maxLength={TODO_LIMITS.itemTitle + 40}
              data-todo-focus={`${addKey}:field`}
              value={addDraft}
              disabled={adding}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setAddDrafts((current) => ({ ...current, [list.id]: value }));
              }}
            />
            <button type="submit" className="secondary-button" disabled={adding || addDraft.trim().length === 0}>
              {adding ? "正在添加…" : "添加"}
            </button>
          </form>
          {addMessage === undefined ? null : <TodoMessageLine message={addMessage} className="todo-add-message" />}
          {inView.length === 0 ? null : <ShortcutHints />}
          {/* After the add field, which stays by the unfinished items however many are folded here. */}
          {folded.length === 0 ? null : (
            <div className="todo-handled">
              <button
                type="button"
                className="todo-handled-toggle"
                aria-expanded={foldedShown}
                aria-controls={foldedId}
                onClick={() => toggleHandled(list.id)}
              >
                <Chevron />已处理 {folded.length} 项
              </button>
              {foldedShown ? (
                <ol id={foldedId} className="todo-items" aria-label="已处理的事项">{entries(sortedItems(folded, sort), "handled")}</ol>
              ) : null}
              {foldedShown ? moreButton("handled", folded.length) : null}
            </div>
          )}
        </div>
      </>
    );
  })();

  const drawerKey = drawer === null ? "" : itemKeyOf(drawer.listId, drawer.number);
  const drawerCopy = copyState?.key === drawerKey ? copyState : null;
  const drawerNode =
    drawer === null || drawerList === null || drawerItem === null ? null : (
      <TodoItemDrawer
        list={drawerList}
        item={drawerItem}
        itemKey={drawerKey}
        today={today}
        busy={busy.has(drawerKey)}
        draft={drafts[drawerKey] ?? null}
        message={messages[drawerKey] ?? null}
        copy={drawerCopy === null ? null : { status: drawerCopy.status, text: drawerCopy.text }}
        onDraft={(next) => setDrafts((current) => (next === null ? without(current, drawerKey) : { ...current, [drawerKey]: next }))}
        onChange={(patch, expected, done) => changeItem(drawerList, drawerItem, patch, expected, done)}
        onCopy={() => void copy(drawerKey, itemPrompt(drawerList, drawerItem))}
        onCloseCopy={() => setCopyState(null)}
        onClose={closeDrawer}
        onDelete={() => {
          setDeleteError(null);
          setDeleting([{ list: drawerList, item: drawerItem }]);
        }}
        onMove={() => {
          setMoveError(null);
          setMoving([{ list: drawerList, item: drawerItem }]);
        }}
        knownTags={knownTags}
        dependencies={<TodoDependencySection key={drawerKey} api={api} list={drawerList} item={drawerItem} busy={busy.has(drawerKey)} onChanged={load}
          onOpen={(listId, number) => {
            select(listId);
            void load().then(() => setDrawer({ listId, number }));
          }} />}
        beforeStart={
          organization === undefined ? undefined : (
            <BeforeStart api={organization.api} links={readingLayer.annotations?.beforeStart[`todo_item:${drawerKey}`] ?? []} onChanged={() => readingLayer.reload()} />
          )
        }
      />
    );

  const viewCounts = Object.fromEntries(VIEW_ORDER.map((id) => [id, groupCount(viewGroups(id, viewLists, today))])) as Record<TodoViewId, number>;

  return (
    <section
      className="todo-panel"
      role="region"
      aria-label="待办"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.defaultPrevented) return;
        // ⌘A in the items picks them all (the pane's, filter applied); in a field it is the field's.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && event.target instanceof Element) {
          if (event.target.closest("input, textarea, select, [contenteditable]") !== null || event.target.closest(".todo-detail") === null) return;
          event.preventDefault();
          setSelection(new Set(paneKeys.current));
          return;
        }
        // Escape puts the drawer away first, then lets go of what was picked; not when something inside took it.
        if (event.key !== "Escape") return;
        if (drawer !== null) {
          event.preventDefault();
          closeDrawer();
        } else if (selection.size > 0) {
          event.preventDefault();
          clearSelection();
        }
      }}
    >
      <header className="desktop-view-header drag-region">
        <div>
          <span>跟进</span>
          <h1>待办</h1>
          <p>agent 存下的调研结果和你记下的事项，在这里逐项处理。</p>
        </div>
        <div className="todo-header-actions no-drag">
          {shown === null && loadError === null ? null : (
            <div className="desktop-view-meta" title="所有清单里待处理和处理中的事项">
              <strong>{shown === null ? "—" : shown.unfinishedItems}</strong>
              <span>项未完成</span>
            </div>
          )}
          {organization === undefined ? null : (
            <button
              type="button"
              className="secondary-button todo-organize-button"
              aria-pressed={organizing === "open"}
              onClick={() => {
                setDrawer(null);
                setOrganizing((current) => (current === "open" ? "hidden" : "open"));
              }}
            >
              <ActionIcon name="star" />整理与记忆
              <span className="org-count" aria-label={`${organization.pending} 个问题需要判断`}>{organization.pending}</span>
            </button>
          )}
          <button type="button" className="secondary-button todo-add-button" onClick={() => setQuickAdd({ initialText: "" })}>
            <ActionIcon name="plus" />添加事项
          </button>
          <button type="button" className="primary-button todo-create-button" onClick={() => setCreating(true)}>
            <ActionIcon name="plus" />新建清单
          </button>
        </div>
      </header>

      {shown === null || shown.unreadable.length === 0 ? null : (
        <section className="todo-unreadable" aria-label="读不出的待办笔记">
          <p>
            有 {shown.unreadable.length} 篇待办笔记读不出来，其中的清单暂时不在这里；在 Obsidian 里改好后会自动回来。
          </p>
          <ul>
            {shown.unreadable.map((note) => (
              <li key={note.relativePath}>
                <button type="button" className="todo-note-link" title="在 Obsidian 中打开" onClick={() => openNote(note.relativePath, "unreadable")}>
                  {note.relativePath}
                </button>
                <span>{note.message}</span>
              </li>
            ))}
          </ul>
          {messages.unreadable === undefined ? null : <TodoMessageLine message={messages.unreadable} />}
        </section>
      )}

      <div className="todo-workspace" data-drawer={drawerNode === null ? undefined : "open"}>
        <aside id={`${idPrefix}-lists`} className="todo-sidebar" aria-label="待办清单">
          <div className="todo-list-controls">
            <div className="todo-search">
              <ActionIcon name="search" />
              <input
                ref={searchRef}
                type="search"
                aria-label="搜索待办清单"
                placeholder="搜索清单和事项"
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "ArrowDown") {
                    const target =
                      listRef.current?.querySelector<HTMLButtonElement>('.todo-list-row[aria-current="true"]') ??
                      listRef.current?.querySelector<HTMLButtonElement>(".todo-list-row");
                    if (target === null || target === undefined) return;
                    event.preventDefault();
                    target.focus();
                  } else if (isClearShortcut(event) && query.length > 0) {
                    event.preventDefault();
                    setQuery("");
                  }
                }}
              />
              {query.length > 0 ? null : <kbd aria-hidden="true" title="按 / 聚焦搜索">/</kbd>}
            </div>
            <div className="todo-filter" role="group" aria-label="清单范围">
              <button type="button" aria-pressed={!includeClosed} onClick={() => { setIncludeClosed(false); setArchivedOnly(false); }}>未完成</button>
              <button type="button" aria-pressed={includeClosed} onClick={() => setIncludeClosed(true)}>全部</button>
            </div>
            {includeClosed && (archivedCount > 0 || archivedOnly) ? (
              <button type="button" className="todo-archived-filter" aria-pressed={archivedOnly} onClick={() => setArchivedOnly((current) => !current)}>
                只看已归档{archivedCount > 0 ? ` · ${archivedCount}` : ""}
              </button>
            ) : null}
          </div>
          <div className="todo-list-scroll">
            {loadError === null ? null : (
              <p className="load-failure todo-load-failure" role="alert">
                <span>读取待办失败：{loadError}</span>
                <button type="button" className="secondary-button" disabled={loading} onClick={() => void load()}>重试</button>
              </p>
            )}
            {shown === null ? null : (
              <nav className="todo-views" aria-label="视图">
                {VIEW_ORDER.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="todo-view-row"
                    data-view={id}
                    aria-current={view === id ? "true" : undefined}
                    onClick={() => {
                      setView(id);
                      setDrawer(null);
                      clearSelection();
                    }}
                  >
                    <span>{VIEW_TITLES[id]}</span>
                    <span className="todo-view-count" data-alert={id === "today" && viewCounts.today > 0 ? "true" : undefined}>{viewCounts[id]}</span>
                  </button>
                ))}
              </nav>
            )}
            {shown === null || tagsInUse.length === 0 ? null : (
              <nav className="todo-views todo-tags" aria-label="标签">
                <h2 className="todo-sidebar-heading">标签</h2>
                {tagsInUse.map((tag) => (
                  <button
                    key={tag.name}
                    type="button"
                    className="todo-view-row"
                    data-view="tag"
                    data-tag={tag.name}
                    aria-current={view === tagViewOf(tag.name) ? "true" : undefined}
                    onClick={() => {
                      setView(tagViewOf(tag.name));
                      setDrawer(null);
                      clearSelection();
                    }}
                  >
                    <span><span className="todo-tag-hash" aria-hidden="true">#</span>{tag.name}</span>
                    <span className="todo-view-count">{tag.count}</span>
                  </button>
                ))}
              </nav>
            )}
            {shown === null ? (
              loadError === null ? <p className="todo-list-empty" role="status">正在读取待办…</p> : null
            ) : lists.length === 0 ? (
              <p className="todo-list-empty">
                {words.length > 0 ? "没有匹配的清单。" : archivedOnly ? "没有归档的清单。" : !shown.includeClosed && shown.anyList ? "没有未完成的清单。" : "还没有清单。"}
              </p>
            ) : (
              <>
                <h2 className="todo-sidebar-heading">清单</h2>
                <ul ref={listRef} className="todo-lists" aria-label="清单" onKeyDown={moveInLists}>
                  {lists.map((candidate) => {
                    const total = itemTotal(candidate.counts);
                    const share = (count: number) => `${total === 0 ? 0 : (count / total) * 100}%`;
                    // Closed as the App files lists away from 未完成: never a long-term one, nor one still empty.
                    const closed = !todoListPending(candidate);
                    const kindId = `${idPrefix}-kind-${candidate.id}`;
                    const metaId = `${idPrefix}-meta-${candidate.id}`;
                    const progressId = `${idPrefix}-progress-${candidate.id}`;
                    const waitingId = `${idPrefix}-waiting-${candidate.id}`;
                    const waiting = listDependencySummary(candidate);
                    return (
                      <li key={candidate.id}>
                        <button
                          type="button"
                          className="todo-list-row"
                          data-list-id={candidate.id}
                          data-closed={closed || undefined}
                          data-waiting={waiting.count || undefined}
                          title={waiting.count > 0 ? `${candidate.title}\n${waiting.description}` : candidate.title}
                          aria-label={candidate.title}
                          aria-describedby={`${candidate.longTerm ? `${kindId} ` : ""}${metaId} ${progressId}${waiting.count > 0 ? ` ${waitingId}` : ""}`}
                          aria-current={view === null && candidate.id === selectedId ? "true" : undefined}
                          onClick={() => select(candidate.id)}
                        >
                          <span className="todo-list-title">
                            <strong>{candidate.title}</strong>
                            {candidate.archived ? <span className="todo-list-badge">已归档</span> : null}
                            {candidate.longTerm ? (
                              <span className="todo-list-badge" id={kindId}>长期<span className="sr-only">清单</span></span>
                            ) : null}
                          </span>
                          <MetaParts
                            className="todo-meta todo-list-meta"
                            id={metaId}
                            parts={[candidate.project, listSourceLabel(candidate), relativeTime(candidate.updatedAt), candidate.counts.inProgress > 0 ? `处理中 ${candidate.counts.inProgress}` : closed ? "已处理完" : null]}
                          />
                          <span className="todo-list-progress" id={progressId}>
                            {total === 0 ? (
                              // Nothing in it yet: said in words, where an empty bar and 0/0 said nothing.
                              <span className="todo-progress-none">还没有事项</span>
                            ) : (
                              <>
                                <span className="todo-progress-bar" aria-hidden="true">
                                  <i data-part="done" style={{ width: share(candidate.counts.done) }} />
                                  <i data-part="dropped" style={{ width: share(candidate.counts.dropped) }} />
                                </span>
                                <span className="todo-progress-count">
                                  <span className="sr-only">已处理 </span>
                                  {handled(candidate.counts)}/{total}
                                </span>
                              </>
                            )}
                          </span>
                          {waiting.count > 0 ? <span className="sr-only" id={waitingId}>{waiting.description}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {shown !== null && shown.total > TODO_LIMITS.page ? (
              <p className="todo-list-empty">只显示最近的 {TODO_LIMITS.page} 份清单；更早的请用搜索查找。</p>
            ) : null}
          </div>
          <p className="todo-sidebar-foot">在 Obsidian 里勾选也会同步到这里</p>
        </aside>
        <ListWidthHandle storageKey="paraself.todos.list-width" label="调整清单列表宽度" controls={`${idPrefix}-lists`} />
        {organization === undefined || organizing === "closed" ? null : (
          <section className="todo-detail todo-organization" aria-label="整理" hidden={organizing === "hidden"}>
            <OrganizationPanel
              api={organization.api}
              organizationRevision={organization.revision}
              context={organizationContext}
              onClose={() => setOrganizing("hidden")}
              onChanged={() => { void load(); readingLayer.reload(); }}
              onOpenMethodology={organization.onOpenMethodology}
              onOpenTodoItem={(key) => {
                const parsed = parseTodoItemSourceKey(key);
                if (parsed === null) return;
                setOrganizing("hidden");
                select(parsed.listId);
                setDrawer({ listId: parsed.listId, number: parsed.item });
              }}
            />
          </section>
        )}
        <section
          hidden={organizing === "open"}
          className="todo-detail"
          aria-label={view !== null ? viewTitle(view) : list === null ? "清单内容" : `清单：${list.title}`}
          onKeyDown={itemKeys}
          onKeyUp={(event) => {
            // Space on an item picks it (see itemKeys): the click a button makes when it is let go is not wanted.
            if (event.key === " " && event.target instanceof Element && event.target.closest(".todo-item-toggle") !== null) event.preventDefault();
          }}
        >
          {organization === undefined || readingLayer.annotations === null ? null : (
            <TodoGroups
              api={organization.api}
              annotations={readingLayer.annotations}
              items={viewLists.flatMap((owner) => owner.items.map((item) => ({ listId: owner.id, listTitle: owner.title, number: item.number, title: item.title, status: item.status })))}
              onOpen={(listId, number) => { select(listId); setDrawer({ listId, number }); }}
              onChanged={() => { readingLayer.reload(); }}
            />
          )}
          {detail}
        </section>
        {organizing === "open" ? null : drawerNode}
      </div>
      <p className="sr-only" role="status">{announcement}</p>
      {deleting === null ? null : (
        <TodoDeleteDialog
          title={`删除 ${deleting.length} 项`}
          description="删除后事项从笔记里去掉，变更记录留在本机。这一步不能在这里撤销。"
          confirmLabel={`删除 ${deleting.length} 项`}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleting(null)}
        >
          <p>将删除{deleting.length === 1 ? "这一项" : `这 ${deleting.length} 项`}，连同它下面缩进的子列表和说明一起删除：</p>
          <ul>
            {deleting.slice(0, 3).map(({ list: owner, item }) => (
              <li key={itemKeyOf(owner.id, item.number)}>第 {item.number} 项「{item.title}」</li>
            ))}
          </ul>
          {deleting.length > 3 ? <p>等，共 {deleting.length} 项。</p> : null}
        </TodoDeleteDialog>
      )}
      {deletingList === null ? null : (
        <TodoDeleteDialog
          title="删除清单"
          description="清单的笔记会移到系统废纸篓，变更记录留在本机。"
          confirmLabel="删除清单"
          expectedText={deletingList.title}
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDeleteList()}
          onClose={() => setDeletingList(null)}
        >
          <p>将删除清单「{deletingList.title}」，里面有 {itemTotal(deletingList.counts)} 项。</p>
        </TodoDeleteDialog>
      )}
      {moving === null ? null : (
        <TodoMoveDialog
          count={moving.length}
          fromListIds={[...new Set(moving.map((entry) => entry.list.id))]}
          lists={viewLists}
          busy={moveBusy}
          error={moveError}
          onPick={(target) => void moveEntries(moving, target)}
          onClose={() => setMoving(null)}
        />
      )}
      {creating ? <TodoCreateDialog api={api} onClose={() => setCreating(false)} onRecorded={recorded} /> : null}
      {quickAdd === null ? null : (
        <TodoQuickAddDialog
          api={api}
          currentListId={view === null ? selectedId : null}
          initialText={quickAdd.initialText}
          onClose={() => setQuickAdd(null)}
          onAdded={(result) => {
            setAnnouncement(`已添加到「${result.list?.title ?? ""}」。`);
            void load();
          }}
        />
      )}
    </section>
  );
};
