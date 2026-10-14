import { useContext, useEffect, useRef, useState } from "react";

import { PageHidden } from "../../ModalDialog.js";
import type {
  DecisionApi,
  ObsidianSearchStatus,
} from "../../../../shared/renderer-api.js";

type ObsidianStatusApi = Pick<DecisionApi, "getObsidianSearchStatus">;

export const INDEXING_STATUS_REFRESH_MS = 800;
export const STABLE_STATUS_REFRESH_MS = 5_000;

type StatusActionKind = "search" | "rebuild";

export interface ObsidianStatusAction {
  commit(status: ObsidianSearchStatus): boolean;
  recover(): void;
}

interface ObsidianSearchStatusState {
  status: ObsidianSearchStatus | null;
  statusError: string | null;
  startAction(kind: StatusActionKind): ObsidianStatusAction;
}

interface StatusController {
  startAction(kind: StatusActionKind): ObsidianStatusAction;
}

interface StatusRuntime {
  generation: number;
  authorityRevision: number;
  requestRevision: number;
  nextActionToken: number;
  activeRebuildToken: number | null;
  timer: number | null;
  status: ObsidianSearchStatus | null;
  controller: StatusController;
  /** Polls again at once, when it was left off while the page was hidden. */
  resume(): void;
}

const inactiveAction = (): ObsidianStatusAction => ({
  commit: () => false,
  recover: () => undefined,
});

const inactiveController: StatusController = {
  startAction: inactiveAction,
};

const emptyIndexingStatus = (): ObsidianSearchStatus => ({
  state: "indexing",
  discoveredNotes: 0,
  indexedNotes: 0,
  chunkCount: 0,
  processedNotes: 0,
  totalNotes: 0,
  skippedNotes: 0,
  failedNotes: 0,
  synchronizedAt: null,
  semanticAvailable: false,
  message: null,
});

const rebuildStatus = (
  current: ObsidianSearchStatus | null,
): ObsidianSearchStatus => {
  const preserved = current ?? emptyIndexingStatus();
  return {
    ...preserved,
    state: "indexing",
    processedNotes: 0,
    totalNotes:
      preserved.discoveredNotes > 0
        ? preserved.discoveredNotes
        : preserved.totalNotes,
    message: null,
  };
};

export const useObsidianSearchStatus = (
  api: ObsidianStatusApi,
): ObsidianSearchStatusState => {
  const [status, setStatus] = useState<ObsidianSearchStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const runtimeRef = useRef<StatusRuntime>({
    generation: 0,
    authorityRevision: 0,
    requestRevision: 0,
    nextActionToken: 0,
    activeRebuildToken: null,
    timer: null,
    status: null,
    controller: inactiveController,
    resume: () => undefined,
  });
  // Kept mounted behind a capture that has the window, the page does not ask every 5 s (0.8 s while
  // indexing) for a status nobody sees; shown again, it asks at once.
  const hidden = useContext(PageHidden);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  useEffect(() => {
    if (!hidden) runtimeRef.current.resume();
  }, [hidden]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const generation = runtime.generation + 1;
    runtime.generation = generation;
    runtime.authorityRevision += 1;
    runtime.requestRevision += 1;

    const isCurrentGeneration = () => runtime.generation === generation;
    const clearTimer = () => {
      if (runtime.timer === null) return;
      window.clearTimeout(runtime.timer);
      runtime.timer = null;
    };

    let requestStatus: () => Promise<void>;
    const scheduleRefresh = (delay?: number) => {
      clearTimer();
      if (!isCurrentGeneration() || hiddenRef.current) return;
      const refreshDelay =
        delay ??
        (runtime.status?.state === "indexing"
          ? INDEXING_STATUS_REFRESH_MS
          : STABLE_STATUS_REFRESH_MS);
      runtime.timer = window.setTimeout(() => {
        runtime.timer = null;
        void requestStatus();
      }, refreshDelay);
    };

    requestStatus = async () => {
      const requestRevision = runtime.requestRevision + 1;
      runtime.requestRevision = requestRevision;
      const authorityRevision = runtime.authorityRevision;
      const isCurrentRequest = () =>
        isCurrentGeneration() &&
        runtime.requestRevision === requestRevision &&
        runtime.authorityRevision === authorityRevision;
      let failed = false;
      try {
        const nextStatus = await api.getObsidianSearchStatus();
        if (!isCurrentRequest()) return;
        runtime.status = nextStatus;
        setStatus(nextStatus);
        setStatusError(null);
      } catch {
        if (!isCurrentRequest()) return;
        failed = true;
        setStatusError("暂时无法获取 Obsidian 索引状态。");
      } finally {
        if (isCurrentRequest()) {
          scheduleRefresh(failed ? STABLE_STATUS_REFRESH_MS : undefined);
        }
      }
    };

    const commitExternalStatus = (nextStatus: ObsidianSearchStatus) => {
      runtime.authorityRevision += 1;
      runtime.requestRevision += 1;
      clearTimer();
      runtime.status = nextStatus;
      setStatus(nextStatus);
      setStatusError(null);
      scheduleRefresh();
    };

    const refresh = () => {
      runtime.authorityRevision += 1;
      runtime.requestRevision += 1;
      clearTimer();
      void requestStatus();
    };

    runtime.resume = () => {
      if (isCurrentGeneration() && runtime.timer === null) refresh();
    };

    runtime.controller = {
      startAction: (kind) => {
        const actionToken = runtime.nextActionToken + 1;
        runtime.nextActionToken = actionToken;
        const authorityAtStart = runtime.authorityRevision;
        if (kind === "rebuild" && isCurrentGeneration()) {
          runtime.activeRebuildToken = actionToken;
          commitExternalStatus(rebuildStatus(runtime.status));
        }
        return {
          commit: (nextStatus) => {
            if (!isCurrentGeneration()) return false;
            if (kind === "rebuild") {
              if (runtime.activeRebuildToken !== actionToken) return false;
              runtime.activeRebuildToken = null;
            } else if (
              runtime.activeRebuildToken !== null ||
              runtime.authorityRevision !== authorityAtStart
            ) {
              return false;
            }
            commitExternalStatus(nextStatus);
            return true;
          },
          recover: () => {
            if (
              kind === "rebuild" &&
              isCurrentGeneration() &&
              runtime.activeRebuildToken === actionToken
            ) {
              runtime.activeRebuildToken = null;
              refresh();
            }
          },
        };
      },
    };

    runtime.status = null;
    runtime.activeRebuildToken = null;
    setStatus(null);
    setStatusError(null);
    void requestStatus();

    return () => {
      clearTimer();
      if (isCurrentGeneration()) {
        runtime.generation = generation + 1;
        runtime.authorityRevision += 1;
        runtime.requestRevision += 1;
        runtime.status = null;
        runtime.activeRebuildToken = null;
        runtime.controller = inactiveController;
        runtime.resume = () => undefined;
      }
    };
  }, [api]);

  return {
    status,
    statusError,
    startAction: (kind) => runtimeRef.current.controller.startAction(kind),
  };
};
