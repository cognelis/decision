import { todoItemPending } from "@cognelis/decision-core/todo";
import { TODO_LIMITS, type TodoItemStatus, type TodoItemView, type TodoListView, type TodoPriority } from "@cognelis/decision-protocol";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { isSubmitShortcut, submitShortcutLabel } from "../../../keyboard.js";
import { ActionIcon, IconButton } from "../../IconButton.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { TodoDrawerHandle } from "./TodoDrawerHandle.js";
import { TodoTagEditor } from "./TodoTagEditor.js";
import { CopyFallbackBlock, ItemChips, StatusGlyph, TodoMessageLine, type TodoMessage } from "./TodoItemRow.js";
import { PRIORITY_LABELS } from "./todo-dates.js";
import { clockLabel, eventText, historyActorLabel, historyByDay, itemHistory, listSourceLabel, momentLabel, recordedStatus, statusLabel } from "./todo-text.js";

/** The progress being written on an item, with the status it had when the writing began (the change is made on it). */
export interface NoteDraft {
  draft: string;
  basis: TodoItemStatus;
}

/** What the drawer changes: any of these, on the status it showed. */
export interface ItemPatch {
  status?: TodoItemStatus;
  note?: string;
  priority?: TodoPriority | null;
  due?: string | null;
  tags?: string[];
  detail?: string | null;
  /** The 补充说明 the writer started from: changed since, it is not overwritten. */
  expectedDetail?: string | null;
  /** 处置备注 (the reader's opinion for an agent); null clears it. */
  disposition?: string | null;
  /** The 处置备注 the writer started from: changed since, it is not overwritten. */
  expectedDisposition?: string | null;
}

interface TodoItemDrawerProps {
  list: TodoListView;
  item: TodoItemView;
  itemKey: string;
  today: string;
  busy: boolean;
  draft: NoteDraft | null;
  message: TodoMessage | null;
  copy: { status: "copied" | "failed"; text: string } | null;
  onDraft(draft: NoteDraft | null): void;
  /** `expected`: the status the change is made on. */
  onChange(patch: ItemPatch, expected?: TodoItemStatus, done?: (saved: boolean) => void): void;
  onCopy(): void;
  onCloseCopy(): void;
  onClose(): void;
  onDelete(): void;
  /** Opens the list picker for this item. */
  onMove(): void;
  /** Every tag in use, offered when one is typed. */
  knownTags: readonly string[];
  /** 整理里已采纳的「开始前要看」（IMP-191），放在补充说明之前。 */
  beforeStart?: ReactNode;
  dependencies?: ReactNode;
}

const PRIORITIES: readonly (TodoPriority | "")[] = ["", "p0", "p1", "p2", "p3"];


/**
 * An item opened: its status, 优先级 and 截止日期 (both can be changed here), where it came from, what an agent found,
 * what happened to it, and a line of progress to write. Finishing and dropping need that line, as they do for an agent.
 */
