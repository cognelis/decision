import { useEffect, useRef, useState } from "react";
import { prDescriptionDraft, type PrDescription, type PrDescriptionFacts } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { renderMarkdown } from "../assistant/markdown.js";
import { platformMessage } from "./platform-message.js";

const PARTS = { verification: "验证", risk: "风险", rollback: "撤回" } as const;

/**
 * PR 描述三段 (the design's 开 PR 时：PR 描述三段，作者确认后写回): the description read fresh from the platform, the parts
 * it lacks drafted below what the author wrote, and written back as the author leaves it, over the version read only.
 */
export function PrDescriptionDialog({ api, connectionId, reference, facts, onClose, onWritten }: {
  api: Pick<DecisionApi, "getPrDescription" | "updatePrDescription">;
  connectionId: string;
  reference: string;
  /** What Paraself knows of the PR: its risk, build, latest review, the latest overview's rollback note. */
  facts: PrDescriptionFacts;
  onClose(): void;
  onWritten(message: string): void;
}) {
  const [current, setCurrent] = useState<PrDescription | null>(null);
  const [text, setText] = useState("");
  const [drafted, setDrafted] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [writing, setWriting] = useState(false);
  const [preview, setPreview] = useState(false);
  const edited = useRef(false);
  edited.current = text !== drafted;
  useEffect(() => {
    let gone = false;
    setError("");
    void api.getPrDescription({ connectionId, reference }).then(read => {
      if (gone) return;
      setCurrent(read);
      // Read again after a refusal: what the reader changed stays, set against the description as it now is.
      if (edited.current) return;
      const draft = prDescriptionDraft(read.description, facts).text;
      setText(draft); setDrafted(draft);
    }, cause => { if (!gone) setError(platformMessage(cause, "读取 PR 描述失败。")); });
    return () => { gone = true; };
  }, [api, connectionId, reference, attempt]);
  const added = current ? prDescriptionDraft(current.description, facts).added : [];
  const changed = current !== null && text.trim().length > 0 && text !== current.description;
  return <ModalDialog title="起草 PR 描述" size="wide" dismissible={!writing} unsaved={text !== drafted} onClose={() => { if (!writing) onClose(); }}
    description="按团队的 PR 模板补上验证、风险、撤回三段，已有的描述原样保留；括号里的是要你补的。确认措辞后，以你的平台账号写回 PR 描述。"
    footer={<><button type="button" className="secondary-button" disabled={writing} onClick={onClose}>取消</button>
      <button type="submit" form="pr-description-form" className="primary-button" disabled={!changed || writing}>{writing ? "正在写回…" : "写回 PR 描述"}</button></>}>
    <form id="pr-description-form" className="pr-action-form" aria-label="起草 PR 描述" onSubmit={async event => {
      event.preventDefault();
      if (!current || !changed || writing) return;
      setWriting(true); setError("");
      try {
        const result = await api.updatePrDescription({ connectionId, reference, description: text, baseVersion: current.version });
        onWritten(result.message);
      } catch (cause) { setError(platformMessage(cause, "写回 PR 描述失败，请先到平台核对后再重试。")); }
      finally { setWriting(false); }
    }}>
      <p>{reference}{current ? ` · ${current.title}` : ""}</p>
      {!current && !error ? <p role="status">正在读取 PR 描述…</p> : null}
      {current ? <p className="review-history-note">{added.length ? `补上了${added.map(part => PARTS[part]).join("、")}。` : "描述里已经有验证、风险、撤回三段，可以直接改。"}{facts.rollback ? "" : " 还没有 PR 概览，撤回一段留给你写；先生成 PR 概览，它会一并起草。"}</p> : null}
      <div className="pr-comment-field">
        <div className="pr-comment-field-head"><span>PR 描述（Markdown）</span><div className="pr-diff-modes" role="group" aria-label="编辑或预览"><button type="button" aria-pressed={!preview} disabled={writing} onClick={() => setPreview(false)}>编辑</button><button type="button" aria-pressed={preview} disabled={writing || !text.trim()} onClick={() => setPreview(true)}>预览</button></div></div>
        <textarea aria-label="PR 描述" hidden={preview} rows={14} value={text} maxLength={60_000} disabled={writing || !current} onChange={event => setText(event.target.value)} />
        {preview ? <div className="assistant-answer pr-comment-preview" role="region" aria-label="描述预览">{renderMarkdown(text, undefined, { linkTargets: true })}</div> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {error ? <button type="button" className="secondary-button" disabled={writing} onClick={() => setAttempt(value => value + 1)}>重新读取 PR 描述</button> : null}
    </form>
  </ModalDialog>;
}
