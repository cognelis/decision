import { todoItemPending } from "@cognelis/decision-core/todo";
import type { TodoItemStatus, TodoItemView, TodoListView, TodoPriority } from "@cognelis/decision-protocol";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";

import { relativeTime } from "../../../relative-time.js";
import { daysBetween, dueLabel, PRIORITY_LABELS } from "./todo-dates.js";
import { ActionIcon } from "../../IconButton.js";
import { ItemMenu, type MenuEntry } from "./TodoMenus.js";
import { actorLabel, dependencyLabel, listSourceLabel, plainMarkdown, statusLabel } from "./todo-text.js";

/** What became of something done on the page. Warnings and errors are alerts; the rest is said in passing. */
export interface TodoMessage {
  tone: "ok" | "note" | "warning" | "error";
  text: string;
}

/** A prompt the clipboard would not take, shown to be copied by hand. */
export interface CopyFallback {
  text: string;
  onClose(): void;
}

export const CopyFallbackBlock = ({ text, onClose }: CopyFallback) => {
  const field = useRef<HTMLTextAreaElement>(null);
  // Selected and focused, so ⌘C is all that is left to do.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  return (
    <div className="todo-copy-fallback" role="alert">
      <p>没能写入剪贴板。下面是要交给 agent 的内容，已经选中，可以手动复制。</p>
      <textarea ref={field} readOnly rows={4} aria-label="要交给 agent 的内容" value={text} />
      <button type="button" className="text-button" onClick={onClose}>收起</button>
    </div>
  );
};

export const TodoMessageLine = ({ message, className = "" }: { message: TodoMessage; className?: string }) => (
  <p className={`todo-message ${className}`} data-tone={message.tone} role={message.tone === "warning" || message.tone === "error" ? "alert" : undefined}>
    {message.text}
  </p>
);

/** The checkbox-like mark of a status: an empty box, half filled under way, ticked when done, struck when dropped. */
export const StatusGlyph = ({ status }: { status: TodoItemStatus }) => (
  <svg className="todo-status-glyph" data-status={status} viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3.25" />
    {status === "in_progress" ? <rect className="todo-status-fill" x="8" y="4.5" width="3.5" height="7" rx="1" /> : null}
    {status === "done" ? <path d="m4.9 8.2 2.2 2.2 4-4.4" /> : null}
    {status === "dropped" ? <path d="M5.25 8h5.5" /> : null}
  </svg>
);

/** 优先级 and 截止日期 as words: 高, 明天. A due date gone by on an item still to be handled is marked overdue. */
export const ItemChips = ({ item, today }: { item: Pick<TodoItemView, "priority" | "due" | "status">; today: string }) => {
  const overdue = item.due !== null && todoItemPending(item.status) && daysBetween(today, item.due) < 0;
  return (
    <>
      {item.priority === null ? null : (
        <span className="todo-chip" data-priority={item.priority} title="优先级">
          <span className="sr-only">优先级 </span>
          {PRIORITY_LABELS[item.priority]}
        </span>
      )}
      {item.due === null ? null : (
        <span className="todo-chip" data-due={overdue ? "overdue" : item.due === today ? "today" : undefined} title={`截止日期 ${item.due}`}>
          <span className="sr-only">截止 </span>
          {dueLabel(item.due, today)}
          {overdue ? <span className="sr-only">，已逾期</span> : null}
        </span>
      )}
    </>
  );
};

/** Where a dragged item would land: before the row under the pointer, or after it. */
export type DropSide = "before" | "after";

const STATUSES: readonly TodoItemStatus[] = ["open", "in_progress", "done", "dropped"];
const PRIORITIES: readonly TodoPriority[] = ["p0", "p1", "p2", "p3"];

/** Which of the row's menus is open (the page opens them from the keyboard too). */
export type RowMenu = "status" | "priority";

