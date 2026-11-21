import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { prBlockingQuoted, prFindingBasis, prFindingBlocksByDefault, prFindingCanBlock, prFindingDuplicate, prPublishedFindingDraft, prReviewSummaryOn, type PrActionContext, type PrConnection, type PrDiscussion, type PrReviewFinding, type PrReviewSnapshot, type PrReviewStatus } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { isSubmitShortcut, SUBMIT_SHORTCUT_KEYS, submitShortcutLabel } from "../../../keyboard.js";
import { ModalDialog } from "../../ModalDialog.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { platformMessage } from "./platform-message.js";

/** Said before a finding with a personal basis is posted: teammates cannot see what it stands on. */
export const BLOCKING_RULE_NOTE = "这条依据你标记为阻塞的本机规则：可以设为阻塞，正文里引用了规则原文，作者看得到要守什么。发布前确认引用的规则里没有个人笔记的标题、链接或编号。";
export const PERSONAL_BASIS_NOTE = "这条只有你的个人决策或本机评审规则支撑：发出去只是建议，不能要求作者照改。发布前确认正文里没有个人笔记的标题、链接或编号。";
/** What a blocking comment is where it is posted: a task Bitbucket's merge check holds on, or a discussion elsewhere. */
export const blockingNote = (platform: PrConnection["platform"] | undefined, canBlock: boolean, unquoted = false): string =>
  unquoted ? "正文里要保留规则原文的引用才能设为阻塞" : !canBlock ? "个人依据不能设为阻塞（依据标记为阻塞的本机规则的 P1 除外）" : platform === "bitbucket-server" ? "建任务，合并检查会拦住"
    : platform ? "这个平台没有任务：发成普通评论，要仓库开启“讨论解决后才能合并”才拦得住" : "Bitbucket 上建任务，其他平台发成普通评论";
/** Said when the repository is known not to hold a merge on open blockers: one posted stops nothing. */
export const notHeldNote = (status: PrReviewStatus) =>
  `仓库没有开启${status.blocking === "tasks" ? "“没有未完成任务”的合并检查" : "“讨论解决后才能合并”"}：阻塞项照样发出，但拦不住合并，请提醒仓库管理员开启。`;
/** The discussion's comments with the side of the code each is on, as the duplicate check reads them. */
export const sideOf = (comments: PrDiscussion["comments"]) => comments.map((comment) => ({ ...comment, side: comment.code?.side ?? null }));

/**
 * The model's finding or answer is only a draft: the reviewer rewrites it here, sees
 * which commits it speaks about (and, for a finding, the line it lands on), and is the
 * one who posts it.
 */
