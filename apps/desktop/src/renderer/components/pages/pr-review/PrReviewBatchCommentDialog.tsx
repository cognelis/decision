import { useEffect, useRef, useState } from "react";
import { prFindingBasis, prFindingBlocksByDefault, prFindingCanBlock, prFindingDuplicate, prPublishedFindingDraft, type PrActionContext, type PrDiscussion, type PrReviewFinding, type PrReviewSnapshot, type PrReviewStatus } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { blockingNote, notHeldNote, sideOf } from "./PrReviewCommentDialog.js";
import { platformMessage } from "./platform-message.js";

/**
 * Several findings posted at once, each on its line, one after another through the same guarded
 * call as a single comment: pinned to the review's commits, refused once the PR moves or closes.
 * The first failure stops the rest, so nothing is posted twice while its outcome is unknown.
 */
export function PrReviewBatchCommentDialog({ api, snapshot, connectionId, findings, status, onPosted, onClose }: {
  api: Pick<DecisionApi, "getPrActionContext" | "publishPrReviewComment" | "listPrDiscussion">;
  snapshot: PrReviewSnapshot;
  connectionId: string;
  /** Findings not posted yet, by their index in the report, as they stand after re-evaluation. */
  findings: { index: number; finding: PrReviewFinding }[];
  /** The PR's status as the page last read it: whether its platform holds a merge on open blockers. */
  status?: PrReviewStatus | null | undefined;
  /** `blocking`: it went out as a blocking item. */
  onPosted(index: number, blocking: boolean, comment?: string): void;
  onClose(message?: string): void;
}) {
  const [context, setContext] = useState<PrActionContext | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState(() => new Set(findings.map(item => item.index)));
  // P1s that may block go out as blocking unless unticked; one on a personal basis cannot.
  const canBlock = (finding: PrReviewFinding) => prFindingCanBlock(finding, snapshot.guides, snapshot.rules);
  const [blocking, setBlocking] = useState(() => new Set(findings.filter(({ finding }) => prFindingBlocksByDefault(finding, snapshot.guides, snapshot.rules)).map(item => item.index)));
  const [posted, setPosted] = useState<number[]>([]);
  const [posting, setPosting] = useState(false);
  const pending = useRef(false);
  const pinned = { connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit };
  // What is on the PR already: a finding another reviewer's Paraself posted at the same place is left unticked, said why.
  const [existing, setExisting] = useState<PrDiscussion["comments"] | null>(null);
  useEffect(() => {
    let disposed = false;
    void api.listPrDiscussion({ connectionId, reference: snapshot.reference }).then(({ comments }) => {
      if (disposed) return;
      setExisting(comments);
      setChosen(current => new Set([...current].filter(index => !prFindingDuplicate(findings.find(item => item.index === index)!.finding, sideOf(comments)))));
    }, () => undefined);
    return () => { disposed = true; };
  }, [api, connectionId, snapshot.reference]);
  const duplicateOf = (finding: PrReviewFinding) => existing ? prFindingDuplicate(finding, sideOf(existing)) : undefined;
  useEffect(() => {
    let disposed = false;
    setContext(null); setError("");
    void api.getPrActionContext(pinned)
      .then(value => { if (!disposed) setContext(value); })
      .catch(cause => { if (!disposed) setError(platformMessage(cause, "读取平台状态失败。")); });
    return () => { disposed = true; };
  }, [api, connectionId, snapshot, attempt]);
  const queue = findings.filter(item => chosen.has(item.index) && !posted.includes(item.index));
  const blockingQueued = queue.filter(item => blocking.has(item.index) && canBlock(item.finding)).length;
  // However it closes, what already went out is said, across retries too.
  const close = (count = posted.length) => onClose(count ? `已发布 ${count} 条评论。` : undefined);
  const publish = async () => {
    if (pending.current || context?.state !== "open") return;
    pending.current = true; setPosting(true); setError("");
    let count = posted.length;
    for (const { index, finding } of queue) {
      let held = false, comment: string | undefined;
      try {
        const result = await api.publishPrReviewComment({ ...pinned, path: finding.path, side: finding.side, line: finding.line, body: prPublishedFindingDraft(finding, snapshot.guides, undefined, snapshot.rules), ...(blocking.has(index) && canBlock(finding) ? { blocking: true } : {}) });
        held = result.blocking === true; comment = result.comment;
      } catch (cause) {
        // What went out stays out and is not sent again: another try posts only what is left.
        setError(`第 ${findings.findIndex(item => item.index === index) + 1} 条「${finding.title}」发布失败：${platformMessage(cause, "请先到平台核对后再重试。")}${count ? `已发出的 ${count} 条不会重发；` : ""}处理好后再发布，只补发剩下的。`);
        pending.current = false; setPosting(false);
        return;
      }
      count++;
      setPosted(current => [...current, index]);
      onPosted(index, held, comment);
    }
    pending.current = false; setPosting(false);
    close(count);
  };

  return <ModalDialog title="批量发布为 PR 评论" description="评审结果只是草稿；勾选要发布的问题，以你的平台账号逐条发布到各自的行上。需要改措辞的，请用单条的“转为评论”。" size="wide" dismissible={!posting} onClose={() => { if (!pending.current) close(); }}
    footer={<>
      <button type="button" className="secondary-button" disabled={posting} onClick={() => close()}>{posted.length ? "完成" : "取消"}</button>
      <button type="button" className="primary-button" disabled={posting || context?.state !== "open" || !queue.length} onClick={() => void publish()}>{posting ? "正在发布…" : `${posted.length ? "补发剩下的" : "发布"} ${queue.length} 条${blockingQueued ? `，其中 ${blockingQueued} 条阻塞` : ""}`}</button>
    </>}>
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
            <span><strong><span className="pr-diff-finding-priority" data-priority={finding.priority}>{finding.priority}</span>{finding.title}</strong><code>{finding.path}:{finding.line}（{finding.side === "new" ? "新版本" : "旧版本"}）</code></span>
            {prFindingBasis(finding, snapshot.guides).tier === "personal" ? <small>{canBlock(finding) ? "标记为阻塞的个人规则" : "建议"}</small> : null}
            {posted.includes(index) ? <small>已发布</small> : null}
          </label>
          {!posted.includes(index) && duplicateOf(finding) ? <p className="pr-blocking-toggle" role="note">PR 上已有同位置的同类意见（{duplicateOf(finding)!.author || "未知作者"}），默认不再发布。</p> : null}
          <label className="pr-blocking-toggle" data-disabled={!canBlock(finding) || undefined}><input type="checkbox" aria-label={`把「${finding.title}」设为阻塞`} checked={blocking.has(index) && canBlock(finding)} disabled={!canBlock(finding) || posting || posted.includes(index) || !chosen.has(index)}
            onChange={() => setBlocking(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })} />
            <span>设为阻塞{canBlock(finding) ? "" : "：个人依据不能设为阻塞（依据标记为阻塞的本机规则的 P1 除外）"}</span></label>
        </li>)}
      </ul>
      {findings.some(({ finding }) => prFindingBasis(finding, snapshot.guides).tier === "personal")
        ? <p className="review-history-note" role="note">标为“建议”的只有你的个人决策或本机评审规则支撑，发出去不能要求作者照改；发布前确认正文里没有个人笔记的标题、链接或编号。</p> : null}
      <p className="review-history-note">每条评论末尾会加一行“— Paraself 预评审”，写明依据和优先级。阻塞项：{blockingNote(context?.platform, true)}。</p>
      {status?.blockersHold === false && blockingQueued ? <p className="review-history-note pr-action-warning" role="note">{notHeldNote(status)}</p> : null}
      {posting ? <p role="status">正在发布 {posted.length + 1} / {posted.length + queue.length}…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!context && error ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新核对平台状态</button> : null}
    </div>
  </ModalDialog>;
}
