import { useEffect, useState } from "react";
import { clipText, type PrDiscussion, type PrDiscussionComment, type PrReviewSnapshot } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
// The day the reader saw it on, as the dialog shows it: the UTC date was the day before for a morning comment.
import { calendarDate } from "../../../calendar-date.js";
import { ModalDialog } from "../../ModalDialog.js";
import type { ActiveRecordDraft } from "../decisions/ActiveRecordDialog.js";
import { renderMarkdown } from "../assistant/markdown.js";

const place = (comment: Pick<PrDiscussionComment, "path" | "line">): string | null =>
  comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""}` : null;

const byWhom = (comment: PrDiscussionComment): string => `${comment.author || "未知作者"} · ${calendarDate(new Date(comment.createdAt))}`;

/**
 * Where a comment's code comes from, as its record and the dialog say: the change the reviewer saw then, or lines of the
 * file as the PR has it now, which may since have moved on. Code read before `kind` was said is the file's.
 */
const codeSource = (code: NonNullable<PrDiscussionComment["code"]>): string => {
  if (code.kind === "hunk") return "评论当时的改动，diff 片段";
  const to = code.from + code.text.split("\n").length - 1;
  return `${code.side === "new" ? "PR 当前版本" : "改动前版本"}第 ${code.from === to ? to : `${code.from}–${to}`} 行`;
};

/** A diff's lines told apart, as the platform shows them: removed, added, and the header saying where each stretch is. */
const diffLines = (text: string) => text.split("\n").map((line, index, lines) =>
  <span key={index} data-diff={line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : undefined}>{index < lines.length - 1 ? `${line}\n` : line}</span>);

/**
 * What a PR comment's record is given as its context. A record holds 8,000 characters: filled to that, what the reader
 * then added to it, which is what the form is for, was refused.
 */
const CONTEXT_CHARS = 6_000;
const CUT = "…（这条评论过长，后文省略）";

/**
 * The code fence (its run of ``` or ~~~) a text cut short leaves open. Left open, a record copied as Markdown read as
 * code from there on, the sections after its context and the decisions after it included.
 */
const openFence = (text: string): string | null => {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const [, fence, rest = ""] = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line) ?? [];
    if (!fence) continue;
    // ```npm install``` is inline code (a backtick fence's info string holds no backtick): taken for a block, the fence
    // added to close it opened one.
    if (open === null) { if (fence[0] === "~" || !rest.includes("`")) open = fence; }
    else if (fence[0] === open[0] && fence.length >= open.length && rest.trim() === "") open = null;
  }
  return open;
};

/**
 * The thread a comment was said in, oldest first, each comment as written: squashed onto one line and cut at 500
 * characters, a suggestion's code ran into the prose around it and a long answer lost its point. Its own words are the
 * choice, so it is only named. Past `room`, the comment opening the thread stays as it does (what was asked, which a
 * reply's "可以" agrees to), then the comments farthest from it go first and are counted; the nearest that no longer
 * fits whole keeps its start.
 */
const threadText = (thread: readonly PrDiscussionComment[], self: string, opener: string, room: number): string => {
  const said = thread.map((item) => (item.id === self ? `${byWhom(item)}（本条）` : `${byWhom(item)}：\n${item.body}`));
  const at = Math.max(0, thread.findIndex((item) => item.id === self));
  // The counts said in place of what is left out take their room first.
  const kept = new Map([[at, said[at]!]]), left = () => room - 80 - [...kept.values()].reduce((sum, text) => sum + text.length + 2, 0);
  /** Whether the comment at `index` went in whole: in part, or not at all, nothing past it goes in. */
  const take = (index: number): boolean => {
    const whole = said[index]!, space = left();
    if (whole.length <= space) kept.set(index, whole);
    else if (space >= 200) {
      // Room kept for a fence to close on a line of its own: followed by anything on its line, it closes nothing.
      const start = clipText(whole, space - CUT.length - 12), fence = openFence(start);
      kept.set(index, fence ? `${start}\n${fence}\n${CUT}` : `${start}${CUT}`);
    }
    return kept.get(index) === whole;
  };
  const first = thread.findIndex((item) => item.id === opener);
  if (first >= 0 && first !== at) take(first);
  let lo = at, hi = at;
  for (let up = true, down = true; up || down;) {
    if (up) { up = lo > 0 && (kept.has(lo - 1) || take(lo - 1)); if (kept.has(lo - 1)) lo--; }
    if (down) { down = hi < said.length - 1 && (kept.has(hi + 1) || take(hi + 1)); if (kept.has(hi + 1)) hi++; }
  }
  // Each run of comments left out is counted where it was.
  const parts: string[] = [];
  for (let index = 0; index < said.length;) {
    let end = index;
    while (end < said.length && !kept.has(end)) end++;
    if (end > index) parts.push(`（上下文已满，${index === 0 ? "更早" : end === said.length ? "之后" : "其间"}的 ${end - index} 条评论未列出）`);
    if (end < said.length) parts.push(kept.get(end)!);
    index = end + 1;
  }
  return parts.join("\n\n");
};

