import { HISTORICAL_REVERSIBILITY_LABELS, HISTORICAL_SOURCE_LABELS, HISTORICAL_STATUS_LABELS, localCalendarDate } from "@cognelis/decision-core/historical-decision";
import type { HistoricalDecision, HistoricalDecisionReversibility, HistoricalDecisionStatus, ListHistoricalDecisionsResult } from "@cognelis/decision-protocol";
import { useEffect, useRef, useState } from "react";

import { sourceLabel } from "../../../client-labels.js";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { useSlashToFocus } from "../../../use-slash-focus.js";
import { ActionIcon } from "../../IconButton.js";
import { HistoricalDecisionDetail, type HistoricalDetailApi } from "./HistoricalDecisionDetail.js";

export type HistoricalDecisionApi = HistoricalDetailApi & Pick<DecisionApi, "rebuildHistoricalDecisionIndex" | "openVaultDocument">;

interface HistoricalDecisionViewProps {
  api: HistoricalDecisionApi;
  /** Moves when a record is written or the page is shown again: the list reads again. */
  refreshRevision: number;
  /** A record to open on arrival (one just recorded, one a decision links back to). */
  openId?: string | null;
  onOpenConsumed?(): void;
  /** How many records are kept in all, for the page's header. */
  onCounted?(kept: number): void;
  /** Opens 主动记录 on 历史决定. */
  onRecord(): void;
  onOpenDecision(id: string): void;
}

type StatusFilter = "all" | HistoricalDecisionStatus;
type PeriodFilter = "all" | "30d" | "90d" | "year";

const STATUS_FILTERS: ReadonlyArray<[StatusFilter, string]> = [["all", "全部"], ["active", "有效"], ["superseded", "已替代"], ["ended", "已结束"], ["withdrawn", "已撤回"]];
const PERIODS: ReadonlyArray<[PeriodFilter, string]> = [["all", "全部"], ["30d", "近 30 天"], ["90d", "近 90 天"], ["year", "今年"]];

/** The first day a period reaches back to, on this machine's calendar. */
const since = (period: PeriodFilter, now: Date): string | undefined => {
  if (period === "all") return undefined;
  if (period === "year") return `${now.getFullYear()}-01-01`;
  const from = new Date(now);
  from.setDate(from.getDate() - (period === "30d" ? 30 : 90));
  return localCalendarDate(from);
};

const fileName = (path: string): string => path.split("/").at(-1) ?? path;

/**
 * 知识 › 历史决定: the ledger of choices already made, newest decision first. Read from the App's index of the
 * notes under Decision Journal/history; nothing here is a decision record, and none of it is searched as one.
 */
