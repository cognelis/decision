import { useEffect, useRef, useState } from "react";
import { decisionFeedbackQuerySchema, decisionFeedbackUpdateSchema, type DecisionContextResult, type DecisionFeedbackResponse, type DecisionFeedbackUpdate } from "@cognelis/decision-protocol";
import type { DecisionEvidenceApi } from "../../../../shared/renderer-api.js";

const ratings = { helpful: "确实有帮助", not_applicable: "相关但不适用", insufficient_context: "信息不足", irrelevant: "与任务无关" } as const;
const sourceStates = { current: "当前原文版本", changed: "对应旧版原文", missing: "原文已缺失", unavailable: "原文暂不可核对" } as const;
type Api = Pick<DecisionEvidenceApi, "saveDecisionContextFeedback" | "getDecisionContextFeedback">;
const READ_FAILED = "反馈读取失败，请重试；不能据此认为没有反馈。";
export const DecisionFeedbackPanel = ({ api, record, onEditingChange }: { api: Api; record: DecisionContextResult; onEditingChange?(editing: boolean): void }) => {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<DecisionFeedbackResponse | null>(null);
  const [draft, setDraft] = useState<DecisionFeedbackUpdate | null>(null);
  const [ratingChosen, setRatingChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const saving = useRef(false);
  const reload = async (page = 0) => {
    const token = ++generation.current; setLoading(true);
    try {
      const result = await api.getDecisionContextFeedback(decisionFeedbackQuerySchema.parse({ source: record.source, recordId: record.id, includeWithdrawn: true, limit: 5, offset: page }));
      // Read since, the list is there: "do not take this as no feedback" stood beside it. A save's own failure stays.
      if (token === generation.current) { setData(result); setOffset(page); setError((current) => (current === READ_FAILED ? null : current)); }
    } catch { if (token === generation.current) setError(READ_FAILED); }
    finally { if (token === generation.current) setLoading(false); }
  };
  useEffect(() => { setData(null); if (expanded) void reload(); return () => { ++generation.current; }; }, [api, record.source, record.id, record.sourceRef.contentHash, expanded]);
  // As the panel's other drafts do: a feedback being written keeps the detail from an Escape or a step
  // to the next decision, which dropped it.
  const editing = draft !== null;
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  const start = () => {
    setError(null); setMessage(null); setRatingChosen(false);
    setDraft({ feedbackId: crypto.randomUUID(), expectedRevision: 0, reference: { source: record.source, recordId: record.id, expectedContentHash: record.sourceRef.contentHash! }, task: "", rating: "insufficient_context", reason: "", withdrawn: false });
  };
  const save = async () => {
    if (draft === null || saving.current) return;
    saving.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api.saveDecisionContextFeedback(decisionFeedbackUpdateSchema.parse({ ...draft, project: draft.project?.trim() || undefined }));
      if (result.status !== "saved" && result.status !== "unchanged") {
        setError(result.status === "source_changed" ? "原文版本已变化，草稿已保留。请重新核对原文后记录新的使用观察。" : result.status === "revision_conflict" ? "反馈已有新版本，草稿已保留。请重新读取列表，核对后再更正。" : "反馈未保存。请检查来源和反馈记录后重试。"); return;
      }
      setDraft(null); setMessage(draft.withdrawn ? "反馈已撤回，原始观察仍保留在历史中。" : "使用反馈已保存，未改变决策或适用范围。");
      await reload();
    } catch { setError("保存状态不确定或输入无效。草稿和编号已保留，请先重新读取列表核实，勿新建重复反馈。"); }
    finally { saving.current = false; setBusy(false); }
  };
  return <details className="decision-feedback-panel" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>使用反馈{data ? ` · ${data.activeCount} 条未撤回` : ""}</summary>
    <p>记录这条决策在具体任务中的帮助与局限；反馈不会改变原决策、适用范围或检索排序。</p>
    <div className="decision-evidence-actions"><button type="button" disabled={busy || loading || draft !== null || !record.sourceRef.contentHash} onClick={start}>记录使用反馈</button><button type="button" disabled={busy || loading} onClick={() => { setError(null); void reload(offset); }}>重新读取反馈</button></div>
    {error && <p role="alert" className="decision-evidence-error">{error}</p>}{message && <p role="status">{message}</p>}
    {loading && <p>正在读取反馈…</p>}
    {data && <>
      {data.coverage !== "complete" && <p className="decision-evidence-error">反馈或来源读取不完整，以下数量只是已读到的观察。</p>}
      <p>{Object.entries(ratings).map(([key, label]) => `${label} ${data.ratings[key as keyof typeof ratings]}`).join(" · ")}。已撤回 {data.withdrawnCount} 条。</p>
      <p>其中当前原文版本：{Object.entries(ratings).map(([key, label]) => `${label} ${data.currentSourceRatings[key as keyof typeof ratings]}`).join(" · ")}。数量不代表准确率。</p>
      {data.total === 0 && data.coverage === "complete" && <p>还没有记录使用反馈。</p>}
      {data.results.map((item) => <div key={item.record.feedbackId} className="decision-evidence-relation"><strong>{item.record.task}</strong><p>{ratings[item.record.rating]} · {sourceStates[item.sourceState]} · 修订 {item.record.revision}{item.record.withdrawn ? " · 已撤回" : ""}</p><p>{item.record.reason}</p>
        {item.record.history.length > 0 && <details><summary>查看修订历史</summary>{item.record.history.map((past) => <p key={past.revision}>修订 {past.revision} · {ratings[past.rating]}{past.withdrawn ? " · 已撤回" : ""}：{past.reason}</p>)}</details>}
        {!item.record.withdrawn && <div className="decision-evidence-actions"><button type="button" disabled={busy || loading || draft !== null || item.sourceState !== "current"} onClick={() => { setError(null); setRatingChosen(true); setDraft(decisionFeedbackUpdateSchema.parse({ feedbackId: item.record.feedbackId, expectedRevision: item.record.revision, reference: item.record.reference, task: item.record.task, project: item.record.project, taskScope: item.record.taskScope, rating: item.record.rating, reason: item.record.reason, withdrawn: false })); }}>更正反馈</button><button type="button" disabled={busy || loading || draft !== null} onClick={() => { setError(null); setRatingChosen(true); setDraft({ feedbackId: item.record.feedbackId, expectedRevision: item.record.revision, reference: item.record.reference, task: item.record.task, project: item.record.project, taskScope: item.record.taskScope, rating: item.record.rating, reason: "", withdrawn: true }); }}>撤回反馈</button></div>}
      </div>)}
      <div className="decision-evidence-actions">{offset > 0 && <button type="button" disabled={busy || loading} onClick={() => void reload(Math.max(0, offset - 5))}>上一页反馈</button>}{data.nextOffset !== null && <button type="button" disabled={busy || loading} onClick={() => void reload(data.nextOffset!)}>下一页反馈</button>}</div>
    </>}
    {draft && <fieldset className="decision-evidence-form" disabled={busy}><legend>{draft.withdrawn ? "撤回这份反馈" : draft.expectedRevision === 0 ? "记录本次使用观察" : "更正使用观察"}</legend>
      <label>使用时的任务<textarea maxLength={1000} value={draft.task} readOnly={draft.withdrawn} onChange={(event) => setDraft({ ...draft, task: event.target.value })} /></label>
      <label>任务所属项目（可选）<input maxLength={500} value={draft.project ?? ""} readOnly={draft.withdrawn} onChange={(event) => setDraft({ ...draft, project: event.target.value || undefined })} /></label>
      <label>本次使用评价<select value={ratingChosen ? draft.rating : ""} disabled={draft.withdrawn} onChange={(event) => { setRatingChosen(true); setDraft({ ...draft, rating: event.target.value as keyof typeof ratings }); }}><option value="" disabled>请选择本次使用评价</option>{Object.entries(ratings).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>{draft.withdrawn ? "撤回理由" : "观察与理由"}<textarea maxLength={2000} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
      <div className="decision-evidence-actions"><button type="button" disabled={!ratingChosen || !draft.task.trim() || !draft.reason.trim()} onClick={() => void save()}>{draft.withdrawn ? "确认撤回反馈" : "保存使用反馈"}</button><button type="button" onClick={() => setDraft(null)}>取消反馈编辑</button></div>
    </fieldset>}
  </details>;
};
