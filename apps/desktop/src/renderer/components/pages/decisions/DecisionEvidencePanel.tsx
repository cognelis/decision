import { IconButton, ActionIcon } from "../../IconButton.js";
import { DecisionFeedbackPanel } from "./DecisionFeedbackPanel.js";
import { useEffect, useRef, useState } from "react";
import { decisionContextQuerySchema, decisionScopeSchema, decisionScopeUpdateSchema, decisionRelationUpdateSchema, decisionHandoffRequestSchema, type DecisionContextResult, type DecisionScope, type DecisionRelationView, type DecisionHandoffResponse } from "@cognelis/decision-protocol";
import type { DecisionEvidenceApi } from "../../../../shared/renderer-api.js";

const layers = { frontend: "前端", backend: "后端", infrastructure: "基础设施", shared: "共享模块" } as const;
const dispositions = { conflict: "存在冲突", supersedes: "替代关系", unrelated: "没有关联", revoked: "撤销关系判断" } as const;
const states = { current: "有效", stale: "原文已变化，待核对", missing_source: "来源缺失", revoked: "已撤销" } as const;
const lines = (value: string) => [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
const sourceLabel = (source: string) => source === "summarize" ? "历史沉淀" : source === "principles" ? "原则" : "已记录决策";
const ref = (record: DecisionContextResult) => ({ source: record.source, recordId: record.id, expectedContentHash: record.sourceRef.contentHash! });
const failure = (status: string) => ({ source_changed: "原文已改变。请保留当前草稿，取消编辑并重新读取后核对。", revision_conflict: "已有更新的范围或关系版本。请取消编辑，重新读取后核对草稿。", source_unavailable: "来源未能完整读取，请检查原文是否缺失、重复或损坏。", cycle_rejected: "这项替代会形成循环，请核对替代方向。", relation_not_found: "关系已不存在，请重新读取。", open_failed: "无法打开原文，请检查 Obsidian 是否可用。" })[status] ?? "操作未完成，请重新读取后核对。";
const scopeFields = { projects: "适用项目", modules: "适用模块", paths: "适用路径", excludedPaths: "排除路径", exceptions: "适用例外" } as const;
// What a handoff tells of a decision beyond its note's text: its standing, scope and relations, kept beside the note
// and outside its hash. Its applicability is reckoned for the handoff's own task, so it is not compared.
const standing = (record: DecisionContextResult | null | undefined): string | null =>
  record === null || record === undefined ? null : JSON.stringify([
    record.sourceRef.contentHash, record.lifecycleState, record.scopeState, record.scopeRevision, record.relationCount,
    record.relations?.map((relation) => [relation.relationId, relation.revision, relation.state]), record.successors,
  ]);
type ScopeEditor = { base: DecisionContextResult; scope: DecisionScope; reason: string };
type RelationEditor = { base: DecisionContextResult; existing: DecisionRelationView | null; other: DecisionContextResult | null; disposition: keyof typeof dispositions; successor: "self" | "other"; reason: string };

export const DecisionEvidencePanel = ({ api, decisionId, revision, onEditingChange }: { api: DecisionEvidenceApi; decisionId: string; revision: string; onEditingChange?(editing: boolean): void }) => {
  const [record, setRecord] = useState<DecisionContextResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [coverage, setCoverage] = useState(false);
  const [scopeEditor, setScopeEditor] = useState<ScopeEditor | null>(null);
  const [relationEditor, setRelationEditor] = useState<RelationEditor | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<DecisionContextResult[]>([]);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const [handoffForm, setHandoffForm] = useState(false);
  const [feedbackEditing, setFeedbackEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [project, setProject] = useState("");
  const [layer, setLayer] = useState("");
  const [questions, setQuestions] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [verification, setVerification] = useState("");
  const [handoff, setHandoff] = useState<DecisionHandoffResponse | null>(null);
  const loadId = useRef(0);
  const searchId = useRef(0);
  const fetchRecord = async (source: DecisionContextResult["source"], id: string) => api.searchDecisionContext(decisionContextQuerySchema.parse({ source, recordId: id }));
  const reload = async () => {
    const id = ++loadId.current; setLoading(true);
    try {
      const response = await fetchRecord("decisions", decisionId);
      if (id !== loadId.current) return;
      const next = response.results[0] ?? null;
      setRecord(next); setCoverage(response.coverage !== "complete");
      // A preview stays while what it was made from is as it was: cleared at every re-read, the one being copied
      // went whenever any other decision was indexed. Its note's hash alone kept one saying "current" under 已被替代.
      setHandoff((shown) => shown?.evidence.every((item) => standing(item.record) === standing(next)) ? shown : null);
      // Read now: a failure to read it before is no longer so.
      setError(response.results.length === 0 ? "未能读取这条决策的来源，请检查笔记后重新读取。" : null);
    } catch { if (id === loadId.current) setError("读取来源失败，请重新读取。"); }
    finally { if (id === loadId.current) setLoading(false); }
  };
  // A re-read (another decision indexed, the page shown again) leaves what is shown, and a search under way, as they
  // are: replaced by 正在核对来源… meanwhile, a feedback being written went with the panel it lived in.
  useEffect(() => { void reload(); return () => { ++loadId.current; }; }, [api, decisionId, revision]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); } catch (caught) { setError(caught instanceof Error && !caught.message.includes('"code"') ? caught.message : "请检查输入：路径每行一项，填写有效范围和修改理由。"); }
    finally { setBusy(false); }
  };
  const open = (target: DecisionContextResult) => run(async () => {
    const result = await api.openDecisionSource(ref(target));
    if (result.status !== "opened") throw new Error(failure(result.status));
    setMessage("已请求在 Obsidian 打开原文。");
  });
  const saveScope = () => run(async () => {
    if (scopeEditor === null) return;
    const result = await api.updateDecisionScope(decisionScopeUpdateSchema.parse({ ...ref(scopeEditor.base), expectedRevision: scopeEditor.base.scopeRevision ?? 0, scope: { ...scopeEditor.scope, ...Object.fromEntries(Object.keys(scopeFields).map((key) => [key, lines(scopeEditor.scope[key as keyof typeof scopeFields].join("\n"))])) }, changeReason: scopeEditor.reason }));
    if (result.status !== "saved" && result.status !== "unchanged") throw new Error(failure(result.status));
    setScopeEditor(null); setMessage("适用范围已保存。"); await reload();
  });
  const beginRelation = (existing: DecisionRelationView | null) => run(async () => {
    if (record === null) return;
    let other: DecisionContextResult | null = null;
    if (existing !== null) other = (await fetchRecord(existing.other.source, existing.other.recordId)).results[0] ?? null;
    setRelationEditor({ base: record, existing, other, disposition: existing?.disposition ?? "conflict", successor: existing?.successor ?? "other", reason: "" });
    setMatches([]); setQuery(""); setSearchNotice(null);
  });
  const search = () => run(async () => {
    const id = ++searchId.current;
    const responses = await Promise.all((["decisions", "summarize"] as const).map((source) => api.searchDecisionContext(decisionContextQuerySchema.parse({ source, query, limit: 10 }))));
    if (id !== searchId.current) return;
    setMatches(responses.flatMap((response) => response.results).filter((item) => !(item.source === "decisions" && item.id === decisionId)));
    setSearchNotice(responses.some((response) => response.coverage !== "complete") ? "部分来源未能读取，结果可能不完整。" : responses.some((response) => response.nextOffset !== null) ? "仅展示部分结果，请用更具体的关键词或编号查找。" : "请选择已核对过的记录；相似内容不代表存在关系。");
  });
  const saveRelation = () => run(async () => {
    if (relationEditor === null) return;
    const { base, other, existing, disposition, successor, reason } = relationEditor;
    if (disposition !== "revoked" && other === null) throw new Error("请选择可读取的另一条决策。");
    const anchors = disposition === "revoked" && existing !== null ? { first: existing.first, second: existing.second } : { first: { source: base.source, recordId: base.id, contentHash: base.sourceRef.contentHash }, second: { source: other!.source, recordId: other!.id, contentHash: other!.sourceRef.contentHash } };
    const result = await api.updateDecisionRelation(decisionRelationUpdateSchema.parse({ ...anchors, disposition, successor: disposition === "supersedes" ? successor === "self" ? "first" : "second" : null, expectedRevision: existing?.revision ?? 0, reason }));
    if (result.status !== "saved" && result.status !== "unchanged") throw new Error(failure(result.status));
    setRelationEditor(null); setMessage("关系判断已保存。"); await reload();
  });
  const generate = () => run(async () => {
    if (record === null) return;
    setHandoff(null);
    const result = await api.prepareDecisionHandoff(decisionHandoffRequestSchema.parse({ objective, references: [ref(record)], ...(project.trim() ? { project: project.trim() } : {}), ...(layer ? { taskScope: { layer } } : {}), openQuestions: lines(questions), nextSteps: lines(nextSteps), verification: lines(verification) }));
    setHandoff(result);
    if (result.status === "unavailable") setError("来源版本已变化或不可读取；请重新读取原文后再生成交接。");
  });
  const editing = scopeEditor !== null || relationEditor !== null || handoffForm || feedbackEditing;
  // The detail around this panel steps to other decisions; it has to know a
  // draft is open here, or moving on would drop it with the unmount.
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  return <section className="decision-evidence-panel" aria-label="适用范围与关联">
    <div className="decision-evidence-heading"><h3>适用范围与关联</h3><button type="button" disabled={busy || loading || (editing && record !== null)} onClick={() => { setError(null); void reload(); }}>重新读取</button></div>
    {message && <p role="status" className="decision-evidence-message">{message}</p>}
    {error && <p role="alert" className="decision-evidence-error">{error}</p>}
    {record === null ? <p>{loading ? "正在核对来源…" : "当前无法读取适用范围和关联信息。"}</p> : <>
      {coverage && <p className="decision-evidence-error">部分来源或关系信息未能读取，请核对原文。</p>}
      <div className="decision-evidence-actions"><button type="button" disabled={busy} onClick={() => void open(record)}>打开原文</button><button type="button" disabled={busy || editing} onClick={() => { setHandoffForm(true); setProject(record.project ?? ""); setHandoff(null); }}>整理交接</button><span>{record.lifecycleState === "current" ? "未标记被替代" : record.lifecycleState === "superseded" ? "已被替代" : "有效状态待核对"}</span></div>
      <details open={scopeEditor !== null}><summary>适用范围 · {record.scopeState === "stale" ? "原文变化，待核对" : record.scopeState === "unrecorded" ? "尚未记录" : record.scopeState === "unavailable" ? "读取失败" : "已记录"}</summary>
        {scopeEditor === null ? <><dl className="decision-evidence-scope">{Object.entries(scopeFields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{record.applicability?.scope[key as keyof typeof scopeFields].join("、") || "未限定"}</dd></div>)}<div><dt>技术层次</dt><dd>{record.applicability?.scope.layers.map((item) => layers[item]).join("、") || "未限定"}</dd></div></dl><p>未限定不代表跨场景通用，仍需结合当前任务判断。</p><button type="button" disabled={busy || editing || record.scopeState === "unavailable"} onClick={() => { setError(null); setScopeEditor({ base: record, scope: decisionScopeSchema.parse(record.applicability?.scope ?? {}), reason: "" }); }}>编辑范围</button></> : <fieldset disabled={busy} className="decision-evidence-form"><legend>编辑适用范围</legend><p>每行一项；路径填写仓库内的目录或文件路径。未修改的仓库身份限定会保留。</p>{Object.entries(scopeFields).map(([key, label]) => <label key={key}>{label}<textarea rows={2} value={scopeEditor.scope[key as keyof typeof scopeFields].join("\n")} onChange={(event) => setScopeEditor({ ...scopeEditor, scope: { ...scopeEditor.scope, [key]: event.target.value.split("\n") } })} /></label>)}<div className="decision-evidence-checks">{Object.entries(layers).map(([key, label]) => <label key={key}><input type="checkbox" checked={scopeEditor.scope.layers.includes(key as keyof typeof layers)} onChange={(event) => setScopeEditor({ ...scopeEditor, scope: { ...scopeEditor.scope, layers: event.target.checked ? [...scopeEditor.scope.layers, key as keyof typeof layers] : scopeEditor.scope.layers.filter((item) => item !== key) } })} />{label}</label>)}</div><label>修改理由<textarea maxLength={2000} value={scopeEditor.reason} onChange={(event) => setScopeEditor({ ...scopeEditor, reason: event.target.value })} /></label><div className="decision-evidence-actions"><button type="button" disabled={!scopeEditor.reason.trim()} onClick={() => void saveScope()}>保存范围</button><button type="button" onClick={() => setScopeEditor(null)}>取消范围编辑</button></div></fieldset>}
      </details>
      <details open={relationEditor !== null}><summary>关联决策 · {record.relationCount ?? 0} 项判断</summary>
        {(record.relations ?? []).map((relation) => <div className="decision-evidence-relation" key={relation.relationId}><strong>{dispositions[relation.disposition]} · {relation.other.title ?? relation.other.recordId}</strong><p>{sourceLabel(relation.other.source)} · {states[relation.state]}{relation.successor ? ` · ${relation.successor === "self" ? "当前决策" : "对方决策"}为后继` : ""}</p><p>{relation.reason}</p><button type="button" disabled={busy || editing} onClick={() => void beginRelation(relation)}>调整或撤销关系</button></div>)}
        {record.relationCount === 0 && <p>尚无人工关系判断；不代表不存在相关决策。</p>}
        {(record.relationCount ?? 0) > (record.relations?.length ?? 0) && <p>还有未展示的关系，请通过交接引用核对完整记录。</p>}
        {record.successors.length > 0 && <p>后继记录：{record.successors.map((item) => `${sourceLabel(item.source ?? record.source)} / ${item.id}`).join("、")}</p>}
        {relationEditor === null ? <button type="button" disabled={busy || editing} onClick={() => void beginRelation(null)}>关联另一条决策</button> : <fieldset disabled={busy} className="decision-evidence-form"><legend>确认关系</legend>
          {relationEditor.existing === null && <><label>查找另一条决策<input value={query} onChange={(event) => { setQuery(event.target.value); setMatches([]); setSearchNotice(null); }} /></label><button type="button" disabled={!query.trim()} onClick={() => void search()}>查找决策</button>{searchNotice && <p>{searchNotice}</p>}<div className="decision-evidence-matches">{matches.map((item) => <button type="button" key={`${item.source}:${item.id}`} onClick={() => { setRelationEditor({ ...relationEditor, other: item }); setMatches([]); }}>{sourceLabel(item.source)} · {item.title}</button>)}</div></>}
          <p>对方：{relationEditor.other?.title ?? relationEditor.existing?.other.title ?? "尚未选择或来源缺失"}</p>
          {relationEditor.other && <><p>{relationEditor.other.summary}</p><button type="button" onClick={() => void open(relationEditor.other!)}>核对对方原文</button></>}
          <label>关系判断<select value={relationEditor.disposition} onChange={(event) => setRelationEditor({ ...relationEditor, disposition: event.target.value as keyof typeof dispositions })}>{Object.entries(dispositions).filter(([key]) => key !== "revoked" || relationEditor.existing !== null).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
          {relationEditor.disposition === "supersedes" && <label>哪条是后继决策<select value={relationEditor.successor} onChange={(event) => setRelationEditor({ ...relationEditor, successor: event.target.value as "self" | "other" })}><option value="self">当前这条决策</option><option value="other">对方决策</option></select></label>}
          <label>判断理由<textarea maxLength={2000} value={relationEditor.reason} onChange={(event) => setRelationEditor({ ...relationEditor, reason: event.target.value })} /></label><p>替代针对整条决策；仅在部分场景例外时，请记录适用范围。</p><div className="decision-evidence-actions"><button type="button" disabled={!relationEditor.reason.trim() || (!relationEditor.other && relationEditor.disposition !== "revoked")} onClick={() => void saveRelation()}>保存关系判断</button><button type="button" onClick={() => setRelationEditor(null)}>取消关系编辑</button></div>
        </fieldset>}
      </details>
      <DecisionFeedbackPanel key={`${record.source}:${record.id}`} api={api} record={record} onEditingChange={setFeedbackEditing} />
      {handoffForm && <fieldset disabled={busy} className="decision-evidence-form" onChange={() => setHandoff(null)}><legend>整理这条决策的交接</legend><label>当前任务目标<textarea maxLength={2000} value={objective} onChange={(event) => setObjective(event.target.value)} /></label><div className="decision-evidence-grid"><label>当前任务项目<input value={project} maxLength={500} onChange={(event) => setProject(event.target.value)} /></label><label>任务技术层次<select value={layer} onChange={(event) => setLayer(event.target.value)}><option value="">尚未明确</option>{Object.entries(layers).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label></div>{([{ label: "未决问题", value: questions, change: setQuestions }, { label: "验证说明", value: verification, change: setVerification }, { label: "后续步骤", value: nextSteps, change: setNextSteps }]).map(({ label, value, change }) => <label key={label}>{label}<textarea rows={2} value={value} onChange={(event) => change(event.target.value)} /></label>)}<p>每行一项，最多 10 项。这些任务信息与历史决策分开呈现。</p><div className="decision-evidence-actions"><button type="button" disabled={!objective.trim()} onClick={() => void generate()}>生成交接预览</button><button type="button" onClick={() => { setHandoffForm(false); setHandoff(null); }}>关闭交接</button></div></fieldset>}
      {handoff && <div className="decision-evidence-handoff"><p>{handoff.status === "ready" ? "交接已生成，请核对后复制。" : "交接含待核对事项，请先检查来源与适用范围。"}</p><textarea aria-label="交接内容" readOnly rows={12} value={handoff.markdown} /><IconButton aria-label="复制交接内容" type="button" disabled={busy || handoff.status === "unavailable"} onClick={() => void run(async () => { try { await navigator.clipboard.writeText(handoff.markdown); setMessage("交接内容已复制。"); } catch { throw new Error("复制失败，可以在上方选中交接内容后手动复制。"); } })}><ActionIcon name="copy" /></IconButton></div>}
    </>}
  </section>;
};
