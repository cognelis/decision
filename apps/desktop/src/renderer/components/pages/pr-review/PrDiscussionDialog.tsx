import { useEffect, useState } from "react";
import type { PrDiscussion, PrDiscussionComment, PrReviewSnapshot } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
// The day the reader saw it on, as the dialog shows it: the UTC date was the day before for a morning comment.
import { calendarDate } from "../../../calendar-date.js";
import { ModalDialog } from "../../ModalDialog.js";
import type { ActiveRecordDraft } from "../decisions/ActiveRecordDialog.js";

const place = (comment: Pick<PrDiscussionComment, "path" | "line">): string | null =>
  comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : null;

/** A PR comment as a starting decision: the reader rewrites the question, the comment's link stays. */
export const commentDraft = (comment: PrDiscussionComment, pr: Pick<PrReviewSnapshot, "title" | "reference" | "project">, link: string): ActiveRecordDraft => {
  const where = place(comment);
  return {
    title: (where ? `${where} 怎么处理？` : `「${pr.title}」怎么处理？`).slice(0, 500),
    content: comment.body,
    project: pr.project,
    context: [`PR：${pr.title}（${pr.reference}）`, where ? `位置：${where}` : "", `评论：${comment.author || "未知作者"} · ${calendarDate(new Date(comment.createdAt))}`].filter(Boolean).join("\n"),
    source: { url: comment.url, label: `PR 评论 · ${link}` },
  };
};

/** What was already said on a PR; a decision made in a comment is recorded with a link back to it. */
export function PrDiscussionDialog({ api, connectionId, pr, onRecord, onOpenDecision, onClose }: {
  api: Pick<DecisionApi, "listPrDiscussion" | "openPrLink">;
  connectionId: string;
  pr: Pick<PrReviewSnapshot, "title" | "reference">;
  onRecord(comment: PrDiscussionComment): void;
  onOpenDecision?: ((id: string) => void) | undefined;
  onClose(): void;
}) {
  const [discussion, setDiscussion] = useState<PrDiscussion | null>(null);
  const [error, setError] = useState("");
  const { reference } = pr;
  useEffect(() => {
    let disposed = false;
    api.listPrDiscussion({ connectionId, reference }).then(
      (result) => { if (!disposed) setDiscussion(result); },
      () => { if (!disposed) setError("PR 讨论读取失败，请检查链接的访问令牌与网络后重试。"); });
    return () => { disposed = true; };
  }, [api, connectionId, reference]);
  const comments = discussion?.comments ?? null;
  return <ModalDialog title="PR 讨论" description={`「${pr.title}」（${pr.reference}）上的评论。评论里做出的决定可以记为决策，记录会保留这条评论的链接。`} size="wide" onClose={onClose}>
    {error ? <p role="alert">{error}</p> : null}
    {comments === null ? (error ? null : <p role="status">正在读取评论…</p>) : !comments.length ? <p>这个 PR 上还没有可读取的评论。</p> : <ol className="pr-discussion-list">
      {comments.map((comment) => <li key={comment.id} className="review-finding">
        <div className="review-message-meta"><strong>{comment.author || "未知作者"}</strong>{place(comment) ? <code>{place(comment)}</code> : null}<time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
        <p className="review-text">{comment.body}</p>
        <div className="review-finding-actions">
          <button type="button" className="text-button" onClick={() => void api.openPrLink(comment.url).catch(() => setError("无法打开这条评论：链接不属于已添加的代码平台，或系统拒绝了打开。"))}>在平台查看</button>
          {comment.decisionId === null
            ? <button type="button" className="text-button" aria-label={`把 ${comment.author || "未知作者"} 的评论记为决策`} onClick={() => onRecord(comment)}>记为决策</button>
            : onOpenDecision ? <button type="button" className="text-button" onClick={() => onOpenDecision(comment.decisionId!)}>已记为决策 · 查看</button> : <span>已记为决策</span>}
        </div>
      </li>)}
    </ol>}
    {discussion?.more ? <p className="review-history-note">评论较多，只列出了最近的一部分；更早的评论请在平台上查看。</p> : null}
  </ModalDialog>;
}
