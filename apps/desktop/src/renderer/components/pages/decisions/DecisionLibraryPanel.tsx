import type { OutcomeVerdict } from "@cognelis/decision-core";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  DecisionApi,
  DecisionLibraryItem,
  DecisionRationaleFilter,
  DecisionSourceFilter,
} from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";

interface DecisionLibraryPanelProps {
  api: DecisionApi;
  totalDecisions: number;
  initialReviewState?: ReviewStateFilter;
  initialDecisionId?: string | null;
  onInitialNavigationConsumed?(): void;
}

const rationaleLabels: Record<DecisionRationaleFilter, string> = {
  captured: "理由完整",
  deferred: "待补理由",
  skipped: "未补理由",
};

const sourceLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  test: "Test",
};

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const listDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dueDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
});

const calendarDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dateAfter = (days: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return calendarDate(date);
};

const dueLabel = (reviewDueDate: string): string =>
  dueDateFormatter.format(new Date(`${reviewDueDate}T12:00:00`));

const statusFilters: Array<{
  label: string;
  value: DecisionRationaleFilter | "all";
}> = [
  { label: "全部", value: "all" },
  { label: "理由完整", value: "captured" },
  { label: "待补理由", value: "deferred" },
  { label: "未补理由", value: "skipped" },
];

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const verdictOptions = Object.entries(verdictLabels) as Array<
  [OutcomeVerdict, string]
>;

type ReviewStateFilter =
  | "all"
  | "attention"
  | "due"
  | "scheduled"
  | "unscheduled"
  | "pending_outcome"
  | "pending_review"
  | "reviewed";

interface PrincipleChoice {
  id: string;
  title: string;
  status: "accepted" | "candidate" | "dismissed" | "retired" | "missing";
  selectable: boolean;
}

