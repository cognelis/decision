import { useState } from "react";
import { prCommentResponse, type LocalReviewJob, type PrReceivedComment } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { platformMessage } from "./platform-message.js";
import { diffSize, fixMoved, roundPreview } from "./pr-fix.js";

/**
 * 本轮变化 on the user's own PR (the design's board 3): what the local review fixed, as the description will say it once
 * pushed; the push onto the PR's own branch, only on the author's word and while the branch is still at the head the
 * fix was made on; and, the branch having moved, the fix redone on its new head instead.
 */
export function PrFixRound({ api, job, comments, onRedo, onChanged }: {
  api: Pick<DecisionApi, "actOnLocalReview" | "openPrLink">; job: LocalReviewJob; comments: readonly PrReceivedComment[];
  /** The same comments handed to the local review again, on the PR's new head. */
  onRedo(commentIds: string[], profileId: string): void;
  onChanged(message: string): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const group = job.groups[0], pr = job.pr!;
  const moved = fixMoved(job);
  if (!group || (!group.artifact && !moved)) return null;
  const preview = roundPreview(job, comments);
  const waiting = group.state === "blocked" && !!group.artifact && !group.artifact.secretFindings?.length;
  const pushed = group.state === "pr_opened";
  const unanswered = comments.filter(comment => !prCommentResponse(comment) && !pr.comments.some(link => link.commentId === comment.id)).length;
  const fixed = pr.comments.filter(link => group.fix?.outcomes.some(outcome => outcome.id === link.annotationId && outcome.outcome !== "skipped")).length;
  const size = group.artifact ? diffSize(group.artifact.diff) : null;
  const act = async (action: "approve" | "follow_up", done: string) => {
    setBusy(true); setError("");
    try {
      await api.actOnLocalReview({ repositoryId: job.repositoryId, jobId: job.id, groupId: group.id, action,
        ...(action === "approve" && group.artifact ? { authorization: { groupId: group.id, commitOid: group.artifact.commitOid, risks: group.artifact.risks, pushUrl: job.pushUrl } } : {}) });
      setConfirming(false); onChanged(done);
    } catch (cause) { setError(platformMessage(cause, action === "approve" ? "没有推送，请到本地审阅里查看。" : "没有补发，请稍后再试。")); }
    finally { setBusy(false); }
  };
  return <section className="pr-fix-round" aria-labelledby="pr-fix-round-title">
    <h3 id="pr-fix-round-title">本轮变化 · {pushed ? (pr.described ? "已写进 PR 描述" : "推送了，描述还没写") : "推送后写进 PR 描述"}</h3>
    {preview && !moved ? <div className="assistant-answer pr-fix-preview">{renderMarkdown(preview)}</div> : null}
    {moved ? <div className="pr-fix-moved" role="alert">
      <p><strong>推送前远端分支头变了</strong>{group.error?.replace(/^推送前远端分支头变了：/u, "：")}</p>
      <div><button type="button" className="secondary-button" onClick={() => void api.openPrLink(pr.url).catch(() => setError("无法打开这个 PR。"))}>查看新提交</button>
        <button type="button" className="primary-button" onClick={() => onRedo(pr.comments.map(link => link.commentId), job.profile.profileId)}>在新提交上重做</button></div>
    </div> : null}
    {waiting ? <>
      <p className="review-history-note">作为新提交推到原 PR 的 <code>{pr.sourceBranch}</code>；推送前核对远端分支头仍是 <code>{pr.headSha.slice(0, 12)}</code>，变了就停，不强推。</p>
      {group.artifact!.risks.length ? <p role="alert">这次修改涉及高风险文件：{group.artifact!.risks.join("、")}。推送前请看过修改。</p> : null}
      {unanswered ? <p className="review-history-note">另有 {unanswered} 条意见还没有去向，推送不等它们，下一轮再处理也可以。</p> : null}
      <div className="pr-fix-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => setConfirming(true)}>推送修复到原 PR</button></div>
    </> : null}
    {pushed ? <p className="review-history-note">已推送，提交 <code>{group.artifact?.commitOid.slice(0, 12)}</code>；{pr.replied.length} / {fixed} 条已回复已修{pr.described ? "；本轮变化已写进 PR 描述" : ""}。</p> : null}
    {pr.followUpError ? <p role="alert">{pr.followUpError} <button type="button" className="review-note-link" disabled={busy} onClick={() => void act("follow_up", "已补发回复和描述。")}>补发回复和描述</button></p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {confirming && group.artifact ? <ModalDialog title="推送修复到原 PR" size="wide" dismissible={!busy} onClose={() => { if (!busy) setConfirming(false); }}
      description={`一个新提交推到 ${pr.sourceBranch}，在 ${pr.headSha.slice(0, 12)} 之上；远端分支头变了就停，不覆盖别人的提交。推送后给修好的意见回复“已修”，并把本轮变化写进 PR 描述。`}
      footer={<><button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void act("approve", "已推送到原 PR。")}>{busy ? "正在推送…" : "确认推送"}</button></>}>
      <p>{group.fix?.commitTitle ?? group.title} · {group.artifact.changes.length} 个文件 · +{size!.added} −{size!.removed}</p>
      <details open={group.artifact.diff.length < 4_000 || undefined}><summary>修改内容</summary><pre className="pr-fix-diff">{group.artifact.diff}</pre></details>
      {group.fix ? <details><summary>验证记录</summary><div className="assistant-answer">{renderMarkdown(group.fix.verification)}</div></details> : null}
      {error ? <p role="alert">{error}</p> : null}
    </ModalDialog> : null}
  </section>;
}