/**
 * A PR comment as a starting decision: the reader rewrites the question, the comment's link stays. Its context is what a
 * reader needs to make sense of it later: the code it is on and the thread it was said in, oldest first.
 */
export const commentDraft = (comment: PrDiscussionComment, pr: Pick<PrReviewSnapshot, "title" | "reference" | "project">, link: string, discussion: readonly PrDiscussionComment[] = []): ActiveRecordDraft => {
  const where = place(comment);
  const opener = comment.replyTo ?? comment.id;
  const thread = discussion.filter((item) => (item.replyTo ?? item.id) === opener).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // The lines kept around the comment can stop inside a fenced block (a README's): it is closed after them.
  const code = comment.code, fence = code && openFence(code.text);
  const head = [
    `PR：${pr.title}（${pr.reference}）`,
    where ? `位置：${where}` : "",
    `评论：${byWhom(comment)}`,
    code ? `代码（${codeSource(code)}）：\n${code.text}${fence ? `\n${fence}` : ""}` : "",
  ].filter(Boolean).join("\n");
  return {
    // The question the model read in it, when it read one: the reader still rewrites it as they see fit.
    title: (comment.candidate?.question || (where ? `${where} 怎么处理？` : `「${pr.title}」怎么处理？`)).slice(0, 500),
    content: comment.body,
    project: pr.project,
    context: clipText(thread.length > 1 ? `${head}\n讨论串：\n${threadText(thread, comment.id, opener, CONTEXT_CHARS - head.length - "\n讨论串：\n".length)}` : head, CONTEXT_CHARS),
    source: { url: comment.url, label: `PR 评论 · ${link}` },
  };
};