export const TodoItemDrawer = ({ list, item, itemKey, today, busy, draft, message, copy, onDraft, onChange, onCopy, onCloseCopy, onClose, onDelete, onMove, knownTags, beforeStart, dependencies }: TodoItemDrawerProps) => {
  const pending = todoItemPending(item.status);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const history = historyByDay(itemHistory(list, item.number), today);
  const [editing, setEditing] = useState<string | null>(null);
  // The detail as it was when the editing began: what the save is made against.
  const editBasis = useRef<string | null>(null);
  const text = draft?.draft ?? "";
  const note = text.trim();
  const drawerId = `${itemKey}-drawer`;
  // Moved to the drawer when it opens, and again for another item opened in place of this one.
  useEffect(() => headingRef.current?.focus(), [itemKey]);
  // The text being edited belongs to the item it was opened on.
  useEffect(() => setEditing(null), [itemKey]);
  // 清空已提交的输入，不把随后失焦的空框当作删除已保存备注。
  const [dispositionDraft, setDispositionDraft] = useState<string | null>(null);
  const [dispositionSaved, setDispositionSaved] = useState(false);
  useEffect(() => {
    setDispositionDraft(null);
    setDispositionSaved(false);
  }, [itemKey]);
  const dispositionBasis = useRef<string | null>(null);
  const saveDisposition = (): void => {
    if (dispositionDraft === null) return;
    const next = dispositionDraft.trim();
    if (next === (dispositionBasis.current ?? "")) {
      setDispositionDraft(null);
      setDispositionSaved(true);
      return;
    }
    // The text stays in the box until it is saved: refused (changed elsewhere meanwhile), it is still there.
    onChange({ disposition: next.length === 0 ? null : next, expectedDisposition: dispositionBasis.current }, undefined, (saved) => {
      if (saved) {
        setDispositionDraft(null);
        setDispositionSaved(true);
      }
    });
  };
  const write = (status: TodoItemStatus | undefined): void => {
    if (busy || note.length === 0) return;
    onChange({ ...(status === undefined ? {} : { status }), note }, draft?.basis);
  };

  return (
    <aside className="todo-drawer" id={drawerId} aria-label={`第 ${item.number} 项详情`} data-todo-drawer={itemKey}>
      <TodoDrawerHandle controls={drawerId} />
      <header className="todo-drawer-head">
        <div>
          <p className="todo-meta"><span>第 {item.number} 项</span><span title={list.title}>{list.title}</span></p>
          <h3 ref={headingRef} tabIndex={-1}>{item.title}</h3>
        </div>
        <IconButton aria-label="关闭详情" onClick={onClose}><ActionIcon name="close" /></IconButton>
      </header>
      <div className="todo-drawer-body">
        <dl className="todo-drawer-fields">
          <div>
            <dt>状态</dt>
            <dd>
              <span className="todo-drawer-status"><StatusGlyph status={item.status} />{statusLabel(item.status)}</span>
              {item.status === "open" ? (
                <button type="button" className="text-button" disabled={busy} onClick={() => onChange({ status: "in_progress" })}>开始处理</button>
              ) : null}
              {pending ? null : (
                <button type="button" className="text-button" disabled={busy} onClick={() => onChange({ status: "open" })}>重新打开</button>
              )}
            </dd>
          </div>
          <div>
            <dt><label htmlFor={`${drawerId}-priority`}>优先级</label></dt>
            <dd>
              <select
                id={`${drawerId}-priority`}
                value={item.priority ?? ""}
                disabled={busy}
                onChange={(event) => onChange({ priority: event.currentTarget.value === "" ? null : (event.currentTarget.value as TodoPriority) })}
              >
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>{priority === "" ? "无" : PRIORITY_LABELS[priority]}</option>
                ))}
              </select>
            </dd>
          </div>
          <div>
            <dt><label htmlFor={`${drawerId}-due`}>截止日期</label></dt>
            <dd>
              <input
                id={`${drawerId}-due`}
                type="date"
                value={item.due ?? ""}
                disabled={busy}
                // A date half typed reads as empty: only a whole date is saved, and clearing is its own button.
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (value !== "" && value !== item.due) onChange({ due: value });
                }}
              />
              {item.due === null ? null : (
                <button type="button" className="text-button" disabled={busy} onClick={() => onChange({ due: null })}>清除</button>
              )}
              <ItemChips item={{ ...item, priority: null }} today={today} />
            </dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd className="todo-drawer-source">{[listSourceLabel(list), `清单「${list.title}」`, `创建于 ${momentLabel(list.createdAt)}`].join(" · ")}</dd>
          </div>
        </dl>
        {dependencies}

        {item.changedInObsidian ? (
          <p className="todo-item-obsidian">
            在 Obsidian 里改过：从「{statusLabel(recordedStatus(list, item.number))}」勾成了「{statusLabel(item.status)}」，下次修改时会补进变更记录。
          </p>
        ) : null}

        <TodoTagEditor tags={item.tags} known={knownTags} disabled={busy} onChange={(tags) => onChange({ tags })} />

        {beforeStart ?? null}

        <section aria-labelledby={`${drawerId}-detail`}>
          <div className="todo-drawer-section-head">
            <h4 id={`${drawerId}-detail`}>补充说明</h4>
            {editing === null ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => {
                editBasis.current = item.detail;
                setEditing(item.detail ?? "");
              }}>编辑</button>
            ) : null}
          </div>
          {editing !== null ? (
            <form
              className="todo-detail-editor"
              onSubmit={(event) => {
                event.preventDefault();
                const next = editing.trim();
                if (next === (editBasis.current ?? "")) {
                  setEditing(null);
                  return;
                }
                // The text stays in the box until it is saved: refused (changed elsewhere meanwhile), it is still there.
                onChange({ detail: next.length === 0 ? null : next, expectedDetail: editBasis.current }, undefined, (saved) => {
                  if (saved) setEditing(null);
                });
              }}
            >
              <textarea
                aria-label="补充说明（Markdown 原文）"
                rows={8}
                maxLength={TODO_LIMITS.itemDetail}
                autoFocus
                value={editing}
                disabled={busy}
                onChange={(event) => setEditing(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditing(null);
                  }
                }}
              />
              <div className="todo-note-actions">
                <small aria-hidden="true">按 Markdown 显示，保存后生效</small>
                <button type="button" className="text-button" onClick={() => setEditing(null)}>取消</button>
                <button type="submit" className="secondary-button" disabled={busy}>保存</button>
              </div>
            </form>
          ) : item.detail === null ? (
            <p className="todo-drawer-none">没有补充说明。</p>
          ) : (
            <div className="todo-item-detail todo-markdown">{renderMarkdown(item.detail)}</div>
          )}
        </section>

        <div className="todo-note-editor">
          <label htmlFor={`${drawerId}-disposition`}>处置备注 · 给 agent 的人工意见</label>
          <textarea
            id={`${drawerId}-disposition`}
            rows={3}
            maxLength={TODO_LIMITS.itemDisposition}
            placeholder="希望 agent 怎么处理这一项，例如：先只修引号，不要改安装目录结构"
            value={dispositionDraft ?? (dispositionSaved ? "" : item.disposition ?? "")}
            disabled={busy}
            onFocus={() => {
              if (dispositionDraft !== null || dispositionSaved) return;
              dispositionBasis.current = item.disposition;
              setDispositionDraft(item.disposition ?? "");
            }}
            onChange={(event) => {
              // Typing in a box that kept focus after a save starts a new writing, on what is held now.
              if (dispositionDraft === null) dispositionBasis.current = item.disposition;
              setDispositionDraft(event.currentTarget.value);
            }}
            onBlur={saveDisposition}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                saveDisposition();
              } else if (event.key === "Escape" && dispositionDraft !== null) {
                // Put away what was typed, not the drawer.
                event.preventDefault();
                event.stopPropagation();
                setDispositionDraft(null);
              }
            }}
          />
          <small>失焦或 {submitShortcutLabel()} 保存。写在笔记里该事项下方的「处置：」行，Obsidian 里也能改；复制给 agent 时一并带上。空行不会保留（一段话）。和「写一句进展」不同：进展是做了什么，处置是希望怎么做。</small>
        </div>

        <section aria-labelledby={`${drawerId}-history`}>
          <h4 id={`${drawerId}-history`}>变更时间线</h4>
          {history.length === 0 ? (
            <p className="todo-drawer-none">还没有改动。</p>
          ) : (
            <div className="todo-timeline">
              {history.map((group) => (
                <section key={group.day} className="todo-timeline-day" aria-label={group.label}>
                  <h5>{group.label}</h5>
                  <ol>
                    {group.events.map((event, index) => {
                      const who = historyActorLabel(event.by);
                      return (
                        <li key={`${event.at}-${index}`}>
                          <time dateTime={event.at}>{clockLabel(event.at)}</time>
                          <span className="todo-history-who" data-who={event.by.kind === "user" ? "me" : undefined} title={who}>{who}</span>
                          <span className="todo-history-what">
                            {eventText(event, today)}
                            {event.note === null ? null : <span className="todo-history-note">{event.note}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
            </div>
          )}
        </section>

        <form
          className="todo-note-editor"
          onSubmit={(event) => {
            event.preventDefault();
            write(undefined);
          }}
        >
          <label htmlFor={`${drawerId}-note`}>写一句进展</label>
          <textarea
            id={`${drawerId}-note`}
            rows={3}
            maxLength={TODO_LIMITS.note}
            placeholder="做了什么、怎么验证的，或为什么不做"
            value={text}
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onDraft(value.length === 0 ? null : { draft: value, basis: draft?.basis ?? item.status });
            }}
            onKeyDown={(event) => {
              if (isSubmitShortcut(event)) {
                event.preventDefault();
                write(pending ? "done" : undefined);
              }
            }}
          />
          <div className="todo-note-actions">
            <small aria-hidden="true">{submitShortcutLabel()} {pending ? "标为完成" : "保存"} · Esc 关闭</small>
            {pending ? (
              <>
                <button type="button" className="text-button" disabled={busy || note.length === 0} onClick={() => write("dropped")}>放弃</button>
                <button type="submit" className="secondary-button" disabled={busy || note.length === 0}>只记进展</button>
                <button type="button" className="primary-button" disabled={busy || note.length === 0} onClick={() => write("done")}>标为完成</button>
              </>
            ) : (
              <button type="submit" className="secondary-button" disabled={busy || note.length === 0}>只记进展</button>
            )}
          </div>
        </form>
        <div className="todo-drawer-actions">
          {pending ? (
            <button type="button" className="text-button todo-copy-item" onClick={onCopy}>
              <ActionIcon name={copy?.status === "copied" ? "check" : "copy"} />
              {copy?.status === "copied" ? "已复制" : "复制给 agent"}
            </button>
          ) : null}
          <button type="button" className="text-button" disabled={busy} onClick={onMove}>移到…</button>
          <button type="button" className="text-button todo-danger-text" disabled={busy} onClick={onDelete}>删除这一项</button>
        </div>
        {copy?.status === "failed" ? <CopyFallbackBlock text={copy.text} onClose={onCloseCopy} /> : null}
        {message === null ? null : <TodoMessageLine message={message} />}
      </div>
    </aside>
  );
};