interface TodoItemRowProps {
  list: TodoListView;
  item: TodoItemView;
  /** Its key on the page: list id and number, which the page's focus and busy states go by. */
  itemKey: string;
  today: string;
  busy: boolean;
  /** Its drawer is open. */
  selected: boolean;
  /** Picked for a batch (its box is ticked). */
  checked: boolean;
  /** Names the list it is in, as in the views. */
  showList?: boolean;
  /** Dragging to reorder is on (the order shown is the note's). */
  reorderable?: boolean;
  dropSide?: DropSide | null;
  message: TodoMessage | null;
  /** The menu of this row that is open, if any. */
  menu?: RowMenu | null;
  onMenu?(menu: RowMenu | null): void;
  /** Prefixes the ids the row's parts are named by. */
  idPrefix: string;
  onOpen(): void;
  /** Its box: picked or not; `shift` to take everything from the last one picked. */
  onCheck(shift: boolean): void;
  onSetStatus(status: TodoItemStatus): void;
  onSetPriority?(priority: TodoPriority | null): void;
  onMoveToList?(): void;
  /** 复制给 agent: this item alone. */
  onCopy?(): void;
  onDelete(): void;
  /** ⌥↑ / ⌥↓ on the row. */
  onMove?(direction: -1 | 1): void;
  onDragStart?(): void;
  onDragOver?(side: DropSide): void;
  onDrop?(side: DropSide): void;
  onDragEnd?(): void;
}

const sideOf = (event: DragEvent<HTMLElement>): DropSide => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? "before" : "after";
};

/** The first sentence of an item's detail: what the second line of a row says of an item that is not under way. */
export const firstSentence = (detail: string | null): string | null => {
  if (detail === null) return null;
  const line = plainMarkdown(detail.trim()).split(/\r?\n/u).find((candidate) => candidate.trim().length > 0) ?? "";
  const end = line.search(/[。！？]|[.!?](?:\s|$)/u);
  const sentence = (end < 0 ? line : line.slice(0, end + 1)).trim();
  return sentence.length === 0 ? null : sentence;
};

/**
 * One item as a card of two lines: the title in full, then a quiet line (#number, and what is under way or the first
 * sentence of its detail). Its box picks it for a batch; a click on the title opens its drawer; its status is a button
 * with a menu. In a list ordered by hand it can be dragged, or moved with ⌥↑ / ⌥↓.
 */
