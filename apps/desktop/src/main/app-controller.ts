import {
  PROTOCOL_VERSION,
  type RuntimeDescriptor,
  type SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import {
  CandidatePersistenceError,
  type CandidateQueueSnapshot,
  type DecisionCandidateQueue,
  type RationaleQueue,
  type RationaleQueueSnapshot,
} from "@cognelis/decision-core";

import type { ThemePreference } from "../shared/appearance.js";
import type { CaptureClassifier } from "../shared/capture-classifier.js";
import type {
  AppSnapshot,
  AppHealth,
  DashboardSnapshot,
  DesktopPrimarySurface,
  IntegrationStatus,
  PendingRationaleSummary,
  PrimarySurface,
} from "../shared/renderer-api.js";

interface ServerLike {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

interface WatcherLike {
  start(): Promise<void>;
  close(): Promise<void>;
}

interface IndexLike {
  close(): void;
}

interface WindowsLike {
  create(): Promise<void>;
  publish(snapshot: AppSnapshot): void;
  prepareToQuit(): void;
}

interface AppControllerOptions {
  queue: RationaleQueue;
  candidates?: DecisionCandidateQueue;
  server: ServerLike;
  watcher: WatcherLike;
  index: IndexLike;
  windows: WindowsLike;
  runtimeFile: string;
  token: string;
  writeRuntime(path: string, descriptor: RuntimeDescriptor): Promise<void>;
  /** Told the runtime file could not be written (a full disk, a read-only folder), the app starts all the same. */
  onRuntimeUnwritable?: (error: unknown) => void;
  removeRuntime(path: string): Promise<void>;
  now?: () => Date;
  pid?: number;
  vaultPath?: string | null;
  health?: () => AppHealth;
  dashboard?: () => DashboardSnapshot;
  integrationStatus?: () => IntegrationStatus;
  pendingRationales?: () => PendingRationaleSummary[];
  pendingRationaleCount?: () => number;
  semanticRecognition?: () => SemanticRecognitionStatus;
  modelTraceContentEnabled?: () => boolean;
  reviewRemindersEnabled?: () => boolean;
  localCredentialsEnabled?: () => boolean;
  captureClassifier?: () => CaptureClassifier;
  theme?: () => ThemePreference;
  onSnapshot?: (snapshot: AppSnapshot) => void;
}

export class AppController {
  readonly #options: AppControllerOptions;
  #started = false;
  #primarySurface: PrimarySurface = "dashboard";
  #surfaceBeforeClose: DesktopPrimarySurface = "dashboard";
  #candidateReviewReturnSurface: PrimarySurface = "dashboard";
  #candidateReviewOpen = false;
  #candidateReviewSessionActive = false;
  #candidateReviewRationaleId: string | null = null;
  #candidateReviewProcessed = 0;
  #candidateReviewTotal = 0;
  #candidateAction: "confirm" | "ignore" | null = null;
  #failedCandidateAction: "confirm" | "ignore" | null = null;
  readonly #unsubscribes: Array<() => void> = [];

  constructor(options: AppControllerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    await this.#options.watcher.start();
    await this.#options.windows.create();
    this.#unsubscribes.push(
      this.#options.queue.subscribe((snapshot) => {
        if (
          this.#candidateReviewSessionActive &&
          this.#candidateReviewRationaleId !== null &&
          snapshot.current?.candidateId !== this.#candidateReviewRationaleId
        ) {
          this.#candidateReviewRationaleId = null;
          if (this.#candidateSnapshot().current === null) {
            this.#resetCandidateReview();
          } else {
            this.#candidateReviewOpen = true;
          }
        }
        this.#publish();
      }),
    );
    if (this.#options.candidates !== undefined) {
      this.#unsubscribes.push(
        this.#options.candidates.subscribe((snapshot) => {
          if (this.#candidateReviewSessionActive) {
            this.#candidateReviewTotal = Math.max(
              this.#candidateReviewTotal,
              this.#candidateReviewProcessed + snapshot.count,
            );
          }
          // The action restores the return surface before publishing an emptied review queue.
          if (snapshot.current === null && this.#candidateAction !== null) return;
          if (
            snapshot.current === null &&
            this.#candidateReviewRationaleId === null &&
            this.#candidateAction === null
          ) {
            this.#resetCandidateReview();
          }
          this.#publish();
        }),
      );
    }
    const address = await this.#options.server.start();
    try {
      await this.#options.writeRuntime(this.#options.runtimeFile, {
        protocolVersion: PROTOCOL_VERSION,
        port: address.port,
        token: this.#options.token,
        pid: this.#options.pid ?? process.pid,
        startedAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      });
    } catch (error) {
      if (this.#options.onRuntimeUnwritable === undefined) throw error;
      this.#options.onRuntimeUnwritable(error);
    }
    this.#started = true;
    this.#publish();
  }

  snapshot(): AppSnapshot {
    return this.#appSnapshot(this.#options.queue.snapshot());
  }

  openSurface(surface: DesktopPrimarySurface): void {
    this.#requestPrimarySurface(surface);
  }

  closePrimarySurface(): void {
    if (this.#primarySurface !== "hidden") this.#surfaceBeforeClose = this.#primarySurface;
    this.#primarySurface = "hidden";
    this.#publish();
  }

  /**
   * The app brought forward (the Dock, a second launch): a window that was closed comes back to the page
   * it was on, and one already open stays where the reader is. Sent home either way, what they were
   * writing went with the page.
   */
  reopen(): void {
    if (this.#primarySurface === "hidden" && !this.#candidateReviewSessionActive) {
      this.#requestPrimarySurface(this.#surfaceBeforeClose);
    }
  }

  openCandidateReview(): void {
    if (this.#candidateSnapshot().current === null) {
      return;
    }
    if (!this.#candidateReviewSessionActive) {
      this.#candidateReviewReturnSurface = this.#primarySurface;
    }
    this.#primarySurface = "hidden";
    this.#candidateReviewSessionActive = true;
    this.#candidateReviewOpen = true;
    this.#candidateReviewRationaleId = null;
    this.#candidateReviewProcessed = 0;
    this.#candidateReviewTotal = this.#candidateSnapshot().count;
    this.#publish();
  }

  closeCandidateReview(): void {
    this.#resetCandidateReview();
    this.#publish();
  }

  async confirmCandidate(candidateId: string): Promise<void> {
    const candidates = this.#requireCandidates();
    await this.#settleCandidate("confirm", () => candidates.promote(candidateId));
  }

  async ignoreCandidate(candidateId: string): Promise<void> {
    const candidates = this.#requireCandidates();
    await this.#settleCandidate("ignore", () => candidates.ignore(candidateId));
  }

  /** A retry that succeeds moves on as the action it retries would have: into the rationale, or to the next. */
  async retryCandidate(): Promise<void> {
    const candidates = this.#requireCandidates();
    const action = this.#failedCandidateAction;
    if (action === null) {
      throw new Error("The current decision candidate is not awaiting persistence retry");
    }
    await this.#settleCandidate(action, () => candidates.retryCurrentPersistence());
  }

  async #settleCandidate(action: "confirm" | "ignore", persist: () => Promise<void>): Promise<void> {
    this.#candidateAction = action;
    try {
      await persist();
    } catch (error) {
      if (error instanceof CandidatePersistenceError) this.#failedCandidateAction = action;
      throw error;
    } finally {
      this.#candidateAction = null;
    }
    this.#failedCandidateAction = null;
    this.#candidateReviewProcessed += 1;
    if (action === "confirm") {
      this.#candidateReviewOpen = false;
      this.#candidateReviewRationaleId =
        this.#options.queue.snapshot().current?.candidateId ?? null;
      if (this.#candidateReviewRationaleId === null) {
        this.#resetCandidateReview();
      }
    } else if (this.#requireCandidates().snapshot().current === null) {
      this.#resetCandidateReview();
    }
    this.#publish();
  }

  refresh(): void {
    this.#publish();
  }

  isStarted(): boolean {
    return this.#started;
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      // Quit while still starting: nothing to stop yet, but the window must let the quit close it.
      // Without this it cancelled that close, and every later one: the app could not be quit at all.
      this.#options.windows.prepareToQuit();
      return;
    }
    this.#started = false;
    for (const unsubscribe of this.#unsubscribes.splice(0)) {
      unsubscribe();
    }
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => this.#options.windows.prepareToQuit());
    await attempt(() => this.#options.watcher.close());
    await attempt(() => this.#options.server.stop());
    await attempt(() => this.#options.index.close());
    await attempt(() => this.#options.removeRuntime(this.#options.runtimeFile));
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Decision shutdown failed");
    }
  }

  #appSnapshot(snapshot: RationaleQueueSnapshot): AppSnapshot {
    return {
      ...snapshot,
      primarySurface: this.#primarySurface,
      dashboard: this.#options.dashboard?.() ?? {
        totalDecisions: 0,
        recorded7d: 0,
        reviewAttention: 0,
        recentDecisions: [],
      },
      candidateReviewOpen: this.#candidateReviewOpen,
      candidateReviewProgress:
        this.#candidateReviewSessionActive && this.#candidateReviewTotal > 0
          ? {
              position: Math.min(
                this.#candidateReviewProcessed + 1,
                this.#candidateReviewTotal,
              ),
              total: this.#candidateReviewTotal,
            }
          : null,
      decisionCandidates: this.#candidateSnapshot(),
      theme: this.#options.theme?.() ?? "auto",
      vaultPath: this.#options.vaultPath ?? null,
      integrationStatus: this.#options.integrationStatus?.() ?? {
        claudeCode: "unknown",
        codex: "unknown",
      },
      pendingRationales: this.#options.pendingRationales?.() ?? [],
      ...(this.#options.pendingRationaleCount === undefined
        ? {}
        : { pendingRationaleCount: this.#options.pendingRationaleCount() }),
      health: this.#options.health?.() ?? {
        index: "healthy",
        recovery: "healthy",
      },
      modelTraceContentEnabled:
        this.#options.modelTraceContentEnabled?.() ?? true,
      localCredentialsEnabled: this.#options.localCredentialsEnabled?.() ?? false,
      reviewRemindersEnabled:
        this.#options.reviewRemindersEnabled?.() ?? true,
      captureClassifier: this.#options.captureClassifier?.() ?? "rules",
      semanticRecognition: this.#options.semanticRecognition?.() ?? {
        provider: "rules",
        providerLabel: "规则识别",
        availability: "loading",
        mode: "hybrid",
        processed7d: 0,
        high7d: 0,
        medium7d: 0,
        failures7d: 0,
        updatedAt: "1970-01-01T00:00:00.000Z",
      },
    };
  }

  #candidateSnapshot(): CandidateQueueSnapshot {
    return (
      this.#options.candidates?.snapshot() ?? {
        current: null,
        count: 0,
      }
    );
  }

  #requireCandidates(): DecisionCandidateQueue {
    const candidates = this.#options.candidates;
    if (candidates === undefined) {
      throw new Error("Decision candidate queue is unavailable");
    }
    return candidates;
  }

  #requestPrimarySurface(surface: DesktopPrimarySurface): void {
    if (this.#candidateReviewSessionActive) {
      this.#candidateReviewReturnSurface = surface;
    } else {
      this.#primarySurface = surface;
    }
    this.#publish();
  }

  #resetCandidateReview(restoreSurface = true): void {
    const returnSurface = this.#candidateReviewReturnSurface;
    this.#candidateReviewSessionActive = false;
    this.#candidateReviewOpen = false;
    this.#candidateReviewRationaleId = null;
    this.#candidateReviewProcessed = 0;
    this.#candidateReviewTotal = 0;
    this.#candidateReviewReturnSurface = "dashboard";
    if (restoreSurface && this.#primarySurface === "hidden") {
      this.#primarySurface = returnSurface;
    }
  }

  #publish(): void {
    const snapshot = this.snapshot();
    this.#options.windows.publish(snapshot);
    this.#options.onSnapshot?.(snapshot);
  }
}
