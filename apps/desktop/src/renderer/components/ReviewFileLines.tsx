import { useEffect, useRef, useState, type ReactNode } from "react";

/** Fixed-revision code, shared by hosted PR reading and local annotations. */
export function ReviewFileLines({ content, focusLine, onSelect, note, selection }: { content: string; focusLine?: number | undefined; onSelect?: ((line: number, extend: boolean) => void) | undefined; note?: ((line: number) => ReactNode) | undefined; selection?: { start: number; end: number } | undefined }) {
  const [limit, setLimit] = useState(2000), focused = useRef<HTMLLIElement>(null);
  const lines = content.split("\n"); if (content.endsWith("\n")) lines.pop();
  useEffect(() => { focused.current?.scrollIntoView?.({ block: "center" }); }, [content, focusLine]);
  const shown = Math.max(limit, focusLine ?? 0);
  return <><ol className={`pr-file-lines${onSelect ? " local-review-file-lines" : ""}`} aria-label="文件内容">{lines.slice(0, shown).map((text, index) => <li key={index} data-line={index + 1} data-selected={selection && index + 1 >= selection.start && index + 1 <= selection.end ? "" : undefined} {...(index + 1 === focusLine ? { ref: focused, "aria-current": "true" as const, "data-focus": "" } : {})}>
    {onSelect ? <div className="local-review-line"><button className="local-review-line-number" aria-label={`第 ${index + 1} 行行号`} onClick={event => onSelect(index + 1, event.shiftKey)}>{index + 1}</button><button className="local-review-add" aria-label={`在第 ${index + 1} 行新增意见`} onClick={event => onSelect(index + 1, event.shiftKey)}>+</button><button className="local-review-code-line" aria-label={`标注第 ${index + 1} 行`} onClick={event => onSelect(index + 1, event.shiftKey)}><code>{text || " "}</code></button></div> : <code>{text || " "}</code>}
    {note?.(index + 1)}
  </li>)}</ol>{lines.length > shown ? <div className="pr-diff-notice"><p>已显示前 {shown} / {lines.length} 行。</p><button className="secondary-button" onClick={() => setLimit(value => value + 2000)}>显示更多内容</button></div> : null}</>;
}