/** What was already said on a PR; a decision made in a comment is recorded with a link back to it. */
export function PrDiscussionDialog({ api, connectionId, pr, candidatesOnly = false, onRecord, onOpenDecision, onClose }: {
  api: Pick<DecisionApi, "listPrDiscussion" | "recognizePrDiscussion" | "dismissPrCommentCandidate" | "openPrLink">;
  connectionId: string;
  pr: Pick<PrReviewSnapshot, "title" | "reference">;
  /** Opened from the home page: at first only the comments read as decisions show. */
  candidatesOnly?: boolean | undefined;
  /** With every comment read, so the draft can take the thread it was said in. */
  onRecord(comment: PrDiscussionComment, discussion: PrDiscussionComment[]): void;
  onOpenDecision?: ((id: string) => void) | undefined;
  onClose(): void;
}) {
  const [discussion, setDiscussion] = useState<PrDiscussion | null>(null);
  // The comments not read: said where they would be, with a way to read them again. Apart from what an action said.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [recognizing, setRecognizing] = useState(false);
  const [onlyCandidates, setOnlyCandidates] = useState(candidatesOnly);
  const { reference, title } = pr;
  useEffect(() => {
    let disposed = false;
    setLoadFailed(false);
    api.listPrDiscussion({ connectionId, reference }).then(
      (result) => { if (!disposed) setDiscussion(result); },
      () => { if (!disposed) setLoadFailed(true); });
    return () => { disposed = true; };
  }, [api, connectionId, reference, attempt]);
  const recognize = () => {
    setRecognizing(true); setError("");
    api.recognizePrDiscussion({ connectionId, reference, title }).then(setDiscussion,
      (cause: unknown) => setError(cause instanceof Error && cause.message ? cause.message : "识别没有完成，请稍后重试。"))
      .finally(() => setRecognizing(false));
  };
  const dismiss = (comment: PrDiscussionComment) => {
    api.dismissPrCommentCandidate(comment.url).then(
      () => setDiscussion((current) => current && { ...current, comments: current.comments.map(({ refused, ...item }) =>
        item.url === comment.url ? { ...item, candidate: null } : { ...item, ...(refused ? { refused } : {}) }) }),
      () => setError("没能记下「不是决定」，请重试。"));
  };
  const recognition = discussion?.recognition ?? null;
  const candidates = discussion?.comments.filter((comment) => comment.candidate !== null).length ?? 0;
  // A batch the provider's moderation refused is not read, which is not "评论都识别过了": the reader is told, each is marked.
  const refused = discussion?.comments.filter((comment) => comment.refused).length ?? 0;
  // Every candidate handled, the filter would show an empty PR: it lets go.
  const filtering = onlyCandidates && candidates > 0;
  const comments = discussion ? discussion.comments.filter((comment) => !filtering || comment.candidate !== null) : null;
  return <ModalDialog title="PR 讨论" description={`「${pr.title}」（${pr.reference}）上的评论。评论里做出的决定可以记为决策，记录会保留这条评论的链接。`} size="wide" onClose={onClose}>
    <div className="pr-discussion">
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {discussion ? recognition ? <div className="pr-discussion-recognition">
      {recognition.pending > 0 ? <button type="button" className="secondary-button" disabled={recognizing || recognition.callsLeft === 0} onClick={recognize}>
        {recognizing ? "正在识别…" : `找出像是决定的评论（${recognition.pending} 条未识别）`}</button> : null}
      <span className="review-history-note">{recognition.pending > 0 ? `今天还能调用 ${recognition.callsLeft} 次` : refused ? null : "评论都识别过了"}{recognition.stopped ? ` · ${recognition.stopped}` : ""}</span>
      {refused ? <span className="review-history-note">{`有 ${refused} 条评论因审核拒绝未能识别，可以手动查看并记录`}</span> : null}
      {candidates ? <button type="button" className="text-button" aria-pressed={filtering} onClick={() => setOnlyCandidates(!filtering)}>{filtering ? "显示全部评论" : `只看像是决定的（${candidates}）`}</button> : null}
    </div> : <p className="review-history-note">在 设置 › 链接 里为这个链接选择识别模型后，可以让模型找出像是决定的评论，由你确认后再记录。</p> : null}
    {comments === null ? loadFailed
      ? <div className="load-failure"><span role="alert">PR 讨论读取失败，请检查链接的访问令牌与网络后重试。</span><button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
      : <p role="status">正在读取评论…</p>
      : !comments.length ? <p>这个 PR 上还没有可读取的评论。</p> : <ol className="pr-discussion-list">
      {comments.map((comment) => <li key={comment.id} className="review-finding">
        <div className="review-message-meta"><strong>{comment.author || "未知作者"}</strong>{comment.replyTo ? <span>回复</span> : null}{place(comment) ? <code>{place(comment)}</code> : null}<time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div>
        {/* Over the comment opening a thread, as the platform shows it; its replies are on the same lines. */}
        {comment.code && !comment.replyTo ? <figure className="pr-discussion-code-figure">
          <figcaption className="review-history-note">{codeSource(comment.code)}</figcaption>
          <pre className="pr-discussion-code">{comment.code.kind === "hunk" ? diffLines(comment.code.text) : comment.code.text}</pre>
        </figure> : null}
        {/* As the platform shows it: a comment's fences, suggestions and lists are Markdown, not text to read past. */}
        <div className="assistant-answer">{renderMarkdown(comment.body, undefined, { linkTargets: true })}</div>
        {comment.candidate ? <p className="pr-discussion-candidate"><strong>像是决定</strong>{comment.candidate.question} {comment.candidate.choice}</p> : null}
        {comment.refused ? <p className="pr-discussion-candidate"><strong>未能识别</strong>它所在的一批评论被服务商审核拒绝，可以手动查看并记录</p> : null}
        {/* One group under the text, as on a finding: spread over the card, three buttons read as three unrelated corners. */}
        <div className="review-finding-actions"><div>
          <button type="button" className="text-button" onClick={() => void api.openPrLink(comment.url).catch(() => setError("无法打开这条评论：链接不属于已添加的代码平台，或系统拒绝了打开。"))}>在平台查看</button>
          {comment.decisionId === null
            ? <button type="button" className="text-button" aria-label={`把 ${comment.author || "未知作者"} 的评论记为决策`} onClick={() => onRecord(comment, discussion!.comments)}>记为决策</button>
            : onOpenDecision ? <button type="button" className="text-button" onClick={() => onOpenDecision(comment.decisionId!)}>已记为决策 · 查看</button> : <span>已记为决策</span>}
          {comment.candidate || comment.refused ? <button type="button" className="text-button" aria-label={`${comment.author || "未知作者"} 的评论不是决定`} onClick={() => dismiss(comment)}>不是决定</button> : null}
        </div></div>
      </li>)}
    </ol>}
    {discussion?.more ? <p className="review-history-note">评论较多，只列出了最近的一部分；更早的评论请在平台上查看。</p> : null}
    </div>
  </ModalDialog>;
}
