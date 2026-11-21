import { isTodoTag, type TodoPriority } from "@cognelis/decision-protocol";
import { useEffect, useRef, useState } from "react";

import { ActionIcon } from "../../IconButton.js";
import { PRIORITY_LABELS } from "./todo-dates.js";

interface TodoBatchBarProps {
  count: number;
  busy: boolean;
  /** 复制给 agent: what is picked, as a prompt. */
  onCopy(): void;
  onComplete(): void;
  onStart(): void;
  onPriority(priority: TodoPriority | null): void;
  /** A day, or null to clear the due date. */
  onDue(due: string | null): void;
  onDelete(): void;
  onClear(): void;
  /** Opens the list picker (移到…). */
  onMove(): void;
  /** 加标签 / 去标签: the tag written, or picked from those on the items chosen. */
  onAddTag(tag: string): void;
  onRemoveTag(tag: string): void;
  /** The tags the items chosen carry, and every tag in use (offered when adding). */
  tagsOnChosen: readonly string[];
  knownTags: readonly string[];
}

/** 标签 ▾: add a tag to every item chosen (typed, or picked from those in use), or take one off from those they carry. */
const TagsButton = ({ busy, tagsOnChosen, knownTags, onAddTag, onRemoveTag }: Pick<TodoBatchBarProps, "tagsOnChosen" | "knownTags" | "onAddTag" | "onRemoveTag"> & { busy: boolean }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("input")?.focus();
    const away = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const lower = (tag: string): string => tag.toLocaleLowerCase("zh-CN");
  const suggestions = knownTags.filter((tag) => !tagsOnChosen.some((on) => lower(on) === lower(tag))).slice(0, 8);
  const add = (value: string): void => {
    const tag = value.trim().replace(/^[#＃]/u, "");
    if (tag.length === 0) return;
    if (!isTodoTag(tag)) {
      setProblem("标签只能写字母（含中文）、数字、_ - /，不能全是数字。");
      return;
    }
    setDraft("");
    setProblem(null);
    setOpen(false);
    onAddTag(tag);
  };
  return (
    <span className="todo-batch-due" ref={root}>
      <button ref={button} type="button" className="secondary-button" aria-haspopup="dialog" aria-expanded={open} disabled={busy} onClick={() => setOpen((current) => !current)}>
        标签 ▾
      </button>
      {open ? (
        <div
          className="todo-batch-popover todo-batch-tags"
          role="dialog"
          aria-label="加标签 / 去标签"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }}
        >
          <input
            aria-label="加标签"
            placeholder="加标签，回车"
            autoComplete="off"
            maxLength={60}
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              add(draft);
            }}
          />
          {problem === null ? null : <p className="form-field-error" role="status">{problem}</p>}
          {suggestions.length === 0 ? null : (
            <div className="todo-batch-taglist" role="group" aria-label="已有标签">
              {suggestions.map((tag) => (
                <button key={tag} type="button" className="todo-tag" onClick={() => add(tag)}>+ #{tag}</button>
              ))}
            </div>
          )}
          {tagsOnChosen.length === 0 ? null : (
            <div className="todo-batch-taglist" role="group" aria-label="去标签">
              {tagsOnChosen.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="todo-tag todo-tag-chip"
                  aria-label={`去标签 #${tag}`}
                  onClick={() => {
                    setOpen(false);
                    onRemoveTag(tag);
                  }}
                >
                  #{tag} ✕
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </span>
  );
};

/** 设截止日期: a button that opens a small popover with the date picker and 清除截止日期, so no bare mm/dd/yyyy sits in the bar. */
const DueButton = ({ busy, onDue }: { busy: boolean; onDue(due: string | null): void }) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("input")?.focus();
    const away = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <span className="todo-batch-due" ref={root}>
      <button type="button" className="secondary-button" aria-haspopup="dialog" aria-expanded={open} disabled={busy} onClick={() => setOpen((current) => !current)}>
        设截止日期
      </button>
      {open ? (
        <div
          className="todo-batch-popover"
          role="dialog"
          aria-label="设截止日期"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }}
        >
          <input
            type="date"
            aria-label="截止日期"
            value=""
            // A date half typed reads as empty: only a whole date is applied.
            onChange={(event) => {
              if (event.currentTarget.value === "") return;
              setOpen(false);
              onDue(event.currentTarget.value);
            }}
          />
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setOpen(false);
              onDue(null);
            }}
          >
            清除截止日期
          </button>
        </div>
      ) : null}
    </span>
  );
};

/** What can be done to the items picked: shown above the items while at least one is. */
export const TodoBatchBar = ({ count, busy, onCopy, onComplete, onStart, onPriority, onDue, onDelete, onClear, onMove, onAddTag, onRemoveTag, tagsOnChosen, knownTags }: TodoBatchBarProps) => (
  <div className="todo-batch-bar" role="toolbar" aria-label="批量操作">
    <strong>已选 {count} 项</strong>
    <button type="button" className="primary-button" onClick={onCopy}>
      <ActionIcon name="copy" />复制给 agent
    </button>
    <button type="button" className="secondary-button" disabled={busy} onClick={onComplete}>标为完成</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={onStart}>开始处理</button>
    <select
      aria-label="设优先级"
      value=""
      disabled={busy}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (value !== "") onPriority(value === "none" ? null : (value as TodoPriority));
      }}
    >
      <option value="">设优先级</option>
      <option value="none">无</option>
      {(["p0", "p1", "p2", "p3"] as const).map((priority) => (
        <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>
      ))}
    </select>
    <DueButton busy={busy} onDue={onDue} />
    <TagsButton busy={busy} tagsOnChosen={tagsOnChosen} knownTags={knownTags} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />
    <button type="button" className="secondary-button" disabled={busy} onClick={onMove}>移到…</button>
    <button type="button" className="text-button todo-danger-text" disabled={busy} onClick={onDelete}>删除</button>
    <button type="button" className="text-button" aria-label="取消选择（Esc）" onClick={onClear}>
      <span className="todo-batch-long" aria-hidden="true">取消选择（Esc）</span>
      <span className="todo-batch-short" aria-hidden="true">取消</span>
    </button>
  </div>
);
