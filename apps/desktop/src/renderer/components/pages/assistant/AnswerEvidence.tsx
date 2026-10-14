import { IconButton, ActionIcon } from "../../IconButton.js";
import { memo, useRef, useState, useEffect } from "react";
import type { AssistantSourceCheck, RetrievalAnswerCitation } from "@cognelis/decision-protocol";
import { renderMarkdown } from "./markdown.js";

type CitationTarget =
  | { kind: "decision"; id: string }
  | { kind: "principle"; id: string }
  | { kind: "journal"; id: string }
  | { kind: "document"; reference: string };

const CITATION_TARGET_LABELS: Record<CitationTarget["kind"], string> = {
  decision: "打开决策详情",
  principle: "打开原则详情",
  journal: "在偏好与想法中打开",
  document: "在 Obsidian 中打开",
};

/**
 * A decision or principle this app holds goes to its own page, where its
 * scope, relations and review live — the Markdown behind it is the same
 * record with all of that stripped off. Notes, and decisions in the
 * historical format the index does not carry, still open in the vault.
 *
 * The label and the action both come from here, so the button cannot say one
 * and do the other.
 */
/** Said beside a source that may no longer stand: here, in a record drafted from the answer, in an export. */
export const citationStanding = (citation: Pick<RetrievalAnswerCitation, "lifecycle">): string | null =>
  citation.lifecycle === "superseded" ? "已被取代" : citation.lifecycle === "uncertain" ? "可能已更新" : null;

export const citationTarget = (
  citation: RetrievalAnswerCitation,
): CitationTarget => {
  const recordId = citation.recordId;
  if (recordId === undefined) {
    return { kind: "document", reference: citation.reference };
  }
  if (citation.kind === "decision") return { kind: "decision", id: recordId };
  if (citation.kind === "principle") {
    return { kind: "principle", id: recordId };
  }
  if (citation.kind === "preference" || citation.kind === "idea") {
    return { kind: "journal", id: recordId };
  }
  return { kind: "document", reference: citation.reference };
};

const SourceComparison = ({ citation, checkSource }: {
  citation: RetrievalAnswerCitation;
  checkSource(citation: RetrievalAnswerCitation): Promise<AssistantSourceCheck>;
}) => {
  const [result, setResult] = useState<AssistantSourceCheck | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <div className="assistant-source-comparison">
    <button type="button" className="text-button" disabled={pending} onClick={async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError(false);
      setResult(null);
      try {
        const checked = await checkSource(citation);
        if (alive.current) setResult(checked);
      } catch { if (alive.current) setError(true); }
      finally { inFlight.current = false; if (alive.current) setPending(false); }
    }}>{pending ? "正在核对来源…" : "核对当前来源"}</button>
    {error ? <p role="alert">无法核对来源，请重试。历史摘录已保留。</p> : null}
    {result === null ? null : <>
      <p role="status">{result.status === "matched" ? "历史摘录仍能在当前来源中找到；这不代表全文没有变化。" : result.status === "review" ? "历史摘录未在当前来源中完整匹配，来源可能已修改，请对照核对。" : "当前来源无法读取，可能已移动、删除或暂不可用。历史摘录已保留。"}</p>
      {result.status === "unavailable" ? null : <details open>
        <summary>当前来源{result.truncated ? "（仅展示前 20,000 字符）" : ""}</summary>
        <pre>{result.content}</pre>
      </details>}
    </>}
  </div>;
};

export const AnswerEvidence = memo(function AnswerEvidence({ content, citations, onOpen, checkSource }: {
  content: string;
  citations: readonly RetrievalAnswerCitation[];
  onOpen(citation: RetrievalAnswerCitation): void;
  checkSource(citation: RetrievalAnswerCitation): Promise<AssistantSourceCheck>;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const reveal = (index: number): void => {
    const detail = listRef.current?.querySelector<HTMLDetailsElement>(`details[data-citation-index="${index}"]`);
    if (detail === null || detail === undefined) return;
    detail.open = true;
    detail.scrollIntoView?.({ block: "nearest" });
    detail.querySelector("summary")?.focus({ preventScroll: true });
  };
  return <>
    <div className="assistant-answer">{renderMarkdown(content, { indexes: citations.map((citation) => citation.index), onSelect: reveal })}</div>
    {citations.length === 0 ? null : <ul className="assistant-citations" ref={listRef}>
      {citations.map((citation) => <li key={citation.index} className="assistant-evidence">
        <details data-citation-index={citation.index}>
          <summary className="assistant-citation" aria-label={`引用 ${citation.index}：${citation.title}，查看摘录`}>
            <span className="assistant-citation-index">{citation.index}</span>
            <span className="assistant-citation-copy"><strong>{citation.title}</strong><span>{citation.reference}</span></span>
            <span className="assistant-citation-kind">
              {citationStanding(citation) === null ? null : <small className={citation.lifecycle === "uncertain" ? "assistant-citation-stale uncertain" : "assistant-citation-stale"}>{citationStanding(citation)}</small>}
              {citation.matchReason}
            </span>
          </summary>
          <div className="assistant-evidence-preview">
            <span>回答时的引用摘录</span>
            <p>{citation.excerpt || "暂无摘录，可打开来源核对。"}</p>
            <SourceComparison key={citation.reference + citation.excerpt} citation={citation} checkSource={checkSource} />
          </div>
        </details>
        <IconButton type="button" className="assistant-source-open" aria-label={`${CITATION_TARGET_LABELS[citationTarget(citation).kind]}：${citation.title}`} onClick={() => onOpen(citation)}><ActionIcon name="open" /></IconButton>
      </li>)}
    </ul>}
  </>;
});