export const TodoItemRow = ({
  list,
  item,
  itemKey,
  today,
  busy,
  selected,
  checked,
  showList = false,
  reorderable = false,
  dropSide = null,
  message,
  menu = null,
  onMenu = () => undefined,
  idPrefix,
  onOpen,
  onCheck,
  onSetStatus,
  onSetPriority = () => undefined,
  onMoveToList,
  onCopy,
  onDelete,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TodoItemRowProps) => {
  const titleId = `${idPrefix}-item-${item.number}-title`;
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!event.altKey || onMove === undefined || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    onMove(event.key === "ArrowUp" ? -1 : 1);
  };
  const under = item.status === "in_progress";
  const second = under
    ? `处理中 · ${item.changedBy === null ? listSourceLabel(list) : actorLabel(item.changedBy)} ${relativeTime(item.changedAt ?? list.updatedAt)}更新`
    : firstSentence(item.detail);

  return (
    <li
      className="todo-item"
      data-status={item.status}
      data-priority={item.priority ?? undefined}
      data-todo-row={itemKey}
      data-selected={selected || undefined}
      data-checked={checked || undefined}
      data-drop={dropSide ?? undefined}
      draggable={reorderable && !busy}
      onDragStart={reorderable ? (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", itemKey);
        onDragStart?.();
      } : undefined}
      onDragOver={reorderable ? (event) => {
        event.preventDefault();
        onDragOver?.(sideOf(event));
      } : undefined}
      onDrop={reorderable ? (event) => {
        event.preventDefault();
        onDrop?.(sideOf(event));
      } : undefined}
      onDragEnd={reorderable ? onDragEnd : undefined}
    >
      <div className="todo-item-card">
        <input
          type="checkbox"
          className="todo-check"
          aria-label={`选择第 ${item.number} 项`}
          aria-describedby={titleId}
          checked={checked}
          disabled={busy}
          data-todo-check={itemKey}
          onChange={() => undefined}
          onClick={(event) => onCheck(event.shiftKey)}
        />
        <button
          type="button"
          className="todo-item-toggle"
          aria-haspopup="dialog"
          aria-expanded={selected}
          aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={reorderable ? "拖动调整顺序，或按 ⌥↑ / ⌥↓ 移动" : undefined}
          data-todo-focus={itemKey}
          onClick={onOpen}
          onKeyDown={keyDown}
        >
          <span className="todo-item-title" id={titleId}>
            <span className="sr-only">第 {item.number} 项：</span>
            {item.title}
          </span>
          <span className="todo-item-sub">
            <span className="todo-item-number" aria-hidden="true">#{item.number}</span>
            {item.tags.map((tag) => (
              <span key={tag} className="todo-tag" title={`标签 #${tag}`}><span className="sr-only">标签 </span>#{tag}</span>
            ))}
            {showList ? <span className="todo-item-list" title={list.title}>{list.title}</span> : null}
            {second === null ? null : <span className="todo-item-second">{second}</span>}
            {item.disposition === null ? null : (
              <span className="todo-item-disposition" title={`处置：${item.disposition}`}>处置：{item.disposition.replace(/\s*\n\s*/gu, " ")}</span>
            )}
          </span>
        </button>
        <span className="todo-item-side">
          {item.changedInObsidian ? <span className="todo-obsidian-chip">Obsidian 里改过</span> : null}
          <ItemMenu
            menuLabel={`第 ${item.number} 项优先级`}
            button={item.priority === null ? null : PRIORITY_LABELS[item.priority]}
            buttonLabel={`第 ${item.number} 项优先级：${item.priority === null ? "无" : PRIORITY_LABELS[item.priority]}`}
            buttonClassName="todo-chip todo-priority-button"
            buttonData={{ priority: item.priority ?? "" }}
            disabled={busy}
            open={menu === "priority"}
            onOpenChange={(open) => onMenu(open ? "priority" : null)}
            entries={[
              ...PRIORITIES.map((priority): MenuEntry => ({ kind: "radio", key: priority, label: PRIORITY_LABELS[priority], checked: item.priority === priority, onSelect: () => onSetPriority(priority) })),
              { kind: "radio", key: "none", label: "无", checked: item.priority === null, onSelect: () => onSetPriority(null) },
            ]}
          />
          <ItemChips item={{ ...item, priority: null }} today={today} />
          {dependencyLabel(item) === null ? null : <span className="todo-chip todo-dependency-chip">{dependencyLabel(item)}</span>}
          {(item.dependents?.length ?? 0) === 0 ? null : <span className="todo-chip">{item.dependents!.length} 项在等它</span>}
          <ItemMenu
            menuLabel={`第 ${item.number} 项`}
            button={<>{statusLabel(item.status)}<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m2 3.5 3 3 3-3" /></svg></>}
            buttonLabel={`第 ${item.number} 项状态：${statusLabel(item.status)}`}
            buttonClassName="todo-status-button"
            buttonData={{ status: item.status }}
            disabled={busy}
            open={menu === "status"}
            onOpenChange={(open) => onMenu(open ? "status" : null)}
            entries={[
              ...STATUSES.map((status): MenuEntry => ({ kind: "radio", key: status, label: statusLabel(status), checked: status === item.status, onSelect: () => onSetStatus(status) })),
              { kind: "rule", key: "rule" },
              ...(onCopy === undefined || !todoItemPending(item.status) ? [] : [{ kind: "action", key: "copy", label: "复制给 agent", icon: <ActionIcon name="copy" />, onSelect: onCopy } as MenuEntry]),
              ...(onMoveToList === undefined ? [] : [{ kind: "action", key: "move", label: "移到…", onSelect: onMoveToList } as MenuEntry]),
              { kind: "action", key: "delete", label: "删除", danger: true, onSelect: onDelete },
            ]}
          />
        </span>
      </div>
      {message === null ? null : <TodoMessageLine message={message} className="todo-item-message" />}
    </li>
  );
};
