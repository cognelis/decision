import { useState } from "react";
import type { ReviewPromotion } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";

type Api = Pick<DecisionApi, "actOnReviewPromotion" | "openSurface">;
const KIND = { decision: "决策", local_rule: "本机规则", escape: "漏网复盘" } as const;

/** One proposal: what says so, its examples, the line for REVIEW.md as the user leaves it, handed to the local review. */
function PromotionCard({ api, connectionId, promotion, onChanged }: { api: Api; connectionId: string; promotion: ReviewPromotion; onChanged(promotion: ReviewPromotion | null): void }) {
  const [draft, setDraft] = useState(promotion.draft);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const id = `promotion-${promotion.key.replace(/[^\w-]/gu, "-")}`;
  const act = async (input: Parameters<Api["actOnReviewPromotion"]>[0]) => {
    setBusy(true); setSaid("");
    try {
      const result = await api.actOnReviewPromotion(input);
      // Proposed, the card itself says where it went.
      setSaid(result.ok && input.action === "propose" ? "" : result.message);
      if (result.ok) onChanged(input.action === "dismiss" ? null : { ...promotion, draft, proposed: { at: new Date().toISOString(), jobId: result.jobId ?? "" } });
    } catch { setSaid("没有完成，请重试。"); }
    finally { setBusy(false); }
  };
  return <article className="review-quality-rule" aria-labelledby={`${id}-title`}>
    <p id={`${id}-title`}><span className="review-context-meta">{KIND[promotion.kind]}</span> <strong>「{promotion.title}」</strong> → {promotion.repository} 的 REVIEW.md</p>
    <p className="review-history-note">{promotion.signals.join("；")}</p>
    <ul className="review-quality-runs">{promotion.evidence.map((item) => <li key={`${item.reference}-${item.title}`}>{item.reference}「{item.title}」（{item.outcome}）</li>)}</ul>
    {promotion.proposed ? <p className="review-history-note">已交给本地审阅（任务 {promotion.proposed.jobId}）：改好后在本地审阅里确认，才会推送并开 PR。 <button type="button" className="review-note-link" onClick={() => void api.openSurface("local-review")}>打开本地审阅</button></p> : <>
      <label className="review-quality-escape-form">写进 REVIEW.md 的一条<textarea rows={2} value={draft} maxLength={1_000} onChange={(event) => setDraft(event.target.value)} /></label>
      <div className="review-quality-actions">
        <button type="button" className="secondary-button" disabled={busy || !draft.trim()} onClick={() => void act({ action: "propose", connectionId, key: promotion.key, draft: draft.trim() })}>提议写进 REVIEW.md</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void act({ action: "dismiss", key: promotion.key })}>不提议</button>
      </div>
    </>}
    {said ? <p className="review-history-note" role="status">{said}</p> : null}
  </article>;
}

/** 晋升提议 (design board 4): the user's own rules review keeps needing, proposed for the repository where everyone sees them. */
export function ReviewPromotions({ api, connectionId, promotions, onChanged }: { api: Api; connectionId: string; promotions: readonly ReviewPromotion[]; onChanged(key: string, promotion: ReviewPromotion | null): void }) {
  if (!promotions.length) return null;
  return <section aria-labelledby="quality-promotions">
    <h3 id="quality-promotions">晋升提议 · {promotions.length}</h3>
    {promotions.map((promotion) => <PromotionCard key={promotion.key} api={api} connectionId={connectionId} promotion={promotion} onChanged={(next) => onChanged(promotion.key, next)} />)}
    <p className="review-history-note">提议交给本地审阅：在隔离副本里改 REVIEW.md、自检；改规则文件属于高风险，要你在本地审阅里确认后才推送分支并开 PR。合入后，下一次评审从目标分支读到它。</p>
  </section>;
}
