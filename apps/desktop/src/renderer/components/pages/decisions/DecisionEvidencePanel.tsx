import { IconButton, ActionIcon } from "../../IconButton.js";
import { Chevron, DecisionFeedbackPanel } from "./DecisionFeedbackPanel.js";
import { useEffect, useId, useRef, useState } from "react";
import { decisionContextQuerySchema, decisionSourceOf, decisionScopeSchema, decisionScopeUpdateSchema, decisionRelationUpdateSchema, decisionHandoffRequestSchema, type DecisionContextResult, type DecisionScope, type DecisionRelationView, type DecisionHandoffResponse } from "@cognelis/decision-protocol";
import type { AmendmentRecordView, DecisionEvidenceApi } from "../../../../shared/renderer-api.js";
import type { AmendmentFields } from "@cognelis/decision-protocol";
import { ModalDialog } from "../../ModalDialog.js";
import { localDay } from "../todos/todo-dates.js";
import { AmendmentHistory, AmendmentList, OriginalWords, Rewritten } from "./AmendmentBlocks.js";
import { FIELD_ORDER, READER, clientLabel, fieldLabels, monthDayLabel, restoreRequest, rewriteInForce, type HistoryRow } from "./amendment-view.js";

const layers = { frontend: "前端", backend: "后端", infrastructure: "基础设施", shared: "共享模块" } as const;
const dispositions = { conflict: "存在冲突", supersedes: "替代关系", unrelated: "没有关联", revoked: "撤销关系判断" } as const;
const states = { current: "有效", stale: "原文已变化，待核对", missing_source: "这条决策已删除或暂不可用", revoked: "已撤销" } as const;
const lines = (value: string) => [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
const sourceLabel = (source: string) => source === "summarize" ? "历史沉淀" : source === "principles" ? "原则" : "已记录决策";
const ref = (record: DecisionContextResult) => ({ source: decisionSourceOf(record), recordId: record.id, expectedContentHash: record.sourceRef.contentHash! });
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
  const [reading, setReading] = useState<Partial<Record<"open" | "copy", boolean>>>({});
  const [readNotices, setReadNotices] = useState<Partial<Record<"open" | "copy", { text: string; error: boolean }>>>({});
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
  // What agents added to or rewrote in this decision, kept beside its note; the note's own text is never changed by them.
  const [amend, setAmend] = useState<AmendmentRecordView | null>(null);
  const [restoring, setRestoring] = useState<{ row: HistoryRow; to: AmendmentFields } | null>(null);
  const [reapplying, setReapplying] = useState(false);
  const [amendBusy, setAmendBusy] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const fieldId = useId();
  const loadId = useRef(0);
  const searchId = useRef(0);
  const fetchRecord = async (source: DecisionContextResult["source"], id: string) => api.searchDecisionContext(decisionContextQuerySchema.parse({ source, recordId: id }));
  const reload = async () => {
    const id = ++loadId.current; setLoading(true);
    try {
      const response = await fetchRecord("decisions", decisionId);
      if (id !== loadId.current) return;
      const next = response.results[0] ?? null;
      void Promise.resolve().then(() => api.listDecisionAmendments())
        .then((overview) => { if (id === loadId.current) setAmend(overview.records.find((item) => item.source === "decisions" && item.recordId === decisionId) ?? null); })
        .catch(() => { if (id === loadId.current) setAmend(null); });
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
  const read = async (action: "open" | "copy", operation: () => Promise<string>) => {
    setReading((current) => ({ ...current, [action]: true }));
    setReadNotices(({ [action]: _previous, ...rest }) => rest);
    try {
      const text = await operation();
      setReadNotices((current) => ({ ...current, [action]: { text, error: false } }));
    } catch (caught) {
      setReadNotices((current) => ({ ...current, [action]: { text: caught instanceof Error ? caught.message : String(caught), error: true } }));
    } finally {
      setReading(({ [action]: _finished, ...rest }) => rest);
    }
  };
  const readNotice = (action: "open" | "copy") => {
    const notice = readNotices[action];
    return notice === undefined ? null : <p className={notice.error ? "form-error" : "decision-evidence-note"} role={notice.error ? "alert" : "status"}>{notice.text}</p>;
  };
  const open = (target: DecisionContextResult) => read("open", async () => {
    const result = await api.openDecisionSource(ref(target));
    if (result.status !== "opened") throw new Error(failure(result.status));
    return "已请求在 Obsidian 打开原文。";
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
  // A failure is said where it happened: in the form open (above its buttons), else under the panel's heading.
  const failedIn = scopeEditor !== null ? "scope" : relationEditor !== null ? "relation" : handoffForm ? "handoff" : "panel";
  const failureHere = (where: typeof failedIn) => (error && failedIn === where ? <p role="alert" className="form-error">{error}</p> : null);
  const lifecycle = record?.lifecycleState === "current" ? "未标记被替代" : record?.lifecycleState === "superseded" ? "已被替代" : "有效状态待核对";
  return <section className="decision-evidence-panel" aria-labelledby={`${fieldId}-title`}>
    <div className="decision-outcome-heading">
      <h4 id={`${fieldId}-title`}>适用范围与关联</h4>
      <button type="button" className="text-button decision-detail-edit" disabled={busy || loading || (editing && record !== null)} onClick={() => { setError(null); void reload(); }}>
        <ActionIcon name="refresh" />重新读取
      </button>
    </div>
    {failureHere("panel")}
    {record === null ? <p className="decision-evidence-note">{loading ? "正在核对来源…" : "当前无法读取适用范围和关联信息。"}</p> : <>
      {coverage && <p className="form-error">部分来源或关系信息未能读取，请核对原文。</p>}
      <div className="decision-evidence-actions">
        <button type="button" className="secondary-button" disabled={reading.open} onClick={() => void open(record)}>打开原文</button>
        <button type="button" className="secondary-button" disabled={busy || editing} onClick={() => { setHandoffForm(true); setProject(record.project ?? ""); setHandoff(null); }}>整理交接</button>
        <span className={`decision-evidence-state ${record.lifecycleState}`}><i aria-hidden="true" />{lifecycle}</span>
      </div>
      {readNotice("open")}
      {amend === null ? null : (() => {
        const rewrite = rewriteInForce(amend.state);
        const labels = fieldLabels("decisions");
        // The fields the page shows in their own sections (question, choice, rationale, context, expected result) are
        // marked there; here, what has no section of its own, and the history of all.
        const original: Partial<Record<keyof AmendmentFields, string>> = { summary: record.summary, appliesWhen: record.appliesWhen ?? "", caution: record.caution ?? "" };
        const rewritten = rewrite === null ? [] : (["summary", "appliesWhen", "caution"] as const).filter((field) => field in rewrite);
        const stale = amend.state.revised?.stale === true;
        return (
          <div className="decision-amend-block" role="region" aria-label="补充与修订">
            <h5>补充与修订</h5>
            {rewritten.map((field) => (
              <div className="decision-amend-field" key={field}>
                <span className="decision-amend-label">{labels[field]} <span className="amendment-tag rewritten">已被 {clientLabel(amend.state.revised!.client)} 改写 · {monthDayLabel(amend.state.revised!.at)}</span></span>
                <p><Rewritten before={original[field] ?? null} after={rewrite![field] ?? ""} /></p>
                <OriginalWords label="原话" lines={[{ name: null, text: original[field] ?? "" }]} />
              </div>
            ))}
            {stale && amend.state.revised !== null ? (
              <div className="amendment-stale" role="note">
                <p>修改已失效（原笔记已变化）：{clientLabel(amend.state.revised.client)} {monthDayLabel(amend.state.revised.at)}的修改基于旧版原文，原文之后改过，所以没有应用：{FIELD_ORDER.filter((field) => field in amend.state.revised!.values).map((field) => `${labels[field]}「${amend.state.revised!.values[field] ?? "（空）"}」`).join("；")}</p>
                {amend.contentHash === null ? null : <div className="amendment-stale-actions"><button type="button" className="secondary-button" disabled={amendBusy} onClick={() => { setAmendError(null); setReapplying(true); }}>按新原文重新应用</button></div>}
              </div>
            ) : null}
            <AmendmentList state={amend.state} title="补充（来自之后的会话）" />
            <details className="decision-amend-history" open>
              <summary><Chevron /><span>修订记录</span><small>修订 {amend.state.revision}</small></summary>
              <AmendmentHistory source="decisions" state={amend.state} today={localDay(new Date())} busy={amendBusy}
                onRestore={amend.contentHash === null ? undefined : (row, to) => { setAmendError(null); setRestoring({ row, to }); }} />
            </details>
            <p className="decision-evidence-note">决策的原笔记不会被改写：改过的内容都留有最初版本，可以恢复为改动之前。</p>
          </div>
        );
      })()}
      {!reapplying || amend === null || amend.contentHash === null || amend.state.revised === null ? null : (
        <ModalDialog title="按新原文重新应用？" description="原笔记已变化。这会把下面的修改重新写在现在的原文上；写入前请确认它们仍然符合你的意思。" size="compact" dismissible={!amendBusy} onClose={() => setReapplying(false)}
          footer={<>
            <button type="button" className="secondary-button" disabled={amendBusy} onClick={() => setReapplying(false)}>取消</button>
            <button type="button" className="primary-button" disabled={amendBusy} onClick={() => {
              setAmendBusy(true); setAmendError(null);
              void api.updateDecisionAmendment({
                amendVersion: 1, source: "decisions", recordId: decisionId, sourceClient: READER, action: "revise", basis: "user_said",
                expectedContentHash: amend.contentHash!, expectedRevision: amend.state.revision, fields: amend.state.revised!.values, reason: "原笔记变化后，在页面上确认并重新应用此前的修改",
              })
                .then(async (result) => {
                  if (result.status === "saved" || result.status === "unchanged") { setReapplying(false); setMessage("已按新原文重新应用。"); }
                  else setAmendError(result.status === "source_changed" ? "原决策刚又改过，已重新读取，请核对后再试。" : result.status === "revision_conflict" ? "这条的修订刚刚又有更新，已重新读取，请核对后再试。" : "没有保存，请重新读取后再试。");
                  await reload();
                })
                .catch((caught) => setAmendError(caught instanceof Error ? caught.message : String(caught)))
                .finally(() => setAmendBusy(false));
            }}>重新应用</button>
          </>}>
          {FIELD_ORDER.filter((field) => field in amend.state.revised!.values).map((field) => <p key={field}>{fieldLabels("decisions")[field]}：{amend.state.revised!.values[field] ?? "（空）"}</p>)}
          {amendError === null ? null : <p className="form-error" role="alert">{amendError}</p>}
        </ModalDialog>
      )}
      {restoring === null || amend === null || amend.contentHash === null ? null : (
        <ModalDialog title="恢复为这一版之前？" description="这会再写一次改写，把改动前的文字放回去；现在的改写留在修订记录里。" size="compact" dismissible={!amendBusy} onClose={() => setRestoring(null)}
          footer={<>
            <button type="button" className="secondary-button" disabled={amendBusy} onClick={() => setRestoring(null)}>取消</button>
            <button type="button" className="primary-button" disabled={amendBusy} onClick={() => {
              setAmendBusy(true); setAmendError(null);
              void api.updateDecisionAmendment(restoreRequest("decisions", decisionId, amend.contentHash!, amend.state.revision, restoring.row.revision, restoring.row.time))
                .then(async (result) => {
                  if (result.status === "saved" || result.status === "unchanged") { setRestoring(null); setMessage("已恢复为那次改写之前。"); }
                  else setAmendError(result.status === "source_changed" ? "原决策在你打开之后改过，已重新读取，请核对后再试。" : result.status === "revision_conflict" ? "这条的增补刚刚又有更新，已重新读取，请核对后再试。" : "没有保存，请重新读取后再试。");
                  await reload();
                })
                .catch((caught) => setAmendError(caught instanceof Error ? caught.message : String(caught)))
                .finally(() => setAmendBusy(false));
            }}>恢复</button>
          </>}>
          {Object.entries(restoring.to).map(([name, value]) => <p key={name}>{fieldLabels("decisions")[name as keyof AmendmentFields]}：{value ?? "（空）"}</p>)}
          {restoring.row.truncated ? <p className="amendment-stale" role="note">…（已截断，恢复会用完整原文）</p> : null}
          {amendError === null ? null : <p className="form-error" role="alert">{amendError}</p>}
        </ModalDialog>
      )}
      <div className="decision-evidence-disclosures">
        <details open={scopeEditor !== null}>
          <summary><Chevron /><span>适用范围</span><small>{record.scopeState === "stale" ? "原文变化，待核对" : record.scopeState === "unrecorded" ? "尚未记录" : record.scopeState === "unavailable" ? "读取失败" : "已记录"}</small></summary>
          <div className="decision-evidence-body">
            {scopeEditor === null ? <>
              <dl className="decision-evidence-scope">
                {Object.entries(scopeFields).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{record.applicability?.scope[key as keyof typeof scopeFields].join("、") || "未限定"}</dd></div>)}
                <div><dt>技术层次</dt><dd>{record.applicability?.scope.layers.map((item) => layers[item]).join("、") || "未限定"}</dd></div>
              </dl>
              <p className="decision-evidence-note">未限定不代表跨场景通用，仍需结合当前任务判断。</p>
              <div className="decision-evidence-actions">
                <button type="button" className="secondary-button" disabled={busy || editing || record.scopeState === "unavailable"} onClick={() => { setError(null); setScopeEditor({ base: record, scope: decisionScopeSchema.parse(record.applicability?.scope ?? {}), reason: "" }); }}>编辑范围</button>
              </div>
            </> : <fieldset disabled={busy} className="form-fields decision-evidence-form">
              <legend>编辑适用范围</legend>
              <p className="decision-evidence-note">每行一项；路径填写仓库内的目录或文件路径。未修改的仓库身份限定会保留。</p>
              {Object.entries(scopeFields).map(([key, label]) => <div className="form-field" key={key}>
                <label htmlFor={`${fieldId}-${key}`}>{label}</label>
                <textarea id={`${fieldId}-${key}`} rows={2} value={scopeEditor.scope[key as keyof typeof scopeFields].join("\n")} onChange={(event) => setScopeEditor({ ...scopeEditor, scope: { ...scopeEditor.scope, [key]: event.target.value.split("\n") } })} />
              </div>)}
              <div className="form-field">
                <span className="decision-evidence-label" id={`${fieldId}-layers`}>技术层次</span>
                <div className="decision-evidence-checks" role="group" aria-labelledby={`${fieldId}-layers`}>{Object.entries(layers).map(([key, label]) => <label key={key}><input type="checkbox" checked={scopeEditor.scope.layers.includes(key as keyof typeof layers)} onChange={(event) => setScopeEditor({ ...scopeEditor, scope: { ...scopeEditor.scope, layers: event.target.checked ? [...scopeEditor.scope.layers, key as keyof typeof layers] : scopeEditor.scope.layers.filter((item) => item !== key) } })} />{label}</label>)}</div>
              </div>
              <div className="form-field">
                <label htmlFor={`${fieldId}-scope-reason`}>修改理由</label>
                <textarea id={`${fieldId}-scope-reason`} rows={2} maxLength={2000} value={scopeEditor.reason} onChange={(event) => setScopeEditor({ ...scopeEditor, reason: event.target.value })} />
              </div>
              {failureHere("scope")}
              <div className="decision-evidence-form-actions"><button type="button" className="secondary-button" onClick={() => setScopeEditor(null)}>取消范围编辑</button><button type="button" className="primary-button" disabled={!scopeEditor.reason.trim()} onClick={() => void saveScope()}>保存范围</button></div>
            </fieldset>}
          </div>
        </details>
        <details open={relationEditor !== null}>
          <summary><Chevron /><span>关联决策</span><small>{record.relationCount ?? 0} 项判断</small></summary>
          <div className="decision-evidence-body">
            {(record.relations ?? []).map((relation) => <div className="decision-evidence-relation" key={relation.relationId}>
              <strong>{dispositions[relation.disposition]} · {relation.other.title ?? relation.other.recordId}</strong>
              <p className="decision-evidence-note">{sourceLabel(relation.other.source)} · {states[relation.state]}{relation.successor ? ` · ${relation.successor === "self" ? "当前决策" : "对方决策"}为后继` : ""}</p>
              <p>{relation.reason}</p>
              <div className="decision-evidence-actions"><button type="button" className="secondary-button" disabled={busy || editing} onClick={() => void beginRelation(relation)}>调整或撤销关系</button></div>
            </div>)}
            {record.relationCount === 0 && <p>尚无人工关系判断；不代表不存在相关决策。</p>}
            {(record.relationCount ?? 0) > (record.relations?.length ?? 0) && <p className="decision-evidence-note">还有未展示的关系，请通过交接引用核对完整记录。</p>}
            {record.successors.length > 0 && <p>后继记录：{record.successors.map((item) => `${sourceLabel(item.source ?? record.source)} / ${item.id}`).join("、")}</p>}
            {relationEditor === null ? <>
              <p className="decision-evidence-note">替代针对整条决策；只在部分场景例外时，请记录适用范围。</p>
              <div className="decision-evidence-actions"><button type="button" className="secondary-button" disabled={busy || editing} onClick={() => void beginRelation(null)}>关联另一条决策</button></div>
            </> : <fieldset disabled={busy} className="form-fields decision-evidence-form">
              <legend>确认关系</legend>
              {relationEditor.existing === null && <div className="form-field">
                <label htmlFor={`${fieldId}-query`}>查找另一条决策</label>
                <div className="decision-evidence-search">
                  <input id={`${fieldId}-query`} value={query} onChange={(event) => { setQuery(event.target.value); setMatches([]); setSearchNotice(null); }} />
                  <button type="button" className="secondary-button" disabled={!query.trim()} onClick={() => void search()}>查找决策</button>
                </div>
                {searchNotice && <p>{searchNotice}</p>}
                {matches.length === 0 ? null : <ul className="decision-evidence-matches">{matches.map((item) => <li key={`${item.source}:${item.id}`}><button type="button" onClick={() => { setRelationEditor({ ...relationEditor, other: item }); setMatches([]); }}>{sourceLabel(item.source)} · {item.title}</button></li>)}</ul>}
              </div>}
              <div className="decision-evidence-other">
                <p><span>对方：</span>{relationEditor.other?.title ?? relationEditor.existing?.other.title ?? "尚未选择或来源缺失"}</p>
                {relationEditor.other && <><p className="decision-evidence-note">{relationEditor.other.summary}</p><div className="decision-evidence-actions"><button type="button" className="secondary-button" onClick={() => void open(relationEditor.other!)}>核对对方原文</button></div></>}
              </div>
              <div className="form-fields-row">
                <div className="form-field">
                  <label htmlFor={`${fieldId}-disposition`}>关系判断</label>
                  <select id={`${fieldId}-disposition`} value={relationEditor.disposition} onChange={(event) => setRelationEditor({ ...relationEditor, disposition: event.target.value as keyof typeof dispositions })}>{Object.entries(dispositions).filter(([key]) => key !== "revoked" || relationEditor.existing !== null).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
                </div>
                {relationEditor.disposition === "supersedes" && <div className="form-field">
                  <label htmlFor={`${fieldId}-successor`}>哪条是后继决策</label>
                  <select id={`${fieldId}-successor`} value={relationEditor.successor} onChange={(event) => setRelationEditor({ ...relationEditor, successor: event.target.value as "self" | "other" })}><option value="self">当前这条决策</option><option value="other">对方决策</option></select>
                </div>}
              </div>
              <div className="form-field">
                <label htmlFor={`${fieldId}-relation-reason`}>判断理由</label>
                <textarea id={`${fieldId}-relation-reason`} rows={2} maxLength={2000} value={relationEditor.reason} aria-describedby={`${fieldId}-relation-help`} onChange={(event) => setRelationEditor({ ...relationEditor, reason: event.target.value })} />
                <p id={`${fieldId}-relation-help`}>替代针对整条决策；仅在部分场景例外时，请记录适用范围。</p>
              </div>
              {failureHere("relation")}
              <div className="decision-evidence-form-actions"><button type="button" className="secondary-button" onClick={() => setRelationEditor(null)}>取消关系编辑</button><button type="button" className="primary-button" disabled={!relationEditor.reason.trim() || (!relationEditor.other && relationEditor.disposition !== "revoked")} onClick={() => void saveRelation()}>保存关系判断</button></div>
            </fieldset>}
          </div>
        </details>
        <DecisionFeedbackPanel key={`${record.source}:${record.id}`} api={api} record={record} onEditingChange={setFeedbackEditing} />
      </div>
      {handoffForm && <fieldset disabled={busy} className="form-fields decision-evidence-form decision-evidence-handoff-form" onChange={() => setHandoff(null)}>
        <legend>整理这条决策的交接</legend>
        <div className="form-field">
          <label htmlFor={`${fieldId}-objective`}>当前任务目标</label>
          <textarea id={`${fieldId}-objective`} rows={2} maxLength={2000} value={objective} onChange={(event) => setObjective(event.target.value)} />
        </div>
        <div className="form-fields-row">
          <div className="form-field">
            <label htmlFor={`${fieldId}-project`}>当前任务项目</label>
            <input id={`${fieldId}-project`} value={project} maxLength={500} onChange={(event) => setProject(event.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor={`${fieldId}-layer`}>任务技术层次</label>
            <select id={`${fieldId}-layer`} value={layer} onChange={(event) => setLayer(event.target.value)}><option value="">尚未明确</option>{Object.entries(layers).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
          </div>
        </div>
        {([{ key: "questions", label: "未决问题", value: questions, change: setQuestions }, { key: "verification", label: "验证说明", value: verification, change: setVerification }, { key: "next", label: "后续步骤", value: nextSteps, change: setNextSteps }]).map(({ key, label, value, change }) => <div className="form-field" key={key}>
          <label htmlFor={`${fieldId}-${key}`}>{label}</label>
          <textarea id={`${fieldId}-${key}`} rows={2} value={value} onChange={(event) => change(event.target.value)} />
        </div>)}
        <p className="decision-evidence-note">每行一项，最多 10 项。这些任务信息与过往决策分开呈现。</p>
        {failureHere("handoff")}
        <div className="decision-evidence-form-actions"><button type="button" className="secondary-button" onClick={() => { setHandoffForm(false); setHandoff(null); }}>关闭交接</button><button type="button" className="primary-button" disabled={!objective.trim()} onClick={() => void generate()}>生成交接预览</button></div>
      </fieldset>}
      {handoff && <div className="decision-evidence-handoff">
        <div className="decision-evidence-handoff-head"><p>{handoff.status === "ready" ? "交接已生成，请核对后复制。" : "交接含待核对事项，请先检查来源与适用范围。"}</p><IconButton aria-label="复制交接内容" type="button" disabled={reading.copy || handoff.status === "unavailable"} onClick={() => void read("copy", async () => { try { await navigator.clipboard.writeText(handoff.markdown); return "交接内容已复制。"; } catch { throw new Error("复制失败，可以在下方选中交接内容后手动复制。"); } })}><ActionIcon name="copy" /></IconButton></div>
        {readNotice("copy")}
        <textarea aria-label="交接内容" readOnly rows={12} value={handoff.markdown} />
      </div>}
    </>}
    {message && <p role="status" className="decision-evidence-message">{message}</p>}
  </section>;
};
