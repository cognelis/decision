import type { RationaleSubmission } from "@cognelis/decision-core";
import { useEffect, useState, type ReactNode } from "react";

import type { DecisionApi } from "../shared/renderer-api.js";
import { CandidateReview } from "./components/CandidateReview.js";
import { DecisionCenter } from "./components/DecisionCenter.js";
import { DecisionHeader } from "./components/DecisionHeader.js";
import {
  DesktopShell,
  type DesktopSurface,
} from "./components/DesktopShell.js";
import { RationaleStep } from "./components/RationaleStep.js";
import { ActivityPanel } from "./components/pages/activity/ActivityPanel.js";
import { ClientsPanel } from "./components/pages/clients/ClientsPanel.js";
import { DecisionLibraryPanel } from "./components/pages/decisions/DecisionLibraryPanel.js";
import { MethodologyPanel } from "./components/pages/methodology/MethodologyPanel.js";
import { ModelsPanel } from "./components/pages/models/ModelsPanel.js";
import { SettingsPanel } from "./components/pages/settings/SettingsPanel.js";
import { useAppSnapshot } from "./use-app-snapshot.js";

interface AppProps {
  api?: DecisionApi;
}

export const App = ({ api = window.decision }: AppProps) => {
  const {
    snapshot,
    loading: snapshotLoading,
    error: snapshotError,
    retry: retrySnapshot,
  } = useAppSnapshot(api);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decisionNavigation, setDecisionNavigation] = useState<{
    id: string | null;
    reviewState:
      | "all"
      | "attention"
      | "due"
      | "scheduled"
      | "unscheduled"
      | "pending_outcome"
      | "pending_review"
      | "reviewed";
  } | null>(null);

  useEffect(() => {
    if (snapshot === null) return;
    setBusy(false);
    setError(null);
  }, [snapshot]);

  const perform = async (
    operation: () => Promise<void>,
    publicError?: string,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (caught) {
      setBusy(false);
      setError(
        publicError ??
          (caught instanceof Error ? caught.message : String(caught)),
      );
    }
  };

  if (snapshot === null) {
    if (snapshotError !== null) {
      return (
        <section
          className="app-recovery-state"
          role="alert"
          aria-labelledby="snapshot-load-error-title"
          aria-describedby="snapshot-load-error-description"
        >
          <h1 id="snapshot-load-error-title">应用状态加载失败</h1>
          <p id="snapshot-load-error-description">{snapshotError}</p>
          <button
            className="primary-button"
            type="button"
            disabled={snapshotLoading}
            onClick={retrySnapshot}
          >
            {snapshotLoading ? "正在重试…" : "重试"}
          </button>
        </section>
      );
    }
    return <div className="loading-state" aria-label="正在加载" />;
  }

  const reviewCandidate = snapshot.decisionCandidates.current;
  const current = snapshot.current;
  let activeSurface: DesktopSurface;
  let content: ReactNode;

  if (snapshot.candidateReviewOpen && reviewCandidate !== null) {
    const reviewProgress = snapshot.candidateReviewProgress ?? {
      position: 1,
      total: snapshot.decisionCandidates.count,
    };
    activeSurface = "task";
    content = (
      <CandidateReview
        candidate={reviewCandidate}
        position={reviewProgress.position}
        total={reviewProgress.total}
        busy={busy}
        persistenceStatus={snapshot.decisionCandidates.persistenceStatus}
        error={error}
        onClose={() => {
          void api.closeCandidateReview();
        }}
        onConfirm={() =>
          perform(
            () => api.confirmCandidate(reviewCandidate.candidateId),
            "候选仍未保存，请重试或稍后处理。",
          )
        }
        onIgnore={() =>
          perform(
            () => api.ignoreCandidate(reviewCandidate.candidateId),
            "候选仍未保存，请重试或稍后处理。",
          )
        }
        onRetry={() =>
          perform(
            () => api.retryCandidate(reviewCandidate.candidateId),
            "候选仍未保存，请重试或稍后处理。",
          )
        }
      />
    );
  } else if (current === null) {
    const requestedSurface =
      snapshot.primarySurface === "hidden"
        ? "dashboard"
        : snapshot.primarySurface;
    activeSurface = requestedSurface;
    if (requestedSurface === "clients") {
      content = <ClientsPanel snapshot={snapshot} api={api} />;
    } else if (requestedSurface === "decisions") {
      content = (
        <DecisionLibraryPanel
          api={api}
          totalDecisions={snapshot.dashboard.totalDecisions}
          initialDecisionId={decisionNavigation?.id ?? null}
          initialReviewState={decisionNavigation?.reviewState ?? "all"}
          onInitialNavigationConsumed={() => setDecisionNavigation(null)}
        />
      );
    } else if (requestedSurface === "methodology") {
      content = (
        <MethodologyPanel
          api={api}
          onOpenDecision={(id) => {
            setDecisionNavigation({ id, reviewState: "all" });
            void api.openSurface("decisions");
          }}
        />
      );
    } else if (requestedSurface === "models") {
      content = <ModelsPanel snapshot={snapshot} api={api} />;
    } else if (requestedSurface === "activity") {
      content = <ActivityPanel snapshot={snapshot} api={api} />;
    } else if (requestedSurface === "settings") {
      content = <SettingsPanel snapshot={snapshot} api={api} />;
    } else {
      content = (
        <DecisionCenter
          api={api}
          snapshot={snapshot}
          onReview={() => {
            void api.openCandidateReview();
          }}
          onOpenDecision={(id) => {
            setDecisionNavigation({ id, reviewState: "all" });
            void api.openSurface("decisions");
          }}
          onOpenReviewInbox={() => {
            setDecisionNavigation({ id: null, reviewState: "attention" });
            void api.openSurface("decisions");
          }}
          onCompleteRationale={(id, rationale) =>
            api.submitRationale({
              candidateId: id,
              status: "captured",
              rationale,
            })
          }
          onSkipRationale={(id) =>
            api.submitRationale({
              candidateId: id,
              status: "skipped",
            })
          }
          onDiscardRationale={(id) =>
            api.submitRationale({
              candidateId: id,
              status: "not_recorded",
            })
          }
        />
      );
    }
  } else if (current.status === "completed") {
    const failed = snapshot.persistenceStatus === "failed";
    activeSurface = "task";
    content = (
      <section
        className="desktop-view decision-workspace decision-saving"
        data-layout="panel"
        data-testid="decision-shell"
        role="region"
        aria-label="决策保存状态"
      >
        <div className="decision-workspace-inner">
          <DecisionHeader
            candidate={current}
            waitingCount={snapshot.waitingCount}
          />
          <p className={failed ? "error-message" : "status-line"} role="status">
            {failed
              ? "Obsidian 暂时无法写入，原生答案和理由仍保留在内存中。"
              : "正在写入 Obsidian…"}
          </p>
          {failed ? (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void perform(() => api.retryPersistence())}
            >
              重试保存
            </button>
          ) : null}
          {error === null ? null : (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    );
  } else {
    const submitRationale = (submission: RationaleSubmission): Promise<void> =>
      perform(() =>
        api.submitRationale({
          candidateId: current.candidateId,
          ...submission,
        }),
      );
    activeSurface = "task";
    content = (
      <section
        className="desktop-view decision-workspace"
        data-layout="desktop"
        data-testid="decision-shell"
        role="region"
        aria-label="待补充决策理由"
      >
        <div className="decision-workspace-inner">
          <DecisionHeader
            candidate={current}
            waitingCount={snapshot.waitingCount}
          />
          <RationaleStep
            candidate={current}
            busy={busy}
            getPrincipleSuggestions={api.getDecisionPrincipleSuggestions}
            onSubmit={submitRationale}
          />
          {error === null ? null : (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <DesktopShell
      snapshot={snapshot}
      activeSurface={activeSurface}
      onNavigate={(surface) => {
        void api.openSurface(surface);
      }}
    >
      {content}
    </DesktopShell>
  );
};
