import { todoListPending } from "@cognelis/decision-core/todo";
import { TODO_LIMITS, type TodoListView, type TodoPriority, type TodoRecordResult } from "@cognelis/decision-protocol";
import { useEffect, useId, useState } from "react";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { isSubmitShortcut, submitShortcutLabel } from "../../../keyboard.js";
import { ModalDialog } from "../../ModalDialog.js";
import { matchList, parseQuickAdd, type QuickAddParse, type QuickAddToken } from "./quick-add.js";
import { dayHeading, dueLabel, localDay, PRIORITY_LABELS } from "./todo-dates.js";
import "./todo-quick-add.css";

const LAST_LIST_KEY = "paraself.todos.quick-add-list";

export interface QuickAddDialogProps {
  api: Pick<DecisionApi, "listTodoLists" | "recordTodoList" | "updateTodoList">;
  /** The list the 待办 page has open; the default when no `#清单` is written. */
  currentListId: string | null;
  initialText?: string;
  onClose(): void;
  /** Written: the result of the call. The dialog closes itself after. */
  onAdded(result: TodoRecordResult): void;
}

/** The item a parse makes: its title (empty when only known words were typed), and the priority and day when there are any. */
export const quickAddItem = (parse: Pick<QuickAddParse, "title" | "priority" | "due" | "tags">): { title: string; priority?: TodoPriority; due?: string; tags?: string[] } => ({
  title: parse.title,
  ...(parse.priority === null ? {} : { priority: parse.priority }),
  ...(parse.due === null ? {} : { due: parse.due }),
  ...(parse.tags.length === 0 ? {} : { tags: parse.tags }),
});

const remembered = (): string | null => {
  try {
    return localStorage.getItem(LAST_LIST_KEY);
  } catch {
    return null;
  }
};
const remember = (id: string): void => {
  try {
    localStorage.setItem(LAST_LIST_KEY, id);
  } catch {
    // Not kept: the next add asks again.
  }
};