export function PrReviewCommentDialog({ api, snapshot, connectionId, platform, finding, draft = "", summary = false, status, onClose, onPublished }: {
  api: Pick<DecisionApi, "getPrActionContext" | "publishPrReviewComment" | "publishPrGeneralComment" | "loadPrReviewFile" | "listPrDiscussion">;
  snapshot: PrReviewSnapshot;
  connectionId: string;
  /** Where it is posted: GitHub and GitLab apply a suggestion block in one click. */
  platform?: PrConnection["platform"] | undefined;
  /** A finding lands on its line; without one the comment is on the PR as a whole. */
  finding?: PrReviewFinding;
  /** The text a PR-wide comment starts from: an overview, suggestions or an answer. */
  draft?: string;
  /** It is the review's summary: each PR keeps one, so on Bitbucket it answers under the one already there. */
  summary?: boolean;
  /** The PR's status as the page last read it: whether its platform holds a merge on open blockers. */
  status?: PrReviewStatus | null | undefined;
  onClose(): void;
  /** `blocking`: the finding went out as a blocking item. */
  onPublished(message: string, blocking?: boolean, comment?: string): void;
}) {
  const [context, setContext] = useState<PrActionContext | null>(null);
  const [body, setBody] = useState(() => finding ? prPublishedFindingDraft(finding, snapshot.guides, undefined, snapshot.rules) : draft);
  // A P1 that may block goes out as one unless the reviewer says otherwise; one on a personal basis never does.
  // A P1 on a rule the reviewer marked blocking may block while the comment still quotes the rule.
  const quoted = finding === undefined || prBlockingQuoted(body, finding, snapshot.guides, snapshot.rules);
  const canBlock = finding !== undefined && prFindingCanBlock(finding, snapshot.guides, snapshot.rules) && quoted;
  const [blocking, setBlocking] = useState(() => finding !== undefined && prFindingBlocksByDefault(finding, snapshot.guides, snapshot.rules));
  // What the PR has already: the same finding from another reviewer's Paraself is said before it goes out again, and a
  // summary already there is the one this answers under.
  const [existing, setExisting] = useState<PrDiscussion["comments"] | null>(null);
  useEffect(() => {
    if (!finding && !summary) return;
    let disposed = false;
    void api.listPrDiscussion({ connectionId, reference: snapshot.reference }).then(({ comments }) => { if (!disposed) setExisting(comments); }, () => undefined);
    return () => { disposed = true; };
  }, [api, connectionId, snapshot.reference]);
  const duplicate = finding && existing ? prFindingDuplicate(finding, sideOf(existing)) : undefined;
  const earlierSummary = summary && existing ? prReviewSummaryOn(existing) : undefined;
  // Reworded, it is closed by 取消 only: a stray Escape or click outside took the rewording with it.
  const [drafted] = useState(body);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [posting, setPosting] = useState(false);
  const [preview, setPreview] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  // The field stays mounted behind the preview, so its undo history and size survive a look.
  useEffect(() => { if (!preview) field.current?.focus(); }, [preview]);
  const pinned = { connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit };
  useEffect(() => {
    let disposed = false;
    setContext(null); setError("");
    void api.getPrActionContext(pinned)
      .then(value => { if (!disposed) setContext(value); })
      .catch(cause => { if (!disposed) setError(platformMessage(cause, "读取平台状态失败。")); });
    return () => { disposed = true; };
  }, [api, connectionId, snapshot, attempt]);
  const canPublish = context?.state === "open" && body.trim().length > 0 && !posting;
  // A suggested change: GitHub and GitLab let the author apply it to the commented line in one click. It starts as the
  // line as it stands on the new side, to be rewritten into the fix, with the caret at its end.
  const [suggesting, setSuggesting] = useState(false);
  // The read may come back after the dialog was closed, as the platform-state read above may.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const suggestable = finding?.side === "new" && (platform === "github" || platform === "gitlab");
  const insertSuggestion = async () => {
    if (!finding) return;
    setSuggesting(true); setError("");
    try {
      const file = await api.loadPrReviewFile({ ...pinned, path: finding.path, side: "new" });
      if (!alive.current) return;
      const line = file.binary ? undefined : file.content.split(/\r?\n/u)[finding.line - 1];
      if (line === undefined) { setError("读不到这一行的代码，无法插入建议修改。"); return; }
      // A fence longer than any run of backticks in the line, which could otherwise close it early.
      const fence = "`".repeat(Math.max(3, ...[...line.matchAll(/`+/gu)].map(run => run[0].length + 1)));
      // Inserted again, it takes the place of the one inserted before rather than piling up.
      flushSync(() => { setPreview(false); setBody(current => `${current.replace(/\n*(`{3,})suggestion\n(?:(?!`{3,}suggestion\n)[\s\S])*\n\1\s*$/u, "").trimEnd()}\n\n${fence}suggestion\n${line}\n${fence}`); });
      const area = field.current;
      if (area) { const at = area.value.length - fence.length - 1; area.focus(); area.setSelectionRange(at, at); }
    } catch (cause) { if (alive.current) setError(platformMessage(cause, "读取这一行的代码失败。")); }
    finally { if (alive.current) setSuggesting(false); }
  };

  return <ModalDialog title={finding ? "发布为 PR 评论" : "发布到 PR"} description={finding ? "评审结果只是草稿；确认措辞后，以你的平台账号发布到这一行。" : "内容只是草稿；确认措辞后，以你的平台账号在 PR 上发布一条普通评论，不绑定代码行。"} size="wide" dismissible={!posting} unsaved={body !== drafted} onClose={() => { if (!pending.current) onClose(); }}
    onKeyDown={event => {
      // On the dialog, not its form: the footer's buttons sit outside the form, and ⌘↩ must work from them too.
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      formRef.current?.requestSubmit();
    }}
    footer={<><button type="button" className="secondary-button" disabled={posting} onClick={onClose}>取消</button><button type="submit" form="pr-comment-form" className="primary-button" disabled={!canPublish} aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS} title={`${submitShortcutLabel()} 发布`}>{posting ? "正在发布…" : "发布评论"}</button></>}>
    <form ref={formRef} id="pr-comment-form" className="pr-action-form" aria-label="发布评论表单" onSubmit={async event => {
      event.preventDefault();
      if (!canPublish || pending.current) return;
      pending.current = true; setPosting(true); setError("");
      try {
        const result = finding
          ? await api.publishPrReviewComment({ ...pinned, path: finding.path, side: finding.side, line: finding.line, body: body.trim(), ...(blocking && canBlock ? { blocking: true } : {}) })
          : await api.publishPrGeneralComment({ ...pinned, body: body.trim(), ...(earlierSummary && context?.platform === "bitbucket-server" ? { replyTo: earlierSummary.id } : {}) });
        onPublished(result.message, result.blocking === true, result.comment);
      } catch (cause) { setError(platformMessage(cause, "评论发布失败，请先到平台核对后再重试。")); }
      finally { pending.current = false; setPosting(false); }
    }}>
      {finding ? <p><code>{finding.path}:{finding.line}</code>（{finding.side === "new" ? "新版本" : "旧版本"}）</p> : null}
      {finding && prFindingBasis(finding, snapshot.guides).tier === "personal" && !prFindingCanBlock(finding, snapshot.guides, snapshot.rules) ? <p className="review-history-note" role="note">{PERSONAL_BASIS_NOTE}</p> : null}
      {finding && prFindingBasis(finding, snapshot.guides).tier === "personal" && prFindingCanBlock(finding, snapshot.guides, snapshot.rules) ? <p className="review-history-note" role="note">{BLOCKING_RULE_NOTE}</p> : null}
      {finding ? <label className="pr-blocking-toggle" data-disabled={!canBlock || undefined}><input type="checkbox" checked={blocking && canBlock} disabled={!canBlock || posting} onChange={event => setBlocking(event.target.checked)} />
        <span>设为阻塞：{blockingNote(context?.platform ?? platform, canBlock, !quoted)}</span></label> : null}
      {finding && blocking && canBlock && status?.blockersHold === false ? <p className="review-history-note pr-action-warning" role="note">{notHeldNote(status)}</p> : null}
      {duplicate ? <p className="review-history-note pr-action-warning" role="note">PR 上已有同位置的同类意见（{duplicate.author || "未知作者"}）：{duplicate.body.replace(/\s+/gu, " ").slice(0, 80)}{duplicate.body.length > 80 ? "…" : ""}。确认还要再发，再发布。</p> : null}
      {earlierSummary ? <p className="review-history-note" role="note">PR 上已有一份评审摘要（{earlierSummary.author || "未知作者"} 发的）：{context?.platform === "bitbucket-server" ? "这次接在它下面，不另发一条。" : "这个平台的整体评论不能接在下面，会另发一条。"}</p> : null}
      {finding ? null : <p>{snapshot.reference} · 针对提交 <code>{snapshot.sourceCommit.slice(0, 12)}</code>；PR 有新提交时不会发布。</p>}
      {!context && !error ? <p role="status">正在核对平台上的提交与分支…</p> : null}
      {context ? context.state !== "open" ? <p role="alert">{context.state === "merged" ? "PR 已合并，不再发布评论。" : "PR 已关闭或锁定，不再发布评论。"}</p> :
        <div className="pr-action-branches"><div><span>源分支</span><strong>{context.sourceBranch}</strong><code>{context.sourceCommit.slice(0, 12)}</code></div><div><span>目标分支</span><strong>{context.destinationBranch}</strong><code>{context.destinationCommit.slice(0, 12)}</code></div></div> : null}
      <div className="pr-comment-field">
        <div className="pr-comment-field-head"><span>评论内容（Markdown）{suggestable ? <> · <button type="button" className="review-note-link" title="作者在平台上可以一键把这段代码应用到这一行" disabled={posting || suggesting} onClick={() => void insertSuggestion()}>{suggesting ? "正在读取这一行…" : "插入建议修改"}</button></> : null}</span><div className="pr-diff-modes" role="group" aria-label="编辑或预览"><button type="button" aria-pressed={!preview} disabled={posting} onClick={() => setPreview(false)}>编辑</button><button type="button" aria-pressed={preview} disabled={posting || !body.trim()} onClick={() => setPreview(true)}>预览</button></div></div>
        <textarea ref={field} aria-label="评论内容" hidden={preview} rows={8} value={body} maxLength={10000} disabled={posting} onChange={event => setBody(event.target.value)} />
        {preview ? <><div className="assistant-answer pr-comment-preview" role="region" aria-label="评论预览">{renderMarkdown(body, undefined, { linkTargets: true })}</div><p>预览只是近似效果，发布后以平台显示为准。</p></> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!context && error ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新核对平台状态</button> : null}
    </form>
  </ModalDialog>;
}
