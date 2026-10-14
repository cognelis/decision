import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  DecisionApi,
  ObsidianSearchResult,
  ObsidianSearchStatus,
} from "../../../../shared/renderer-api.js";
import { zonedFormatter } from "../../../calendar-date.js";
import { navigateList } from "../../../list-navigation.js";
import { useSearchHighlight } from "../../../use-search-highlight.js";
import { useObsidianSearchStatus } from "./useObsidianSearchStatus.js";

export type ObsidianSearchApi = Pick<
  DecisionApi,
  | "getObsidianSearchStatus"
  | "searchObsidian"
  | "rebuildObsidianSearch"
  | "openObsidianNote"
>;

interface VaultNoteResultsProps {
  api: ObsidianSearchApi;
  /**
   * The knowledge page's own query. Decisions and notes are the same vault, so
   * they answer to one search box rather than two.
   */
  query: string;
}

const matchLabel: Record<ObsidianSearchResult["matchKind"], string> = {
  keyword: "关键词命中",
  semantic: "语义相关",
  hybrid: "综合命中",
};

const statusCopy = (
  status: ObsidianSearchStatus | null,
  rebuilding: boolean,
): string => {
  if (status === null) return "正在读取全库索引状态…";
  if (rebuilding && status.state !== "indexing") {
    return "正在完成全库索引重建…";
  }
  if (status.state === "idle") {
    return "尚未建立全库索引。";
  }
  if (status.state === "indexing") {
    return status.indexedNotes === 0
      ? "正在建立全库索引，完成后即可搜索。"
      : "正在更新全库索引，已有内容仍可搜索。";
  }
  if (status.state === "ready") {
    return status.skippedNotes > 0 || status.failedNotes > 0
      ? "索引已完成，部分笔记未纳入。"
      : "全库索引已就绪。";
  }
  if (status.state === "unavailable") {
    return status.skippedNotes > 0 || status.failedNotes > 0
      ? "语义检索暂不可用，当前仅使用关键词匹配；部分笔记未纳入。"
      : "语义检索暂不可用，当前仅使用关键词匹配。";
  }
  return "全库索引暂时不可用，请重建后重试。";
};

// As every other time on the knowledge page reads (2026年10月5日 08:30), not "2026/10/5 08:30:00".
const synchronizedFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const synchronizedLabel = (value: string | null): string => {
  if (value === null) return "最近同步：尚未完成";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "最近同步：已完成";
  return `最近同步：${synchronizedFormatter.format(timestamp)}`;
};

