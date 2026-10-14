import { useEffect, useRef, useState } from "react";
import type { PrActionContext, PrReviewFinding, PrReviewSnapshot } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { findingCommentDraft } from "./PrReviewCommentDialog.js";
import { platformMessage } from "./platform-message.js";

/**
 * Several findings posted at once, each on its line, one after another through the same guarded
 * call as a single comment: pinned to the review's commits, refused once the PR moves or closes.
 * The first failure stops the rest, so nothing is posted twice while its outcome is unknown.
 */
export function PrReviewBatchCommentDialog({ api, snapshot, connectionId, findings, onPosted, onClose }: {
  api: Pick<DecisionApi, "getPrActionContext" | "publishPrReviewComment">;
  snapshot: PrReviewSnapshot;
  connectionId: string;
  /** Findings not posted yet, by their index in the report, as they stand after re-evaluation. */
  findings: { index: number; finding: PrReviewFinding }[];
  onPosted(index: number): void;
  onClose(message?: string): void;
}) {
  const [context, setContext] = useState<PrActionContext | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState(() => new Set(findings.map(item => item.index)));
  const [posted, setPosted] = useState<number[]>([]);
  const [posting, setPosting] = useState(false);
  const pending = useRef(false);
  const pinned = { connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit };
  useEffect(() => {
    let disposed = false;
    setContext(null); setError("");
    void api.getPrActionContext(pinned)
      .then(value => { if (!disposed) setContext(value); })
      .catch(cause => { if (!disposed) setError(platformMessage(cause, "读取平台状态失败。")); });
    return () => { disposed = true; };
  }, [api, connectionId, snapshot, attempt]);
  const queue = findings.filter(item => chosen.has(item.index) && !posted.includes(item.index));
  // However it closes, what already went out is said, across retries too.
  const close = (count = posted.length) => onClose(count ? `已发布 ${count} 条评论。` : undefined);
  const publish = async () => {
    if (pending.current || context?.state !== "open") return;
    pending.current = true; setPosting(true); setError("");
    let count = posted.length;
    for (const { index, finding } of queue) {
      try {
        await api.publishPrReviewComment({ ...pinned, path: finding.path, side: finding.side, line: finding.line, body: findingCommentDraft(finding) });
      } catch (cause) {
        setError(`「${finding.title}」发布失败：${platformMessage(cause, "请先到平台核对后再重试。")}${count ? `已发布 ${count} 条。` : ""}`);
        pending.current = false; setPosting(false);
        return;
      }
      count++;
      setPosted(current => [...current, index]);
      onPosted(index);
    }
    pending.current = false; setPosting(false);
    close(count);
  };

  return <ModalDialog title="批量发布为 PR 评论" description="评审结果只是草稿；勾选要发布的问题，以你的平台账号逐条发布到各自的行上。需要改措辞的，请用单条的“转为评论”。" size="wide" dismissible={!posting} onClose={() => { if (!pending.current) close(); }}>
    <div className="pr-action-form">
      <p>{snapshot.reference} · 针对提交 <code>{snapshot.sourceCommit.slice(0, 12)}</code>；PR 有新提交时不会发布。</p>
      {!context && !error ? <p role="status">正在核对平台上的提交与分支…</p> : null}
      {context ? context.state !== "open" ? <p role="alert">{context.state === "merged" ? "PR 已合并，不再发布评论。" : "PR 已关闭或锁定，不再发布评论。"}</p> :
        <div className="pr-action-branches"><div><span>源分支</span><strong>{context.sourceBranch}</strong><code>{context.sourceCommit.slice(0, 12)}</code></div><div><span>目标分支</span><strong>{context.destinationBranch}</strong><code>{context.destinationCommit.slice(0, 12)}</code></div></div> : null}
      <ul className="review-batch-findings" aria-label="要发布的问题">
        {findings.map(({ index, finding }) => <li key={index}>
          <label>
            <input type="checkbox" aria-label={`${finding.title}（${finding.path}:${finding.line}）`} disabled={posting || posted.includes(index)} checked={chosen.has(index)}
              onChange={() => setChosen(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} />
            <span><strong>{finding.priority} · {finding.title}</strong><code>{finding.path}:{finding.line}（{finding.side === "new" ? "新版本" : "旧版本"}）</code></span>
            {posted.includes(index) ? <small>已发布</small> : null}
          </label>
        </li>)}
      </ul>
      {posting ? <p role="status">正在发布 {posted.length + 1} / {posted.length + queue.length}…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!context && error ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新核对平台状态</button> : null}
      <div className="modal-form-actions">
        <button type="button" className="secondary-button" disabled={posting} onClick={() => close()}>{posted.length ? "完成" : "取消"}</button>
        <button type="button" className="primary-button" disabled={posting || context?.state !== "open" || !queue.length} onClick={() => void publish()}>{posting ? "正在发布…" : `发布 ${queue.length} 条`}</button>
      </div>
    </div>
  </ModalDialog>;
}