export const DecisionLibraryPanel = ({
  api,
  totalDecisions,
  initialReviewState = "all",
  initialDecisionId = null,
  onInitialNavigationConsumed,
}: DecisionLibraryPanelProps) => {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"keyword" | "semantic">(
    "keyword",
  );
  const [status, setStatus] = useState<DecisionRationaleFilter | "all">("all");
  const [source, setSource] = useState<DecisionSourceFilter | "all">("all");
  const [reviewState, setReviewState] =
    useState<ReviewStateFilter>(initialReviewState);
  const [decisions, setDecisions] = useState<DecisionLibraryItem[]>([]);
  const [selected, setSelected] = useState<DecisionLibraryItem | null>(null);
  const [editingOutcome, setEditingOutcome] = useState(false);
  const [outcomeDraft, setOutcomeDraft] = useState("");
  const [outcomeSaving, setOutcomeSaving] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [editingReview, setEditingReview] = useState(false);
  const [reviewVerdict, setReviewVerdict] = useState<OutcomeVerdict>("as_expected");
  const [reviewLesson, setReviewLesson] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [editingReviewSchedule, setEditingReviewSchedule] = useState(false);
  const [reviewScheduleDraft, setReviewScheduleDraft] = useState("");
  const [reviewScheduleSaving, setReviewScheduleSaving] = useState(false);
  const [reviewScheduleError, setReviewScheduleError] = useState<string | null>(
    null,
  );
  const [editingPrinciples, setEditingPrinciples] = useState(false);
  const [principleChoices, setPrincipleChoices] = useState<PrincipleChoice[]>([]);
  const [selectedPrincipleIds, setSelectedPrincipleIds] = useState<string[]>([]);
  const [principleLoading, setPrincipleLoading] = useState(false);
  const [principleSaving, setPrincipleSaving] = useState(false);
  const [principleError, setPrincipleError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastSearchRequest = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const normalizedQuery = query.trim();
    const searchRequestKey = `${searchMode}:${normalizedQuery}`;
    const isSearchRequest = lastSearchRequest.current !== searchRequestKey;
    const timer = setTimeout(() => {
      lastSearchRequest.current = searchRequestKey;
      setLoading(isSearchRequest);
      setError(null);
      void api
        .listDecisions({
          query: normalizedQuery,
          searchMode,
          ...(status === "all" ? {} : { rationaleStatus: status }),
          ...(source === "all" ? {} : { sourceClient: source }),
          ...(reviewState === "all" ? {} : { reviewState }),
          limit: 200,
        })
        .then((items) => {
          if (active) setDecisions(items);
        })
        .catch((caught: unknown) => {
          if (active) {
            setDecisions([]);
            setError(caught instanceof Error ? caught.message : String(caught));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, isSearchRequest ? 160 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, query, refreshRevision, reviewState, searchMode, source, status]);

  useEffect(() => {
    if (initialDecisionId === null) {
      onInitialNavigationConsumed?.();
      return;
    }
    let active = true;
    void api
      .listDecisions({ query: "", decisionId: initialDecisionId, limit: 1 })
      .then((items) => {
        if (active && items[0] !== undefined) setSelected(items[0]);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (active) onInitialNavigationConsumed?.();
      });
    return () => {
      active = false;
    };
  }, [api, initialDecisionId, onInitialNavigationConsumed]);

  const closeDetails = (): void => {
    setSelected(null);
    setEditingOutcome(false);
    setOutcomeDraft("");
    setOutcomeError(null);
    setEditingReview(false);
    setReviewLesson("");
    setReviewError(null);
    setEditingReviewSchedule(false);
    setReviewScheduleDraft("");
    setReviewScheduleError(null);
    setEditingPrinciples(false);
    setPrincipleChoices([]);
    setSelectedPrincipleIds([]);
    setPrincipleError(null);
  };

  const beginPrincipleEdit = async (): Promise<void> => {
    if (selected === null) return;
    setEditingOutcome(false);
    setEditingReview(false);
    setEditingReviewSchedule(false);
    setEditingPrinciples(true);
    setSelectedPrincipleIds([...selected.appliedPrincipleIds]);
    setPrincipleLoading(true);
    setPrincipleError(null);
    try {
      const accepted = await api.listMethodologies("accepted");
      const choices = new Map<string, PrincipleChoice>();
      accepted.forEach((item) => {
        choices.set(item.id, {
          id: item.id,
          title: item.title,
          status: item.status,
          selectable: true,
        });
      });
      selected.appliedPrinciples.forEach((item) => {
        if (!choices.has(item.id)) {
          choices.set(item.id, {
            id: item.id,
            title: item.title,
            status: item.status,
            selectable: false,
          });
        }
      });
      selected.appliedPrincipleIds.forEach((id) => {
        if (!choices.has(id)) {
          choices.set(id, {
            id,
            title: "已归档或缺失的原则",
            status: "missing",
            selectable: false,
          });
        }
      });
      setPrincipleChoices([...choices.values()]);
    } catch (caught) {
      setPrincipleChoices(
        selected.appliedPrinciples.map((item) => ({
          ...item,
          selectable: false,
        })),
      );
      setPrincipleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setPrincipleLoading(false);
    }
  };

  const togglePrinciple = (choice: PrincipleChoice): void => {
    setSelectedPrincipleIds((current) => {
      if (current.includes(choice.id)) {
        return current.filter((id) => id !== choice.id);
      }
      if (!choice.selectable || current.length >= 5) return current;
      return [...current, choice.id];
    });
  };

  const savePrinciples = async (): Promise<void> => {
    if (selected === null) return;
    setPrincipleSaving(true);
    setPrincipleError(null);
    try {
      const appliedPrinciples = await api.updateDecisionAppliedPrinciples(
        selected.id,
        selectedPrincipleIds,
      );
      setSelected({
        ...selected,
        appliedPrincipleIds: [...selectedPrincipleIds],
        appliedPrinciples,
      });
      setEditingPrinciples(false);
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      setPrincipleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setPrincipleSaving(false);
    }
  };

  const beginReviewScheduleEdit = (): void => {
    setReviewScheduleDraft(selected?.reviewDueDate ?? dateAfter(7));
    setReviewScheduleError(null);
    setEditingOutcome(false);
    setEditingReview(false);
    setEditingPrinciples(false);
    setEditingReviewSchedule(true);
  };

  const saveReviewSchedule = async (
    reviewDueDate: string | null = reviewScheduleDraft,
  ): Promise<void> => {
    if (selected === null || (reviewDueDate !== null && reviewDueDate === "")) {
      return;
    }
    setReviewScheduleSaving(true);
    setReviewScheduleError(null);
    try {
      await api.updateDecisionReviewDueDate(selected.id, reviewDueDate);
      setSelected({ ...selected, reviewDueDate });
      setEditingReviewSchedule(false);
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      setReviewScheduleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setReviewScheduleSaving(false);
    }
  };

  const beginReviewEdit = (): void => {
    setReviewVerdict(selected?.outcomeReview?.verdict ?? "as_expected");
    setReviewLesson(selected?.outcomeReview?.lesson ?? "");
    setReviewError(null);
    setEditingOutcome(false);
    setEditingReviewSchedule(false);
    setEditingPrinciples(false);
    setEditingReview(true);
  };

  const saveReview = async (): Promise<void> => {
    if (selected === null || selected.outcome === null) return;
    setReviewSaving(true);
    setReviewError(null);
    try {
      const outcomeReview = await api.updateDecisionReview(selected.id, {
        verdict: reviewVerdict,
        lesson: reviewLesson.trim().length === 0 ? null : reviewLesson.trim(),
      });
      setSelected({ ...selected, outcomeReview });
      setEditingReview(false);
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReviewSaving(false);
    }
  };

  const beginOutcomeEdit = (): void => {
    setOutcomeDraft(selected?.outcome ?? "");
    setOutcomeError(null);
    setEditingReview(false);
    setEditingReviewSchedule(false);
    setEditingPrinciples(false);
    setEditingOutcome(true);
  };

  const saveOutcome = async (): Promise<void> => {
    if (selected === null || outcomeDraft.trim().length === 0) return;
    const outcome = outcomeDraft.trim();
    setOutcomeSaving(true);
    setOutcomeError(null);
    try {
      await api.updateDecisionOutcome(selected.id, outcome);
      setSelected({ ...selected, outcome });
      setEditingOutcome(false);
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      setOutcomeError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setOutcomeSaving(false);
    }
  };

  const resultCopy = useMemo(() => {
    if (loading) {
      return query.trim().length > 0 && searchMode === "semantic"
        ? "正在理解并查找…"
        : "正在查找…";
    }
    if (error !== null) return "查询失败";
    const semanticParticipated = decisions.some(
      (decision) =>
        decision.searchMatch === "semantic" || decision.searchMatch === "hybrid",
    );
    if (query.trim().length === 0) return `${decisions.length} 条结果`;
    return `${decisions.length} 条结果 · ${
      semanticParticipated ? "语义参与排序" : "关键词匹配"
    }`;
  }, [decisions, error, loading, query, searchMode]);

  const detailEditingClass = editingReview
    ? " review-editing"
    : editingOutcome
      ? " outcome-editing"
      : editingReviewSchedule
        ? " schedule-editing"
        : editingPrinciples
          ? " principles-editing"
        : "";

  return (
    <section
      className="desktop-view decisions-panel decision-library-panel"
      role="region"
      aria-label="决策库"
    >
      <DesktopPageHeader
        eyebrow="历史"
        title="决策库"
        description="搜索和回看所有已记录决策。"
        meta={totalDecisions}
        metaLabel="全部决策"
      />

      <div className="desktop-page-scroll decision-library-content">
        <section className="decision-library-card" aria-label="决策历史">
          <div className="decision-library-toolbar">
            <div className="decision-search-control">
              <div className="decision-search-field">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5" />
                  <path d="m12.2 12.2 4 4" />
                </svg>
                <input
                  type="text"
                  role="searchbox"
                  aria-label="搜索决策"
                  placeholder={
                    searchMode === "semantic"
                      ? "按关键词或含义搜索决策"
                      : "按关键词搜索决策"
                  }
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
                {query.length > 0 ? (
                  <button
                    type="button"
                    className="decision-search-clear"
                    aria-label="清空搜索"
                    onClick={() => setQuery("")}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m4 4 8 8m0-8-8 8" />
                    </svg>
                  </button>
                ) : null}
              </div>
              <label
                className="decision-search-mode"
                title={
                  searchMode === "semantic"
                    ? "关闭后仅按关键词查找"
                    : "开启后可按含义查找"
                }
              >
                <span className="decision-search-mode-label">语义</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="使用语义检索"
                  aria-checked={searchMode === "semantic"}
                  checked={searchMode === "semantic"}
                  onChange={(event) =>
                    setSearchMode(
                      event.currentTarget.checked ? "semantic" : "keyword",
                    )
                  }
                />
                <span className="decision-search-mode-track" aria-hidden="true" />
              </label>
            </div>

            <div className="decision-filter-segment" aria-label="理由状态">
              {statusFilters.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={status === filter.value}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            <label className="decision-source-filter">
              <span>来源</span>
              <select
                aria-label="按来源筛选"
                value={source}
                onChange={(event) =>
                  setSource(
                    event.currentTarget.value as DecisionSourceFilter | "all",
                  )
                }
              >
                <option value="all">全部</option>
                <option value="codex">Codex</option>
                <option value="claude-code">Claude Code</option>
              </select>
            </label>

            <label className="decision-source-filter decision-review-filter">
              <span>复盘</span>
              <select
                aria-label="按复盘进度筛选"
                value={reviewState}
                onChange={(event) =>
                  setReviewState(event.currentTarget.value as ReviewStateFilter)
                }
              >
                <option value="all">全部</option>
                <option value="attention">需处理</option>
                <option value="due">已到期</option>
                <option value="scheduled">已安排</option>
                <option value="unscheduled">未安排</option>
                <option value="pending_outcome">待回填</option>
                <option value="pending_review">待复盘</option>
                <option value="reviewed">已复盘</option>
              </select>
            </label>

            <span className="decision-result-count" role="status">
              {resultCopy}
            </span>
          </div>

          {error !== null ? (
            <p className="decision-library-message error-message">
              无法读取决策库，请在设置中重建索引后重试。
            </p>
          ) : !loading && decisions.length === 0 ? (
            <div className="decision-library-empty">
              <strong>{query.trim().length > 0 ? "没有匹配结果" : "还没有决策"}</strong>
              <span>调整关键词或筛选条件后再试。</span>
            </div>
          ) : (
            <ol className="decision-library-list" aria-label="决策列表">
              {decisions.map((decision) => (
                <li key={decision.id}>
                  <button
                    type="button"
                    className="decision-library-row"
                    onClick={() => setSelected(decision)}
                  >
                    <span className="decision-library-copy">
                      <strong>{decision.question}</strong>
                      <span>
                        {decision.selectedAnswer}
                        {decision.searchMatch === "semantic" ||
                        decision.searchMatch === "hybrid" ? (
                          <small
                            className={`decision-semantic-badge ${decision.searchMatch}`}
                          >
                            {decision.searchMatch === "hybrid"
                              ? "综合命中"
                              : "语义命中"}
                          </small>
                        ) : null}
                        {decision.outcomeReview !== null ? (
                          <small
                            className={`decision-review-badge ${decision.outcomeReview.verdict}`}
                          >
                            {verdictLabels[decision.outcomeReview.verdict]}
                          </small>
                        ) : decision.outcome !== null ? (
                          <small className="decision-outcome-badge">待复盘</small>
                        ) : decision.reviewDueDate !== null ? (
                          <small
                            className={`decision-schedule-badge${
                              decision.reviewDueDate <= calendarDate(new Date())
                                ? " due"
                                : ""
                            }`}
                          >
                            {decision.reviewDueDate <= calendarDate(new Date())
                              ? "到期回填"
                              : `${dueLabel(decision.reviewDueDate)}复盘`}
                          </small>
                        ) : null}
                      </span>
                    </span>
                    <span className="decision-library-project">
                      {decision.project}
                    </span>
                    <span className="decision-library-source">
                      {sourceLabels[decision.sourceClient] ?? decision.sourceClient}
                    </span>
                    <time dateTime={decision.created}>
                      {listDateFormatter.format(new Date(decision.created))}
                    </time>
                    <span className={`rationale-state ${decision.rationaleStatus}`}>
                      {rationaleLabels[decision.rationaleStatus]}
                    </span>
                    <span className="decision-library-disclosure" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {selected === null ? null : (
        <ModalDialog
          title="决策详情"
          description={`${selected.project} · ${dateFormatter.format(
            new Date(selected.created),
          )}`}
          size="wide"
          onClose={closeDetails}
        >
          <article className={`decision-library-detail${detailEditingClass}`}>
            <section className="decision-detail-question">
              <span>问题</span>
              <h3>{selected.question}</h3>
            </section>
            <section className="decision-detail-choice">
              <span>最终选择</span>
              <p>{selected.selectedAnswer}</p>
            </section>
            <div className="decision-library-detail-meta">
              <div>
                <span>来源</span>
                <strong>
                  {sourceLabels[selected.sourceClient] ?? selected.sourceClient}
                </strong>
              </div>
              <div>
                <span>理由状态</span>
                <strong>{rationaleLabels[selected.rationaleStatus]}</strong>
              </div>
            </div>
            <section className="decision-detail-rationale">
              <span>决策理由</span>
              <p>{selected.rationale ?? "没有补充理由。"}</p>
            </section>
            {selected.context === null ? null : (
              <section className="decision-detail-context">
                <span>当时上下文</span>
                <p>{selected.context}</p>
              </section>
            )}
            <section className="decision-applied-principles">
              <div className="decision-outcome-heading">
                <span>采用的方法论</span>
                {editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ? null : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void beginPrincipleEdit()}
                  >
                    {selected.appliedPrincipleIds.length === 0
                      ? "关联原则"
                      : "调整关联"}
                  </button>
                )}
              </div>
              {editingPrinciples ? (
                <div className="decision-principle-editor">
                  <p>
                    只记录这次决策实际采用过的原则，最多 5 条；不会由模型自动判断。
                  </p>
                  {principleLoading ? (
                    <span className="decision-principle-loading">正在读取已采纳原则…</span>
                  ) : principleChoices.length === 0 ? (
                    <span className="decision-principle-loading">
                      还没有已采纳原则，可先到方法论中审核候选。
                    </span>
                  ) : (
                    <div className="decision-principle-choices">
                      {principleChoices.map((choice) => {
                        const checked = selectedPrincipleIds.includes(choice.id);
                        return (
                          <label
                            key={choice.id}
                            className={checked ? "selected" : ""}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={
                                principleSaving ||
                                (!checked &&
                                  (!choice.selectable ||
                                    selectedPrincipleIds.length >= 5))
                              }
                              onChange={() => togglePrinciple(choice)}
                            />
                            <span>
                              <strong>{choice.title}</strong>
                              {choice.selectable ? null : (
                                <small>仅保留历史关联，取消后不能重新添加</small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {principleError === null ? null : (
                    <p className="error-message" role="alert">
                      原则关联暂时无法处理：{principleError}
                    </p>
                  )}
                  <footer>
                    <span>已选 {selectedPrincipleIds.length} / 5</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={principleSaving}
                        onClick={() => {
                          setEditingPrinciples(false);
                          setPrincipleError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={principleSaving || principleLoading}
                        onClick={() => void savePrinciples()}
                      >
                        {principleSaving ? "保存中…" : "保存关联"}
                      </button>
                    </div>
                  </footer>
                </div>
              ) : selected.appliedPrinciples.length === 0 ? (
                <p>尚未记录这次决策实际采用了哪些原则。</p>
              ) : (
                <div className="decision-principle-tags">
                  {selected.appliedPrinciples.map((principle) => (
                    <span key={principle.id} className={principle.status}>
                      {principle.title}
                      {principle.status === "retired" ? " · 已归档" : ""}
                    </span>
                  ))}
                  {selected.appliedPrincipleIds.length >
                  selected.appliedPrinciples.length ? (
                    <span className="missing">部分历史原则已不可用</span>
                  ) : null}
                </div>
              )}
            </section>
            <section
              className={`decision-review-plan${
                selected.outcomeReview !== null ? " completed" : ""
              }`}
            >
              <div className="decision-outcome-heading">
                <span>复盘计划</span>
                {selected.outcomeReview !== null ||
                editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ? null : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={beginReviewScheduleEdit}
                  >
                    {selected.reviewDueDate === null ? "安排日期" : "调整日期"}
                  </button>
                )}
              </div>
              {selected.outcomeReview !== null ? (
                <div className="decision-review-plan-copy">
                  <strong>复盘已完成</strong>
                  <span>
                    {dateFormatter.format(
                      new Date(selected.outcomeReview.reviewedAt),
                    )}
                  </span>
                </div>
              ) : editingReviewSchedule ? (
                <div className="decision-review-schedule-editor">
                  <div className="decision-review-presets" aria-label="快捷日期">
                    {([
                      [1, "明天"],
                      [7, "一周后"],
                      [30, "一个月后"],
                    ] as const).map(([days, label]) => (
                      <button
                        key={days}
                        type="button"
                        aria-pressed={reviewScheduleDraft === dateAfter(days)}
                        onClick={() => setReviewScheduleDraft(dateAfter(days))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label htmlFor="decision-review-due-date">复盘日期</label>
                  <input
                    id="decision-review-due-date"
                    type="text"
                    autoComplete="off"
                    autoFocus
                    inputMode="numeric"
                    maxLength={10}
                    pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
                    placeholder="YYYY-MM-DD"
                    value={reviewScheduleDraft}
                    onChange={(event) =>
                      setReviewScheduleDraft(event.currentTarget.value)
                    }
                  />
                  <div className="decision-review-schedule-actions">
                    <span>到期后只进入首页收件箱，不会自动弹出窗口。</span>
                    <div>
                      {selected.reviewDueDate === null ? null : (
                        <button
                          type="button"
                          className="text-button"
                          disabled={reviewScheduleSaving}
                          onClick={() => void saveReviewSchedule(null)}
                        >
                          取消安排
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={reviewScheduleSaving}
                        onClick={() => setEditingReviewSchedule(false)}
                      >
                        返回
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          reviewScheduleSaving || reviewScheduleDraft.length === 0
                        }
                        onClick={() => void saveReviewSchedule()}
                      >
                        {reviewScheduleSaving ? "保存中…" : "保存日期"}
                      </button>
                    </div>
                  </div>
                  {reviewScheduleError === null ? null : (
                    <p className="error-message" role="alert">
                      复盘日期暂时无法保存：{reviewScheduleError}
                    </p>
                  )}
                </div>
              ) : selected.reviewDueDate === null ? (
                <div className="decision-review-plan-copy empty">
                  <strong>尚未安排</strong>
                  <span>安排一个合适的日期，届时会出现在首页复盘收件箱。</span>
                </div>
              ) : (
                <div
                  className={`decision-review-plan-copy${
                    selected.reviewDueDate <= calendarDate(new Date())
                      ? " due"
                      : ""
                  }`}
                >
                  <strong>
                    {selected.reviewDueDate <= calendarDate(new Date())
                      ? "已到复盘时间"
                      : `${dueLabel(selected.reviewDueDate)}复盘`}
                  </strong>
                  <span>只在首页提醒，不会主动打开应用。</span>
                </div>
              )}
            </section>
            <section className="decision-outcome-section">
              <div className="decision-outcome-heading">
                <span>实际结果</span>
                {editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ? null : (
                  <button type="button" className="text-button" onClick={beginOutcomeEdit}>
                    {selected.outcome === null ? "记录结果" : "更新结果"}
                  </button>
                )}
              </div>
              {editingOutcome ? (
                <div className="decision-outcome-editor">
                  <label htmlFor="decision-outcome-input">结果说明</label>
                  <textarea
                    id="decision-outcome-input"
                    autoFocus
                    maxLength={8_000}
                    value={outcomeDraft}
                    placeholder="记录实施后的实际效果、偏差或新的结论。"
                    onChange={(event) => setOutcomeDraft(event.currentTarget.value)}
                  />
                  <div className="decision-outcome-editor-footer">
                    <span>{outcomeDraft.length} / 8000</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={outcomeSaving}
                        onClick={() => {
                          setEditingOutcome(false);
                          setOutcomeError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={outcomeSaving || outcomeDraft.trim().length === 0}
                        onClick={() => void saveOutcome()}
                      >
                        {outcomeSaving ? "保存中…" : "保存结果"}
                      </button>
                    </div>
                  </div>
                  {outcomeError === null ? null : (
                    <p className="error-message" role="alert">
                      结果暂时无法保存：{outcomeError}
                    </p>
                  )}
                </div>
              ) : (
                <p>{selected.outcome ?? "尚未记录实际结果。"}</p>
              )}
            </section>
            <section className="decision-review-section">
              <div className="decision-outcome-heading">
                <span>预期 / 实际复盘</span>
                {selected.outcome === null ||
                editingReview ||
                editingOutcome ||
                editingReviewSchedule ||
                editingPrinciples ? null : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={beginReviewEdit}
                  >
                    {selected.outcomeReview === null ? "开始复盘" : "更新复盘"}
                  </button>
                )}
              </div>
              {selected.outcome === null ? (
                <p>记录实际结果后即可比较当初选择与最终效果。</p>
              ) : editingReview ? (
                <div className="decision-review-editor">
                  <fieldset>
                    <legend>实际结果与当初选择相比</legend>
                    <div className="decision-verdict-options">
                      {verdictOptions.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={reviewVerdict === value}
                          onClick={() => setReviewVerdict(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label htmlFor="decision-review-lesson">复盘经验（可选）</label>
                  <textarea
                    id="decision-review-lesson"
                    autoFocus
                    maxLength={8_000}
                    value={reviewLesson}
                    placeholder="哪些判断有效、哪里出现偏差、下次应如何调整。"
                    onChange={(event) => setReviewLesson(event.currentTarget.value)}
                  />
                  <div className="decision-outcome-editor-footer">
                    <span>{reviewLesson.length} / 8000</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={reviewSaving}
                        onClick={() => {
                          setEditingReview(false);
                          setReviewError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={reviewSaving}
                        onClick={() => void saveReview()}
                      >
                        {reviewSaving ? "保存中…" : "保存复盘"}
                      </button>
                    </div>
                  </div>
                  {reviewError === null ? null : (
                    <p className="error-message" role="alert">
                      复盘暂时无法保存：{reviewError}
                    </p>
                  )}
                </div>
              ) : selected.outcomeReview === null ? (
                <p>实际结果已记录，尚未进行复盘。</p>
              ) : (
                <div className="decision-review-summary">
                  <strong
                    className={`decision-review-verdict ${selected.outcomeReview.verdict}`}
                  >
                    {verdictLabels[selected.outcomeReview.verdict]}
                  </strong>
                  <time dateTime={selected.outcomeReview.reviewedAt}>
                    {dateFormatter.format(
                      new Date(selected.outcomeReview.reviewedAt),
                    )}
                  </time>
                  <p>{selected.outcomeReview.lesson ?? "未填写复盘经验。"}</p>
                  <div className="decision-methodology-ready">
                    <span>
                      <strong>这条决策现在可作为方法论证据</strong>
                      <small>可与其它已复盘决策一起提炼成可复用原则。</small>
                    </span>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void api.openSurface("methodology")}
                    >
                      用于提炼原则
                    </button>
                  </div>
                </div>
              )}
            </section>
          </article>
        </ModalDialog>
      )}
    </section>
  );
};
