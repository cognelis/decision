import { useEffect, useId, useRef, useState } from "react";
import { decisionFeedbackQuerySchema, decisionSourceOf, decisionFeedbackUpdateSchema, type DecisionContextResult, type DecisionFeedbackResponse, type DecisionFeedbackUpdate } from "@cognelis/decision-protocol";
import type { DecisionEvidenceApi } from "../../../../shared/renderer-api.js";

const ratings = { helpful: "确实有帮助", not_applicable: "相关但不适用", insufficient_context: "信息不足", irrelevant: "与任务无关" } as const;
const sourceStates = { current: "当前原文版本", changed: "对应旧版原文", missing: "原文已缺失", unavailable: "原文暂不可核对" } as const;
type Api = Pick<DecisionEvidenceApi, "saveDecisionContextFeedback" | "getDecisionContextFeedback">;
/** The disclosure's mark, turned down when open (styles.css). */
export const Chevron = () => <svg className="decision-evidence-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 3 3 3-3 3" /></svg>;
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
  const fieldId = useId();
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
    setDraft({ feedbackId: crypto.randomUUID(), expectedRevision: 0, reference: { source: decisionSourceOf(record), recordId: record.id, expectedContentHash: record.sourceRef.contentHash! }, task: "", rating: "insufficient_context", reason: "", withdrawn: false });
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
  // A save's failure is said in the form, above its buttons; a read's under the panel's own buttons.
  const failed = error && <p role="alert" className="form-error">{error}</p>;
  return <details className="decision-feedback-panel" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><Chevron /><span>使用反馈</span>{data ? <small>{data.activeCount} 条未撤回</small> : null}</summary>
    <div className="decision-evidence-body">
      <p className="decision-evidence-note">记录这条决策在具体任务中的帮助与局限；反馈不会改变原决策、适用范围或检索排序。</p>
      <div className="decision-evidence-actions"><button type="button" className="secondary-button" disabled={busy || loading || draft !== null || !record.sourceRef.contentHash} onClick={start}>记录使用反馈</button><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => { setError(null); void reload(offset); }}>重新读取反馈</button></div>
      {draft === null ? failed : null}
      {loading && <p className="decision-evidence-note">正在读取反馈…</p>}
      {data && <>
        {data.coverage !== "complete" && <p className="form-error">反馈或来源读取不完整，以下数量只是已读到的观察。</p>}
        <p>{Object.entries(ratings).map(([key, label]) => `${label} ${data.ratings[key as keyof typeof ratings]}`).join(" · ")}。已撤回 {data.withdrawnCount} 条。</p>
        <p className="decision-evidence-note">其中当前原文版本：{Object.entries(ratings).map(([key, label]) => `${label} ${data.currentSourceRatings[key as keyof typeof ratings]}`).join(" · ")}。数量不代表准确率。</p>
        {data.total === 0 && data.coverage === "complete" && <p className="decision-evidence-note">还没有记录使用反馈。</p>}
        {data.results.map((item) => <div key={item.record.feedbackId} className="decision-evidence-relation"><strong>{item.record.task}</strong><p className="decision-evidence-note">{ratings[item.record.rating]} · {sourceStates[item.sourceState]} · 修订 {item.record.revision}{item.record.withdrawn ? " · 已撤回" : ""}</p><p>{item.record.reason}</p>
          {item.record.history.length > 0 && <details className="decision-evidence-history"><summary><Chevron /><span>查看修订历史</span></summary>{item.record.history.map((past) => <p key={past.revision}>修订 {past.revision} · {ratings[past.rating]}{past.withdrawn ? " · 已撤回" : ""}：{past.reason}</p>)}</details>}
          {!item.record.withdrawn && <div className="decision-evidence-actions"><button type="button" className="secondary-button" disabled={busy || loading || draft !== null || item.sourceState !== "current"} onClick={() => { setError(null); setRatingChosen(true); setDraft(decisionFeedbackUpdateSchema.parse({ feedbackId: item.record.feedbackId, expectedRevision: item.record.revision, reference: item.record.reference, task: item.record.task, project: item.record.project, taskScope: item.record.taskScope, rating: item.record.rating, reason: item.record.reason, withdrawn: false })); }}>更正反馈</button><button type="button" className="secondary-button danger-button" disabled={busy || loading || draft !== null} onClick={() => { setError(null); setRatingChosen(true); setDraft({ feedbackId: item.record.feedbackId, expectedRevision: item.record.revision, reference: item.record.reference, task: item.record.task, project: item.record.project, taskScope: item.record.taskScope, rating: item.record.rating, reason: "", withdrawn: true }); }}>撤回反馈</button></div>}
        </div>)}
        {offset > 0 || data.nextOffset !== null ? <div className="decision-evidence-actions">{offset > 0 && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void reload(Math.max(0, offset - 5))}>上一页反馈</button>}{data.nextOffset !== null && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void reload(data.nextOffset!)}>下一页反馈</button>}</div> : null}
      </>}
      {draft && <fieldset className="form-fields decision-evidence-form" disabled={busy}><legend>{draft.withdrawn ? "撤回这份反馈" : draft.expectedRevision === 0 ? "记录本次使用观察" : "更正使用观察"}</legend>
        <div className="form-field"><label htmlFor={`${fieldId}-task`}>使用时的任务</label><textarea id={`${fieldId}-task`} rows={2} maxLength={1000} value={draft.task} readOnly={draft.withdrawn} onChange={(event) => setDraft({ ...draft, task: event.target.value })} /></div>
        <div className="form-fields-row">
          <div className="form-field"><label htmlFor={`${fieldId}-project`}>任务所属项目（可选）</label><input id={`${fieldId}-project`} maxLength={500} value={draft.project ?? ""} readOnly={draft.withdrawn} onChange={(event) => setDraft({ ...draft, project: event.target.value || undefined })} /></div>
          <div className="form-field"><label htmlFor={`${fieldId}-rating`}>本次使用评价</label><select id={`${fieldId}-rating`} value={ratingChosen ? draft.rating : ""} disabled={draft.withdrawn} onChange={(event) => { setRatingChosen(true); setDraft({ ...draft, rating: event.target.value as keyof typeof ratings }); }}><option value="" disabled>请选择本次使用评价</option>{Object.entries(ratings).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
        </div>
        <div className="form-field"><label htmlFor={`${fieldId}-reason`}>{draft.withdrawn ? "撤回理由" : "观察与理由"}</label><textarea id={`${fieldId}-reason`} rows={2} maxLength={2000} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></div>
        {failed}
        <div className="decision-evidence-form-actions"><button type="button" className="secondary-button" onClick={() => setDraft(null)}>取消反馈编辑</button><button type="button" className={draft.withdrawn ? "primary-button danger-button" : "primary-button"} disabled={!ratingChosen || !draft.task.trim() || !draft.reason.trim()} onClick={() => void save()}>{draft.withdrawn ? "确认撤回反馈" : "保存使用反馈"}</button></div>
      </fieldset>}
      {message && <p role="status" className="decision-evidence-message">{message}</p>}
    </div>
  </details>;
};
