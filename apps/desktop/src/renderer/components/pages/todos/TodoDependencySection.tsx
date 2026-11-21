import { TodoDependencies } from "@cognelis/decision-core/todo-dependencies";
import { TODO_LIMITS, type TodoDependencyView, type TodoItemChange, type TodoItemView, type TodoListView } from "@cognelis/decision-protocol";
import { useId, useMemo, useRef, useState } from "react";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { StatusGlyph } from "./TodoItemRow.js";
import { dependencyLabel, statusLabel } from "./todo-text.js";

interface Props {
  api: Pick<DecisionApi, "listTodoLists" | "changeTodoItem">;
  list: TodoListView;
  item: TodoItemView;
  busy: boolean;
  onChanged(): Promise<void>;
  onOpen(listId: string, item: number): void;
}

export const TodoDependencySection = ({ api, list, item, busy, onChanged, onOpen }: Props) => {
  const [picker, setPicker] = useState<"before" | "after" | null>(null);
  const [lists, setLists] = useState<TodoListView[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const option = useRef<HTMLLIElement>(null);
  const id = useId();
  const graph = useMemo(() => new TodoDependencies(lists), [lists]);
  const source = graph.find(list.id, item.number);
  const words = query.normalize("NFKC").toLocaleLowerCase("zh-CN").split(/\s+/u).filter(Boolean);
  const choices = graph.nodes.filter(node => words.every(word => `${node.item.title} ${node.list.title}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(word))).map(node => {
    const from = picker === "before" ? source : node;
    const to = picker === "before" ? node : source;
    const reason = from === undefined || to === undefined ? "事项已不存在" :
      from === to ? "不能依赖自己" :
      to.item.id !== undefined && !graph.unique(to.item.id) ? "稳定编号重复，需确认" :
      to.item.id !== undefined && from.item.dependsOn?.includes(to.item.id) ? "已有关联" :
      graph.wouldCycle(from, to) ? "会形成循环依赖" : null;
    return { node, reason };
  });
  const current = Math.min(active, Math.max(0, choices.length - 1));
  const disabled = busy || saving;
  const openPicker = async (direction: "before" | "after"): Promise<void> => {
    setPicker(direction);
    setQuery("");
    setActive(0);
    setLists([]);
    setError(null);
    setLoading(true);
    try {
      const all: TodoListView[] = [];
      let offset: number | null = 0;
      do {
        const page = await api.listTodoLists({ includeClosed: true, limit: TODO_LIMITS.page, offset });
        if (page.unreadable.length > 0) throw new Error("有清单无法读取，暂不能安全添加依赖。现有依赖仍可解除。");
        all.push(...page.lists);
        offset = page.nextOffset;
      } while (offset !== null);
      setLists(all);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  };
  const change = async (request: TodoItemChange): Promise<void> => {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.changeTodoItem(request);
      if (result.status !== "saved" && result.status !== "unchanged") {
        setError(result.message ?? "事项已变化，请关闭后重新选择。");
      } else setPicker(null);
      await onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  const pick = (index: number): void => {
    const choice = choices[index];
    if (choice === undefined || choice.reason !== null || loading || disabled) return;
    const target = { listId: choice.node.list.id, item: choice.node.item.number };
    void change(picker === "before"
      ? { listId: list.id, item: item.number, expectedStatus: item.status, addDependencies: [target] }
      : { ...target, expectedStatus: choice.node.item.status, addDependencies: [{ listId: list.id, item: item.number }] });
  };
  const row = (dependency: TodoDependencyView, direction: "before" | "after") => (
    <li key={`${dependency.listId}:${dependency.item}:${dependency.id}`}>
      <div className="todo-dependency-title">
        {dependency.status === null ? <span aria-hidden="true">?</span> : <StatusGlyph status={dependency.status} />}
        <button type="button" className="text-button" disabled={disabled || dependency.listId === null || dependency.item === null}
          onClick={() => onOpen(dependency.listId!, dependency.item!)}>{dependency.title}</button>
      </div>
      <span className="todo-dependency-meta">{dependency.issue === "missing" ? "找不到该事项 · 需确认" : dependency.issue === "ambiguous" ? "稳定编号重复 · 需确认" : `${dependency.listTitle} · ${statusLabel(dependency.status!)}`}</span>
      <button type="button" className="text-button todo-dependency-remove" disabled={disabled}
        aria-label={`解除${direction === "before" ? "前置" : "后续"}：${dependency.title}`}
        onClick={() => void change(direction === "before"
          ? { listId: list.id, item: item.number, expectedStatus: item.status, removeDependencies: [dependency.id!] }
          : { listId: dependency.listId!, item: dependency.item!, expectedStatus: dependency.status!, removeDependencies: [item.id!] })}>解除</button>
    </li>
  );
  return (
    <section className="todo-dependencies" aria-label="事项依赖">
      {(["before", "after"] as const).map(direction => {
        const entries = (direction === "before" ? item.prerequisites : item.dependents) ?? [];
        return <section key={direction} aria-label={direction === "before" ? "前置事项" : "后续事项"}>
          <div className="todo-drawer-section-head">
            <h4>{direction === "before" ? "前置" : "后续"}<span className="todo-dependency-meta"> {entries.length}</span></h4>
            <button type="button" className="text-button" disabled={disabled || loading} onClick={() => void openPicker(direction)}>添加{direction === "before" ? "前置" : "后续"}</button>
          </div>
          {entries.length === 0 ? <p className="todo-drawer-none">{direction === "before" ? "没有前置，可以直接开始。" : "没有事项在等它。"}</p> : <ul className="todo-dependency-list">{entries.map(entry => row(entry, direction))}</ul>}
        </section>;
      })}
      {(item.dependencyCycle?.length ?? 0) > 0 ? <p className="todo-dependency-warning" role="alert">循环依赖：{item.dependencyCycle!.join(" → ")}。请解除其中一条关联。</p> : null}
      {dependencyLabel(item) === null ? null : <p className="todo-dependency-meta">{dependencyLabel(item)}。依赖变化不会自动改变事项状态。</p>}
      {error !== null && picker === null ? <p className="form-error" role="alert">{error}</p> : null}
      {picker === null ? null : <ModalDialog title={picker === "before" ? "添加前置" : "添加后续"} size="compact" dismissible={!saving} onClose={() => setPicker(null)}
        description={picker === "before" ? "当前事项要等哪些事项完成" : "哪些事项要等当前事项完成"}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            for (let step = 1; step <= choices.length; step++) {
              const next = (current + (event.key === "ArrowDown" ? step : choices.length - step)) % choices.length;
              if (choices[next]!.reason === null) { setActive(next); break; }
            }
            requestAnimationFrame(() => option.current?.scrollIntoView?.({ block: "nearest" }));
          } else if (event.key === "Enter" && event.target === field.current) { event.preventDefault(); pick(current); }
        }}>
        <div className="todo-move">
          <input ref={field} type="search" autoFocus role="combobox" aria-expanded="true" aria-controls={`${id}-choices`}
            aria-activedescendant={choices[current] === undefined ? undefined : `${id}-${current}`} aria-label="搜索事项或清单" placeholder="搜索事项或清单" value={query} disabled={saving}
            onChange={event => { setQuery(event.currentTarget.value); setActive(0); }} />
          {loading ? <p role="status">正在读取所有清单…</p> : choices.length === 0 ? <p className="todo-move-none">没有匹配的事项。</p> :
            <ul id={`${id}-choices`} role="listbox" aria-label="选择事项" className="todo-move-lists">{choices.map(({ node, reason }, index) =>
              <li key={`${node.list.id}:${node.item.number}`} id={`${id}-${index}`} ref={index === current ? option : undefined} role="option" aria-selected={index === current} aria-disabled={reason !== null || saving || undefined} data-active={index === current || undefined}
                onMouseEnter={() => setActive(index)} onClick={() => pick(index)}>
                <span className="todo-move-name"><StatusGlyph status={node.item.status} /> {node.item.title}</span>
                <span className="todo-move-meta">{node.list.title} · {statusLabel(node.item.status)}{reason === null ? "" : ` · ${reason}`}</span>
              </li>)}</ul>}
          {error === null ? null : <p className="form-error" role="alert">{error}</p>}
          <p className="todo-move-note">包含已完成和归档清单。只有“已完成”满足前置；已放弃的事项需要确认。</p>
        </div>
      </ModalDialog>}
    </section>
  );
};
