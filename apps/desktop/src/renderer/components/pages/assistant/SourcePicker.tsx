import { IconButton, ActionIcon } from "../../IconButton.js";
import { useEffect, useRef, useState } from "react";
import type { RetrievalAnswerCitation } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";

export const SourcePicker = ({ api, sources, disabled, onChange }: {
  api: Pick<DecisionApi, "searchAssistantSources">;
  sources: RetrievalAnswerCitation[] | undefined;
  disabled: boolean;
  onChange(sources: RetrievalAnswerCitation[] | undefined): void;
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RetrievalAnswerCitation[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  const selected = sources !== undefined;
  return <div className="assistant-library assistant-source-picker">
    <div className="assistant-library-body">
      <div className="assistant-source-modes" role="group" aria-label="材料选择方式">
        <button type="button" aria-pressed={!selected} disabled={disabled} onClick={() => onChange(undefined)}>自动检索</button>
        <button type="button" aria-label="仅根据指定材料回答" aria-pressed={selected} disabled={disabled} onClick={() => { if (!selected) onChange([]); }}>指定材料{selected && sources.length > 0 ? <span>{sources.length}</span> : null}</button>
      </div>
      {!selected ? <p className="assistant-source-hint">在当前范围内查找相关材料。</p> : <>
        <form className="assistant-library-tools" onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || !query.trim()) return;
          const id = ++request.current;
          setLoading(true);
          setNotice("");
          try {
            const response = await api.searchAssistantSources({ query: query.trim(), scope: "all" });
            if (id !== request.current) return;
            setResults(response.sources);
            setNotice(response.issues.join("；") || (response.sources.length ? "" : "没有匹配的材料。"));
          } catch {
            if (id === request.current) { setResults([]); setNotice("材料检索失败，请重试。"); }
          } finally { if (id === request.current) setLoading(false); }
        }}>
          <div className="assistant-search-field"><ActionIcon name="search" /><input aria-label="搜索指定材料" placeholder="搜索决策、原则或笔记" value={query} maxLength={500} disabled={disabled} onChange={(event) => { request.current += 1; setLoading(false); setResults([]); setNotice(""); setQuery(event.target.value); }} /></div>
          <button className="assistant-search-submit" aria-label="搜索材料" type="submit" disabled={disabled || loading || !query.trim()}>{loading ? "搜索中…" : "搜索"}</button>
        </form>
        <ul className="assistant-source-chips" aria-label="已指定的材料">
          {sources.map((source) => <li key={source.reference}><span>{source.title}</span><IconButton type="button" disabled={disabled} aria-label={`移除材料：${source.title}`} onClick={() => onChange(sources.filter((entry) => entry.reference !== source.reference))}><ActionIcon name="close" /></IconButton></li>)}
        </ul>
        <ul className="assistant-source-list" aria-label="材料搜索结果">
          {results.map((source) => {
            const checked = sources.some((entry) => entry.reference === source.reference);
            return <li key={source.reference} className={checked ? "selected" : ""}><label><input type="checkbox" checked={checked} disabled={disabled || (!checked && sources.length >= 12)} onChange={() => onChange(checked ? sources.filter((entry) => entry.reference !== source.reference) : [...sources, source])} /><span className="assistant-source-check" aria-hidden="true"><ActionIcon name="check" /></span><span className="assistant-source-copy"><strong>{source.title}</strong><small>{source.reference}</small></span></label></li>;
          })}
        </ul>
        <p className="assistant-source-hint" role="status">{notice || (sources.length === 0 ? "搜索并选择材料，最多 12 份。" : `仅依据这 ${sources.length} 份材料回答。`)}</p>
      </>}
    </div>
  </div>;
};