export const VaultNoteResults = ({ api, query }: VaultNoteResultsProps) => {
  const { status, statusError, startAction } = useObsidianSearchStatus(api);
  const [results, setResults] = useState<ObsidianSearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [openingPaths, setOpeningPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const searchRevisionRef = useRef(0);
  const rebuildRevisionRef = useRef(0);
  const searchingRef = useRef(false);
  const rebuildingRef = useRef(false);
  const openingPathsRef = useRef(new Set<string>());
  const resultsRef = useRef<HTMLUListElement>(null);
  useSearchHighlight(
    resultsRef,
    ".obsidian-search-result-title, .obsidian-search-result-heading, .obsidian-search-result-snippet",
    query,
    "note-search",
    results,
  );

  const handleResultsKeyDown = (
    event: ReactKeyboardEvent<HTMLUListElement>,
  ): void => {
    navigateList(
      event,
      [
        ...event.currentTarget.querySelectorAll<HTMLElement>(
          ".obsidian-search-result-action",
        ),
      ],
    );
  };

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    searchRevisionRef.current += 1;
    rebuildRevisionRef.current += 1;
    searchingRef.current = false;
    rebuildingRef.current = false;
    openingPathsRef.current = new Set();
    setResults([]);
    setHasSearched(false);
    setSubmittedQuery(null);
    setSearching(false);
    setRebuilding(false);
    setOpeningPaths(new Set());
    setSearchError(null);
    setRebuildError(null);
    setOpenError(null);
    return () => {
      if (lifecycleGenerationRef.current === generation) {
        lifecycleGenerationRef.current = generation + 1;
        searchRevisionRef.current += 1;
        rebuildRevisionRef.current += 1;
        searchingRef.current = false;
        rebuildingRef.current = false;
        openingPathsRef.current = new Set();
      }
    };
  }, [api]);

  const runSearch = async (trimmedQuery: string) => {
    const generation = lifecycleGenerationRef.current;
    const searchRevision = searchRevisionRef.current + 1;
    searchRevisionRef.current = searchRevision;
    const statusAction = startAction("search");
    const isCurrentSearch = () =>
      lifecycleGenerationRef.current === generation &&
      searchRevisionRef.current === searchRevision;
    searchingRef.current = true;
    setSearching(true);
    setSearchError(null);
    try {
      const response = await api.searchObsidian({ query: trimmedQuery });
      if (!isCurrentSearch()) return;
      statusAction.commit(response.status);
      setResults(response.results);
      setSubmittedQuery(trimmedQuery);
      setHasSearched(true);
    } catch {
      if (!isCurrentSearch()) return;
      setSearchError("暂时无法搜索 Obsidian 笔记。");
    } finally {
      if (isCurrentSearch()) {
        searchingRef.current = false;
        setSearching(false);
      }
    }
  };

  const indexedNotes = status?.indexedNotes ?? 0;
  // A status we have not read yet is not a reason to swallow the user's first
  // query — only a known-empty index is. The service answers honestly either
  // way, and the shared box must not feel dead while the index reports in.
  const canSearch = status === null || indexedNotes > 0;

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      searchRevisionRef.current += 1;
      setResults([]);
      setHasSearched(false);
      setSubmittedQuery(null);
      setSearching(false);
      return;
    }
    if (!canSearch) return;
    // Matches the decision list's own debounce so both halves of a result
    // settle together rather than one flickering ahead of the other.
    const timer = setTimeout(() => void runSearch(trimmedQuery), 160);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSearch is
    // recreated every render; the revision guard, not identity, orders results.
  }, [canSearch, query]);

  const rebuild = async () => {
    if (rebuildingRef.current) return;
    const generation = lifecycleGenerationRef.current;
    const rebuildRevision = rebuildRevisionRef.current + 1;
    rebuildRevisionRef.current = rebuildRevision;
    const statusAction = startAction("rebuild");
    const isCurrentRebuild = () =>
      lifecycleGenerationRef.current === generation &&
      rebuildRevisionRef.current === rebuildRevision;
    rebuildingRef.current = true;
    setRebuilding(true);
    setRebuildError(null);
    try {
      const nextStatus = await api.rebuildObsidianSearch();
      if (isCurrentRebuild()) statusAction.commit(nextStatus);
    } catch {
      if (isCurrentRebuild()) {
        setRebuildError("暂时无法重建 Obsidian 全库索引。");
        statusAction.recover();
      }
    } finally {
      if (isCurrentRebuild()) {
        rebuildingRef.current = false;
        setRebuilding(false);
      }
    }
  };

  const openResult = async (result: ObsidianSearchResult) => {
    if (openingPathsRef.current.has(result.relativePath)) return;
    const generation = lifecycleGenerationRef.current;
    const nextOpeningPaths = new Set(openingPathsRef.current);
    nextOpeningPaths.add(result.relativePath);
    openingPathsRef.current = nextOpeningPaths;
    setOpeningPaths(nextOpeningPaths);
    setOpenError(null);
    try {
      await api.openObsidianNote(result.relativePath);
    } catch {
      if (lifecycleGenerationRef.current !== generation) return;
      setOpenError("暂时无法在 Obsidian 中打开这篇笔记。");
    } finally {
      if (lifecycleGenerationRef.current === generation) {
        const remainingPaths = new Set(openingPathsRef.current);
        remainingPaths.delete(result.relativePath);
        openingPathsRef.current = remainingPaths;
        setOpeningPaths(remainingPaths);
      }
    }
  };

  const firstIndexing = status?.state === "indexing" && indexedNotes === 0;

  return (
    <section
      className="decision-library-card vault-note-results"
      aria-label="Vault 笔记"
    >
      <div className="vault-note-heading">
        <h2>Vault 笔记</h2>
        <span className="decision-result-count">
          {query.trim().length === 0
            ? `${indexedNotes} 篇已索引`
            : searching
              ? "正在查找…"
              : hasSearched
                ? `${results.length} 篇笔记`
                : firstIndexing
                  ? "首次索引完成前请稍候"
                  : "等待索引就绪"}
        </span>
      </div>

      <div className="obsidian-search-content">
        <section className="obsidian-search-status-strip" aria-label="索引状态">
          <p className="obsidian-search-privacy">检索仅在本机处理</p>
          <p className="obsidian-search-state" role="status">
            {statusCopy(status, rebuilding)}
          </p>
          <div className="obsidian-search-coverage">
            <span>
              已索引 {indexedNotes} / 发现 {status?.discoveredNotes ?? 0} 篇笔记
            </span>
            {status?.state === "indexing" ? (
              <span>
                已处理 {status.processedNotes} / {status.totalNotes} 篇
              </span>
            ) : null}
            {(status?.skippedNotes ?? 0) > 0 ? (
              <span>{status?.skippedNotes} 篇笔记未纳入索引</span>
            ) : null}
            {(status?.failedNotes ?? 0) > 0 ? (
              <span>{status?.failedNotes} 篇笔记处理失败</span>
            ) : null}
            <span>{status?.chunkCount ?? 0} 个片段</span>
            <span>{synchronizedLabel(status?.synchronizedAt ?? null)}</span>
          </div>
          <button
            className="secondary-button obsidian-search-rebuild"
            type="button"
            disabled={rebuilding}
            onClick={() => void rebuild()}
          >
            {rebuilding ? "正在重建…" : "重建全库索引"}
          </button>
        </section>

        {statusError === null ? null : (
          <p className="error-message obsidian-status-error" role="alert">
            {statusError}
          </p>
        )}
        {searchError === null ? null : (
          <p className="error-message obsidian-search-error" role="alert">
            {searchError}
          </p>
        )}
        {rebuildError === null ? null : (
          <p className="error-message obsidian-rebuild-error" role="alert">
            {rebuildError}
          </p>
        )}
        {openError === null ? null : (
          <p className="error-message obsidian-open-error" role="alert">
            {openError}
          </p>
        )}

        <div className="obsidian-search-results-state">
          {hasSearched && submittedQuery !== null ? (
            <>
              {results.length === 0 ? (
                <p className="obsidian-search-result-summary" role="status">
                  “{submittedQuery}” 没有匹配的笔记
                </p>
              ) : (
                <ul
                  ref={resultsRef}
                  className="obsidian-search-results"
                  aria-label="Obsidian 搜索结果"
                  onKeyDown={handleResultsKeyDown}
                >
                  {results.map((result, index) => (
                    <li
                      className="obsidian-search-result"
                      key={`${result.relativePath}:${result.heading ?? ""}:${index}`}
                    >
                      <button
                        className="obsidian-search-result-action"
                        type="button"
                        aria-label={`在 Obsidian 中打开：${result.title}`}
                        // Not `disabled`: a disabled button gives up focus, and the arrow keys with it.
                        // A second open while one is under way is turned away in openResult.
                        aria-disabled={openingPaths.has(result.relativePath)}
                        onClick={() => void openResult(result)}
                      >
                        <span className="obsidian-search-result-title">
                          {result.title}
                        </span>
                        <span className="obsidian-search-result-path">
                          {result.relativePath}
                        </span>
                        {result.heading === null ? null : (
                          <span className="obsidian-search-result-heading">
                            {result.heading}
                          </span>
                        )}
                        <span className="obsidian-search-result-snippet">
                          {result.snippet}
                        </span>
                        <span
                          className={`obsidian-search-match ${result.matchKind}`}
                        >
                          {matchLabel[result.matchKind]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : firstIndexing ? (
            <p className="obsidian-search-instruction">
              首次索引完成前请稍候。
            </p>
          ) : (
            <p className="obsidian-search-instruction">
              上方的关键词同时搜索决策与笔记。
            </p>
          )}
        </div>
      </div>
    </section>
  );
};
