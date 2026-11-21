import { useEffect, useRef, useState } from "react";
import type { PrActionContext, PrActionRequest, PrActionResult, PrReviewSnapshot, PrReviewStatus } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ActionIcon } from "../../IconButton.js";
import { ModalDialog } from "../../ModalDialog.js";
import { platformMessage } from "./platform-message.js";

type Action = PrActionRequest["action"];
const LABELS: Record<Action, string> = { approve: "批准", "need-work": "需要修改", merge: "合并" };
/** A confirmation says the act and its object in its title, and the act again on its one solid button. */
const TITLES: Record<Action, string> = { approve: "批准这个 PR？", "need-work": "把这个 PR 标记为需要修改？", merge: "合并这个 PR？" };
const VERBS: Record<Action, string> = { approve: "批准", "need-work": "标记为需要修改", merge: "合并" };

/** What a quick approval rests on (prQuickApprovalChecks): offered only when every check holds. */
export interface QuickApproval { eligible: boolean; checks: Array<{ label: string; ok: boolean }> }

export function PrPlatformActions({ api, snapshot, connectionId, disabled, openP1 = 0, status, quick, onPending, onComplete }: {
  api: Pick<DecisionApi, "getPrActionContext" | "performPrAction" | "publishPrGeneralComment">;
  snapshot: PrReviewSnapshot;
  connectionId?: string | undefined;
  disabled: boolean;
  /** P1 findings of the review on screen that were not dropped: approving past them takes a reason; merging is warned. */
  openP1?: number;
  /** The platform's build, approvals and open blockers for the PR, as last read. */
  status?: PrReviewStatus | null | undefined;
  quick?: QuickApproval | undefined;
  onPending(value: boolean): void;
  onComplete(result: PrActionResult): void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  // A quick approval: the checks it rests on, and what they cannot catch, go to the PR with it.
  const [fast, setFast] = useState(false);
  const [context, setContext] = useState<PrActionContext | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [body, setBody] = useState("");
  const [mergeMethod, setMergeMethod] = useState<PrActionRequest["mergeMethod"]>("merge");
  const [posting, setPosting] = useState(false);
  const [merged, setMerged] = useState(false);
  // Approved where an approval takes no words (GitLab, Bitbucket), its reason or evidence not on the PR yet: trying
  // again posts only the comment.
  const approved = useRef<PrActionResult | null>(null);
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
  const blockers = status?.blockers ?? 0;
  // The design's 批准: with open blockers or standing P1s, an approval says why.
  const guarded = action === "approve" && !fast && (openP1 > 0 || blockers > 0);
  const worded = fast || guarded;
  const github = context?.platform === "github";
  const words = fast && quick ? `快速批准（低风险）：${quick.checks.map(check => check.label).join("；")}。\n\n这些检查拦不住什么：${body.trim()}`
    : guarded ? `批准理由：${body.trim()}` : body.trim();
  const canSubmit = context?.state === "open" && (action === "merge" || context.canReview) && !((action === "need-work" && github || worded) && !body.trim());
  const open = (value: Action, quickly = false) => { setBody(""); setFast(quickly); approved.current = null; setAction(value); };
  const what = fast ? "依据" : "理由";

  return <>
    <div className="pr-platform-actions" role="group" aria-label="代码平台操作">
      {quick?.eligible ? <button className="secondary-button" disabled={disabled || !connectionId || merged} onClick={() => open("approve", true)}>快速批准</button> : null}
      {(Object.keys(LABELS) as Action[]).map(value => <button key={value} className="secondary-button" disabled={disabled || !connectionId || merged} onClick={() => open(value)}>{LABELS[value]}</button>)}
      {merged ? <span role="status">已合并</span> : null}
      {!connectionId ? <span>请从 PR 列表读取最新提交后操作</span> : null}
    </div>
    {action ? <ModalDialog title={fast ? `快速批准 ${snapshot.reference}？` : TITLES[action]} size="compact" dismissible={!posting} unsaved={body.trim().length > 0} onClose={() => { if (!pending.current) setAction(null); }}
      footer={<><button type="button" className="secondary-button" autoFocus disabled={posting} onClick={() => setAction(null)}>取消</button><button type="submit" form="pr-platform-action-form" className="primary-button" disabled={!canSubmit || posting}>{posting ? "正在提交…" : approved.current ? `重新发布${what}` : fast ? "批准并写入依据" : VERBS[action]}</button></>}>
      <form id="pr-platform-action-form" className="pr-action-form" onSubmit={async event => {
        event.preventDefault();
        if (!context || !connectionId || !canSubmit || pending.current) return;
        pending.current = true; setPosting(true); onPending(true); setError("");
        const pinned = { connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit };
        try {
          let result = approved.current;
          if (!result) {
            result = await api.performPrAction({ ...pinned, sourceBranch: context.sourceBranch, destinationBranch: context.destinationBranch, action, body: github && action !== "merge" ? words : "", mergeMethod });
            if (!worded || github) { setMerged(result.action === "merge"); setAction(null); onComplete(result); return; }
            approved.current = result;
          }
          // GitLab and Bitbucket approve without words: they follow as a comment of their own.
          await api.publishPrGeneralComment({ ...pinned, body: words });
          approved.current = null; setAction(null); onComplete({ ...result, message: `${result.message}${what}已发到 PR。` });
        } catch (cause) {
          setError(approved.current ? `已批准，但${what}没能发到 PR：${platformMessage(cause, "请稍后重试。")}可以重新发布${what}，不会再批准一次。` : platformMessage(cause, "平台操作失败，请核对状态后重试。"));
        }
        finally { pending.current = false; setPosting(false); onPending(false); }
      }}>
        <p className="pr-action-target"><strong>{snapshot.title}</strong><span>{snapshot.reference}</span></p>
        {!context && !error ? <p role="status">正在核对平台上的提交与分支…</p> : null}
        {context ? <>
          <div className="pr-action-branches"><div><span>源分支</span><strong>{context.sourceBranch}</strong><code>{context.sourceCommit.slice(0, 12)}</code></div><div><span>目标分支</span><strong>{context.destinationBranch}</strong><code>{context.destinationCommit.slice(0, 12)}</code></div></div>
          {context.state !== "open" ? <p role="alert">{context.state === "merged" ? "PR 已合并。" : "PR 已关闭或锁定。"}</p> : action !== "merge" && !context.canReview ? <p role="alert">没能读取当前平台账号（账号信息读取失败或被限流），无法确认评审人。请稍后重试或在平台操作；一直如此时检查代理响应头。</p> : <p>{action === "merge" ? `将把 ${context.sourceBranch} 合并到 ${context.destinationBranch}，由平台检查合并权限和分支保护条件。` : action === "approve" ? "将以当前平台账号提交通过评审。" : "将以当前平台账号标记需要修改。"}</p>}
          {fast && quick ? <ul className="pr-quick-checks" aria-label="快速批准的条件">{quick.checks.map(check => <li key={check.label}><ActionIcon name="check" />{check.label}</li>)}</ul> : null}
          {guarded ? <p role="note" className="pr-action-warning">{[blockers ? `还有 ${blockers} 项未完成的阻塞项` : "", openP1 ? `这份评审还有 ${openP1} 个 P1 问题没有撤销` : ""].filter(Boolean).join("，")}：批准要写明理由。</p>
            : openP1 > 0 && action === "merge" ? <p role="note" className="pr-action-warning">这份评审还有 {openP1} 个 P1 问题没有撤销；确认后照样合并。</p> : null}
          {(github && action !== "merge") || worded ? <div className="form-field">
            <label htmlFor="pr-action-body">{fast ? "这些检查拦不住什么（必填）" : guarded ? "批准理由（必填）" : "评审意见"}</label>
            <textarea id="pr-action-body" aria-describedby="pr-action-body-help" value={body} maxLength={8000} required={worded || action === "need-work"} disabled={posting} onChange={event => setBody(event.target.value)} />
            <p id="pr-action-body-help">{fast ? "说不出检查会漏掉什么，就请认真评审，不要快速批准。" : ""}{worded ? `会${github ? "作为批准意见" : "在批准之后作为一条评论"}发到 PR${fast ? "，连同上面的条件" : ""}。` : action === "need-work" ? "必填，会作为评审意见发布到 PR。" : "可选，填了会作为评审意见发布到 PR。"}</p>
          </div> : null}
          {action === "merge" ? github ? <div className="form-field">
            <label htmlFor="pr-action-merge-method">合并方式</label>
            <select id="pr-action-merge-method" value={mergeMethod} disabled={posting} onChange={event => setMergeMethod(event.target.value as typeof mergeMethod)}><option value="merge">Merge commit</option><option value="squash">Squash</option><option value="rebase">Rebase</option></select>
          </div> : <p>合并方式遵循代码平台的项目设置。</p> : !github && !worded ? <p>仅更新评审状态，不发布评论或已有草稿。</p> : null}
        </> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!context && error ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新核对平台状态</button> : null}
      </form>
    </ModalDialog> : null}
  </>;
}
