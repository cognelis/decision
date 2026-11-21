import { useCallback, useEffect, useRef, useState } from "react";
import { parseTodoItemSourceKey, type TodoAnnotations } from "@cognelis/decision-protocol";

import type { DecisionApi } from "../../../../shared/renderer-api.js";

export type ReadingLayerApi = Pick<DecisionApi, "getTodoAnnotations" | "undoSuggestion">;

/** 阅读层读到的事项：只为显示标题与所在清单，不拿它当来源。 */
export interface ReadingItem { listId: string; listTitle: string; number: number; title: string; status: string }

const STATUS = { open: "待处理", in_progress: "处理中", done: "已完成", dropped: "已放弃" } as Record<string, string>;
const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

/**
 * 待办页的阅读层：已采纳的主题组（可展开，逐项列出，随时取消分组）。只是放在一起读，
 * 事项的状态、编号、所属清单都不变；成员读不到（在别的清单、已移走）就如实写「没在当前读取范围」。
 */
export const useTodoAnnotations = (api: ReadingLayerApi | undefined, listIds: readonly string[], revision: number): { annotations: TodoAnnotations | null; error: string | null; reload(): void } => {
  const [annotations, setAnnotations] = useState<TodoAnnotations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const key = listIds.join("\n");
  const reload = useCallback(() => {
    if (api === undefined) return;
    const mine = ++token.current;
    api.getTodoAnnotations({ listIds: key === "" ? [] : key.split("\n") }).then(
      (next) => { if (mine === token.current) { setAnnotations(next); setError(null); } },
      (caught: unknown) => { if (mine === token.current) setError(errorText(caught)); },
    );
  }, [api, key]);
  useEffect(reload, [reload, revision]);
  return { annotations, error, reload };
};

export const TodoGroups = ({ api, annotations, items, onOpen, onChanged }: {
  api: ReadingLayerApi;
  annotations: TodoAnnotations;
  items: readonly ReadingItem[];
  onOpen(listId: string, number: number): void;
  onChanged(): void;
}) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (annotations.groups.length === 0) return null;
  const ungroup = async (suggestionId: string, revision: number): Promise<void> => {
    setBusy(suggestionId);
    try {
      const result = await api.undoSuggestion({ id: suggestionId, expectedRevision: revision });
      setMessage(result.status === "saved" ? "已取消分组，事项本身没有变化。" : (result.message ?? "没能取消分组，请刷新后再试。"));
      onChanged();
    } catch (caught) { setMessage(errorText(caught)); } finally { setBusy(null); }
  };
  return (
    <section className="org-groups" aria-label="主题组">
      {annotations.groups.map((group) => {
        const expanded = open.has(group.suggestionId);
        const listId = `org-group-${group.suggestionId}`;
        return (
          <div key={group.suggestionId} className="org-group">
            <div className="org-group-head">
              <button type="button" className="text-button" aria-expanded={expanded} aria-controls={listId}
                onClick={() => setOpen((current) => { const next = new Set(current); if (!next.delete(group.suggestionId)) next.add(group.suggestionId); return next; })}>
                {expanded ? "▾" : "▸"} 主题组：{group.title}（{group.members.length} 条）
              </button>
              <span className="org-badge">仅分组阅读</span>
              <button type="button" className="text-button" disabled={busy === group.suggestionId} onClick={() => void ungroup(group.suggestionId, group.revision)}>取消分组</button>
            </div>
            {expanded ? (
              <ul id={listId}>
                {group.members.map((key) => {
                  const parsed = parseTodoItemSourceKey(key);
                  const item = parsed === null ? undefined : items.find((candidate) => candidate.listId === parsed.listId && candidate.number === parsed.item);
                  return (
                    <li key={key}>
                      {item === undefined || parsed === null
                        ? <span className="org-muted">{parsed === null ? key : `事项 #${parsed.item}`}（没在当前读取范围，或已移走）</span>
                        : <button type="button" className="text-button" onClick={() => onOpen(item.listId, item.number)}>#{item.number} {item.title}<span className="org-muted"> · {item.listTitle} · {STATUS[item.status] ?? item.status}</span></button>}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
      {message === null ? null : <p className="org-muted" role="status">{message}</p>}
    </section>
  );
};
