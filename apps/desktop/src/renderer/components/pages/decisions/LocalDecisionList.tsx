import { DecisionDeletionDialog } from "./DecisionDeletionDialog.js";
import { sourceLabel } from "../../../client-labels.js";
import { useEffect, useId, useRef, useState } from "react";
import type { DecisionApi, LocalDecisionPage } from "../../../../shared/renderer-api.js";
import { zonedFormatter } from "../../../calendar-date.js";
import { ActionIcon, IconButton } from "../../IconButton.js";
import { ModalDialog, usePageShownAgain } from "../../ModalDialog.js";
import { plainHeadline } from "../../question-title.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { Chevron } from "./DecisionFeedbackPanel.js";

const dateFormatter = zonedFormatter({ year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const LocalDecisionList = ({ api }: { api: DecisionApi }) => {
  // Each row's 删除 says which record it is for.
  const idPrefix = useId();
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<LocalDecisionPage>({ records: [], total: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<"publish" | "discard" | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // A read that failed is not an empty list: said in its place, with a way to read again, and the count not given.
  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  usePageShownAgain(() => setRevision(value => value + 1));
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.listLocalDecisions(query, offset).then(result => {
      if (!active) return;
      if (!result.records.length && offset > 0) { setOffset(Math.max(0, offset - 100)); return; }
      setPage(result);
      setReadFailed(null);
      setSelected(ids => ids.filter(id => result.records.some(record => record.id === id)));
    }).catch(caught => { if (active) { setPage({ records: [], total: 0 }); setSelected([]); setReadFailed(`本机记录读取失败：${caught instanceof Error ? caught.message : String(caught)}`); } })
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
  const closeAction = () => { setAction(null); setError(null); };
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
      {/* What ends a record for good sits apart, before the one solid button. */}
      <button className="secondary-button danger-button local-decision-discard" type="button" disabled={loading || saving || !selected.length} onClick={() => { setError(null); setAction("discard"); }}>不保留</button>
      <button className="primary-button" type="button" disabled={loading || saving || !selected.length} onClick={() => { setError(null); setAction("publish"); }}>记录到知识库</button>
    </div>
    <div className="local-decision-content">
    <p className="local-decision-note">仅保存在本机，不进入 Obsidian。索引重建不会删除这些记录；请随应用数据备份。</p>
    <p className="local-decision-status" role="status">{loading ? "正在读取…" : readFailed !== null ? "共 — 条" : `共 ${page.total} 条 · 已选 ${selected.length} 条 · 按项目与问题集中排列`}{notice ? ` · ${notice}` : ""}</p>
    {readFailed === null ? null : (
      <p className="load-failure" role="alert">
        {readFailed}
        <button className="secondary-button" type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>重试</button>
      </p>
    )}
    {!loading && readFailed === null && !page.records.length ? (
      <div className="decision-library-empty">
        <strong>{query ? "没有匹配的本机记录" : "没有本机记录"}</strong>
        <span>{query ? "换个关键词再试。" : "采集或补充理由时，可以选择“仅本机保留”。"}</span>
      </div>
    ) : null}
    <ul className="local-decision-records">
      {page.records.map(record => <li key={record.id}>
        <div className="local-decision-row">
          <input type="checkbox" aria-label={`选择 ${plainHeadline(record.question)}`} checked={selected.includes(record.id)} disabled={loading || saving}
            onChange={event => setSelected(ids => event.target.checked ? [...ids, record.id] : ids.filter(id => id !== record.id))} />
          <span className="local-decision-copy">
            <strong id={`${idPrefix}-${record.id}`}>{plainHeadline(record.question)}</strong>
            <span>选择：{record.selectedAnswer.values.join("、")}</span>
          </span>
          <span className="local-decision-meta">
            {record.project} · {dateFormatter.format(new Date(record.created))} · {sourceLabel(record.sourceClient)}
          </span>
          <IconButton className="row-delete-button" aria-label="删除" title="删除这条本机记录" aria-describedby={`${idPrefix}-${record.id}`}
            disabled={loading || saving} onClick={() => setDeleting(record.id)}>
            <ActionIcon name="trash" />
          </IconButton>
        </div>
        {/* The row's title is two lines of the question: the whole of it is here, to tell two records apart before either is published or deleted. */}
        <details className="local-decision-details"><summary><Chevron />查看问题全文、理由与上下文</summary>
          <dl>
            <div><dt>问题</dt><dd><div className="assistant-answer">{renderMarkdown(record.question)}</div></dd></div>
            <div><dt>理由</dt><dd className={record.rationaleOriginal ? undefined : "missing"}>{record.rationaleOriginal ?? "没有补充理由"}</dd></div>
            {record.reasonFactors.length ? <div><dt>判断依据</dt><dd>{record.reasonFactors.join("、")}</dd></div> : null}
            {record.expectedOutcome ? <div><dt>预期</dt><dd>{record.expectedOutcome}</dd></div> : null}
            {record.context ? <div><dt>当时上下文</dt><dd>{[record.context.taskBackground, record.context.decisionFraming].filter(Boolean).join("\n")}</dd></div> : null}
            {record.options.length ? <div><dt>选项</dt><dd>{record.options.map((option, index) => <span key={index}>{option.label}{option.description ? `：${option.description}` : ""}</span>)}</dd></div> : null}
          </dl>
        </details>
      </li>)}
    </ul>
    </div>
    {/* Only where there is more than one page to move between. */}
    {page.total > page.records.length || offset > 0 ? (
      <div className="decision-library-toolbar local-decision-pagination">
        <button className="secondary-button" type="button" disabled={loading || saving || offset === 0} onClick={() => { setOffset(value => Math.max(0, value - 100)); setSelected([]); }}>上一页</button>
        <button className="secondary-button" type="button" disabled={loading || saving || offset + page.records.length >= page.total} onClick={() => { setOffset(value => value + 100); setSelected([]); }}>下一页</button>
      </div>
    ) : null}
    {deleting === null ? null : <DecisionDeletionDialog api={api} target={{ id: deleting, storage: "local" }} onClose={() => setDeleting(null)} onDeleted={(result) => {
      setDeleting(null); setNotice(result.warnings.join(" ") || "已永久删除这条本机决策。"); setRevision(value => value + 1);
    }} />}
    {action === "publish" ? <ModalDialog title={`记录 ${selected.length} 条到知识库？`} size="compact" dismissible={!saving} onClose={closeAction}
      footer={<>
        <button className="secondary-button" type="button" autoFocus disabled={saving} onClick={closeAction}>取消</button>
        <button className="primary-button" type="button" disabled={saving || loading || !selected.length} onClick={() => void resolve()}>{saving ? "正在记录…" : "记录到知识库"}</button>
      </>}>
      <p>所选记录会逐条写入 Obsidian，写入成功的从本机整理列表移出。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </ModalDialog> : action === "discard" ? <ModalDialog title={`不保留所选 ${selected.length} 条本机记录？`} size="compact" dismissible={!saving} onClose={closeAction}
      footer={<>
        <button className="secondary-button" type="button" autoFocus disabled={saving} onClick={closeAction}>取消</button>
        <button className="primary-button danger-button" type="button" disabled={saving || loading || !selected.length} onClick={() => void resolve()}>{saving ? "正在处理…" : "不保留"}</button>
      </>}>
      <p>所选记录的正文会永久删除，无法从 Obsidian 或重建索引恢复。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </ModalDialog> : null}
  </section>;
};
