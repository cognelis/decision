import { useEffect, useRef, useState } from "react";
import type { PrCommentCandidates } from "@cognelis/decision-protocol";

import {
  pendingRationaleTotal,
  pendingWorkTotal,
  type AmendmentRecordView,
  type AppSnapshot,
  type DecisionApi,
  type DecisionLibraryItem,
  type DesktopPrimarySurface,
} from "../../shared/renderer-api.js";
import { OrganizationPanel } from "./pages/organization/OrganizationPanel.js";
import { ModalDialog } from "./ModalDialog.js";
import { DashboardGettingStarted } from "./DashboardGettingStarted.js";
import {
  DashboardPendingRationales,
  type PendingRationaleCompletion,
  type PendingRationaleDraft,
} from "./DashboardPendingRationales.js";
import { DashboardReviewInbox, type ReviewInboxDraft } from "./DashboardReviewInbox.js";
import { RecentDecisionList } from "./RecentDecisionList.js";
import { decisionWordsNow } from "./pages/decisions/amendment-view.js";
import { DecisionDeletionDialog } from "./pages/decisions/DecisionDeletionDialog.js";

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
  /** Opens a PR's discussion, showing the comments its link read as decisions. */
  onOpenPrDiscussion?(target: { connectionId: string; reference: string; title: string }): void;
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
  onOpenPrDiscussion,
}: DecisionCenterProps) => {
  // What the links following their PRs read as decisions, by PR: read again with each snapshot pushed, so one recorded
  // or turned down leaves and one found on the last look arrives.
  const [organizing, setOrganizing] = useState(false);
  const [organizingDirty, setOrganizingDirty] = useState(false);
  const [rawQueues, setRawQueues] = useState(false);
  const [prCandidates, setPrCandidates] = useState<PrCommentCandidates["prs"]>([]);
  useEffect(() => {
    let disposed = false;
    api.listPrCommentCandidates().then((result) => { if (!disposed) setPrCandidates(result.prs); }, () => undefined);
    return () => { disposed = true; };
  }, [api, snapshot]);
  const [reviewInbox, setReviewInbox] = useState<DecisionLibraryItem[]>([]);
  const [unscheduled, setUnscheduled] = useState<DecisionLibraryItem[]>([]);
  const [reviewInboxLoading, setReviewInboxLoading] = useState(true);
  const [reviewInboxFailed, setReviewInboxFailed] = useState(false);
  // Saving from the card changes what belongs in it, and the list is loaded
  // here rather than carried by the pushed snapshot.
  const [reviewRevision, setReviewRevision] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const firstReviewRead = useRef(true);
  // What agents or the reader rewrote of a decision's question and choice: the recent list reads as it stands now.
  const [amendments, setAmendments] = useState<Map<string, AmendmentRecordView>>(new Map());
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.listDecisionAmendments())
      .then((overview) => { if (active) setAmendments(new Map(overview.records.filter((record) => record.source === "decisions").map((record) => [record.recordId, record]))); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [api, snapshot.dashboard]);

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
    snapshot.pendingRationales.length === 0 &&
    prCandidates.length === 0;
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
          <p>记录你的决定与经验，查看自动维护进展。</p>
        </div>
        <div className="desktop-view-meta">
          {snapshot.dashboard.organizationAutomatic ? null : <><strong>{pendingWorkTotal(snapshot)}</strong><span>项待处理</span></>}
          <button type="button" className="secondary-button no-drag" onClick={() => setOrganizing(true)}>整理与记忆{(snapshot.dashboard.organizationPending ?? 0) > 0 ? ` · 需要你判断 ${snapshot.dashboard.organizationPending}` : ""}</button>
        </div>
      </header>

      {organizing ? <ModalDialog title="整理与记忆" size="workspace" unsaved={organizingDirty} onClose={() => setOrganizing(false)}><OrganizationPanel api={api} organizationRevision={snapshot.dashboard.organizationRevision ?? 0} context={{ project: null, projects: [], listId: null, listTitle: null, items: [] }} onClose={() => setOrganizing(false)} onDirtyChange={setOrganizingDirty} /></ModalDialog> : null}
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
        {snapshot.dashboard.organizationAutomatic ? <section className="dashboard-card"><h2>{(snapshot.dashboard.organizationPending ?? 0) === 0 ? "当前没有需要你判断的事项" : `${snapshot.dashboard.organizationPending} 个问题需要你判断`}</h2><p>常规整理自动进行；缺少理由和结果的记录安静保留，不需要逐条处理。</p><button type="button" className="secondary-button" onClick={() => setOrganizing(true)}>查看整理与记忆</button><button type="button" className="text-button" aria-expanded={rawQueues} onClick={() => setRawQueues(!rawQueues)}>查看原始待处理记录</button></section> : null}
        <section className="dashboard-work-grid" aria-label="待处理" hidden={snapshot.dashboard.organizationAutomatic && !rawQueues}>
          <section
            className="dashboard-card dashboard-candidate-card"
            aria-labelledby="dashboard-candidate-title"
          >
            <header className="dashboard-card-header">
              <div>
                <span>待处理</span>
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
              prCandidates.length ? null : <p className="dashboard-empty-copy">目前没有需要确认的决策。</p>
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
            {prCandidates.length ? (
              <div className="dashboard-pr-candidates">
                <span>PR 评论里像是决定的 · {prCandidates.reduce((sum, item) => sum + item.count, 0)} 条</span>
                <ul>
                  {prCandidates.slice(0, 5).map((item) => (
                    <li key={`${item.connectionId}\n${item.reference}`}>
                      <button type="button" className="text-button" onClick={() => onOpenPrDiscussion?.(item)}>{item.title}</button>
                      <small>{item.reference} · {item.count} 条</small>
                    </li>
                  ))}
                </ul>
                {prCandidates.length > 5 ? <small>另有 {prCandidates.length - 5} 个 PR</small> : null}
              </div>
            ) : null}
          </section>

          <DashboardPendingRationales
            decisions={snapshot.pendingRationales}
            total={pendingRationaleTotal(snapshot)}
            onBrowseAll={onOpenDeferred}
            listDecisions={api.listDecisions}
            onComplete={onCompleteRationale}
            onSkip={onSkipRationale}
            onDiscard={onDiscardRationale}
            recordApi={api}
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
            onDeleteDecision={setDeleting}
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
          decisions={dashboard.recentDecisions.map((decision) => decisionWordsNow(decision, amendments.get(decision.id)?.state))}
          onOpenDecision={onOpenDecision}
          onOpenRetrospective={onOpenRetrospective}
          onDeleteDecision={setDeleting}
        />
        {/* The list itself follows the snapshot the deletion pushes; an index warning arrives the same way. */}
        {deleting === null ? null : <DecisionDeletionDialog api={api} target={{ id: deleting, storage: "vault" }}
          onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); setReviewRevision((value) => value + 1); }} />}
        </>}
      </div>
    </section>
  );
};
