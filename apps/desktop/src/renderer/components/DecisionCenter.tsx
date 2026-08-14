import { useEffect, useState } from "react";

import type {
  AppSnapshot,
  DecisionApi,
  DecisionLibraryItem,
} from "../../shared/renderer-api.js";
import { DashboardPendingRationales } from "./DashboardPendingRationales.js";
import { RecentDecisionList } from "./RecentDecisionList.js";

interface DecisionCenterProps {
  api: DecisionApi;
  snapshot: AppSnapshot;
  onReview(): void;
  onOpenDecision(id: string): void;
  onOpenReviewInbox(): void;
  onCompleteRationale(id: string, rationale: string): Promise<void>;
  onSkipRationale(id: string): Promise<void>;
  onDiscardRationale(id: string): Promise<void>;
}

export const DecisionCenter = ({
  api,
  snapshot,
  onReview,
  onOpenDecision,
  onOpenReviewInbox,
  onCompleteRationale,
  onSkipRationale,
  onDiscardRationale,
}: DecisionCenterProps) => {
  const [reviewInbox, setReviewInbox] = useState<DecisionLibraryItem[]>([]);
  const [unscheduled, setUnscheduled] = useState<DecisionLibraryItem[]>([]);
  const [reviewInboxLoading, setReviewInboxLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setReviewInboxLoading(true);
    void Promise.all([
      api.listDecisions({ query: "", reviewState: "attention", limit: 200 }),
      api.listDecisions({ query: "", reviewState: "unscheduled", limit: 3 }),
    ])
      .then(([attention, withoutSchedule]) => {
        if (!active) return;
        setReviewInbox(attention);
        setUnscheduled(withoutSchedule);
      })
      .catch(() => {
        if (!active) return;
        setReviewInbox([]);
        setUnscheduled([]);
      })
      .finally(() => {
        if (active) setReviewInboxLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const dashboard = snapshot.dashboard ?? {
    totalDecisions: 0,
    recorded7d: 0,
    reviewAttention: 0,
    recentDecisions: [],
  };
  const candidate = snapshot.decisionCandidates.current;
  const candidateQuestion = candidate?.event.questions[0]?.question;
  const candidateProject = candidate?.event.project;
  const summary = [
    {
      label: "待确认",
      value: snapshot.decisionCandidates.count,
    },
    {
      label: "需复盘",
      value: dashboard.reviewAttention,
    },
    { label: "近 7 天记录", value: dashboard.recorded7d },
    { label: "全部决策", value: dashboard.totalDecisions },
  ];

  return (
    <section
      className="desktop-view dashboard-panel"
      role="region"
      aria-label="首页"
    >
      <header className="desktop-view-header drag-region">
        <div>
          <span>概览</span>
          <h1>首页</h1>
          <p>集中处理待确认事项、理由补充与最近决策。</p>
        </div>
        <div className="desktop-view-meta">
          <strong>
            {snapshot.decisionCandidates.count +
              snapshot.pendingRationales.length +
              dashboard.reviewAttention}
          </strong>
          <span>项待办</span>
        </div>
      </header>

      <div className="dashboard-scroll">
        <section className="dashboard-summary" aria-label="决策概览">
          {summary.map((item) => (
            <div className="dashboard-summary-item" key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </section>

        {snapshot.health.recovery === "degraded" ? (
          <p className="dashboard-recovery-alert" role="status">
            {snapshot.health.recoveryMessage ?? "理由恢复数据需要关注。"}
          </p>
        ) : null}

        <section className="dashboard-work-grid" aria-label="待办">
          <section
            className="dashboard-card dashboard-candidate-card"
            aria-labelledby="dashboard-candidate-title"
          >
            <header className="dashboard-card-header">
              <div>
                <span>待办</span>
                <h2 id="dashboard-candidate-title">待确认</h2>
              </div>
              <strong>{snapshot.decisionCandidates.count}</strong>
            </header>
            {candidateQuestion === undefined ? (
              <p className="dashboard-empty-copy">目前没有需要确认的决策。</p>
            ) : (
              <div className="dashboard-candidate-body">
                <span>下一项</span>
                <strong>{candidateQuestion}</strong>
                <small>{candidateProject}</small>
                <button
                  type="button"
                  className="primary-button"
                  onClick={onReview}
                >
                  开始处理
                </button>
              </div>
            )}
          </section>

          <DashboardPendingRationales
            decisions={snapshot.pendingRationales}
            onComplete={onCompleteRationale}
            onSkip={onSkipRationale}
            onDiscard={onDiscardRationale}
          />

          <section
            className="dashboard-card dashboard-review-inbox"
            aria-labelledby="dashboard-review-inbox-title"
          >
          <header className="dashboard-card-header">
            <div>
              <span>结果闭环</span>
              <h2 id="dashboard-review-inbox-title">复盘收件箱</h2>
            </div>
            <strong>{reviewInbox.length}</strong>
          </header>
          {reviewInboxLoading ? (
            <p className="dashboard-empty-copy">正在读取复盘计划…</p>
          ) : reviewInbox.length > 0 ? (
            <ol className="dashboard-review-list">
              {reviewInbox.slice(0, 2).map((decision) => (
                <li key={decision.id}>
                  <button
                    type="button"
                    onClick={() => onOpenDecision(decision.id)}
                  >
                    <span>
                      <strong>{decision.question}</strong>
                      <small>{decision.project}</small>
                    </span>
                    <em>{decision.outcome === null ? "待回填结果" : "待完成复盘"}</em>
                    <span aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : unscheduled.length > 0 ? (
            <div className="dashboard-review-empty">
              <div>
                <strong>还没有安排复盘日期</strong>
                <span>先为最近的决策设定验证时间，避免记录停留在“做过选择”。</span>
              </div>
              <button
                type="button"
                className="primary-button"
                onClick={() => onOpenDecision(unscheduled[0]!.id)}
              >
                安排第一条
              </button>
            </div>
          ) : (
            <p className="dashboard-empty-copy">目前没有需要处理的复盘。</p>
          )}
          {reviewInbox.length === 0 ? null : (
            <footer className="dashboard-review-footer">
              <span>到期事项只在这里出现，不会主动弹窗唤醒应用。</span>
              <button
                type="button"
                className="text-button"
                onClick={onOpenReviewInbox}
              >
                查看全部
              </button>
            </footer>
          )}
          </section>
        </section>

        <RecentDecisionList decisions={dashboard.recentDecisions} />
      </div>
    </section>
  );
};
