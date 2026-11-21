import type { TodoListView } from "@cognelis/decision-protocol";
import { useId, useRef, useState } from "react";

import { ModalDialog } from "../../ModalDialog.js";
import { itemTotal, listSourceLabel } from "./todo-text.js";

const fold = (text: string): string => text.normalize("NFKC").toLocaleLowerCase("zh-CN");

interface TodoMoveDialogProps {
  /** How many items are moved, and the lists they are in (those lists are not offered when they are all in one). */
  count: number;
  fromListIds: readonly string[];
  lists: readonly TodoListView[];
  busy: boolean;
  error: string | null;
  onPick(list: TodoListView): void;
  onClose(): void;
}

/** 移到…: the lists to choose from, searched by name, project or source. Arrows and Enter pick; nothing moves before one is picked. */
export const TodoMoveDialog = ({ count, fromListIds, lists, busy, error, onPick, onClose }: TodoMoveDialogProps) => {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const only = fromListIds.length === 1 ? fromListIds[0] : null;
  const words = fold(query).split(/\s+/u).filter((word) => word.length > 0);
  const choices = lists.filter(
    (list) =>
      !list.archived &&
      list.id !== only &&
      words.every((word) => fold(`${list.title}\n${list.project ?? ""}\n${listSourceLabel(list)}`).includes(word)),
  );
  const current = Math.min(active, Math.max(0, choices.length - 1));
  return (
    <ModalDialog
      title="移到…"
      description={`把 ${count} 项移到…`}
      size="compact"
      dismissible={!busy}
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (choices.length > 0) setActive((current + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
        } else if (event.key === "Enter" && event.target === field.current) {
          event.preventDefault();
          const list = choices[current];
          if (list !== undefined && !busy) onPick(list);
        }
      }}
    >
      <div className="todo-move">
        <input
          ref={field}
          type="search"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-lists`}
          aria-activedescendant={choices[current] === undefined ? undefined : `${id}-${choices[current]!.id}`}
          aria-label="搜索清单"
          placeholder="搜索清单"
          autoComplete="off"
          value={query}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
        />
        {choices.length === 0 ? (
          <p className="todo-move-none">{words.length > 0 ? "没有匹配的清单。" : "没有别的清单可以移到。"}</p>
        ) : (
          <ul id={`${id}-lists`} role="listbox" aria-label="目标清单" className="todo-move-lists">
            {choices.map((list, index) => (
              <li
                key={list.id}
                id={`${id}-${list.id}`}
                role="option"
                aria-selected={index === current}
                aria-disabled={busy || undefined}
                data-active={index === current || undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  if (!busy) onPick(list);
                }}
              >
                <span className="todo-move-name">{list.title}</span>
                <span className="todo-move-meta">{[list.project ?? "未标明项目", listSourceLabel(list), `${itemTotal(list.counts)} 项`].join(" · ")}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="todo-move-note">在目标清单新建（拿新编号），成功后再从这里删除；状态、优先级、截止、标签、补充说明都带过去。</p>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      </div>
    </ModalDialog>
  );
};