export const HistoricalDecisionView = ({ api, refreshRevision, openId = null, onOpenConsumed, onCounted, onRecord, onOpenDecision }: HistoricalDecisionViewProps) => {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [project, setProject] = useState("");
  const [period, setPeriod] = useState<PeriodFilter>("all");
  const [tag, setTag] = useState("");
  const [reversibility, setReversibility] = useState<"" | HistoricalDecisionReversibility>("");
  const [listed, setListed] = useState<ListHistoricalDecisionsResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [changed, setChanged] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);
  const [showUnreadable, setShowUnreadable] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashToFocus(searchRef);

  const typed = useRef(query);
  // The page's own setter, as last given: named in the effect, each render's new one would read the list again.
  const counted = useRef(onCounted);
  counted.current = onCounted;
  useEffect(() => {
    let current = true;
    const read = (): void => {
      void api.listHistoricalDecisions({
        ...(query.trim() === "" ? {} : { query: query.trim() }),
        // 全部 is every record, the withdrawn ones too: they are told apart in the list, not left out of it.
        ...(status === "all" ? { includeWithdrawn: true } : { status }),
        ...(project === "" ? {} : { project }),
        ...(tag === "" ? {} : { tag }),
        ...(reversibility === "" ? {} : { reversibility }),
        ...(since(period, new Date()) === undefined ? {} : { fromDate: since(period, new Date())! }),
        limit: 100,
      }).then((result) => {
        if (!current) return;
        setListed(result);
        setFailure(null);
        counted.current?.(result.kept);
      }, (error: unknown) => {
        if (current) setFailure(error instanceof Error && error.message !== "" ? error.message : "无法读取历史决定。");
      });
    };
    // Typed, the list waits for the typing to pause; a filter or a change elsewhere reads at once.
    const waited = typed.current !== query;
    typed.current = query;
    const timer = waited ? window.setTimeout(read, 160) : (read(), undefined);
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, query, status, project, period, tag, reversibility, refreshRevision, changed]);

  // A record to arrive at: shown whatever the list is filtered to.
  useEffect(() => {
    if (openId === null) return;
    setSelected(openId);
    onOpenConsumed?.();
  }, [openId, onOpenConsumed]);

  const filtered = query.trim() !== "" || status !== "all" || project !== "" || period !== "all" || tag !== "" || reversibility !== "";
  const reset = (): void => { setQuery(""); setStatus("all"); setProject(""); setPeriod("all"); setTag(""); setReversibility(""); };
  const rebuild = async (): Promise<void> => {
    setRebuilding(true);
    setRebuildNote(null);
    try {
      const { index } = await api.rebuildHistoricalDecisionIndex();
      setRebuildNote(index.state === "ready" ? index.message ?? `索引已从 Vault 重建，读入 ${index.indexed ?? 0} 条。` : `重建没有完成：${index.message ?? "索引文件仍然读不了"}`);
      setChanged((count) => count + 1);
    } catch (error) {
      setRebuildNote(`重建没有完成：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRebuilding(false);
    }
  };

  const records = listed?.records ?? [];
  const indexDown = listed?.index.state === "unavailable";
  const unreadable = listed?.diagnostics ?? [];
  const empty = listed !== null && !indexDown && listed.kept === 0;
  const select = (label: string, value: string, change: (value: string) => void, options: ReadonlyArray<readonly [string, string]>, className = "") => (
    <label className={`decision-source-filter ${className}`}>
      <span>{label}</span>
      <select value={value} onChange={(event) => change(event.currentTarget.value)}>
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </label>
  );
  const marks = (record: HistoricalDecision) => (
    <>
      {record.supersedesId === null ? null : <small className="historical-mark">替代旧决定</small>}
      {record.promotedDecisionId === null ? null : <small className="historical-mark">已转正式决策</small>}
      {record.reversibility === null ? null : <small className="historical-mark">{HISTORICAL_REVERSIBILITY_LABELS[record.reversibility]}</small>}
      {record.tags.slice(0, 2).map((item) => <small key={item} className="historical-tag">#{item}</small>)}
    </>
  );

  return (
    <>
      <section className="decision-library-card historical-decision-list" aria-label="历史决定">
        {/* Nothing to search or filter with no record, or with the index out of reach: only what to do about it. */}
        {indexDown || (empty && unreadable.length === 0) ? null : (
          <div className="decision-library-toolbar">
            <div className="decision-search-control">
              <div className="decision-search-field">
                <ActionIcon name="search" />
                <input ref={searchRef} role="searchbox" aria-label="搜索历史决定" maxLength={200} placeholder="按事项、决定、背景或备注搜索" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
                <kbd className="decision-search-shortcut" aria-hidden="true">/</kbd>
              </div>
            </div>
            <div className="decision-filter-segment" role="group" aria-label="状态">
              {STATUS_FILTERS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</button>
              ))}
            </div>
            {select("项目", project, setProject, [["", "全部"], ...(listed?.projects ?? []).map((item) => [item, item] as const)])}
            {select("时间", period, (value) => setPeriod(value as PeriodFilter), PERIODS)}
            {select("标签", tag, setTag, [["", "全部"], ...(listed?.tags ?? []).map((item) => [item, item] as const)])}
            {select("可逆性", reversibility, (value) => setReversibility(value as typeof reversibility), [["", "全部"], ...Object.entries(HISTORICAL_REVERSIBILITY_LABELS)])}
            <span className="decision-result-count" role="status">{listed === null || indexDown ? "" : `${listed.total} 条结果`}</span>
          </div>
        )}

        {failure === null ? null : <p className="load-failure" role="alert">无法读取历史决定：{failure}</p>}
        {indexDown ? (
          <div className="historical-notice" role="alert">
            <ActionIcon name="warning" />
            <p>
              <strong>本机索引读不了，这里暂时列不出记录。</strong>
              <span>Vault 里读到 {listed?.index.found ?? 0} 篇历史决定笔记，它们都还在。笔记是事实源，索引只是加速用的副本；重建只读笔记，不改内容。</span>
            </p>
            <button type="button" className="secondary-button" disabled={rebuilding} onClick={() => void rebuild()}>{rebuilding ? "正在重建…" : "从 Vault 重建索引"}</button>
          </div>
        ) : null}
        {rebuildNote === null ? null : <p className="historical-rebuild-note" role="status">{rebuildNote}</p>}
        {unreadable.length === 0 ? null : (
          <div className="historical-notice" role="status">
            <ActionIcon name="warning" />
            <p>
              <strong>{unreadable.length} 篇笔记读不出来，没有进入列表。</strong>
              <span>其余的照常显示；在 Obsidian 里修好后会自动出现。</span>
            </p>
            <button type="button" className="secondary-button" aria-expanded={showUnreadable} onClick={() => setShowUnreadable((shown) => !shown)}>{showUnreadable ? "收起" : "查看"}</button>
            {showUnreadable ? (
              <ul>
                {unreadable.map((item) => (
                  <li key={item.path}>
                    <button type="button" title={item.path} onClick={() => void api.openVaultDocument(item.path).catch(() => undefined)}>{fileName(item.path)}</button>
                    <span>{item.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {indexDown || failure !== null ? null : empty ? (
          <div className="decision-library-empty historical-empty">
            <span className="historical-empty-icon" aria-hidden="true"><ActionIcon name="history" /></span>
            <strong>还没有历史决定</strong>
            <span>只记决定了什么、何时定的。不写理由，不进复盘。</span>
            <button type="button" className="secondary-button" onClick={onRecord}>
              <ActionIcon name="plus" />
              记一条历史决定
            </button>
            <small>补充理由时点「记为历史决定」，也会记到这里。</small>
          </div>
        ) : listed !== null && records.length === 0 ? (
          <div className="decision-library-empty">
            <strong>没有匹配结果</strong>
            <span>调整关键词或筛选条件后再试。</span>
            {filtered ? <button type="button" className="secondary-button decision-library-reset" onClick={reset}>清除关键词与筛选</button> : null}
          </div>
        ) : (
          <ol className="decision-library-list">
            {records.map((record) => (
              <li key={record.id} className="decision-library-item">
                <button type="button" className={`decision-library-row historical-row${record.status === "withdrawn" ? " withdrawn" : ""}`} onClick={() => setSelected(record.id)}>
                  <span className="decision-library-copy">
                    <strong>{record.title}</strong>
                    <span><span>{record.decision}</span>{marks(record)}</span>
                  </span>
                  <span className="historical-row-pair">
                    <span>{record.project ?? "未归属项目"}</span>
                    <span>{record.scope ?? ""}</span>
                  </span>
                  <span className="historical-row-pair">
                    <span>{record.participants.join("、")}</span>
                    <span>{HISTORICAL_SOURCE_LABELS[record.sourceKind]}{record.sourceClient === null ? "" : ` · ${sourceLabel(record.sourceClient)}`}</span>
                  </span>
                  <time dateTime={record.decidedOn}>{record.decidedOn}</time>
                  <span className={`rationale-state historical-status ${record.status}`}>{HISTORICAL_STATUS_LABELS[record.status]}</span>
                  <span className="decision-library-disclosure" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ol>
        )}

        {empty || indexDown ? null : (
          <p className="historical-footnote">
            <ActionIcon name="info" />
            <span>存在 Obsidian 的 <b>Decision Journal/history/</b> 与本机索引里；不进入 search_decision_context，也不进入待补理由和复盘队列。</span>
          </p>
        )}
      </section>

      {selected === null ? null : (
        <HistoricalDecisionDetail
          api={api}
          id={selected}
          order={records.map((record) => record.id)}
          revision={refreshRevision + changed}
          onOpen={setSelected}
          onClose={() => setSelected(null)}
          onChanged={() => setChanged((count) => count + 1)}
          onOpenDecision={(id) => { setSelected(null); onOpenDecision(id); }}
        />
      )}
    </>
  );
};
