import {
  createDecisionRecord,
  DecisionCandidateQueue,
  RationaleQueue,
  rationaleCandidateKey,
  rationaleSemanticKey,
  RecoveryQueueWriteError,
  LocalDecisionWriteError,
  type CrossModeDuplicate,
  type PersistableRationaleSubmission,
  type RationaleCandidate,
  type RationaleSubmission,
} from "@cognelis/decision-core";
import type {
  CaptureReceipt,
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
  CapturedQuestion,
} from "@cognelis/decision-protocol";
import type {
  DeferredRationaleUpdate,
  RebuildReport,
  SaveResult,
} from "@cognelis/decision-storage";
import {
  CaptureDispositionCorruptError,
  CaptureDispositionQuarantineError,
  noteProblem,
} from "@cognelis/decision-storage";
import { basename } from "node:path";

const SPOOL_UNWRITABLE =
  "决策暂时无法写入本地恢复队列：本次照常处理，但在补完理由前退出可能丢失。请检查磁盘空间与权限。";
// A submission journaled before a restart that could not be finished as it came back in: said until each is.
const DISPOSITION_RETRY =
  "已提交的记录暂时没能写入知识库、本机存储或恢复队列；捕获保留在恢复队列，下次恢复时重试。";

/** A submission by what it says: read back from its journal or sent again, each is a new object saying the same. */
const submissionText = (submission: RationaleSubmission): string =>
  JSON.stringify(Object.entries(submission).sort(([left], [right]) => (left < right ? -1 : 1)));

import type {
  AppHealth,
  PendingRationaleSummary,
} from "../shared/renderer-api.js";

