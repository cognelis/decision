import { LocalReviewPanel } from "./components/pages/local-review/LocalReviewPanel.js";
import { PrReviewPanel } from "./components/pages/pr-review/PrReviewPanel.js";
import { moveReviewHistory } from "./components/pages/pr-review/review-history.js";
import type { OutcomeVerdict, RationaleSubmission } from "@cognelis/decision-core";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  pendingRationaleTotal,
  type DecisionApi,
  type DesktopPrimarySurface,
} from "../shared/renderer-api.js";
import type { ActiveRecordSaved } from "./components/pages/decisions/ActiveRecordDialog.js";
import { CandidateReview } from "./components/CandidateReview.js";
import { DecisionCenter, type HomeDrafts } from "./components/DecisionCenter.js";
import { DecisionHeader } from "./components/DecisionHeader.js";
import { PageHidden, pageFocusLost } from "./components/ModalDialog.js";
import {
  DesktopShell,
  SETTINGS_SURFACES,
  type DesktopSurface,
} from "./components/DesktopShell.js";
import { RationaleStep } from "./components/RationaleStep.js";
import { ActivityPanel } from "./components/pages/activity/ActivityPanel.js";
import { PrConnectionsPanel } from "./components/pages/pr-review/PrConnectionsPanel.js";
import { ClientsPanel } from "./components/pages/clients/ClientsPanel.js";
import {
  DecisionLibraryPanel,
  type DecisionBrowseFilter,
} from "./components/pages/decisions/DecisionLibraryPanel.js";
import { MethodologyPanel } from "./components/pages/methodology/MethodologyPanel.js";
import type { MethodologyView } from "./components/pages/methodology/methodology-view-types.js";
import { ModelsPanel } from "./components/pages/models/ModelsPanel.js";
import { AssistantPanel } from "./components/pages/assistant/AssistantPanel.js";
import { START_ONBOARDING_EVENT } from "./onboarding-navigation.js";
import { SettingsPanel } from "./components/pages/settings/SettingsPanel.js";
import { TodoPanel } from "./components/pages/todos/TodoPanel.js";
import { PromptsPanel } from "./components/pages/prompts/PromptsPanel.js";
import { followAccent } from "./accent.js";
import { keepSwitchFocus } from "./keyboard.js";
import { useAppSnapshot } from "./use-app-snapshot.js";
import { rememberClients } from "./client-labels.js";

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
  const operationPending = useRef(false);
  /** The page last asked for: a closed window keeps it, rather than the home page in its place. */
  const shownSurface = useRef<DesktopPrimarySurface>("dashboard");
  // The home page's dialogs, as they were: a capture taking the window over unmounts the page.
  const homeDrafts = useRef<HomeDrafts>({});
  const [error, setError] = useState<string | null>(null);
  const [decisionNavigation, setDecisionNavigation] = useState<{
    id: string | null;
    reviewState:
      | "all"
      | "attention"
      | "due"
      | "scheduled"
      | "unscheduled"
      | "expectation_missing"
      | "pending_outcome"
      | "pending_review"
      | "reviewed";
    query?: string;
    period?: "7" | "30";
    rationaleStatus?: "captured" | "deferred" | "skipped";
    project?: string;
    outcomeVerdict?: OutcomeVerdict;
  } | null>(null);
  const [principleNavigation, setPrincipleNavigation] = useState<string | null>(
    null,
  );
  const [methodologyView, setMethodologyView] = useState<MethodologyView | null>(
    null,
  );
  const [journalNavigation, setJournalNavigation] = useState<string | null>(
    null,
  );
  const [browseRequest, setBrowseRequest] = useState(0);
  const [sourceNavigation, setSourceNavigation] = useState<string | null>(null);
  // The page a jump left, held mounted out of sight: going back by the sidebar finds it as it was left, not afresh.
  const [kept, setKept] = useState<DesktopPrimarySurface | null>(null);
  // Each increase asks the shell for the manual record dialog, as ⌘N does.
  const [recordRequest, setRecordRequest] = useState(0);
  const [assistantOpened, setAssistantOpened] = useState(false);
  const [reviewOpened, setReviewOpened] = useState(false);
  const [localReviewOpened, setLocalReviewOpened] = useState(false);
  const [localReviewJobId, setLocalReviewJobId] = useState<string | null>(null);
  useEffect(() => api.onLocalReviewNavigate(id => { setLocalReviewJobId(id); setLocalReviewOpened(true); void api.openSurface("local-review").catch(cause => setError(String(cause))); }), [api]);
  useEffect(() => { if (snapshot?.primarySurface === "local-review") setLocalReviewOpened(true); }, [snapshot?.primarySurface]);
  const [reviewActivity, setReviewActivity] = useState<"running" | "done" | null>(null);
  // A review record picked in quick jump; a new object each time, so picking the same one again still opens it.
  const [reviewNavigation, setReviewNavigation] = useState<{ id: string } | null>(null);
  // A PR whose comments a link read as decisions, picked on the home page; a new object each time, as above.
  const [discussionNavigation, setDiscussionNavigation] = useState<{ connectionId: string; reference: string; title: string } | null>(null);
  const [assistantNavigation, setAssistantNavigation] = useState<{ id: string } | { onboarding: true } | null>(null);
  // Set once jumpTo is: a 接入新工具 conversation asked for from any page (onboarding-navigation.ts).
  const startOnboardingRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const start = () => startOnboardingRef.current?.();
    window.addEventListener(START_ONBOARDING_EVENT, start);
    return () => window.removeEventListener(START_ONBOARDING_EVENT, start);
  }, []);
  // Here, at the start, not on the review page, which is not there until it is opened.
  // The review history this window's storage held before the App kept it: moved at the start, so it no longer crowds out
  // the drafts kept there. The App's own api only: the preview's store is that storage.
  useEffect(() => { if (api !== undefined && api === window.decision) void moveReviewHistory(api); }, [api]);
  // Before any page reads a client's name.
  rememberClients(snapshot?.clients);
  const accent = snapshot?.accent;
  // The theme colour the settings hold, for the scheme shown now and again whenever it changes (IMP-140).
  useEffect(() => (accent === undefined ? undefined : followAccent(accent)), [accent]);
  useEffect(() => { if (snapshot?.primarySurface === "pr-review") setReviewOpened(true); }, [snapshot?.primarySurface]);
  // The same function at every render: a page's arrival effect depends on it, and a new one with each snapshot
  // pushed meanwhile threw the record's lookup away and sent it again, the arrival opening only once pushes paused.
  const decisionNavigationConsumed = useCallback(() => setDecisionNavigation(null), []);
  const journalNavigationConsumed = useCallback(() => setJournalNavigation(null), []);
  const [historicalNavigation, setHistoricalNavigation] = useState<string | null>(null);
  const historicalNavigationConsumed = useCallback(() => setHistoricalNavigation(null), []);
  const sourceNavigationConsumed = useCallback(() => setSourceNavigation(null), []);
  const principleNavigationConsumed = useCallback(() => {
    setPrincipleNavigation(null);
    setMethodologyView(null);
  }, []);
  // Where the last jump went. A page then opened from the tray, a notification or a settings section's own
  // navigation (the main process, not this window's sidebar) is the reader moving on as surely as one chosen here:
  // the page the jump left, held mounted, came back as it was left long after, and 设置 led back to a section left
  // since. Still on that page, the jump's round trip has not come back yet, or the reader went back to it.
  const jumpTarget = useRef<DesktopPrimarySurface | null>(null);
  useEffect(() => {
    const surface = snapshot?.primarySurface;
    if (surface === undefined || surface === "hidden") return;
    if (surface === jumpTarget.current || surface === kept) return;
    jumpTarget.current = null;
    setKept(null);
  }, [snapshot?.primarySurface, kept]);

  // Pushed while a change is still being saved (the vault watcher, an agent's write), a snapshot is not the one
  // that change brings: cleared then, the form opened again under the save, and a press on it went nowhere. Held
  // until the change is done instead.
  const pushedMeanwhile = useRef(false);
  useEffect(() => {
    if (snapshot === null) return;
    if (snapshot.primarySurface === "assistant") setAssistantOpened(true);
    if (operationPending.current) pushedMeanwhile.current = true;
    else setBusy(false);
  }, [snapshot]);
  // An error belongs to the task it was raised on, and goes when that task moves on, not with every
  // refresh: a vault watcher or a semantic pair pushes snapshots all the time, and why a save failed was
  // gone with the first of them, leaving "暂时无法写入" and nothing to act on.
  const errorSubject =
    snapshot === null
      ? null
      : [
          snapshot.current?.candidateId ?? "",
          snapshot.decisionCandidates.current?.candidateId ?? "",
          snapshot.candidateReviewOpen,
        ].join("|");
  useEffect(() => setError(null), [errorSubject]);

  // A save that failed is said over the page, and retrying it is the one thing to do: focus goes to it, not to the
  // page's title after the alert (DesktopShell), where Tab led away from it and a screen reader never reached it.
  const retryPersistence = useRef<HTMLButtonElement>(null);
  const persistenceFailed = snapshot?.current?.status === "completed" && snapshot.persistenceStatus === "failed";
  useEffect(() => {
    if (!persistenceFailed || busy) return;
    if (pageFocusLost() || document.activeElement instanceof HTMLHeadingElement) retryPersistence.current?.focus();
  }, [persistenceFailed, busy]);

  const perform = async (
    operation: () => Promise<void>,
    publicError?: string,
  ): Promise<void> => {
    if (operationPending.current) return;
    operationPending.current = true;
    // What was pressed or typed in is disabled while the change is saved, which takes focus from it: given back when
    // the change fails and leaves it there, where Tab started over at the sidebar.
    const control = document.activeElement;
    setBusy(true);
    setError(null);
    try {
      const pending = operation();
      if (control instanceof HTMLButtonElement || control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement) {
        keepSwitchFocus(control, pending);
      }
      await pending;
    } catch (caught) {
      setBusy(false);
      setError(
        publicError ??
          (caught instanceof Error ? caught.message : String(caught)),
      );
    } finally {
      operationPending.current = false;
      // A snapshot came while it was saved: that one may have been the change's own, and none other may follow.
      if (pushedMeanwhile.current) setBusy(false);
      pushedMeanwhile.current = false;
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

  // Every page that names a record can now send the reader to it, and there is
  // one way to arrive at each kind rather than one per caller.
  const jumpTo = (surface: DesktopPrimarySurface): void => {
    // Where they were, from the snapshot rather than the rendered surface:
    // that is the one the main process will replace.
    const from =
      snapshot.primarySurface === "hidden"
        ? "dashboard"
        : snapshot.primarySurface;
    const back = from === surface ? null : from;
    jumpTarget.current = surface;
    // Mounted afresh, the page left lost the view, filters and record the reader left it on. Not the home
    // page, which reads again what still waits; the assistant and reviews are kept mounted anyway.
    setKept(back === "dashboard" || back === "assistant" || (back === "pr-review" || back === "local-review") ? null : back);
    void api.openSurface(surface);
  };
  startOnboardingRef.current = () => {
    setAssistantNavigation({ onboarding: true });
    setAssistantOpened(true);
    jumpTo("assistant");
  };
  const openDecision = (id: string): void => {
    setDecisionNavigation({ id, reviewState: "all" });
    jumpTo("decisions");
  };
  const browseDecisions = (filter: DecisionBrowseFilter): void => {
    setDecisionNavigation({ id: null, reviewState: "all", ...filter });
    // The library reads a filter as it opens: one asked for while it is open opens it afresh.
    setBrowseRequest((count) => count + 1);
    jumpTo("decisions");
  };
  const openRetrospective = (): void => {
    setMethodologyView("analysis");
    jumpTo("methodology");
  };
  const openPrinciple = (id: string): void => {
    setPrincipleNavigation(id);
    jumpTo("methodology");
  };
  const openJournalEntry = (id: string): void => {
    setJournalNavigation(id);
    jumpTo("decisions");
  };
  const openRecorded = (result: ActiveRecordSaved): void => {
    if (result.recordKind === "decision") openDecision(result.recordId);
    else if (result.recordKind === "historical_decision") {
      setHistoricalNavigation(result.recordId);
      jumpTo("decisions");
    } else openJournalEntry(result.recordId);
  };

  const reviewCandidate = snapshot.decisionCandidates.current;
  const current = snapshot.current;
  /*
   * The page asked for is kept while a captured decision has the window: mounted but out of sight, so
   * what the reader was writing on it is there when they come back (the home page kept its drafts by
   * hand; the others lost theirs). Its dialogs stay out of sight with it.
   */
  // Closed (⌘W, the red button), the window keeps the page it had: drawn as the home page instead, that
  // page went, and what was being written on it with it.
  if (snapshot.primarySurface !== "hidden") shownSurface.current = snapshot.primarySurface;
  const requestedSurface =
    snapshot.primarySurface === "hidden"
      ? shownSurface.current
      : snapshot.primarySurface;
  const pageFor = (surface: DesktopPrimarySurface): ReactNode => {
    if (surface === "clients") {
      return <ClientsPanel snapshot={snapshot} api={api} />;
    } else if (surface === "connections") {
      return <PrConnectionsPanel api={api} />;
    } else if (surface === "decisions") {
      return (
        <DecisionLibraryPanel
          key={browseRequest}
          api={api}
          totalDecisions={snapshot.dashboard.totalDecisions}
          decisionsRevision={snapshot.dashboard.revision ?? 0}
          journalRevision={snapshot.dashboard.journalRevision ?? 0}
          pendingRationales={pendingRationaleTotal(snapshot)}
          journalNotice={snapshot.health.journalMessage ?? null}
          onOpenHome={() => jumpTo("dashboard")}
          initialDecisionId={decisionNavigation?.id ?? null}
          initialJournalEntryId={journalNavigation}
          historicalRevision={snapshot.dashboard.historicalDecisionRevision ?? 0}
          initialHistoricalId={historicalNavigation}
          onInitialHistoricalConsumed={historicalNavigationConsumed}
          initialReviewState={decisionNavigation?.reviewState ?? "all"}
          initialQuery={decisionNavigation?.query ?? ""}
          initialPeriod={decisionNavigation?.period ?? "all"}
          initialRationaleStatus={decisionNavigation?.rationaleStatus ?? "all"}
          initialProject={decisionNavigation?.project ?? null}
          initialVerdict={decisionNavigation?.outcomeVerdict ?? null}
          onInitialNavigationConsumed={decisionNavigationConsumed}
          onInitialJournalConsumed={journalNavigationConsumed}
          onOpenPrinciple={openPrinciple}
          organization={{ revision: snapshot.dashboard.organizationRevision ?? 0, pending: snapshot.dashboard.organizationPending ?? 0, onOpenMethodology: () => jumpTo("methodology") }}
          onRecorded={openRecorded}
          onDistillDecision={(id) => {
            setSourceNavigation(id);
            jumpTo("methodology");
          }}
        />
      );
    } else if ((surface === "assistant" || surface === "pr-review" || surface === "local-review")) {
      return null;
    } else if (surface === "todos") {
      return (
        <TodoPanel
          api={api}
          todoRevision={snapshot.dashboard.todoRevision ?? 0}
          organization={{ api, revision: snapshot.dashboard.organizationRevision ?? 0, pending: snapshot.dashboard.organizationPending ?? 0, onOpenMethodology: () => jumpTo("methodology") }}
        />
      );
    } else if (surface === "methodology") {
      return (
        <MethodologyPanel
          api={api}
          unreadableNotice={snapshot.health.methodologyMessage ?? null}
          initialPrincipleId={principleNavigation}
          initialSourceDecisionId={sourceNavigation}
          initialView={methodologyView}
          onInitialSourceConsumed={sourceNavigationConsumed}
          onInitialNavigationConsumed={principleNavigationConsumed}
          onOpenDecision={openDecision}
          onBrowseDecisions={browseDecisions}
        />
      );
    } else if (surface === "prompts") {
      return <PromptsPanel api={api} />;
    } else if (surface === "models") {
      return <ModelsPanel snapshot={snapshot} api={api} />;
    } else if (surface === "activity") {
      return <ActivityPanel snapshot={snapshot} api={api} />;
    } else if (surface === "settings") {
      return <SettingsPanel snapshot={snapshot} api={api} />;
    } else {
      return (
        <DecisionCenter
          api={api}
          snapshot={snapshot}
          drafts={homeDrafts.current}
          onReview={() => {
            void api.openCandidateReview();
          }}
          onOpenDecision={openDecision}
          onOpenReviewInbox={() => {
            setDecisionNavigation({ id: null, reviewState: "attention" });
            jumpTo("decisions");
          }}
          onOpenLibrary={() => {
            setDecisionNavigation({ id: null, reviewState: "all" });
            jumpTo("decisions");
          }}
          onOpenRecent={() => browseDecisions({ period: "7" })}
          onOpenPrDiscussion={(target) => {
            setDiscussionNavigation({ connectionId: target.connectionId, reference: target.reference, title: target.title });
            jumpTo("pr-review");
          }}
          onOpenDeferred={() => browseDecisions({ rationaleStatus: "deferred" })}
          onOpenRetrospective={openRetrospective}
          onNavigate={jumpTo}
          onRecord={() => setRecordRequest((count) => count + 1)}
          onCompleteRationale={(id, completion) =>
            api.submitRationale({
              candidateId: id,
              status: "captured",
              ...completion,
            })
          }
          onSkipRationale={(id) =>
            api.submitRationale({
              candidateId: id,
              status: "skipped",
            })
          }
          onKeepLocalRationale={(id, completion) => api.submitRationale({ candidateId: id, status: "local_only", ...completion })}
          onDiscardRationale={(id) =>
            api.submitRationale({
              candidateId: id,
              status: "not_recorded",
            })
          }
        />
      );
    }
  };
  let task: ReactNode = null;
  let taskKey: string | null = null;
  let persistenceAlert: ReactNode = null;

  if (snapshot.candidateReviewOpen && reviewCandidate !== null) {
    taskKey = `review:${reviewCandidate.candidateId}`;
    const reviewProgress = snapshot.candidateReviewProgress ?? {
      position: 1,
      total: snapshot.decisionCandidates.count,
    };
    task = (
      <CandidateReview
        candidate={reviewCandidate}
        position={reviewProgress.position}
        total={reviewProgress.total}
        remaining={snapshot.decisionCandidates.count}
        recordApi={api}
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
        onSkip={() => perform(() => api.skipCandidate(reviewCandidate.candidateId))}
        onRetry={() =>
          perform(
            () => api.retryCandidate(reviewCandidate.candidateId),
            "候选仍未保存，请重试或稍后处理。",
          )
        }
      />
    );
  } else if (current !== null && current.status === "completed" && snapshot.persistenceStatus === "failed") {
    // Said over whatever page is open, not in place of every page: held there, the window had only a retry
    // that could not work while the vault was gone, and Settings, where the vault is changed, out of reach.
    // A strip across the top of the content that takes its own height: floated over the bottom right corner, it
    // covered whatever page was open there, every page, for as long as the vault was gone.
    persistenceAlert = (
      <section className="persistence-alert" role="region" aria-label="决策保存状态">
        {/* Said as an alert: a status inserted with its words was, as often as not, never read out. */}
        <p role="alert">
          {snapshot.persistenceFailure === "local"
            ? "本机记录暂时无法保存，这条内容仍留在恢复队列。请检查磁盘空间和应用数据目录权限后重试。"
            : snapshot.persistenceFailure === "recovery_queue"
            ? "本机恢复队列暂时写不进，这条决策还停在这里。清出磁盘空间或修好本机数据目录的权限后重试。"
            : "Obsidian 暂时无法写入，原生答案和理由仍保留在本机。仓库目录被移动、改名或所在的磁盘没有连接时，接回后重试；也可以在设置里更换仓库。"}
        </p>
        {error === null ? null : <p role="alert">{error}</p>}
        <div className="persistence-alert-actions">
          <button
            ref={retryPersistence}
            className="primary-button"
            disabled={busy}
            onClick={() => void perform(() => api.retryPersistence())}
          >
            重试保存
          </button>
          {requestedSurface === "settings" ? null : (
            <button className="secondary-button" onClick={() => void api.openSurface("settings")}>
              打开设置
            </button>
          )}
        </div>
      </section>
    );
  } else if (current !== null) {
    // Taken by one of its actions and being carried out (written to Obsidian, kept on this Mac, put off), it is the same
    // panel, the same component: what was written in it stays in sight, its fields and actions still, while the bar says
    // what is under way. A page of its own for it was a line on an empty window.
    const saving = current.status === "completed";
    taskKey = `${saving ? "saving" : "rationale"}:${current.candidateId}`;
    const submitRationale = (submission: RationaleSubmission): Promise<void> =>
      perform(() =>
        api.submitRationale({
          candidateId: current.candidateId,
          ...submission,
        }),
      );
    task = (
      <section
        key={`rationale-${current.candidateId}`}
        className="desktop-view decision-workspace"
        data-layout="desktop"
        data-testid="decision-shell"
        role="region"
        aria-label={saving ? "决策保存状态" : "待补充决策理由"}
      >
        <div className="decision-workspace-inner">
          <DecisionHeader
            candidate={current}
            waitingCount={snapshot.waitingCount}
            questionId="rationale-question-text"
          />
          <RationaleStep
            candidate={current}
            busy={busy || saving}
            saving={saving}
            error={error}
            getPrincipleSuggestions={api.getDecisionPrincipleSuggestions}
            listDecisions={api.listDecisions}
            recordApi={api}
            onSubmit={submitRationale}
          />
        </div>
      </section>
    );
  }
  const activeSurface: DesktopSurface = task === null ? requestedSurface : "task";
  // The page asked for and the one a jump left, each in a holder of its own: neither is mounted afresh as
  // the other comes and goes. The home page is the exception while a task has the window: it keeps its
  // drafts itself, and reads again what still waits when it comes back, so a dialog for something done
  // elsewhere meanwhile does not come back with it.
  const holders = [...new Set([kept ?? requestedSurface, requestedSurface])].filter(
    (surface) => task === null || surface !== "dashboard",
  );
  const content = (
    <>
      {persistenceAlert}
      {task}
      {holders.map((surface) => {
        const hidden = task !== null || surface !== requestedSurface;
        return (
          <PageHidden.Provider key={surface} value={hidden}>
            <div className="page-holder" hidden={hidden}>
              {pageFor(surface)}
            </div>
          </PageHidden.Provider>
        );
      })}
    </>
  );
  return (
    <DesktopShell
      snapshot={snapshot}
      activeSurface={activeSurface}
      quickJumpApi={api}
      todoApi={api}
      recordApi={api}
      recordRequest={recordRequest}
      reviewActivity={reviewActivity}
      taskKey={taskKey}
      onNavigate={(chosen) => {
        // 设置 stands for every settings section: from a jump that left one (⌘K or ⌘N on 模型, say), it leads back
        // to that section as it was left, not to 通用 and the section afresh, its unsaved fields gone.
        const surface = chosen === "settings" && kept !== null && SETTINGS_SURFACES.has(kept) && kept !== requestedSurface ? kept : chosen;
        // Choosing a page from here is the reader deciding where they are; the
        // trail back to a jump they have left is no longer theirs to follow.
        jumpTarget.current = null;
        // Going back to the page a jump left by the sidebar finds it as it was left.
        if (surface !== kept) setKept(null);
        void api.openSurface(surface);
      }}
      onRecorded={openRecorded}
      onOpenDecision={openDecision}
      onOpenJournalEntry={openJournalEntry}
      onOpenPrinciple={openPrinciple}
      onOpenReview={(id) => {
        setReviewNavigation({ id });
        jumpTo("pr-review");
      }}
      onOpenConversation={(id) => {
        setAssistantNavigation({ id });
        jumpTo("assistant");
      }}
      onOpenPage={(page) => {
        if (page === "retrospective") {
          openRetrospective();
        } else {
          browseDecisions(
            page === "rationale-deferred"
              ? { rationaleStatus: "deferred" }
              : page === "review-attention"
                ? { reviewState: "attention" }
                : { reviewState: "expectation_missing" },
          );
        }
      }}
    >
      {content}
      {localReviewOpened || activeSurface === "local-review" ? <PageHidden.Provider value={activeSurface !== "local-review"}><LocalReviewPanel api={api} hidden={activeSurface !== "local-review"} openJobId={localReviewJobId} /></PageHidden.Provider> : null}
      {reviewOpened || activeSurface === "pr-review" ? (
        <PageHidden.Provider value={activeSurface !== "pr-review"}>
          <PrReviewPanel api={api} hidden={activeSurface !== "pr-review"} onOpenDecision={openDecision} onActivity={setReviewActivity} openRun={reviewNavigation} openDiscussion={discussionNavigation} />
        </PageHidden.Provider>
      ) : null}
      {assistantOpened || activeSurface === "assistant" ? (
        <PageHidden.Provider value={activeSurface !== "assistant"}>
          <AssistantPanel
            key="assistant"
            api={api}
            hidden={activeSurface !== "assistant"}
            onOpenDecision={openDecision}
            onOpenJournalEntry={openJournalEntry}
            onOpenPrinciple={openPrinciple}
            openConversationId={assistantNavigation}
            vault={snapshot.vaultPath}
          />
        </PageHidden.Provider>
      ) : null}
    </DesktopShell>
  );
};
