import { useEffect, useState } from "react";
import { PR_RESPONSE_LABELS, modelKindSupportsGeneration, prCommentResponse, prCommentTitle, prResponseReply, prReviewMarkOf, type LocalReviewJob, type PrReceivedComment, type PrReceivedComments as Received, type RedactedModelProviderProfile } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { platformMessage } from "./platform-message.js";
import { fixJobsFor, fixRunning, fixStatus } from "./pr-fix.js";
import { PrFixRound } from "./PrFixRound.js";

type Api = Pick<DecisionApi, "listPrReceivedComments" | "respondToPrComment" | "openPrLink" | "getLocalReviewState" | "submitLocalReviewFromPr" | "actOnLocalReview" | "listModelProviderProfiles">;
/** The local review's worker a model profile runs as: its own CLI, or Pi for any other model. */
const workerOf = (profile: RedactedModelProviderProfile) => profile.kind === "codex-cli" ? "codex" as const : profile.kind === "claude-code-cli" ? "claude-code" as const : "pi" as const;
const NOT_FIXING = [
  { kind: "wrong", hint: "意见不成立：说明为什么" },
  { kind: "intended", hint: "是有意的做法：说明原因" },
  { kind: "wontfix", hint: "成立但这次不改：说明为什么不值得改" },
] as const;

/**
 * 收到的意见 on the user's own PR (docs/review-collaboration-design.md「作者回应与修复」, the design's board 3): every
 * comment someone else opened on it, people's and Paraself pre-reviews', with what the author did with it, read from the
 * PR's threads. 不修 and 转后续 answer one in its thread with a standard reply the reviewers' Paraself can read.
 */
