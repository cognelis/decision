import { useEffect, useRef, useState } from "react";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import type { DecisionDeletionTarget, DecisionDeletionPreview, DecisionDeletionResult } from "../../../../shared/decision-deletion.js";
import { ModalDialog } from "../../ModalDialog.js";
import { plainHeadline } from "../../question-title.js";

export const DecisionDeletionDialog = ({ api, target, onClose, onDeleted }: {
  api: Pick<DecisionApi, "previewDecisionDeletion" | "deleteDecision">;
  target: DecisionDeletionTarget;
  onClose(): void;
  onDeleted(result: DecisionDeletionResult): void;
}) => {
  const [preview, setPreview] = useState<DecisionDeletionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    let active = true; setLoading(true); setPreview(null); setError(null);
    void api.previewDecisionDeletion(target).then(value => { if (active) setPreview(value); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "读取删除影响失败，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, target.id, target.storage, revision]);
  const confirm = async (misrecognized: boolean) => {
    if (busy.current || preview === null) return;
    busy.current = true; setSaving(true); setError(null);
    try { onDeleted(await api.deleteDecision({ id: target.id, storage: target.storage, expectedContentHash: preview.contentHash, ...(misrecognized ? { misrecognized } : {}), ...(organization === undefined ? {} : { expectedOrganizationPreviewHash: organization.previewHash }) })); }
    catch (caught) { setPreview(null); setError(caught instanceof Error ? caught.message : "删除未完成，请重新读取后核对。"); }
    finally { busy.current = false; setSaving(false); }
  };
  // 整理与记忆（IMP-191）：删除会一并清掉的东西，照预览逐项写出；预览不全就不让确认，确认带回看过的哈希。
  const organization = preview?.organization;
  const organizationBlocked = organization !== undefined && !organization.complete;
  // Nothing points at it: the one sentence on where it goes is all there is to weigh.
  const referenced = preview !== null && (preview.evidencePrinciples + preview.adoptedPrinciples + preview.relations > 0 || preview.batchId !== null || preview.deferredHeld);
  // A confirmation (画板「二级页面 · 确认与危险操作」): what happens and whether it comes back, the decision framed, what
  // refers to it listed; 取消 first and focused, the one solid button the deletion, at the end.
  return <ModalDialog title="删除这条决策？" size="compact" onClose={onClose} dismissible={!saving}
    footer={<>
      <button className="secondary-button" type="button" autoFocus disabled={saving} onClick={onClose}>取消</button>
      {(error && preview === null) || organizationBlocked ? <button className="secondary-button" type="button" disabled={saving || loading} onClick={() => setRevision(value => value + 1)}>重新读取</button> : null}
      {preview?.captured ? <button className="secondary-button danger-button" type="button" disabled={saving || loading || organizationBlocked} onClick={() => void confirm(true)}>识别错误，删除</button> : null}
      <button className="primary-button danger-button" type="button" disabled={saving || loading || preview === null || organizationBlocked} onClick={() => void confirm(false)}>{saving ? "正在删除…" : "删除"}</button>
    </>}>
    <p>{target.storage === "vault" ? "笔记会移到系统废纸篓，可以从废纸篓恢复。" : "本机记录将永久删除，无法恢复。"}</p>
    {loading ? <p className="decision-deletion-note" role="status">正在核对删除影响…</p> : null}
    {preview ? <>
      <div className="modal-decision-summary">
        <strong>{plainHeadline(preview.question)}</strong>
        <span>{preview.selectedAnswer ? `选择：${preview.selectedAnswer}` : `项目：${preview.project}`}</span>
      </div>
      {referenced ? <>
      <ul className="decision-deletion-impact">
        <li>被 {preview.evidencePrinciples} 条原则用作证据。</li>
        <li>关联采用的原则 {preview.adoptedPrinciples} 条。</li>
        <li>人工关系（含历史）{preview.relations} 条。</li>
      </ul>
      {preview.deferredHeld ? <p className="decision-deletion-note">这条还在待补理由队列里，删除后不再提醒补理由。</p> : null}
      {preview.batchId !== null ? <p className="decision-deletion-note">属于同一批多问题记录，只删除这一条，其他记录保留。</p> : null}
      <p className="decision-deletion-note">原则和人工关系保留，缺失的引用会标明这条决策已删除或暂不可用。已确认的独立选择保留。</p>
      </> : null}
      {organization === undefined ? null : <>
        <p className="decision-deletion-note">整理与记忆里依赖这条决策的机器派生内容会一并处理：</p>
        <ul className="decision-deletion-impact" aria-label="一并清除的整理内容">
          <li>将一并删除的经验 {organization.experiences.length} 条{organization.experiences.length === 0 ? "。" : "："}
            {organization.experiences.length === 0 ? null : <ul>{organization.experiences.map((item) => <li key={item.id}>{item.title}</li>)}</ul>}
          </li>
          <li>将清除的整理建议 {organization.suggestions} 条。</li>
          <li>将删除的模型调用记录 {organization.modelCalls} 条。</li>
        </ul>
        {organization.complete ? null : <p className="form-error" role="alert">有来源这次没能完整读取，影响范围可能不全，暂不能确认删除。请点「重新读取」。</p>}
      </>}
      {preview.captured ? <p className="decision-deletion-note">这条是从对话里识别出来的。不该记成决策时选「识别错误，删除」，本机会留一条不含正文的回执（规则版本、档位、信号等），用于改进识别。</p> : null}
    </> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </ModalDialog>;
};
