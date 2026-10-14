import { useEffect, useRef, useState } from "react";
import type { DecisionApi, LocalDecisionPage } from "../../../../shared/renderer-api.js";
import { zonedFormatter } from "../../../calendar-date.js";
import { ActionIcon } from "../../IconButton.js";
import { ModalDialog, usePageShownAgain } from "../../ModalDialog.js";

const dateFormatter = zonedFormatter({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const LocalDecisionList = ({ api }: { api: DecisionApi }) => {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<LocalDecisionPage>({ records: [], total: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<"publish" | "discard" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  usePageShownAgain(() => setRevision(value => value + 1));
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listLocalDecisions(query, offset).then(result => {
      if (!active) return;
      if (!result.records.length && offset > 0) { setOffset(Math.max(0, offset - 100)); return; }
      setPage(result);
      setSelected(ids => ids.filter(id => result.records.some(record => record.id === id)));
    }).catch(caught => { if (active) { setPage({ records: [], total: 0 }); setSelected([]); setError(`本机记录读取失败：${caught instanceof Error ? caught.message : String(caught)}`); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, query, offset, revision]);
  const resolve = async (): Promise<void> => {
    if (!action || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    let done = 0;
    try {
      for (const id of selected) {
        await api.resolveLocalDecision(id, action);
        done++;
        setSelected(ids => ids.filter(value => value !== id));
      }
      setAction(null);
      setNotice(`已${action === "publish" ? "记录到知识库" : "不再保留"} ${done} 条。`);
    } catch (caught) { setError(`已处理 ${done} 条，其余未处理：${caught instanceof Error ? caught.message : String(caught)}。可重试剩余项。`); }
    finally { busy.current = false; setSaving(false); setRevision(value => value + 1); }
  };
  return <section className="decision-library-card local-decision-list" aria-label="本机记录集中整理">
    <div className="decision-library-toolbar">
      <div className="decision-search-control"><div className="decision-search-field">
      <ActionIcon name="search" />
      <input type="search" aria-label="搜索本机记录" maxLength={200} value={query} disabled={saving}
        placeholder="搜索项目、问题、选择或理由" onChange={event => { setQuery(event.target.value); setOffset(0); setSelected([]); setError(null); }} />
      </div></div>
      <button className="secondary-button" type="button" disabled={loading || saving} onClick={() => { setError(null); setRevision(value => value + 1); }}>刷新</button>
      <button className="secondary-button" type="button" disabled={loading || saving || !page.records.length}
        onClick={() => setSelected(selected.length === page.records.length ? [] : page.records.map(record => record.id))}>全选本页</button>
      <button className="primary-button" type="button" disabled={loading || saving || !selected.length} onClick={() => { setError(null); setAction("publish"); }}>记录到知识库</button>
      <button className="secondary-button" type="button" disabled={loading || saving || !selected.length} onClick={() => { setError(null); setAction("discard"); }}>不保留</button>
    </div>
    <div className="local-decision-content">
    <p className="local-decision-note">仅保存在本机，不进入 Obsidian。索引重建不会删除这些记录；请随应用数据备份。</p>
    <p className="local-decision-status" role="status">{loading ? "正在读取…" : `共 ${page.total} 条 · 已选 ${selected.length} 条 · 按项目与问题集中排列`}{notice ? ` · ${notice}` : ""}</p>
    {error && !action ? <p role="alert">{error}</p> : null}
    {!loading && !error && !page.records.length ? <p>没有本机记录。采集或补充理由时，可以选择“仅本机保留”。</p> : null}
    <ul className="local-decision-records">
      {page.records.map(record => <li key={record.id}>
        <label><input type="checkbox" aria-label={`选择 ${record.question}`} checked={selected.includes(record.id)} disabled={loading || saving}
          onChange={event => setSelected(ids => event.target.checked ? [...ids, record.id] : ids.filter(id => id !== record.id))} />
          <strong>{record.question}</strong></label>
        <p>{record.project} · {dateFormatter.format(new Date(record.created))} · {record.sourceClient}</p>
        <p>选择：{record.selectedAnswer.values.join("、")}</p>
        <details><summary>查看理由与上下文</summary>
          <p className="local-decision-text">{record.rationaleOriginal ?? "没有补充理由"}</p>
          {record.reasonFactors.length ? <p>判断依据：{record.reasonFactors.join("、")}</p> : null}
          {record.expectedOutcome ? <p>预期：{record.expectedOutcome}</p> : null}
          {record.context ? <p className="local-decision-text">{[record.context.taskBackground, record.context.decisionFraming].filter(Boolean).join("\n")}</p> : null}
          {record.options.map((option, index) => <p key={index}>{option.label}{option.description ? `：${option.description}` : ""}</p>)}
        </details>
      </li>)}
    </ul>
    </div>
    <div className="decision-library-toolbar local-decision-pagination">
      <button className="secondary-button" type="button" disabled={loading || saving || offset === 0} onClick={() => { setOffset(value => Math.max(0, value - 100)); setSelected([]); }}>上一页</button>
      <button className="secondary-button" type="button" disabled={loading || saving || offset + page.records.length >= page.total} onClick={() => { setOffset(value => value + 100); setSelected([]); }}>下一页</button>
    </div>
    {action ? <ModalDialog title={action === "publish" ? "记录到知识库？" : "不保留所选本机记录？"} size="compact" dismissible={!saving}
      description={action === "publish" ? "所选记录将逐条写入 Obsidian，成功后从本机整理列表移出。" : "将永久删除所选记录正文，无法从 Obsidian 或重建索引恢复。"}
      onClose={() => { setAction(null); setError(null); }}>
      <p>已选择 {selected.length} 条。</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="modal-form-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={() => { setAction(null); setError(null); }}>取消</button>
        <button className="primary-button" type="button" disabled={saving || loading || !selected.length} onClick={() => void resolve()}>{saving ? "处理中…" : action === "publish" ? "确认记录到知识库" : "确认不保留"}</button>
      </div>
    </ModalDialog> : null}
  </section>;
};
