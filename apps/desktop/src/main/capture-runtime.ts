import {
  createDecisionRecord,
  DecisionCandidateQueue,
  DecisionPersistenceError,
  RationaleQueue,
  rationaleCandidateKey,
  rationaleSemanticKey,
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
} from "@cognelis/decision-storage";

import type {
  AppHealth,
  PendingRationaleSummary,
} from "../shared/renderer-api.js";

interface CaptureSpoolAcknowledger {
  append?(event: CapturedDecisionEvent): Promise<void>;
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
  rebuildIndex?(): Promise<RebuildReport>;
}

interface RationaleIndexLike {
  listByRationaleStatus?(
    status: "deferred",
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
  index?: RationaleIndexLike;
  idFactory: () => string;
  now?: () => Date;
}

type PendingDecisionRecord = ReturnType<
  typeof createDecisionRecord
>;

const CROSS_MODE_WINDOW_MS = 30 * 60 * 1_000;

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
  readonly #candidateSpool: CandidateSpoolLike | undefined;
  readonly #store: DecisionStoreLike;
  readonly #index: RationaleIndexLike | undefined;
  readonly #pendingRecords = new Map<
    string,
    PendingDecisionRecord
  >();
  readonly #deferredRationales = new Map<
    string,
    RationaleCandidate
  >();
  readonly #deferredAppliedPrincipleIds = new Map<string, string[]>();
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
  #health: AppHealth = {
    index: "healthy",
    recovery: "healthy",
  };

  constructor(options: CaptureRuntimeOptions) {
    this.#spool = options.spool;
    this.#candidateSpool = options.candidateSpool;
    this.#store = options.store;
    this.#index = options.index;
    this.queue = new RationaleQueue(options.idFactory, {
      onDisposition: async (candidate, submission) => {
        this.#candidateOccurrenceKeys.set(
          candidate.candidateId,
          candidate.candidateKey,
        );
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
        if (submission.status === "deferred") {
          this.#deferredAppliedPrincipleIds.set(
            `decision-${candidate.candidateKey}`,
            [...(submission.appliedPrincipleIds ?? [])],
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
        if (receipt.accepted === 0 && !alreadyQueued) {
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

  async ingest(
    event: CapturedDecisionEvent,
    placement: "fifo" | "priority" = "fifo",
  ): Promise<CaptureReceipt> {
    return this.#ingest(event, placement, false);
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
      if (
        await this.#restoreDeferredRationale(event, question)
      ) {
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

  async resumePendingDispositions(): Promise<void> {
    if (this.#spool.loadDisposition === undefined) {
      return;
    }
    while (true) {
      const current = this.queue.snapshot().current;
      if (
        current === null ||
        current.status !== "awaiting_rationale"
      ) {
        return;
      }
      let submission: RationaleSubmission | null;
      try {
        submission = await this.#spool.loadDisposition(
          current.event,
          current.question.questionIndex,
        );
      } catch (error) {
        if (error instanceof CaptureDispositionCorruptError) {
          this.#health = {
            ...this.#health,
            recovery: "degraded",
            recoveryMessage:
              "理由恢复日志损坏，已隔离；原始决策仍保留在待处理队列。",
          };
          return;
        }
        if (
          error instanceof CaptureDispositionQuarantineError
        ) {
          this.#health = {
            ...this.#health,
            recovery: "degraded",
            recoveryMessage:
              "理由恢复日志损坏且无法隔离；原始决策仍保留，请检查本地存储权限。",
          };
          return;
        }
        this.#health = {
          ...this.#health,
          recovery: "degraded",
          recoveryMessage:
            "理由恢复日志暂时无法读取；原始决策仍保留，请检查本地存储。",
        };
        return;
      }
      if (submission === null) {
        return;
      }
      try {
        await this.queue.submit(submission);
      } catch (error) {
        if (error instanceof DecisionPersistenceError) {
          return;
        }
        throw error;
      }
    }
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

  async #restoreDeferredRationale(
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
    if (submission?.status !== "deferred") {
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
    this.#deferredAppliedPrincipleIds.set(
      `decision-${candidate.candidateKey}`,
      [...(submission.appliedPrincipleIds ?? [])],
    );
    this.#rememberDeferredRationale(candidate);
    await this.#spool.rememberSemanticOccurrence(
      candidate.candidateKey,
      rationaleSemanticKey(event, question),
      event.captureMode,
      event.capturedAt,
    );
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
    if (submission.status !== "not_recorded") {
      let record = this.#pendingRecords.get(candidate.candidateId);
      if (record === undefined) {
        record = createDecisionRecord(
          candidate,
          submission as PersistableRationaleSubmission,
          decisionId,
          new Date(candidate.event.capturedAt),
        );
        this.#pendingRecords.set(candidate.candidateId, record);
      }
      const result = await this.#store.save(record);
      if (!result.indexed) {
        this.#health = {
          ...this.#health,
          index: "degraded",
          indexMessage:
            "Markdown 已保存，但 SQLite 索引更新失败。",
        };
      }
    }
    this.#finalizingCandidates.add(candidate.candidateId);
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
    this.#deferredRationales.delete(decisionId);
    this.#deferredAppliedPrincipleIds.delete(decisionId);
    this.#pendingRecords.delete(candidate.candidateId);
    this.#crossModeDuplicates.delete(candidate.candidateId);
    this.#finalizingCandidates.delete(candidate.candidateId);
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

  pendingRationales(): PendingRationaleSummary[] {
    const pending = new Map<string, PendingRationaleSummary>();
    try {
      for (const decision of
        this.#index?.listByRationaleStatus?.("deferred") ?? []) {
        pending.set(decision.id, {
          id: decision.id,
          question: decision.question,
          created: decision.created,
          project: decision.project,
          sourceClient: decision.sourceClient,
          selectedAnswer: decision.selectedAnswer,
          contextSummary: decision.context,
        });
      }
    } catch {
      this.reportIndexIssue(
        "SQLite 索引读取失败；Markdown 事实源和本次运行中的待补理由仍然保留。",
      );
    }
    for (const [id, candidate] of this.#deferredRationales) {
      if (!pending.has(id)) {
        pending.set(id, {
          id,
          question: candidate.question.question,
          created: candidate.event.capturedAt,
          project: candidate.event.project,
          sourceClient: candidate.event.sourceClient,
          selectedAnswer:
            candidate.question.answer.values.join("、"),
          contextSummary:
            [
              candidate.event.context?.taskBackground,
              candidate.event.context?.decisionFraming,
            ]
              .filter(
                (value): value is string => value !== undefined,
              )
              .join("\n\n") || null,
        });
      }
    }
    return [...pending.values()].sort(
      (left, right) =>
        right.created.localeCompare(left.created) ||
        right.id.localeCompare(left.id),
    );
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
        ...(this.#deferredAppliedPrincipleIds.get(id)?.length
          ? {
              appliedPrincipleIds: [
                ...(this.#deferredAppliedPrincipleIds.get(id) ?? []),
              ],
            }
          : {}),
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
          "理由已写入 Markdown，但 SQLite 索引更新失败。",
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
        ...(this.#deferredAppliedPrincipleIds.get(id)?.length
          ? {
              appliedPrincipleIds: [
                ...(this.#deferredAppliedPrincipleIds.get(id) ?? []),
              ],
            }
          : {}),
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
          "未补理由状态已写入 Markdown，但 SQLite 索引更新失败。",
      };
    }
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
          "决策笔记已删除，但 SQLite 索引清理失败；请在设置中重建索引。",
      };
    }
  }

  async rebuildIndex(): Promise<RebuildReport> {
    if (this.#store.rebuildIndex === undefined) {
      throw new Error("Index rebuild is unavailable");
    }
    const report = await this.#store.rebuildIndex();
    const {
      indexMessage: _indexMessage,
      ...healthWithoutIndexMessage
    } = this.#health;
    this.#health = {
      ...healthWithoutIndexMessage,
      index: "healthy",
    };
    return report;
  }
}
