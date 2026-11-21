import { useState } from "react";
import type { TodoAnnotations } from "@cognelis/decision-protocol";

import type { ReadingLayerApi } from "./TodoReadingLayer.js";

type Links = TodoAnnotations["beforeStart"][string];

/** 事项详情里的「开始前要看」：已采纳的整理关联。相关不等于适用，范围与例外照写；不改事项正文和处置备注。 */
export const BeforeStart = ({ api, links, onChanged }: { api: ReadingLayerApi; links: Links; onChanged(): void }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (links.length === 0) return null;
  const remove = async (suggestionId: string, revision: number): Promise<void> => {
    setBusy(suggestionId);
    try {
      const result = await api.undoSuggestion({ id: suggestionId, expectedRevision: revision });
      setMessage(result.status === "saved" ? "已取消这条关联，事项正文没有变化。" : (result.message ?? "没能取消，请刷新后再试。"));
      onChanged();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(null); }
  };
  return (
    <section className="org-before-start" aria-label="开始前要看">
      <h4>开始前要看</h4>
      <ul>
        {links.map((link) => (
          <li key={`${link.suggestionId}-${link.key}`}>
            <strong>{link.title}</strong>
            <p>{link.whyRelevant}</p>
            <p className="org-muted">范围与例外：{link.scopeNote ?? "没有标明范围，使用前需核对"}（相关不等于适用）</p>
            <button type="button" className="text-button" disabled={busy === link.suggestionId} onClick={() => void remove(link.suggestionId, link.revision)}>取消这条关联</button>
          </li>
        ))}
      </ul>
      {message === null ? null : <p className="org-muted" role="status">{message}</p>}
    </section>
  );
};