interface CaptureSpoolAcknowledger {
  append?(event: CapturedDecisionEvent): Promise<void>;
  list?(): Promise<CapturedDecisionEvent[]>;
  acknowledge(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<void>;
  isAcknowledged(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<boolean>;
  saveDisposition?(
    event: CapturedDecisionEvent,
    questionIndex: number,
    submission: RationaleSubmission,
  ): Promise<void>;
  replaceDisposition?(
    event: CapturedDecisionEvent,
    questionIndex: number,
    submission: RationaleSubmission,
  ): Promise<void>;
  loadDisposition?(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<RationaleSubmission | null>;
  rememberSemanticOccurrence(
    occurrenceId: string,
    semanticKey: string,
    mode: CapturedDecisionEvent["captureMode"],
    capturedAt: string,
  ): Promise<void>;
  claimCrossModeSemantic(
    semanticKey: string,
    mode: CapturedDecisionEvent["captureMode"],
    capturedAt: string,
    maximumAgeMs: number,
    aliasCandidateKey: string,
  ): Promise<boolean>;
  claimKnownSemanticOccurrence(
    occurrenceId: string,
    aliasMode: CapturedDecisionEvent["captureMode"],
    aliasCandidateKey: string,
  ): Promise<boolean>;
  recoveryIssue?(): string | null;
}

interface CandidateSpoolLike {
  append(
    candidate: CapturedDecisionCandidate,
  ): Promise<void>;
  acknowledge(candidateId: string): Promise<void>;
  isAcknowledged?(candidateId: string): Promise<boolean>;
}

interface DecisionStoreLike {
  save(
    record: ReturnType<typeof createDecisionRecord>,
  ): Promise<SaveResult>;
  completeDeferredRationale?(
    id: string,
    input: DeferredRationaleUpdate,
  ): Promise<SaveResult>;
  skipDeferredRationale?(id: string): Promise<SaveResult>;
  deleteDeferredRationale?(id: string): Promise<SaveResult>;
  keepDeferredLocally?(id: string, local: { save(record: ReturnType<typeof createDecisionRecord>, content?: string): void }, input: { rationale?: string; reasonFactors?: string[] }): Promise<SaveResult>;
  rebuildIndex?(): Promise<RebuildReport>;
  reconcileIndex?(): Promise<RebuildReport>;
}

interface RationaleIndexLike {
  idsByRationaleStatus?(status: "deferred"): string[];
  listByRationaleStatus?(
    status: "deferred",
    limit?: number,
  ): Array<{
    id: string;
    question: string;
    created: string;
    project: string;
    sourceClient: string;
    selectedAnswer: string;
    context: string | null;
  }>;
  hasDecision?(id: string): boolean;
}

interface CaptureRuntimeOptions {
  spool: CaptureSpoolAcknowledger;
  candidateSpool?: CandidateSpoolLike;
  store: DecisionStoreLike;
  localDecisions?: { save(record: ReturnType<typeof createDecisionRecord>, content?: string): void; resolve(id: string, state: "published" | "discarded"): void; has(id: string): boolean };
  index?: RationaleIndexLike;
  idFactory: () => string;
  now?: () => Date;
}

const CROSS_MODE_WINDOW_MS = 30 * 60 * 1_000;
/** As many of the vault's waiting rationales as the home page lists; the rest are a filter away on 知识. */
const PENDING_RATIONALE_LIMIT = 50;

type DeferredKept = Pick<
  Extract<RationaleSubmission, { status: "deferred" | "skipped" }>,
  "appliedPrincipleIds" | "expectedOutcome"
>;
const keptOf = (
  submission: Extract<RationaleSubmission, { status: "deferred" | "skipped" }>,
): DeferredKept => ({
  ...(submission.appliedPrincipleIds?.length
    ? { appliedPrincipleIds: [...submission.appliedPrincipleIds] }
    : {}),
  ...(submission.expectedOutcome === undefined
    ? {}
    : { expectedOutcome: submission.expectedOutcome }),
});

const captureEventIdentity = (
  event: CapturedDecisionEvent,
): string =>
  [
    event.eventVersion,
    event.sourceClient,
    event.sessionId,
    event.batchId,
  ].join("\u0000");

export class CaptureRuntime {
  readonly queue: RationaleQueue;
  readonly candidates: DecisionCandidateQueue;
  readonly #spool: CaptureSpoolAcknowledger;
  #recovering: Promise<void> | null = null;
  readonly #candidateSpool: CandidateSpoolLike | undefined;
  readonly #store: DecisionStoreLike;
  readonly #localDecisions: CaptureRuntimeOptions["localDecisions"];
  readonly #index: RationaleIndexLike | undefined;
  readonly #deferredRationales = new Map<
    string,
    RationaleCandidate
  >();
  // What a deferral kept for when its rationale is completed or skipped: the
  // principles marked, and an expectation already written.
  readonly #deferredKept = new Map<string, DeferredKept>();
  readonly #crossModeDuplicates = new Map<
    string,
    CrossModeDuplicate[]
  >();
  readonly #disposedCandidates = new Set<string>();
  readonly #finalizingCandidates = new Set<string>();
  readonly #candidateOccurrenceKeys = new Map<string, string>();
  readonly #recoveredPromotionReceipts = new Map<
    string,
    string
  >();
  // Taken in while the recovery queue would not take them, and held only here until it does.
  readonly #unspooled = new Map<string, CapturedDecisionEvent>();
  // Notes written for a submission still being finished, by decision and by what the submission says: its receipt
  // refused, the retry does not write them again — sent anew, or read back from its journal on the way back in.
  readonly #notesWritten = new Map<string, string>();
  readonly #localWritten = new Map<string, string>();
  // Journaled submissions that could not be finished on their way back in (DISPOSITION_RETRY), by decision.
  readonly #unfinished = new Set<string>();
  #health: AppHealth = {
    index: "healthy",
    recovery: "healthy",
  };

  constructor(options: CaptureRuntimeOptions) {
    this.#spool = options.spool;
    this.#candidateSpool = options.candidateSpool;
    this.#store = options.store;
    this.#localDecisions = options.localDecisions;
    this.#index = options.index;
    this.queue = new RationaleQueue(options.idFactory, {
      onDisposition: async (candidate, submission) => {
        this.#candidateOccurrenceKeys.set(
          candidate.candidateId,
          candidate.candidateKey,
        );
        try {
          // Its event first: a disposition is read back at a start only through the event it belongs to, and
          // one taken in while the disk was full was never written. One already spooled is left as it is.
          await this.#spool.append?.(candidate.event);
          this.#unspooled.delete(captureEventIdentity(candidate.event));
          await this.#respool();
          await this.#spool.saveDisposition?.(
            candidate.event,
            candidate.question.questionIndex,
            submission,
          );
          await this.#spool.rememberSemanticOccurrence(
            candidate.candidateKey,
            rationaleSemanticKey(
              candidate.event,
              candidate.question,
            ),
            candidate.event.captureMode,
            candidate.event.capturedAt,
          );
        } catch (error) {
          // Tried again with the disk still full, the note written on the first try is in the vault: said so.
          throw new RecoveryQueueWriteError(error, this.#notesWritten.has(`decision-${candidate.candidateKey}`));
        }
        if (submission.status === "deferred") {
          this.#deferredKept.set(
            `decision-${candidate.candidateKey}`,
            keptOf(submission),
          );
          this.#rememberDeferredRationale(candidate);
          return;
        }
        await this.#finalizeRationale(candidate, submission);
      },
    });
    this.candidates = new DecisionCandidateQueue({
      ...(options.now === undefined ? {} : { now: options.now }),
      onPromote: async (candidate) => {
        if (
          this.#spool.append === undefined ||
          this.#candidateSpool === undefined
        ) {
          throw new Error(
            "Decision candidate promotion storage is unavailable",
          );
        }
        await this.#spool.append(candidate.event);
        const receipt = await this.#ingest(
          candidate.event,
          "priority",
          true,
        );
        const queuedCandidate = this.queue.snapshot().current;
        const alreadyQueued =
          queuedCandidate !== null &&
          candidate.event.questions.some(
            (question) =>
              rationaleCandidateKey(candidate.event, question) ===
              queuedCandidate.candidateKey,
          );
        // Recorded already (the same answer delivered twice): nothing is left to promote. Seen by the queue
        // and not recorded is not that, and still fails rather than taking the reader's "record" as done.
        const recorded = candidate.event.questions.every(
          (question) =>
            this.#index?.hasDecision?.(
              `decision-${rationaleCandidateKey(candidate.event, question)}`,
            ) === true,
        );
        if (receipt.accepted === 0 && !alreadyQueued && !recorded) {
          throw new Error(
            "Explicitly promoted decision candidate did not enter the rationale queue",
          );
        }
        await this.#candidateSpool.acknowledge(
          candidate.candidateId,
        );
      },
      onIgnore: async (candidate) => {
        if (this.#candidateSpool === undefined) {
          throw new Error(
            "Decision candidate acknowledgement is unavailable",
          );
        }
        await this.#candidateSpool.acknowledge(
          candidate.candidateId,
        );
      },
    });
  }

  async ingestCandidate(
    candidate: CapturedDecisionCandidate,
  ): Promise<void> {
    if (this.#candidateSpool === undefined) {
      throw new Error("Decision candidate storage is unavailable");
    }
    if (
      (await this.#candidateSpool.isAcknowledged?.(
        candidate.candidateId,
      )) === true
    ) {
      return;
    }
    await this.#candidateSpool.append(candidate);
    this.candidates.ingest(candidate);
  }

  async resumeCandidates(
    candidates: CapturedDecisionCandidate[],
    promotedEvents: CapturedDecisionEvent[] = [],
  ): Promise<void> {
    const promoted = new Set(
      promotedEvents.map(captureEventIdentity),
    );
    for (const candidate of candidates) {
      if (
        this.#candidateSpool !== undefined &&
        promoted.has(captureEventIdentity(candidate.event))
      ) {
        const eventIdentity = captureEventIdentity(
          candidate.event,
        );
        this.#recoveredPromotionReceipts.set(
          eventIdentity,
          candidate.candidateId,
        );
        try {
          await this.#candidateSpool.acknowledge(
            candidate.candidateId,
          );
          this.#recoveredPromotionReceipts.delete(eventIdentity);
        } catch {
          this.reportRecoveryIssue(
            "已提升候选的恢复回执暂时无法写入；本次启动不会重复显示该候选。",
          );
        }
        continue;
      }
      this.candidates.ingest(candidate);
    }
  }

  confirmCurrentCandidate(): Promise<void> {
    const current = this.candidates.snapshot().current;
    if (current === null) {
      return Promise.reject(
        new Error("No current decision candidate"),
      );
    }
    return this.candidates.promote(current.candidateId);
  }

  ignoreCurrentCandidate(): Promise<void> {
    const current = this.candidates.snapshot().current;
    if (current === null) {
      return Promise.reject(
        new Error("No current decision candidate"),
      );
    }
    return this.candidates.ignore(current.candidateId);
  }

  retryCurrentCandidate(): Promise<void> {
    return this.candidates.retryCurrentPersistence();
  }

  /**
   * Takes in what a hook could only spool while the app ran (too busy to prove itself in time): read at startup
   * alone, a capture waited there for the next start, days for an app that stays in the tray. One pass at a time;
   * what is queued or done already is left as it is, as at startup.
   */
  recoverSpooled(): Promise<void> {
    this.#recovering ??= (async () => {
      // Held only here since a spool write failed: written now that space may be free. The events taken in already
      // (left as they are below) once carried it along, each re-ingested with every pass.
      await this.#respool();
      for (const event of (await this.#spool.list?.().catch(() => [])) ?? []) {
        // Queued, answered or put off in this run already: taken in again with every capture that came in, each
        // was written to the spool again and its twin looked for among every semantic receipt.
        const takenIn = event.questions.every((question) => {
          const candidateKey = rationaleCandidateKey(event, question);
          return this.queue.has(candidateKey) || this.#deferredRationales.has(`decision-${candidateKey}`);
        });
        if (takenIn) continue;
        await this.ingest(event).catch(() => undefined);
      }
    })().finally(() => {
      this.#recovering = null;
    });
    return this.#recovering;
  }

  async ingest(
    event: CapturedDecisionEvent,
    placement: "fifo" | "priority" = "fifo",
  ): Promise<CaptureReceipt> {
    // On disk before anything else, as the bridge keeps a hook's capture: a decision recognised in a
    // text answer would otherwise live only in memory, and a restart, or a rationale put off until
    // one, would lose it. An event already spooled is left as it is. A disk that will not take it
    // (full, read-only) is said so and the decision is still taken in now: not a reason to lose it
    // at once, or to stop the app starting.
    this.#unspooled.set(captureEventIdentity(event), event);
    await this.#respool();
    return this.#ingest(event, placement, false);
  }

  /**
   * Writes every event the recovery queue would not take, and says so until all of them are written: one
   * written once space is freed said nothing of one before it still held only in memory, and the warning
   * went while that one could still be lost.
   */
  async #respool(): Promise<void> {
    for (const [identity, event] of this.#unspooled) {
      try {
        await this.#spool.append?.(event);
        this.#unspooled.delete(identity);
      } catch {
        // Still held only here: tried again with the next capture or disposition.
      }
    }
    if (this.#unspooled.size > 0) {
      this.reportRecoveryIssue(SPOOL_UNWRITABLE);
    } else if (this.#health.recoveryMessage === SPOOL_UNWRITABLE) {
      // All written (space freed, a permission fixed): the warning this path raised goes, and only it.
      const { recoveryMessage: _recoveryMessage, ...healthWithoutRecoveryMessage } = this.#health;
      this.#health = { ...healthWithoutRecoveryMessage, recovery: "healthy" };
    }
  }

  async #ingest(
    event: CapturedDecisionEvent,
    placement: "fifo" | "priority",
    explicitPromotion: boolean,
  ): Promise<CaptureReceipt> {
    await this.#acknowledgeRecoveredPromotion(event);
    let persistedDuplicates = 0;
    const pendingQuestions = [];
    for (const question of event.questions) {
      const candidateKey = rationaleCandidateKey(
        event,
        question,
      );
      let isAcknowledged: boolean;
      try {
        isAcknowledged =
          await this.#spool.isAcknowledged(
            event,
            question.questionIndex,
          );
      } catch {
        this.reportRecoveryIssue(
          this.#spool.recoveryIssue?.() ??
            "捕获确认回执暂时无法读取；状态未知的问题仍保留在待处理队列。",
        );
        continue;
      }
      if (isAcknowledged && !explicitPromotion) {
        persistedDuplicates += 1;
        continue;
      }
      const recordId = `decision-${candidateKey}`;
      const semanticKey = rationaleSemanticKey(event, question);
      const isExactReplay =
        this.#index?.hasDecision?.(recordId) === true;
      if (isExactReplay) {
        await this.#spool.acknowledge(
          event,
          question.questionIndex,
        );
        persistedDuplicates += 1;
        continue;
      }
      // Put off, and listed on the home page until its rationale is written: being written now, or refused by
      // the vault a moment ago, its disposition already says "captured" while its note is not there. Taken for a
      // new question, it was asked again, and the answer wrote the whole note over the rationale just given.
      if (this.#deferredRationales.has(recordId)) {
        persistedDuplicates += 1;
        continue;
      }
      if (await this.#restoreDisposition(event, question)) {
        persistedDuplicates += 1;
        continue;
      }
      let isPersistedCrossModeReplay = false;
      if (!explicitPromotion) {
        try {
          isPersistedCrossModeReplay =
            await this.#spool.claimCrossModeSemantic(
              semanticKey,
              event.captureMode,
              event.capturedAt,
              CROSS_MODE_WINDOW_MS,
              candidateKey,
            );
        } finally {
          this.reportRecoveryIssue(
            this.#spool.recoveryIssue?.() ?? null,
          );
        }
      }
      if (isPersistedCrossModeReplay) {
        await this.#spool.acknowledge(
          event,
          question.questionIndex,
        );
        persistedDuplicates += 1;
      } else {
        pendingQuestions.push(question);
      }
    }
    if (pendingQuestions.length === 0) {
      return {
        accepted: 0,
        duplicates: persistedDuplicates,
      };
    }
    const pendingEvent = {
      ...event,
      questions: pendingQuestions,
    };
    const result =
      placement === "priority"
        ? this.queue.ingestPrioritizedDetailed(pendingEvent)
        : this.queue.ingestDetailed(pendingEvent);
    for (const duplicate of result.crossModeDuplicates) {
      if (
        this.#disposedCandidates.has(
          duplicate.primaryCandidateId,
        ) ||
        this.#finalizingCandidates.has(
          duplicate.primaryCandidateId,
        )
      ) {
        const occurrenceId = this.#candidateOccurrenceKeys.get(
          duplicate.primaryCandidateId,
        );
        if (occurrenceId === undefined) {
          throw new Error(
            "Semantic occurrence is unavailable for alias acknowledgement",
          );
        }
        let claimed: boolean;
        try {
          claimed =
            await this.#spool.claimKnownSemanticOccurrence(
              occurrenceId,
              duplicate.event.captureMode,
              rationaleCandidateKey(
                duplicate.event,
                duplicate.question,
              ),
            );
        } finally {
          this.reportRecoveryIssue(
            this.#spool.recoveryIssue?.() ?? null,
          );
        }
        if (!claimed) {
          throw new Error(
            "Semantic occurrence was already claimed by another alias",
          );
        }
        await this.#spool.acknowledge(
          duplicate.event,
          duplicate.question.questionIndex,
        );
        continue;
      }
      const duplicates =
        this.#crossModeDuplicates.get(
          duplicate.primaryCandidateId,
        ) ?? [];
      duplicates.push(duplicate);
      this.#crossModeDuplicates.set(
        duplicate.primaryCandidateId,
        duplicates,
      );
    }
    return {
      accepted: result.receipt.accepted,
      duplicates:
        result.receipt.duplicates + persistedDuplicates,
    };
  }

  health(): AppHealth {
    return { ...this.#health };
  }

  reportRecoveryIssue(message: string | null): void {
    if (message === null) {
      return;
    }
    this.#health = {
      ...this.#health,
      recovery: "degraded",
      recoveryMessage: message,
    };
  }

  reportIndexIssue(message: string): void {
    this.#health = {
      ...this.#health,
      index: "degraded",
      indexMessage: message,
    };
  }

  /**
   * A disposition the spool holds for this question, applied. Put off: kept as such and listed on the home page.
   * Answered or skipped, with the note not written or the receipt not taken before a quit: finished here as the
   * answer would have been, note and receipts, and the reader not asked again. (Handed at a start to whatever was
   * current then, a rationale for the capture behind another, or for one the ten-minute recovery took in, was never
   * applied, and the reader typed it again.) One that cannot be finished now stays in the spool, said, for the next
   * pass.
   */
  async #restoreDisposition(
    event: CapturedDecisionEvent,
    question: CapturedQuestion,
  ): Promise<boolean> {
    if (this.#spool.loadDisposition === undefined) {
      return false;
    }
    let submission: RationaleSubmission | null;
    try {
      submission = await this.#spool.loadDisposition(
        event,
        question.questionIndex,
      );
    } catch (error) {
      if (error instanceof CaptureDispositionCorruptError) {
        this.#health = {
          ...this.#health,
          recovery: "degraded",
          recoveryMessage:
            "理由恢复日志损坏，已隔离；原始决策仍保留在待处理队列。",
        };
        return false;
      }
      if (error instanceof CaptureDispositionQuarantineError) {
        this.#health = {
          ...this.#health,
          recovery: "degraded",
          recoveryMessage:
            "理由恢复日志损坏且无法隔离；原始决策仍保留，请检查本地存储权限。",
        };
        return false;
      }
      this.#health = {
        ...this.#health,
        recovery: "degraded",
        recoveryMessage:
          "理由恢复日志暂时无法读取；原始决策仍保留，请检查本地存储。",
      };
      return false;
    }
    if (submission === null) {
      return false;
    }
    const candidateKey = rationaleCandidateKey(event, question);
    const candidate: RationaleCandidate = {
      status: "completed",
      candidateId: `decision-${candidateKey}`,
      candidateKey,
      event,
      question,
    };
    this.#candidateOccurrenceKeys.set(
      candidate.candidateId,
      candidate.candidateKey,
    );
    await this.#spool.rememberSemanticOccurrence(
      candidate.candidateKey,
      rationaleSemanticKey(event, question),
      event.captureMode,
      event.capturedAt,
    );
    if (submission.status === "deferred" && this.#localDecisions?.has(candidate.candidateId)) {
      // Older deferred journals can outlive a transfer to local storage; never offer that choice again.
      await this.#spool.acknowledge(event, question.questionIndex);
      return true;
    }
    if (submission.status === "deferred") {
      this.#deferredKept.set(candidate.candidateId, keptOf(submission));
      this.#rememberDeferredRationale(candidate);
      return true;
    }
    try {
      await this.#finalizeRationale(candidate, submission);
    } catch {
      this.#unfinished.add(candidate.candidateId);
      this.reportRecoveryIssue(DISPOSITION_RETRY);
    }
    return true;
  }

  #rememberDeferredRationale(candidate: RationaleCandidate): void {
    this.#deferredRationales.set(
      `decision-${candidate.candidateKey}`,
      candidate,
    );
  }

  async #finalizeRationale(
    candidate: RationaleCandidate,
    submission: RationaleSubmission,
  ): Promise<void> {
    if (submission.status === "deferred") {
      throw new Error(
        "A deferred rationale cannot be finalized before completion",
      );
    }
    const decisionId = `decision-${candidate.candidateKey}`;
    // Written once for a submission: tried again after its receipt was refused (a full disk beside a vault with
    // room), the note is not written over what the reader changed in Obsidian meanwhile, and what fails again is
    // said as the recovery queue, not Obsidian.
    if (submission.status === "local_only" && this.#localWritten.get(decisionId) !== submissionText(submission)) {
      if (!this.#localDecisions) throw new LocalDecisionWriteError(new Error("本机记录存储不可用。"));
      const status = submission.rationale || submission.reasonFactors?.length || submission.appliedPrincipleIds?.length ? "captured" : "skipped";
      try { this.#localDecisions.save(createDecisionRecord(candidate, { ...submission, status }, decisionId, new Date(candidate.event.capturedAt))); }
      catch (error) { throw new LocalDecisionWriteError(error); }
      this.#localWritten.set(decisionId, submissionText(submission));
    }
    if (submission.status !== "local_only" && submission.status !== "not_recorded" && this.#notesWritten.get(decisionId) !== submissionText(submission)) {
      // Built from this submission every time, never kept from an earlier try: a save that failed and
      // is tried again with other words, or skipped instead, writes what was given now.
      const record = createDecisionRecord(
        candidate,
        submission as PersistableRationaleSubmission,
        decisionId,
        new Date(candidate.event.capturedAt),
      );
      const result = await this.#store.save(record);
      this.#notesWritten.set(decisionId, submissionText(submission));
      if (!result.indexed) {
        this.#health = {
          ...this.#health,
          index: "degraded",
          indexMessage:
            "Markdown 已保存，但决策索引更新失败。",
        };
      }
    }
    if (submission.status !== "local_only") this.#localDecisions?.resolve(decisionId, submission.status === "not_recorded" ? "discarded" : "published");
    this.#finalizingCandidates.add(candidate.candidateId);
    try {
      await this.#acknowledgeRecoveredPromotion(candidate.event);
      for (const duplicate of
        this.#crossModeDuplicates.get(candidate.candidateId) ?? []) {
        let claimed: boolean;
        try {
          claimed = await this.#spool.claimKnownSemanticOccurrence(
            candidate.candidateKey,
            duplicate.event.captureMode,
            rationaleCandidateKey(
              duplicate.event,
              duplicate.question,
            ),
          );
        } finally {
          this.reportRecoveryIssue(
            this.#spool.recoveryIssue?.() ?? null,
          );
        }
        if (!claimed) {
          throw new Error(
            "Semantic occurrence was already claimed by another alias",
          );
        }
        await this.#spool.acknowledge(
          duplicate.event,
          duplicate.question.questionIndex,
        );
      }
      await this.#spool.acknowledge(
        candidate.event,
        candidate.question.questionIndex,
      );
    } catch (error) {
      throw new RecoveryQueueWriteError(error, submission.status !== "not_recorded" && submission.status !== "local_only");
    }
    this.#deferredRationales.delete(decisionId);
    this.#deferredKept.delete(decisionId);
    this.#crossModeDuplicates.delete(candidate.candidateId);
    this.#finalizingCandidates.delete(candidate.candidateId);
    this.#notesWritten.delete(decisionId);
    this.#localWritten.delete(decisionId);
    // Finished at a later pass: the warning that it would be tried again goes once none is left to try.
    this.#unfinished.delete(decisionId);
    if (this.#unfinished.size === 0 && this.#health.recoveryMessage === DISPOSITION_RETRY) {
      const { recoveryMessage: _recoveryMessage, ...healthWithoutRecoveryMessage } = this.#health;
      this.#health = { ...healthWithoutRecoveryMessage, recovery: "healthy" };
    }
    this.#disposedCandidates.add(candidate.candidateId);
    const cleanup = setTimeout(() => {
      this.#disposedCandidates.delete(candidate.candidateId);
      this.#candidateOccurrenceKeys.delete(candidate.candidateId);
    }, CROSS_MODE_WINDOW_MS);
    cleanup.unref();
  }

  async #acknowledgeRecoveredPromotion(
    event: CapturedDecisionEvent,
  ): Promise<void> {
    const eventIdentity = captureEventIdentity(event);
    const candidateId =
      this.#recoveredPromotionReceipts.get(eventIdentity);
    if (
      candidateId === undefined ||
      this.#candidateSpool === undefined
    ) {
      return;
    }
    await this.#candidateSpool.acknowledge(candidateId);
    this.#recoveredPromotionReceipts.delete(eventIdentity);
  }

  /**
   * The decisions whose rationale waits, as the home page lists them: at most `limit`, those put off in a capture
   * and held in the capture spool alone (found nowhere else) first, then the vault's newest, the rest being a
   * filter away on the knowledge page. Every snapshot carried every one of the spool's with its context,
   * megabytes on every push with a backlog of thousands. How many wait in all is pendingRationaleCount.
   */
  pendingRationales(limit = PENDING_RATIONALE_LIMIT): PendingRationaleSummary[] {
    const pending = new Map<string, PendingRationaleSummary>();
    try {
      for (const decision of
        this.#index?.listByRationaleStatus?.("deferred", limit) ?? []) {
        pending.set(decision.id, {
          id: decision.id,
          question: decision.question,
          created: decision.created,
          project: decision.project,
          sourceClient: decision.sourceClient,
          selectedAnswer: decision.selectedAnswer,
          contextSummary: decision.context,
          capturedQuestion: null,
        });
      }
    } catch {
      this.reportIndexIssue(
        "决策索引读取失败；Markdown 事实源和本次运行中的待补理由仍然保留。",
      );
    }
    for (const [id, candidate] of this.#deferredRationales) {
      const existing = pending.get(id);
      const capturedContext = [
        candidate.event.context?.taskBackground,
        candidate.event.context?.decisionFraming,
      ]
        .filter((value): value is string => value !== undefined)
        .join("\n\n");
      pending.set(id, {
        id,
        question: candidate.question.question,
        created: candidate.event.capturedAt,
        project: candidate.event.project,
        sourceClient: candidate.event.sourceClient,
        selectedAnswer:
          candidate.question.answer.values.join("、"),
        contextSummary:
          capturedContext.length > 0
            ? capturedContext
            : (existing?.contextSummary ?? null),
        capturedQuestion: candidate.question,
        // Held here alone, no note yet: the home page said it was recorded and would be taken out of Obsidian.
        ...(this.#heldAlone(id) ? { inVault: false as const } : {}),
      });
    }
    // The spool's own first: listed past the newest few of the vault's, they were found nowhere until then.
    return [...pending.values()]
      .sort(
        (left, right) =>
          Number(right.inVault === false) - Number(left.inVault === false) ||
          right.created.localeCompare(left.created) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, limit);
  }

  // Whether the vault has no note of it yet. An index that cannot be read says nothing either way (the read above
  // said so): asked outright, it took the whole snapshot down, and with it the home page, the sidebar and the tray.
  #heldAlone(id: string): boolean {
    try {
      return this.#index?.hasDecision?.(id) !== true;
    } catch {
      return false;
    }
  }

  /** How many decisions wait for a rationale in all, counted by identifier alone. */
  pendingRationaleCount(): number {
    const waiting = new Set(this.#deferredRationales.keys());
    try {
      for (const id of this.#index?.idsByRationaleStatus?.("deferred") ?? []) waiting.add(id);
    } catch {
      // Said by pendingRationales, read for the same snapshot.
    }
    return waiting.size;
  }

  async completeDeferredRationale(
    id: string,
    input: DeferredRationaleUpdate,
  ): Promise<void> {
    const local = this.#deferredRationales.get(id);
    if (local !== undefined) {
      if (this.#spool.replaceDisposition === undefined) {
        throw new Error(
          "Local deferred rationale completion is unavailable",
        );
      }
      const submission: RationaleSubmission = {
        status: "captured",
        rationale: input.rationale,
        ...(input.reasonFactors === undefined
          ? {}
          : { reasonFactors: [...input.reasonFactors] }),
        ...this.#deferredKept.get(id),
      };
      await this.#spool.replaceDisposition(
        local.event,
        local.question.questionIndex,
        submission,
      );
      await this.#finalizeRationale(local, submission);
      return;
    }
    if (this.#store.completeDeferredRationale === undefined) {
      throw new Error("Deferred rationale completion is unavailable");
    }
    const result = await this.#store.completeDeferredRationale(id, input);
    if (!result.indexed) {
      this.#health = {
        ...this.#health,
        index: "degraded",
        indexMessage:
          "理由已写入 Markdown，但决策索引更新失败。",
      };
    }
  }

  async skipDeferredRationale(id: string): Promise<void> {
    const local = this.#deferredRationales.get(id);
    if (local !== undefined) {
      if (this.#spool.replaceDisposition === undefined) {
        throw new Error(
          "Local deferred rationale resolution is unavailable",
        );
      }
      const submission: RationaleSubmission = {
        status: "skipped",
        ...this.#deferredKept.get(id),
      };
      await this.#spool.replaceDisposition(
        local.event,
        local.question.questionIndex,
        submission,
      );
      await this.#finalizeRationale(local, submission);
      return;
    }
    if (this.#store.skipDeferredRationale === undefined) {
      throw new Error("Deferred rationale skipping is unavailable");
    }
    const result = await this.#store.skipDeferredRationale(id);
    if (!result.indexed) {
      this.#health = {
        ...this.#health,
        index: "degraded",
        indexMessage:
          "未补理由状态已写入 Markdown，但决策索引更新失败。",
      };
    }
  }

  async keepLocalRationale(id: string, input: { rationale?: string; reasonFactors?: string[] }): Promise<void> {
    const candidate = this.#deferredRationales.get(id);
    if (candidate) {
      if (!this.#spool.replaceDisposition) throw new Error("本机记录处置不可用。");
      const submission: RationaleSubmission = { status: "local_only", ...input, ...this.#deferredKept.get(id) };
      if (!this.#heldAlone(id) && this.#localWritten.get(id) !== submissionText(submission)) {
        if (!this.#localDecisions || !this.#store.keepDeferredLocally) throw new Error("本机记录存储不可用。");
        const result = await this.#store.keepDeferredLocally(id, this.#localDecisions, input);
        this.#localWritten.set(id, submissionText(submission));
        if (!result.indexed) this.reportIndexIssue("已转为本机记录，但索引清理失败，请重建索引。");
      }
      await this.#spool.replaceDisposition(candidate.event, candidate.question.questionIndex, submission);
      await this.#finalizeRationale(candidate, submission);
      return;
    }
    if (!this.#localDecisions || !this.#store.keepDeferredLocally) throw new Error("本机记录存储不可用。");
    const result = await this.#store.keepDeferredLocally(id, this.#localDecisions, input);
    if (!result.indexed) this.reportIndexIssue("已转为本机记录，但索引清理失败，请重建索引。");
  }

  async discardDeferredRationale(id: string): Promise<void> {
    const local = this.#deferredRationales.get(id);
    if (local !== undefined) {
      if (this.#spool.replaceDisposition === undefined) {
        throw new Error(
          "Local deferred rationale discard is unavailable",
        );
      }
      const submission: RationaleSubmission = {
        status: "not_recorded",
      };
      await this.#spool.replaceDisposition(
        local.event,
        local.question.questionIndex,
        submission,
      );
      await this.#finalizeRationale(local, submission);
      return;
    }
    if (this.#store.deleteDeferredRationale === undefined) {
      throw new Error("Deferred rationale deletion is unavailable");
    }
    const result = await this.#store.deleteDeferredRationale(id);
    if (!result.indexed) {
      this.#health = {
        ...this.#health,
        index: "degraded",
        indexMessage:
          "决策笔记已删除，但决策索引清理失败；请在设置中重建决策索引。",
      };
    }
  }

  /** `reconcile`: as at a start, only notes changed since are read in again; otherwise the whole vault is. */
  async rebuildIndex(mode: "rebuild" | "reconcile" = "rebuild"): Promise<RebuildReport> {
    if (this.#store.rebuildIndex === undefined) {
      throw new Error("Index rebuild is unavailable");
    }
    const report = mode === "reconcile" && this.#store.reconcileIndex !== undefined
      ? await this.#store.reconcileIndex()
      : await this.#store.rebuildIndex();
    const {
      indexMessage: _indexMessage,
      ...healthWithoutIndexMessage
    } = this.#health;
    // A note the index could not read, a folder it could not list, a note iCloud moved off this Mac, two notes
    // with one id: each is said, in its own words, not reset to healthy. The folder's and the moved note's
    // decisions stay as last read (stillThere): called left out of the list, they were not.
    const issues = report.diagnostics.map((diagnostic) => `${basename(diagnostic.path)}（${noteProblem(diagnostic.message)}）`);
    this.#health = issues.length === 0
      ? { ...healthWithoutIndexMessage, index: "healthy" }
      : {
          ...healthWithoutIndexMessage,
          index: "degraded",
          indexMessage: `${issues.length} 处决策笔记这次没能读取：${issues.slice(0, 3).join("；")}${issues.length > 3 ? " 等" : ""}。所在文件夹读不了或被 iCloud 移到云端的，列表里仍是上次读到的内容；其余的不在列表里。在 Obsidian 中处理后，可以重建索引。`,
        };
    return report;
  }
}
