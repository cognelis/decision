import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PrActionContext, PrConnection, PrReviewFinding, PrReviewSnapshot } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { isSubmitShortcut, SUBMIT_SHORTCUT_KEYS, submitShortcutLabel } from "../../../keyboard.js";
import { ModalDialog } from "../../ModalDialog.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { platformMessage } from "./platform-message.js";

export const findingCommentDraft = (finding: PrReviewFinding): string =>
  `**${finding.priority} · ${finding.title}**\n\n${finding.body}`;

/**
 * The model's finding or answer is only a draft: the reviewer rewrites it here, sees
 * which commits it speaks about (and, for a finding, the line it lands on), and is the
 * one who posts it.
 */
export function PrReviewCommentDialog({ api, snapshot, connectionId, platform, finding, draft = "", onClose, onPublished }: {
  api: Pick<DecisionApi, "getPrActionContext" | "publishPrReviewComment" | "publishPrGeneralComment" | "loadPrReviewFile">;
  snapshot: PrReviewSnapshot;
  connectionId: string;
  /** Where it is posted: GitHub and GitLab apply a suggestion block in one click. */
  platform?: PrConnection["platform"] | undefined;
  /** A finding lands on its line; without one the comment is on the PR as a whole. */
  finding?: PrReviewFinding;
  /** The text a PR-wide comment starts from: an overview, suggestions or an answer. */
  draft?: string;
  onClose(): void;
  onPublished(message: string): void;
}) {
  const [context, setContext] = useState<PrActionContext | null>(null);
  const [body, setBody] = useState(() => finding ? findingCommentDraft(finding) : draft);
  // Reworded, it is closed by 取消 only: a stray Escape or click outside took the rewording with it.
  const [drafted] = useState(body);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [posting, setPosting] = useState(false);
  const [preview, setPreview] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
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

  return <ModalDialog title={finding ? "发布为 PR 评论" : "发布到 PR"} description={finding ? "评审结果只是草稿；确认措辞后，以你的平台账号发布到这一行。" : "内容只是草稿；确认措辞后，以你的平台账号在 PR 上发布一条普通评论，不绑定代码行。"} size="wide" dismissible={!posting && body === drafted} onClose={() => { if (!pending.current) onClose(); }}>
    <form className="pr-action-form" aria-label="发布评论表单" onKeyDown={event => {
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }} onSubmit={async event => {
      event.preventDefault();
      if (!canPublish || pending.current) return;
      pending.current = true; setPosting(true); setError("");
      try {
        const result = finding
          ? await api.publishPrReviewComment({ ...pinned, path: finding.path, side: finding.side, line: finding.line, body: body.trim() })
          : await api.publishPrGeneralComment({ ...pinned, body: body.trim() });
        onPublished(result.message);
      } catch (cause) { setError(platformMessage(cause, "评论发布失败，请先到平台核对后再重试。")); }
      finally { pending.current = false; setPosting(false); }
    }}>
      {finding ? <p><code>{finding.path}:{finding.line}</code>（{finding.side === "new" ? "新版本" : "旧版本"}）</p> : <p>{snapshot.reference} · 针对提交 <code>{snapshot.sourceCommit.slice(0, 12)}</code>；PR 有新提交时不会发布。</p>}
      {!context && !error ? <p role="status">正在核对平台上的提交与分支…</p> : null}
      {context ? context.state !== "open" ? <p role="alert">{context.state === "merged" ? "PR 已合并，不再发布评论。" : "PR 已关闭或锁定，不再发布评论。"}</p> :
        <div className="pr-action-branches"><div><span>源分支</span><strong>{context.sourceBranch}</strong><code>{context.sourceCommit.slice(0, 12)}</code></div><div><span>目标分支</span><strong>{context.destinationBranch}</strong><code>{context.destinationCommit.slice(0, 12)}</code></div></div> : null}
      <div className="pr-comment-field">
        <div className="pr-comment-field-head"><span>评论内容（Markdown）{suggestable ? <> · <button type="button" className="review-note-link" title="作者在平台上可以一键把这段代码应用到这一行" disabled={posting || suggesting} onClick={() => void insertSuggestion()}>{suggesting ? "正在读取这一行…" : "插入建议修改"}</button></> : null}</span><div className="pr-diff-modes" role="group" aria-label="编辑或预览"><button type="button" aria-pressed={!preview} disabled={posting} onClick={() => setPreview(false)}>编辑</button><button type="button" aria-pressed={preview} disabled={posting || !body.trim()} onClick={() => setPreview(true)}>预览</button></div></div>
        <textarea ref={field} aria-label="评论内容" hidden={preview} rows={8} value={body} maxLength={10000} disabled={posting} onChange={event => setBody(event.target.value)} />
        {preview ? <><div className="assistant-answer pr-comment-preview" role="region" aria-label="评论预览">{renderMarkdown(body)}</div><p>预览只是近似效果，发布后以平台显示为准。</p></> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!context && error ? <button type="button" className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重新核对平台状态</button> : null}
      <div className="modal-form-actions"><button type="button" className="secondary-button" disabled={posting} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!canPublish} aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS} title={`${submitShortcutLabel()} 发布`}>{posting ? "正在发布…" : "发布评论"}</button></div>
    </form>
  </ModalDialog>;
}
