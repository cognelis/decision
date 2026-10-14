import { useEffect, useRef, useState } from "react";

import {
  pendingRationaleTotal,
  pendingWorkTotal,
  type AppSnapshot,
  type DecisionApi,
  type DecisionLibraryItem,
  type DesktopPrimarySurface,
} from "../../shared/renderer-api.js";
import { DashboardGettingStarted } from "./DashboardGettingStarted.js";
import {
  DashboardPendingRationales,
  type PendingRationaleCompletion,
  type PendingRationaleDraft,
} from "./DashboardPendingRationales.js";
import { DashboardReviewInbox, type ReviewInboxDraft } from "./DashboardReviewInbox.js";
import { RecentDecisionList } from "./RecentDecisionList.js";

interface DecisionCenterProps {
  api: DecisionApi;
  snapshot: AppSnapshot;
  onReview(): void;
  onOpenDecision(id: string): void;
  onOpenReviewInbox(): void;
  onOpenLibrary(): void;
  /** The knowledge page, already narrowed to the last seven days. */
  onOpenRecent(): void;
  /** The knowledge page, narrowed to the decisions whose rationale waits: the home page lists the latest alone. */
  onOpenDeferred(): void;
  onOpenRetrospective(): void;
  /** Where a getting-started step leads: client setup, models, code platforms. */
  onNavigate(surface: DesktopPrimarySurface): void;
  /** Opens the manual record dialog, as ⌘N does. */
  onRecord(): void;
  onCompleteRationale(
    id: string,
    completion: PendingRationaleCompletion,
  ): Promise<void>;
  onSkipRationale(id: string): Promise<void>;
  onDiscardRationale(id: string): Promise<void>;
  onKeepLocalRationale(id: string, completion: PendingRationaleCompletion): Promise<void>;
  /** Kept by the app: the home page's dialogs, as they were when a capture took the window over. */
  drafts?: HomeDrafts;
}

export interface HomeDrafts {
  inbox?: ReviewInboxDraft | undefined;
  pending?: PendingRationaleDraft | undefined;
}

