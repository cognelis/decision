import { useEffect, type RefObject } from "react";

export interface ReviewDraft {
  sessionId: string;
  view: "file" | "diff";
  path: string;
  side: "old" | "new";
  startLine: number;
  endLine: number;
  anchor: number;
  body: string;
  initialBody: string;
  annotationId?: string;
}

export function InlineReviewEditor({ draft, busy, atLimit, editorRef, onChange, onSave, onCancel }: {
  draft: ReviewDraft;
  busy: boolean;
  atLimit: boolean;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  onChange(body: string): void;
  onSave(): void;
  onCancel(): void;
}) {
  useEffect(() => { editorRef.current?.focus(); }, [editorRef, draft.path, draft.side, draft.startLine, draft.endLine]);
  const range = draft.startLine === draft.endLine ? `L${draft.startLine}` : `L${draft.startLine}–${draft.endLine}`;
  const disabled = busy || !draft.body.trim() || (atLimit && !draft.annotationId);
  return <form className="local-review-inline-editor" aria-label={`${draft.annotationId ? "编辑意见" : "新增意见"} ${range}`} onSubmit={event => { event.preventDefault(); if (!disabled) onSave(); }} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (!disabled) onSave(); }
  }}>
    <label><strong>{draft.annotationId ? "编辑意见" : "新增意见"} · {range}</strong><span>{draft.side === "old" ? "旧版本" : "新版本"}</span><textarea ref={editorRef} aria-label={`${draft.annotationId ? "编辑意见" : "新增意见"} ${range}`} value={draft.body} maxLength={4000} disabled={busy} onChange={event => onChange(event.target.value)} placeholder="说明问题、原因和期望行为。" /></label>
    <div className="local-review-inline-actions"><small>⌘↩ 保存 · Esc 取消</small><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button disabled={disabled}>保存意见</button></div>
  </form>;
}
