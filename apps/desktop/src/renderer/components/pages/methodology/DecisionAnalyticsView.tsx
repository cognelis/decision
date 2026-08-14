import type {
  DecisionAnalyticsGroup,
  DecisionAnalyticsSnapshot,
  OutcomeVerdict,
} from "@cognelis/decision-core";
import type {
  DecisionConsultationFeedbackRating,
  DecisionConsultationMetricsSnapshot,
  DecisionConsultationResponse,
} from "@cognelis/decision-protocol";
import { useCallback, useEffect, useState } from "react";

import type { DecisionAnalyticsApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";

interface DecisionAnalyticsViewProps {
  api: DecisionAnalyticsApi;
  onOpenDecisions(): void;
}

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const sourceLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  test: "测试数据",
};

const monthLabel = (period: string): string => {
  const [year, month] = period.split("-");
  return year === undefined || month === undefined
    ? period
    : `${year.slice(-2)}.${month}`;
};

const percentage = (value: number, total: number): number =>
  total === 0 ? 0 : Math.round((value / total) * 100);

const ConsultationCalibration = ({
  api,
  metrics,
  error,
  onMetricsChanged,
}: {
  api: DecisionAnalyticsApi;
  metrics: DecisionConsultationMetricsSnapshot | null;
  error: string | null;
  onMetricsChanged(): Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [context, setContext] = useState("");
  const [running, setRunning] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [result, setResult] = useState<DecisionConsultationResponse | null>(
    null,
  );
  const [feedbackRating, setFeedbackRating] =
    useState<DecisionConsultationFeedbackRating | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<
    "idle" | "submitting" | "accepted" | "error"
  >("idle");
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const resetFeedback = (): void => {
    setFeedbackRating(null);
    setFeedbackStatus("idle");
    setFeedbackMessage(null);
  };
  const busy = running || feedbackStatus === "submitting";

  const close = (): void => {
    if (busy) return;
    setOpen(false);
    setQuestion("");
    setOptions(["", ""]);
    setContext("");
    setPreviewError(null);
    setResult(null);
    resetFeedback();
  };
  const requests = metrics?.requests ?? 0;
  const matches = metrics?.matches ?? 0;
  const coverage = percentage(metrics?.matched ?? 0, requests);
  const strongShare = percentage(metrics?.strongMatches ?? 0, matches);
  const averageMatches =
    requests === 0 ? "0" : (matches / requests).toFixed(1);
  const averageDuration =
    requests === 0 ? 0 : Math.round((metrics?.durationMs ?? 0) / requests);
  const feedbackTotal = metrics?.feedback.total ?? 0;
  const helpfulShare = percentage(
    metrics?.feedback.helpful ?? 0,
    feedbackTotal,
  );

  const submitFeedback = (
    rating: DecisionConsultationFeedbackRating,
  ): void => {
    const token = result?.feedback?.token;
    if (token === undefined) {
      setFeedbackStatus("error");
      setFeedbackMessage("本次匿名回执已不可用，请重新试算。");
      return;
    }
    setFeedbackRating(rating);
    setFeedbackStatus("submitting");
    setFeedbackMessage(null);
    void api
      .submitDecisionConsultationFeedback({ token, rating })
      .then(async (submitted) => {
        if (submitted.status !== "accepted") {
          setFeedbackStatus("error");
          setFeedbackMessage(
            submitted.status === "expired"
              ? "匿名回执已过期，请重新试算后评价。"
              : "这次评价已记录或回执已失效，没有重复计数。",
          );
          return;
        }
        setFeedbackStatus("accepted");
        setFeedbackMessage("已匿名计入质量校准，没有保存本次输入。");
        await onMetricsChanged();
      })
      .catch((caught) => {
        setFeedbackStatus("error");
        setFeedbackMessage(
          caught instanceof Error ? caught.message : String(caught),
        );
      });
  };

  return (
    <>
      <section
        className="consultation-calibration"
        aria-label="决策前原则核对"
      >
        <header>
          <div>
            <span>决策前核对</span>
            <strong>
              {requests === 0
                ? "等待首次调用"
                : `已运行 ${requests} 次 · ${feedbackTotal} 次评价`}
            </strong>
            <small>只持久化匿名聚合计数，不保存输入、令牌或单次记录。</small>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => setOpen(true)}
          >
            试算一次
          </button>
        </header>
        {error === null ? (
          <dl>
            <div>
              <dt>覆盖率</dt>
              <dd>{coverage}%</dd>
              <span>{metrics?.matched ?? 0} 次返回相关原则</span>
            </div>
            <div>
              <dt>有帮助率</dt>
              <dd>{feedbackTotal === 0 ? "—" : `${helpfulShare}%`}</dd>
              <span>
                {feedbackTotal === 0
                  ? "等待主动评价"
                  : `${metrics?.feedback.helpful ?? 0} / ${feedbackTotal} 次`}
              </span>
            </div>
            <div>
              <dt>强匹配占比</dt>
              <dd>{strongShare}%</dd>
              <span>{metrics?.strongMatches ?? 0} 条 · 平均 {averageMatches} 条</span>
            </div>
            <div>
              <dt>本地耗时</dt>
              <dd>{averageDuration} ms</dd>
              <span>
                Claude {metrics?.byClient.claudeCode ?? 0} · Codex{" "}
                {metrics?.byClient.codex ?? 0}
              </span>
            </div>
          </dl>
        ) : (
          <p className="consultation-calibration-error" role="status">
            聚合指标暂时无法读取：{error}
          </p>
        )}
        <footer>
          <span>覆盖率只表示“找到了候选原则”，不代表建议正确。</span>
          <span>
            {feedbackTotal === 0
              ? "试算不计入调用次数；主动评价才增加一个匿名计数。"
              : `不相关 ${metrics?.feedback.notHelpful ?? 0} · 可能误导 ${metrics?.feedback.misleading ?? 0} · 试算 ${metrics?.feedback.bySource.preview ?? 0}`}
          </span>
        </footer>
      </section>

      {open ? (
        <ModalDialog
          title="试算决策前核对"
          description="使用与 Claude Code、Codex 相同的本地匹配规则；关闭后不保留输入，只有主动评价会增加一个匿名计数。"
          size="wide"
          dismissible={!busy}
          onClose={close}
        >
          <form
            className="consultation-preview"
            onSubmit={(event) => {
              event.preventDefault();
              setRunning(true);
              setPreviewError(null);
              setResult(null);
              resetFeedback();
              void api
                .previewDecisionConsultation({
                  question: question.trim(),
                  options: options.map((value) => value.trim()).filter(Boolean),
                  context: context.trim().length === 0 ? null : context.trim(),
                })
                .then(setResult)
                .catch((caught) => {
                  setPreviewError(
                    caught instanceof Error ? caught.message : String(caught),
                  );
                })
                .finally(() => setRunning(false));
            }}
          >
            <div className="consultation-preview-fields">
              <label>
                <span>待决定的问题</span>
                <textarea
                  rows={3}
                  maxLength={4_000}
                  required
                  value={question}
                  placeholder="例如：正式上线前是否先做一轮小范围兼容验证？"
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </label>
              <fieldset>
                <legend>候选选项（可选）</legend>
                <div className="consultation-preview-options">
                  {options.map((value, index) => (
                    <div key={index}>
                      <input
                        type="text"
                        maxLength={500}
                        aria-label={`候选选项 ${index + 1}`}
                        value={value}
                        placeholder={`选项 ${index + 1}`}
                        onChange={(event) =>
                          setOptions((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? event.target.value : item,
                            ),
                          )
                        }
                      />
                      {options.length > 2 ? (
                        <button
                          type="button"
                          aria-label={`删除候选选项 ${index + 1}`}
                          onClick={() =>
                            setOptions((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
                {options.length < 8 ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setOptions((current) => [...current, ""])}
                  >
                    添加选项
                  </button>
                ) : null}
              </fieldset>
              <label>
                <span>必要上下文（可选）</span>
                <textarea
                  rows={2}
                  maxLength={6_000}
                  value={context}
                  placeholder="只填写判断适用条件和失败边界所需的信息"
                  onChange={(event) => setContext(event.target.value)}
                />
              </label>
            </div>

            {previewError === null ? null : (
              <p className="consultation-preview-error" role="alert">
                试算未完成：{previewError}
              </p>
            )}
            {result === null ? null : result.status === "no_match" ? (
              <div className="consultation-preview-empty" role="status">
                <strong>没有找到足够明确的原则</strong>
                <span>客户端会继续独立分析，不会为了给出建议而强行套用历史原则。</span>
              </div>
            ) : (
              <ol className="consultation-preview-results" aria-label="试算结果">
                {result.matches.map((match) => (
                  <li key={match.principleId}>
                    <header>
                      <strong>{match.title}</strong>
                      <span className={match.relevance}>
                        {match.relevance === "strong" ? "强匹配" : "可核对"} ·{" "}
                        {match.relevanceScore}
                      </span>
                    </header>
                    <p>{match.principle}</p>
                    <dl>
                      <div><dt>适用</dt><dd>{match.appliesWhen}</dd></div>
                      <div><dt>边界</dt><dd>{match.caution}</dd></div>
                    </dl>
                    <small>{match.reason}</small>
                  </li>
                ))}
              </ol>
            )}

            {result?.feedback === null || result === null ? null : (
              <section
                className={`consultation-preview-feedback ${feedbackStatus}`}
                aria-label="评价试算结果"
              >
                <div>
                  <strong>这次核对质量如何？</strong>
                  <span>只记录分类计数，不保存问题和匹配结果。</span>
                </div>
                <div role="group" aria-label="匿名质量评价">
                  {(
                    [
                      ["helpful", "有帮助"],
                      ["not_helpful", "不相关"],
                      ["misleading", "可能误导"],
                    ] as const
                  ).map(([rating, label]) => (
                    <button
                      type="button"
                      key={rating}
                      className={feedbackRating === rating ? "selected" : ""}
                      disabled={
                        feedbackStatus === "submitting" ||
                        feedbackStatus === "accepted"
                      }
                      aria-pressed={feedbackRating === rating}
                      onClick={() => submitFeedback(rating)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {feedbackMessage === null ? null : (
                  <small role="status">{feedbackMessage}</small>
                )}
              </section>
            )}

            <footer className="consultation-preview-actions">
              <span>只读试算 · 不调用模型 · 不写入决策</span>
              <button type="button" className="text-button" onClick={close} disabled={busy}>
                关闭
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || question.trim().length === 0}
              >
                {running
                  ? "正在匹配…"
                  : result === null
                    ? "查看实际结果"
                    : "重新试算"}
              </button>
            </footer>
          </form>
        </ModalDialog>
      ) : null}
    </>
  );
};

const GroupTable = ({
  title,
  groups,
  source = false,
}: {
  title: string;
  groups: DecisionAnalyticsGroup[];
  source?: boolean;
}) => (
  <section className="analytics-section analytics-group-section">
    <div className="analytics-section-heading">
      <strong>{title}</strong>
      <span>数量 · 理由 · 结果 · 复盘</span>
    </div>
    <div className="analytics-group-table" role="table" aria-label={title}>
      <div className="analytics-group-header" role="row">
        <span role="columnheader">{source ? "来源" : "项目"}</span>
        <span role="columnheader">决策</span>
        <span role="columnheader">理由</span>
        <span role="columnheader">结果</span>
        <span role="columnheader">复盘</span>
        <span role="columnheader">结果表现</span>
      </div>
      {groups.map((group) => (
        <div className="analytics-group-row" role="row" key={group.key}>
          <strong role="cell">
            {source ? (sourceLabels[group.label] ?? group.label) : group.label}
          </strong>
          <span role="cell">{group.decisionCount}</span>
          <span role="cell">{group.rationaleCaptured}</span>
          <span role="cell">{group.outcomesRecorded}</span>
          <span role="cell">{group.outcomesReviewed}</span>
          <span role="cell" className="analytics-outcome-balance">
            <em>+{group.favorableOutcomes}</em>
            <small>需关注 {group.attentionOutcomes}</small>
          </span>
        </div>
      ))}
    </div>
  </section>
);

export const DecisionAnalyticsView = ({
  api,
  onOpenDecisions,
}: DecisionAnalyticsViewProps) => {
  const [snapshot, setSnapshot] = useState<DecisionAnalyticsSnapshot | null>(
    null,
  );
  const [consultationMetrics, setConsultationMetrics] =
    useState<DecisionConsultationMetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [consultationError, setConsultationError] = useState<string | null>(
    null,
  );

  const refreshConsultationMetrics = useCallback(async (): Promise<void> => {
    try {
      setConsultationMetrics(await api.getDecisionConsultationMetrics());
      setConsultationError(null);
    } catch (caught) {
      setConsultationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  }, [api]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setConsultationError(null);
    const [analyticsResult, consultationResult] = await Promise.allSettled([
      api.getDecisionAnalytics(),
      api.getDecisionConsultationMetrics(),
    ]);
    if (analyticsResult.status === "fulfilled") {
      setSnapshot(analyticsResult.value);
    } else {
      setSnapshot(null);
      setError(
        analyticsResult.reason instanceof Error
          ? analyticsResult.reason.message
          : String(analyticsResult.reason),
      );
    }
    if (consultationResult.status === "fulfilled") {
      setConsultationMetrics(consultationResult.value);
    } else {
      setConsultationMetrics(null);
      setConsultationError(
        consultationResult.reason instanceof Error
          ? consultationResult.reason.message
          : String(consultationResult.reason),
      );
    }
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="methodology-message">正在分析本地快照…</p>;
  }
  if (error !== null) {
    return (
      <div className="decision-analytics">
        <ConsultationCalibration
          api={api}
          metrics={consultationMetrics}
          error={consultationError}
          onMetricsChanged={refreshConsultationMetrics}
        />
        <div className="methodology-empty compact">
          <strong>决策分析暂时不可用</strong>
          <span>{error}</span>
          <button type="button" className="text-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      </div>
    );
  }
  if (snapshot === null || snapshot.totals.decisions === 0) {
    return (
      <div className="decision-analytics">
        <ConsultationCalibration
          api={api}
          metrics={consultationMetrics}
          error={consultationError}
          onMetricsChanged={refreshConsultationMetrics}
        />
        <div className="methodology-empty compact">
          <strong>还没有可分析的决策</strong>
          <span>记录决策后，这里会从可重建的 SQLite 快照生成本地统计。</span>
          <button type="button" className="primary-button" onClick={onOpenDecisions}>
            去记录决策
          </button>
        </div>
      </div>
    );
  }

  const maxTrend = Math.max(
    1,
    ...snapshot.trend.map(({ decisionCount }) => decisionCount),
  );

  return (
    <div className="decision-analytics">
      <ConsultationCalibration
        api={api}
        metrics={consultationMetrics}
        error={consultationError}
        onMetricsChanged={refreshConsultationMetrics}
      />
      {snapshot.totals.outcomesReviewed === 0 ? (
        <section className="analytics-next-step" aria-label="方法论下一步">
          <div>
            <strong>已有 {snapshot.totals.decisions} 条决策，还缺少可提炼的复盘证据</strong>
            <span>
              先为实际结果留痕并完成复盘，原则、图谱和技能才会逐步产生内容。
            </span>
          </div>
          <button type="button" className="primary-button" onClick={onOpenDecisions}>
            去补充结果与复盘
          </button>
        </section>
      ) : null}
      <div className="analytics-meta">
        <span>本地聚合 v{snapshot.engine.version} · SQLite 快照</span>
        <button type="button" className="text-button" onClick={() => void load()}>
          刷新分析
        </button>
      </div>

      <dl className="analytics-summary">
        <div>
          <dt>决策总数</dt>
          <dd>{snapshot.totals.decisions}</dd>
          <span>{snapshot.totals.projects} 个项目</span>
        </div>
        <div>
          <dt>理由完整率</dt>
          <dd>{snapshot.rates.rationaleCaptured}%</dd>
          <span>{snapshot.totals.rationaleCaptured} 条已补充</span>
        </div>
        <div>
          <dt>结果回填率</dt>
          <dd>{snapshot.rates.outcomesRecorded}%</dd>
          <span>{snapshot.totals.outcomesRecorded} 条有实际结果</span>
        </div>
        <div>
          <dt>结果复盘率</dt>
          <dd>{snapshot.rates.outcomesReviewed}%</dd>
          <span>按已回填结果计算</span>
        </div>
      </dl>

      <div className="analytics-grid">
        <section className="analytics-section analytics-verdicts">
          <div className="analytics-section-heading">
            <strong>预期与实际</strong>
            <span>{snapshot.totals.outcomesReviewed} 条已复盘</span>
          </div>
          <ol>
            {snapshot.verdicts.map((item) => (
              <li key={item.verdict}>
                <span>{verdictLabels[item.verdict]}</span>
                <div aria-hidden="true">
                  <i style={{ width: `${item.percentage}%` }} />
                </div>
                <strong>{item.count}</strong>
                <small>{item.percentage}%</small>
              </li>
            ))}
          </ol>
        </section>

        <section className="analytics-section analytics-trend">
          <div className="analytics-section-heading">
            <strong>月度趋势</strong>
            <span>最近 12 个有记录月份</span>
          </div>
          <ol aria-label="月度决策趋势">
            {snapshot.trend.map((item) => (
              <li key={item.period}>
                <div className="analytics-trend-bars">
                  <i
                    style={{ height: `${Math.max(5, (item.decisionCount / maxTrend) * 100)}%` }}
                    title={`${item.decisionCount} 条决策`}
                  />
                  <b
                    style={{ height: `${Math.max(3, (item.outcomesReviewed / maxTrend) * 100)}%` }}
                    title={`${item.outcomesReviewed} 条已复盘`}
                  />
                </div>
                <span>{monthLabel(item.period)}</span>
              </li>
            ))}
          </ol>
          <p><i /> 决策 <b /> 已复盘</p>
        </section>
      </div>

      <GroupTable title="项目分布" groups={snapshot.projects} />
      <GroupTable title="来源分布" groups={snapshot.sources} source />
    </div>
  );
};