/** 快速添加: one line (明天 !p1 写周报 @日常 #周报) turned into an item, shown as tags and a 「将保存为」 line before it is saved. */
export const TodoQuickAddDialog = ({ api, currentListId, initialText = "", onClose, onAdded }: QuickAddDialogProps) => {
  const id = useId();
  const [text, setText] = useState(initialText);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [lists, setLists] = useState<TodoListView[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Archived lists too: a #name that names one finds it, not a second list of the same name.
    api.listTodoLists({ includeClosed: true, limit: TODO_LIMITS.page }).then(
      (response) => live && setLists(response.lists.filter((candidate) => todoListPending(candidate) || candidate.archived)),
      (caught: unknown) => {
        if (!live) return;
        setLists([]);
        setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const today = localDay(new Date());
  const available = lists ?? [];
  const parse = parseQuickAdd(text, today, dismissed, {
    listTitles: available.map((candidate) => candidate.title),
    knownTags: available.flatMap((candidate) => candidate.items.flatMap((item) => item.tags)),
  });
  const matched = parse.listName === null ? null : matchList(parse.listName, available);
  const unmatched = parse.listName !== null && matched === null && lists !== null;
  const exists = (listId: string | null): string | null => (listId !== null && available.some((list) => list.id === listId) ? listId : null);
  // The reader's pick, else the list named, else (when none is named) the one open on the page, else the last used.
  const listId = exists(chosen) ?? matched?.id ?? (parse.listName !== null ? null : (exists(currentListId) ?? exists(remembered())));
  const list = available.find((candidate) => candidate.id === listId) ?? null;
  const tooLong = parse.title.length > TODO_LIMITS.itemTitle;
  const canSave = !saving && lists !== null && parse.title.length > 0 && !tooLong && list !== null;

  const finish = (result: TodoRecordResult): void => {
    if (result.list !== null) remember(result.list.id);
    onAdded(result);
    onClose();
  };

  const write = async (request: Parameters<TodoQuickAddDialogApi["recordTodoList"]>[0], fallback: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.recordTodoList(request);
      if (result.status === "appended" || result.status === "created") finish(result);
      else if (result.status === "duplicate") setError("这份清单里已经有同名的事项，没有重复添加。");
      else if (result.status === "list_full") setError(`一份清单最多 ${TODO_LIMITS.itemsPerList} 项，这份已经满了，请换一份清单。`);
      else setError("这份清单找不到了，可能在 Obsidian 里移走或删掉了；请重新选择清单。");
    } catch (caught) {
      setError(`${fallback}：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setSaving(false);
    }
  };

  const save = (): void => {
    if (!canSave || list === null) return;
    void (async () => {
      // An archived list is taken out of the archive first (the notice said so), then added to.
      if (list.archived) {
        try {
          await api.updateTodoList({ listId: list.id, archived: false });
        } catch (caught) {
          setError(`没有取消归档：${caught instanceof Error ? caught.message : String(caught)}`);
          return;
        }
      }
      await write({ listId: list.id, items: [quickAddItem(parse)] }, "没有添加");
    })();
  };
  // Only on the reader's press: a name nothing matches is asked about, never made up.
  const createNamed = (): void => {
    if (!saving && parse.listName !== null && parse.title.length > 0 && !tooLong) {
      void write({ title: parse.listName, longTerm: true, items: [quickAddItem(parse)] }, "没有新建");
    }
  };

  /** A chip: what was recognised (截止, 优先级, 清单, 标签) and its value; a list named the old way says so. */
  const chip = (token: QuickAddToken): { name: string; value: string } => {
    if (token.kind === "due" && parse.due !== null) return { name: "截止", value: `${dueLabel(parse.due, today)} · ${dayHeading(parse.due, today).replace(/^(今天|明天) · /u, "")}` };
    if (token.kind === "priority" && parse.priority !== null) return { name: "优先级", value: PRIORITY_LABELS[parse.priority] };
    if (token.kind === "list") return { name: "清单", value: parse.legacyList ? `${parse.listName}（按旧写法 ${token.text}）` : (parse.listName ?? token.text) };
    return { name: "标签", value: token.text };
  };

  return (
    <ModalDialog
      title="快速添加"
      description="一句话加一项：明天、周五、11-15 是截止日期，!p0 到 !p3 是优先级，@清单名 指定清单，#标签 加标签。"
      dismissible={!saving}
      unsaved={text.trim().length > 0}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" form={`${id}-form`} className="primary-button" disabled={!canSave}>
            {saving ? "正在添加…" : "添加"}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="todo-quick-add-form form-fields"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        onKeyDown={(event) => {
          if (!isSubmitShortcut(event)) return;
          event.preventDefault();
          save();
        }}
      >
        <div className="form-field">
          <label htmlFor={`${id}-text`}>事项</label>
          <input
            id={`${id}-text`}
            autoFocus
            value={text}
            disabled={saving}
            placeholder="如：明天 !p1 写周报 @日常 #周报"
            aria-describedby={`${id}-summary`}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setError(null);
            }}
          />
          {tooLong ? <p className="form-field-error" role="status">标题最多 {TODO_LIMITS.itemTitle} 个字，请缩短。</p> : null}
        </div>
        {parse.tokens.length === 0 ? null : (
          <>
            <p className="todo-quick-add-recognised">识别到</p>
            <ul className="todo-quick-add-chips" aria-label="识别结果">
              {parse.tokens.map((token) => {
                const { name, value } = chip(token);
                return (
                  <li key={token.key}>
                    <button
                      type="button"
                      className="todo-quick-add-chip"
                      aria-label={`取消识别「${token.text}」`}
                      onClick={() => setDismissed((current) => new Set(current).add(token.key))}
                    >
                      <span>{name}</span><strong>{value}</strong>
                      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" /></svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {unmatched ? (
          <div className="todo-quick-add-unmatched" role="group" aria-label="没有找到清单">
            <p>没有名为「{parse.listName}」的清单。可以在下面选一份已有的清单，或者新建它。</p>
            <button type="button" className="secondary-button" disabled={saving || parse.title.length === 0 || tooLong} onClick={createNamed}>
              新建清单「{parse.listName}」
            </button>
          </div>
        ) : null}
        <div className="form-field">
          <label htmlFor={`${id}-list`}>{unmatched ? "选择已有清单" : "清单"}</label>
          <select id={`${id}-list`} value={list?.id ?? ""} disabled={saving || lists === null} onChange={(event) => setChosen(event.currentTarget.value || null)}>
            <option value="">{lists === null ? "正在读取清单…" : "请选择清单"}</option>
            {available.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.archived ? `${candidate.title}（已归档）` : candidate.title}</option>
            ))}
          </select>
        </div>
        {list?.archived ? <p className="todo-quick-add-archived" role="status">这份清单已归档，添加后会取消归档。</p> : null}
        <p id={`${id}-summary`} className="todo-quick-add-summary" aria-live="polite">
          将保存为：<strong>{parse.title || "（还没有标题）"}</strong>
          {parse.due === null ? "" : ` · 截止 ${dayHeading(parse.due, today)}`}
          {parse.priority === null ? "" : ` · 优先级 ${PRIORITY_LABELS[parse.priority]}`}
          {parse.tags.length === 0 ? "" : ` · ${parse.tags.map((tag) => `#${tag}`).join(" ")}`}
          {` · ${list === null ? (unmatched ? `新清单「${parse.listName}」需确认` : "请选择清单") : `清单 ${list.title}`}`}
          <small> （{submitShortcutLabel()} 添加）</small>
        </p>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      </form>
    </ModalDialog>
  );
};

type TodoQuickAddDialogApi = Pick<DecisionApi, "recordTodoList">;
