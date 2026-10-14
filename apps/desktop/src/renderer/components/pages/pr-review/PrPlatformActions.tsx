import { useEffect, useRef, useState } from "react";
import type { PrActionContext, PrActionRequest, PrActionResult, PrReviewSnapshot } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { platformMessage } from "./platform-message.js";

type Action = PrActionRequest["action"];
const LABELS: Record<Action, string> = { approve: "批准", "need-work": "需要修改", merge: "合并" };

export function PrPlatformActions({ api, snapshot, connectionId, disabled, openP1 = 0, onPending, onComplete }: {
  api: Pick<DecisionApi, "getPrActionContext" | "performPrAction">;
  snapshot: PrReviewSnapshot;
  connectionId?: string | undefined;
  disabled: boolean;
  /** P1 findings of the review on screen that were not dropped: said before approving or merging, not a block. */
  openP1?: number;
  onPending(value: boolean): void;
  onComplete(result: PrActionResult): void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [context, setContext] = useState<PrActionContext | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PrActionRequest["mergeMethod"]>("merge");
  const [posting, setPosting] = useState(false);
  const [merged, setMerged] = useState(false);
  const pending = useRef(false);
  useEffect(() => {
    if (!action || !connectionId) return;
    let disposed = false;
    setContext(null); setError("");
    void api.getPrActionContext({ connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit })
      .then(value => { if (!disposed) setContext(value); })
      .catch(cause => { if (!disposed) setError(platformMessage(cause, "读取平台状态失败。")); });
    return () => { disposed = true; };
  }, [api, snapshot, connectionId, action, attempt]);
  const canSubmit = context?.state === "open" && (action === "merge" || context.canReview) && !(context.platform === "github" && action === "need-work" && !body.trim());

  return <>
    <div className="pr-platform-actions" role="group" aria-label="代码平台操作">
      {(Object.keys(LABELS) as Action[]).map(value => <button key={value} className="secondary-button" disabled={disabled || !connectionId || merged} onClick={() => { setBody(""); setAction(value); }}>{LABELS[value]}</button>)}
      {merged ? <span role="status">已合并</span> : null}
      {!connectionId ? <span>请从 PR 列表读取最新提交后操作</span> : null}
    </div>
    {action ? <ModalDialog title={`${LABELS[action]} · 确认平台操作`} size="compact" dismissible={!posting && body.trim().length === 0} onClose={() => { if (!pending.current) setAction(null); }}>
      <form className="pr-action-form" onSubmit={async event => {
        event.preventDefault();
        if (!context || !connectionId || !canSubmit || pending.current) return;
        pending.current = true; setPosting(true); onPending(true); setError("");
        try {
          const result = await api.performPrAction({ connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit, sourceBranch: context.sourceBranch, destinationBranch: context.destinationBranch, action, body: context.platform === "github" && action !== "merge" ? body.trim() : "", mergeMethod });
          setMerged(result.action === "merge"); setAction(null); onComplete(result);
        } catch (cause) { setError(platformMessage(cause, "平台操作失败，请核对状态后重试。")); }
        finally { pending.current = false; setPosting(false); onPending(false); }
      }}>
        <strong>{snapshot.title}</strong><p>{snapshot.reference}</p>
        {!context && !error ? <p role="status">正在核对平台上的提交与分支…</p> : null}
        {context ? <>
          <div className="pr-action-branches"><div><span>源分支</span><strong>{context.sourceBranch}</strong><code>{context.sourceCommit.slice(0, 12)}</code></div><div><span>目标分支</span><strong>{context.destinationBranch}</strong><code>{context.destinationCommit.slice(0, 12)}</code></div></div>
          {context.state !== "open" ? <p role="alert">{context.state === "merged" ? "PR 已合并。" : "PR 已关闭或锁定。"}</p> : action !== "merge" && !context.canReview ? <p role="alert">没能读取当前平台账号（账号信息读取失败或被限流），无法确认评审人。请稍后重试或在平台操作；一直如此时检查代理响应头。</p> : <p>{action === "merge" ? `将把 ${context.sourceBranch} 合并到 ${context.destinationBranch}，由平台检查合并权限和分支保护条件。` : action === "approve" ? "将以当前平台账号提交通过评审。" : "将以当前平台账号标记需要修改。"}</p>}
          {openP1 > 0 && action !== "need-work" ? <p role="note" className="pr-action-warning">这份评审还有 {openP1} 个 P1 问题没有撤销；确认后照样{LABELS[action]}。</p> : null}
          {context.platform === "github" && action !== "merge" ? <label>评审意见{action === "need-work" ? "（必填，将发布到 PR）" : "（可选，将发布到 PR）"}<textarea aria-label="评审意见" value={body} maxLength={10000} required={action === "need-work"} disabled={posting} onChange={event => setBody(event.target.value)} /></label> : null}
          {action === "merge" ? context.platform === "github" ? <label>合并方式<select aria-label="合并方式" value={mergeMethod} disabled={posting} onChange={event => setMergeMethod(event.target.value as typeof mergeMethod)}><option value="merge">Merge commit</option><option value="squash">Squash</option><option value="rebase">Rebase</option></select></label> : <p>合并方式遵循代码平台的项目设置。</p> : context.platform !== "github" ? <p>仅更新评审状态，不发布评论或已有草稿。</p> : null}
        </> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!context && error ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新核对平台状态</button> : null}
        <div className="modal-form-actions"><button type="button" className="secondary-button" disabled={posting} onClick={() => setAction(null)}>取消</button><button type="submit" className="primary-button" disabled={!canSubmit || posting}>{posting ? "正在提交…" : `确认${LABELS[action]}`}</button></div>
      </form>
    </ModalDialog> : null}
  </>;
}