export const DecisionCenter = ({
  api,
  snapshot,
  onReview,
  onOpenDecision,
  onOpenReviewInbox,
  onOpenLibrary,
  onOpenRecent,
  onOpenDeferred,
  onOpenRetrospective,
  onNavigate,
  onRecord,
  onCompleteRationale,
  onSkipRationale,
  onDiscardRationale,
  onKeepLocalRationale,
  drafts,
}: DecisionCenterProps) => {
  const [reviewInbox, setReviewInbox] = useState<DecisionLibraryItem[]>([]);
  const [unscheduled, setUnscheduled] = useState<DecisionLibraryItem[]>([]);
  const [reviewInboxLoading, setReviewInboxLoading] = useState(true);
  const [reviewInboxFailed, setReviewInboxFailed] = useState(false);
  // Saving from the card changes what belongs in it, and the list is loaded
  // here rather than carried by the pushed snapshot.
  const [reviewRevision, setReviewRevision] = useState(0);
  const firstReviewRead = useRef(true);

  useEffect(() => {
    let active = true;
    const read = (): void => {
      void Promise.all([
        api.listDecisions({ query: "", reviewState: "attention", limit: 200 }),
        api.listDecisions({ query: "", reviewState: "unscheduled", limit: 3 }),
      ])
        .then(([attention, withoutSchedule]) => {
          if (!active) return;
          setReviewInbox(attention);
          setUnscheduled(withoutSchedule);
          setReviewInboxFailed(false);
        })
        .catch(() => {
          // Said as such, not shown as nothing to review.
          if (active) setReviewInboxFailed(true);
        })
        .finally(() => {
          if (active) setReviewInboxLoading(false);
        });
    };
    // Only the first read shows that it is reading: later ones keep the list,
    // and the button just pressed, where they are. A pushed snapshot (an
    // outcome written in Obsidian or by an agent, a new day begun) reads it
    // again too, a burst of them once.
    if (firstReviewRead.current) {
      firstReviewRead.current = false;
      read();
      return () => {
        active = false;
      };
    }
    const timer = setTimeout(read, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, reviewRevision, snapshot.dashboard]);

  const dashboard = snapshot.dashboard ?? {
    totalDecisions: 0,
    recorded7d: 0,
    reviewAttention: 0,
    recentDecisions: [],
  };
  // Nothing recorded, waiting or half-done yet: zeros and empty cards would say
  // nothing, so the home page shows how to begin instead.
  const firstRun =
    dashboard.unavailable !== true &&
    dashboard.totalDecisions === 0 &&
    snapshot.decisionCandidates.count === 0 &&
    snapshot.pendingRationales.length === 0;
  const candidate = snapshot.decisionCandidates.current;
  const candidateQuestion = candidate?.event.questions[0]?.question;
  const candidateProject = candidate?.event.project;
  const summary: Array<{
    label: string;
    value: number;
    hint?: string;
    onSelect?: () => void;
  }> = [
    {
      label: "待确认",
      value: snapshot.decisionCandidates.count,
      ...(snapshot.decisionCandidates.count > 0
        ? { hint: "开始处理待确认候选", onSelect: onReview }
        : {}),
    },
    {
      label: "需复盘",
      value: dashboard.reviewAttention,
      ...(dashboard.reviewAttention > 0
        ? { hint: "打开复盘收件箱", onSelect: onOpenReviewInbox }
        : {}),
    },
    {
      label: "近 7 天记录",
      value: dashboard.recorded7d,
      hint: "查看近 7 天的决策",
      onSelect: onOpenRecent,
    },
    {
      label: "全部决策",
      value: dashboard.totalDecisions,
      hint: "打开知识页",
      onSelect: onOpenLibrary,
    },
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
          <strong>{pendingWorkTotal(snapshot)}</strong>
          <span>项待办</span>
        </div>
      </header>

      <div className="dashboard-scroll">
        {firstRun ? null : <section className="dashboard-summary" aria-label="决策概览">
          {summary.map((item) =>
            item.onSelect === undefined ? (
              <div className="dashboard-summary-item" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ) : (
              <button
                type="button"
                className="dashboard-summary-item interactive"
                key={item.label}
                title={item.hint}
                onClick={item.onSelect}
              >
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </button>
            ),
          )}
        </section>}

        {dashboard.unavailable === true ? (
          <p className="dashboard-recovery-alert" role="status">
            决策索引暂时读不出来，这里的数字和最近决策可能不全；可以在设置里重建决策索引。
          </p>
        ) : null}
        {snapshot.health.recovery === "degraded" ? (
          <p className="dashboard-recovery-alert" role="status">
            {snapshot.health.recoveryMessage ?? "理由恢复数据需要关注。"}
          </p>
        ) : null}

        {firstRun ? (
          <DashboardGettingStarted
            api={api}
            integrationStatus={snapshot.integrationStatus}
            onNavigate={onNavigate}
            onRecord={onRecord}
          />
        ) : <>
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
              <strong
                className={
                  snapshot.decisionCandidates.count === 0 ? "idle" : undefined
                }
              >
                {snapshot.decisionCandidates.count}
              </strong>
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
            total={pendingRationaleTotal(snapshot)}
            onBrowseAll={onOpenDeferred}
            listDecisions={api.listDecisions}
            onComplete={onCompleteRationale}
            onSkip={onSkipRationale}
            onDiscard={onDiscardRationale}
            onKeepLocal={onKeepLocalRationale}
            {...(drafts === undefined ? {} : { drafts })}
          />

          <DashboardReviewInbox
            decisions={reviewInbox}
            unscheduled={unscheduled}
            loading={reviewInboxLoading}
            failed={reviewInboxFailed}
            onRetry={() => setReviewRevision((value) => value + 1)}
            onOpenDecision={onOpenDecision}
            onOpenReviewInbox={onOpenReviewInbox}
            onSaveOutcome={async (id, text, basis) => {
              await api.updateDecisionOutcome(id, text, ...(basis === undefined ? [] as const : [basis] as const));
              setReviewRevision((value) => value + 1);
            }}
            onSaveReview={async (id, input, basis) => {
              await api.updateDecisionReview(id, input, ...(basis === undefined ? [] as const : [basis] as const));
              setReviewRevision((value) => value + 1);
            }}
            onPostponeReview={async (id, reviewDueDate) => {
              await api.updateDecisionReviewDueDate(id, reviewDueDate);
              setReviewRevision((value) => value + 1);
            }}
            remindersEnabled={snapshot.reviewRemindersEnabled ?? true}
            {...(drafts === undefined ? {} : { drafts })}
          />
        </section>

        <RecentDecisionList
          decisions={dashboard.recentDecisions}
          onOpenDecision={onOpenDecision}
          onOpenRetrospective={onOpenRetrospective}
        />
        </>}
      </div>
    </section>
  );
};
