import {
  PROTOCOL_VERSION,
  type RuntimeDescriptor,
  type SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import type {
  CandidateQueueSnapshot,
  DecisionCandidateQueue,
  RationaleQueue,
  RationaleQueueSnapshot,
} from "@cognelis/decision-core";

import type { ThemePreference } from "../shared/appearance.js";
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
  removeRuntime(path: string): Promise<void>;
  now?: () => Date;
  pid?: number;
  vaultPath?: string | null;
  health?: () => AppHealth;
  dashboard?: () => DashboardSnapshot;
  integrationStatus?: () => IntegrationStatus;
  pendingRationales?: () => PendingRationaleSummary[];
  semanticRecognition?: () => SemanticRecognitionStatus;
  modelTraceContentEnabled?: () => boolean;
  theme?: () => ThemePreference;
  onSnapshot?: (snapshot: AppSnapshot) => void;
}

export class AppController {
  readonly #options: AppControllerOptions;
  #started = false;
  #primarySurface: PrimarySurface = "dashboard";
  #candidateReviewReturnSurface: PrimarySurface = "dashboard";
  #candidateReviewOpen = false;
  #candidateReviewSessionActive = false;
  #candidateReviewRationaleId: string | null = null;
  #candidateReviewProcessed = 0;
  #candidateReviewTotal = 0;
  #candidateAction: "confirm" | "ignore" | null = null;
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
    await this.#options.writeRuntime(this.#options.runtimeFile, {
      protocolVersion: PROTOCOL_VERSION,
      port: address.port,
      token: this.#options.token,
      pid: this.#options.pid ?? process.pid,
      startedAt: (this.#options.now ?? (() => new Date()))().toISOString(),
    });
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
    this.#primarySurface = "hidden";
    this.#publish();
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
    this.#candidateAction = "confirm";
    try {
      await candidates.promote(candidateId);
    } finally {
      this.#candidateAction = null;
    }
    this.#candidateReviewProcessed += 1;
    this.#candidateReviewOpen = false;
    this.#candidateReviewRationaleId =
      this.#options.queue.snapshot().current?.candidateId ?? null;
    if (this.#candidateReviewRationaleId === null) {
      this.#resetCandidateReview();
    }
    this.#publish();
  }

  async ignoreCandidate(candidateId: string): Promise<void> {
    const candidates = this.#requireCandidates();
    this.#candidateAction = "ignore";
    try {
      await candidates.ignore(candidateId);
    } finally {
      this.#candidateAction = null;
    }
    this.#candidateReviewProcessed += 1;
    if (candidates.snapshot().current === null) {
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
      health: this.#options.health?.() ?? {
        index: "healthy",
        recovery: "healthy",
      },
      modelTraceContentEnabled:
        this.#options.modelTraceContentEnabled?.() ?? true,
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