export function PrReceivedComments({ api, connectionId, reference, onAnswered, onCounted }: {
  api: Api; connectionId: string; reference: string;
  /** Told once a reply went out: the PR's blockers and comments moved. */
  onAnswered?(message: string): void;
  /** Told each time the comments are read: how many have an answer, of how many, for the approval conditions. */
  onCounted?(answered: number, total: number): void;
}) {
  const [read, setRead] = useState<Received | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [answering, setAnswering] = useState<{ comment: PrReceivedComment; later: boolean } | null>(null);
  // 修: the comments chosen for the local review, the tasks made of this PR's comments, and the model to run them.
  const [fixing, setFixing] = useState<ReadonlySet<string>>(new Set());
  const [jobs, setJobs] = useState<LocalReviewJob[]>([]);
  const [profiles, setProfiles] = useState<RedactedModelProviderProfile[] | null>(null);
  const [profileId, setProfileId] = useState("");
  const [handing, setHanding] = useState(false);
  const [fixError, setFixError] = useState("");
  const [tick, setTick] = useState(0);
  const running = jobs.some(fixRunning);
  useEffect(() => {
    let gone = false;
    void api.getLocalReviewState().then(state => { if (!gone) setJobs(fixJobsFor(state, connectionId, reference)); }, () => undefined);
    // Read again while a task is under way, as the local review page does.
    const timer = running ? setTimeout(() => setTick(value => value + 1), 2_000) : undefined;
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [api, connectionId, reference, tick, running]);
  useEffect(() => {
    if (!fixing.size || profiles) return;
    void api.listModelProviderProfiles().then(values => {
      const usable = values.filter(profile => profile.enabled && modelKindSupportsGeneration(profile.kind));
      setProfiles(usable); setProfileId(current => current || usable[0]?.profileId || "");
    }, cause => setFixError(platformMessage(cause, "读不到模型档案。")));
  }, [api, fixing.size, profiles]);
  const handOver = async (commentIds: string[], chosen = profileId) => {
    const profile = profiles?.find(item => item.profileId === chosen);
    if (!commentIds.length || !chosen) return;
    setHanding(true); setFixError("");
    try {
      await api.submitLocalReviewFromPr({ connectionId, reference, commentIds, profileId: chosen, ...(profile ? { worker: workerOf(profile) } : {}) });
      setFixing(new Set()); setTick(value => value + 1);
      onAnswered?.(`已交给本地审阅修改 ${commentIds.length} 条意见；改好后在这里确认再推送。`);
    } catch (cause) { setFixError(platformMessage(cause, "没有交给本地审阅。")); }
    finally { setHanding(false); }
  };
  useEffect(() => {
    let gone = false;
    setError("");
    void api.listPrReceivedComments({ connectionId, reference }).then(value => { if (!gone) setRead(value); },
      cause => { if (!gone) setError(platformMessage(cause, "读取 PR 上的意见失败。")); });
    return () => { gone = true; };
  }, [api, connectionId, reference, attempt]);
  const comments = read?.comments ?? [];
  const answered = comments.filter(comment => prCommentResponse(comment)).length;
  useEffect(() => { if (read) onCounted?.(answered, read.comments.length); }, [read]);
  const fromParaself = comments.filter(comment => prReviewMarkOf(comment.body)).length;
  return <section className="pr-received" aria-labelledby="pr-received-title">
    <div className="pr-received-head">
      <h3 id="pr-received-title">收到的意见{read ? ` · ${comments.length} 条` : ""}</h3>
      {comments.length ? <p>{fromParaself ? `${fromParaself} 条来自 Paraself 预评审 · ` : ""}<span data-state={answered === comments.length ? "ok" : "warn"}>{answered} / {comments.length} 条有去向</span></p> : null}
    </div>
    {!read && !error ? <p role="status">正在读取 PR 上的意见…</p> : null}
    {error ? <p role="alert">{error} <button type="button" className="review-note-link" onClick={() => setAttempt(value => value + 1)}>重新读取</button></p> : null}
    {read && !comments.length ? <p className="review-history-note">还没有别人的意见。</p> : null}
    {comments.length ? <p className="review-history-note">每条意见都要有去向：修交给本地审阅，推回原 PR 后自动回复已修；不修写明理由，转后续会建一条待办。回复以你的平台账号发出，审阅人的 Paraself 能读到。</p> : null}
    {comments.length ? <ol className="pr-received-list">
      {comments.map(comment => {
        const mark = prReviewMarkOf(comment.body), response = prCommentResponse(comment), title = prCommentTitle(comment.body);
        const fix = fixStatus(comment, jobs), chosen = fixing.has(comment.id);
        // Handed over already and not back with a refusal: not handed over twice.
        const handed = fix !== null && fix.tone !== "bad";
        return <li key={comment.id} className="review-finding pr-received-item">
          <div className="pr-received-title">
            {comment.task === "open" ? <span className="review-finding-blocking">阻塞</span> : comment.task === "resolved" ? <span className="review-finding-blocking" data-off="">任务已完成</span> : null}
            <span className="pr-received-source" data-source={mark ? "paraself" : "person"}>{mark ? mark.priority : "人工"}</span>
            <strong>{title}</strong>
          </div>
          <p className="review-message-meta">
            <span>{comment.author || "未知作者"}</span>
            {mark ? <span>· Paraself 预评审{mark.suggestion ? " · 个人经验，只作建议" : mark.basis ? ` · ${mark.basis}` : ""}</span> : null}
            {comment.path ? <code>{comment.path}{comment.line ? `:${comment.line}` : ""}</code> : null}
            {comment.resolved === true ? <span>· 讨论已解决</span> : null}
          </p>
          <details className="pr-received-body"><summary>原文</summary><div className="assistant-answer">{renderMarkdown(comment.body, undefined, { linkTargets: true })}</div></details>
          <p className="pr-received-state" data-state={response ? "answered" : fix ? fix.tone : chosen ? "chosen" : "waiting"}>{response ? `已回复：${PR_RESPONSE_LABELS[response.kind]} —— ${response.words}` : fix ? fix.text : chosen ? "将交给本地审阅修改" : "待你决定"}</p>
          <div className="review-finding-actions"><div role="group" aria-label={`「${title}」的去向`}>
            {/* A comment on the PR as a whole has no line to fix at: it is answered, not handed over. */}
            <button type="button" className="text-button" aria-pressed={chosen} disabled={response !== null || handed || !comment.path || !comment.line}
              title={!comment.path || !comment.line ? "整体评论没有位置，不能交给本地审阅" : undefined}
              onClick={() => setFixing(current => { const next = new Set(current); if (next.has(comment.id)) next.delete(comment.id); else next.add(comment.id); return next; })}>修</button>
            <button type="button" className="text-button" disabled={response !== null} onClick={() => setAnswering({ comment, later: false })}>不修</button>
            <button type="button" className="text-button" disabled={response !== null} onClick={() => setAnswering({ comment, later: true })}>转后续</button>
            <button type="button" className="text-button" onClick={() => void api.openPrLink(comment.url).catch(() => setError("无法打开这条评论：链接不属于已添加的代码平台，或系统拒绝了打开。"))}>在平台查看</button>
          </div></div>
        </li>;
      })}
    </ol> : null}
    {read?.more ? <p className="review-history-note">评论很多，只读了最近的十页；更早的到平台上看。</p> : null}
    {fixing.size ? <div className="pr-fix-hand" role="group" aria-label="交给本地审阅">
      <p>选了 {fixing.size} 条意见：交给本地审阅，在 PR 的最新提交上修改；改好后由你确认，再作为新提交推到原 PR。本地仓库要先拉取 PR 的最新提交。</p>
      {profiles?.length === 0 ? <p role="status">没有可用的模型档案：先在“模型”里启用一个，再交给本地审阅。</p>
        : <label>模型档案<select value={profileId} disabled={handing || !profiles} onChange={event => setProfileId(event.target.value)}>{(profiles ?? []).map(profile => <option key={profile.profileId} value={profile.profileId}>{profile.label}{profile.model ? ` · ${profile.model}` : ""}</option>)}</select></label>}
      <button type="button" className="primary-button" disabled={handing || !profileId} onClick={() => void handOver([...fixing])}>{handing ? "正在交给本地审阅…" : `交给本地审阅修改 ${fixing.size} 条`}</button>
      <button type="button" className="secondary-button" disabled={handing} onClick={() => setFixing(new Set())}>取消</button>
    </div> : null}
    {fixError ? <p role="alert">{fixError}</p> : null}
    {jobs[0] && read ? <PrFixRound api={api} job={jobs[0]} comments={comments} onRedo={(commentIds, profile) => void handOver(commentIds, profile)}
      onChanged={message => { setTick(value => value + 1); setAttempt(value => value + 1); onAnswered?.(message); }} /> : null}
    {answering ? <PrResponseDialog api={api} connectionId={connectionId} reference={reference} comment={answering.comment} later={answering.later}
      onClose={() => setAnswering(null)} onSent={message => { setAnswering(null); setAttempt(value => value + 1); onAnswered?.(message); }} /> : null}
  </section>;
}

/** 不修 (误报, 有意为之, 不处理) with the author's reason, or 转后续 with the todo's title: the reply shown as it will go out. */
function PrResponseDialog({ api, connectionId, reference, comment, later, onClose, onSent }: {
  api: Api; connectionId: string; reference: string; comment: PrReceivedComment; later: boolean; onClose(): void; onSent(message: string): void;
}) {
  const title = prCommentTitle(comment.body);
  const [kind, setKind] = useState<"wrong" | "intended" | "wontfix">("wrong");
  const [reason, setReason] = useState("");
  const [todo, setTodo] = useState(title);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const words = later ? `已建待办「${todo.trim() || title}」。${reason.trim()}` : reason.trim();
  const ready = later ? todo.trim().length > 0 : reason.trim().length > 0;
  return <ModalDialog title={later ? "转后续" : "不修"} size="wide" dismissible={!sending} unsaved={reason.trim().length > 0} onClose={() => { if (!sending) onClose(); }}
    description={later ? "先在 Paraself 的「PR 后续」清单里建一条待办，再回复这条意见说明已转为后续。" : "选一种标准回复并写明理由，以你的平台账号回复在这条意见下面。"}
    footer={<><button type="button" className="secondary-button" disabled={sending} onClick={onClose}>取消</button>
      <button type="submit" form="pr-response-form" className="primary-button" disabled={!ready || sending}>{sending ? "正在发出…" : later ? "建待办并回复" : "发出回复"}</button></>}>
    <form id="pr-response-form" className="pr-action-form" aria-label={later ? "转后续" : "不修"} onSubmit={async event => {
      event.preventDefault();
      if (!ready || sending) return;
      setSending(true); setError("");
      try {
        const result = await api.respondToPrComment({ connectionId, reference, commentId: comment.id, kind: later ? "later" : kind, reason: reason.trim(), ...(later ? { todo: todo.trim() } : {}) });
        onSent(result.message);
      } catch (cause) { setError(platformMessage(cause, "回复没有发出，请到平台核对后再试。")); }
      finally { setSending(false); }
    }}>
      <p><strong>{title}</strong> · {comment.author || "未知作者"}{comment.path ? ` · ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""}</p>
      {later ? <label className="pr-response-field"><span>待办标题</span><input value={todo} maxLength={200} disabled={sending} onChange={event => setTodo(event.target.value)} /></label>
        : <fieldset className="pr-response-kinds" disabled={sending}><legend>回复</legend>
          {NOT_FIXING.map(option => <label key={option.kind}><input type="radio" name="pr-response-kind" checked={kind === option.kind} onChange={() => setKind(option.kind)} /><strong>{PR_RESPONSE_LABELS[option.kind]}</strong><span>{option.hint}</span></label>)}
        </fieldset>}
      <label className="pr-response-field"><span>{later ? "补充说明（可选）" : "理由"}</span><textarea rows={4} value={reason} maxLength={4_000} disabled={sending} onChange={event => setReason(event.target.value)} /></label>
      <div className="pr-response-preview"><span>将回复</span><div className="assistant-answer">{renderMarkdown(prResponseReply(later ? "later" : kind, words || "（理由）"))}</div></div>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  </ModalDialog>;
}
