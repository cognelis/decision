import {
  captureReceiptSchema,
  capturedDecisionEventSchema,
  type CaptureReceipt,
  type CapturedDecisionEvent,
  type CapturedQuestion,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

export type RationaleSubmission =
  | {
      status: "captured";
      rationale?: string;
      reasonFactors?: string[];
      appliedPrincipleIds?: string[];
      /** Written while the choice is fresh, before any outcome can colour it. */
      expectedOutcome?: string;
    }
  | {
      status: "deferred" | "skipped";
      appliedPrincipleIds?: string[];
      /** Already written when the rationale was put off or skipped: kept, as fresh as it was. */
      expectedOutcome?: string;
    }
  | { status: "local_only"; rationale?: string; reasonFactors?: string[]; appliedPrincipleIds?: string[]; expectedOutcome?: string }
  | { status: "not_recorded" };

export interface RationaleCandidate {
  status: "awaiting_rationale" | "completed";
  candidateId: string;
  event: CapturedDecisionEvent;
  question: CapturedQuestion;
  candidateKey: string;
}

export interface RationaleQueueSnapshot {
  current: RationaleCandidate | null;
  waitingCount: number;
  persistenceStatus?: "saving" | "failed";
  /** Where a failed save failed: the vault, or the app's own recovery queue on this machine. */
  persistenceFailure?: DecisionPersistenceError["store"];
}

export interface CrossModeDuplicate {
  primaryCandidateId: string;
  event: CapturedDecisionEvent;
  question: CapturedQuestion;
}

export interface RationaleIngestResult {
  receipt: CaptureReceipt;
  crossModeDuplicates: CrossModeDuplicate[];
}

export interface RationaleQueueOptions {
  onDisposition?: (
    candidate: RationaleCandidate,
    submission: RationaleSubmission,
  ) => void | Promise<void>;
}

type IdFactory = () => string;
type IngestPlacement = "fifo" | "priority";
const CROSS_MODE_WINDOW_MS = 30 * 60 * 1_000;

interface SemanticOccurrence {
  candidate: RationaleCandidate;
  capturedAt: number;
}

const normalize = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();

export const rationaleCandidateKey = (
  event: CapturedDecisionEvent,
  question: CapturedQuestion,
): string => {
  const stableIdentity =
    event.captureMode === "transcript"
      ? event.batchId
      : event.toolUseId ?? event.sourceEventId;
  const material =
    stableIdentity === undefined
      ? [
          event.sourceClient,
          event.sessionId,
          event.turnId ?? "",
          normalize(question.question),
          question.answer.values.map(normalize).join("\u001f"),
        ]
      : [
          event.sourceClient,
          event.sessionId,
          stableIdentity,
          String(question.questionIndex),
        ];
  return createHash("sha256")
    .update(JSON.stringify(material), "utf8")
    .digest("hex");
};

export const rationaleSemanticKey = (
  event: CapturedDecisionEvent,
  question: CapturedQuestion,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        event.sourceClient,
        event.sessionId,
        normalize(question.question),
        question.answer.values
          .map(normalize)
          .sort()
          .join("\u001f"),
      ]),
      "utf8",
    )
    .digest("hex");

/**
 * A file system refusal in words, naming the folder and never a temporary file in it: Node's own line ("ENOSPC: no
 * space left on device, open '…/principle-1-….md.4242.….tmp'") reached the page and the agent as it was, from every
 * write but a capture's. Null for anything else, which is said as it is.
 */
export const fileSystemRefusal = (cause: unknown): string | null => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  const path = "path" in cause && typeof cause.path === "string" ? cause.path : null;
  const syscall = "syscall" in cause ? cause.syscall : undefined;
  // Held open for a moment (Obsidian, a sync client, an antivirus scan: Windows refuses the rename or unlink with
  // EPERM or EBUSY, which renameReplacing retries a little): the folder's permissions are not the trouble, and a
  // reader sent to check them went the wrong way.
  if ((syscall === "rename" || syscall === "unlink") && (cause.code === "EPERM" || cause.code === "EBUSY")) {
    return "文件正被其它程序占用（如 Obsidian、同步或杀毒软件），请稍后再试";
  }
  const making = syscall === "mkdir";
  // A file's own folder (a note, its temporary copy), or the folder it is in.
  let folder = path === null ? null : making || /\.[^./\\]+$/u.test(basename(path)) ? dirname(path) : path;
  // A folder it could not make, in the nearest one there: a recursive mkdir names the whole path it was asked for
  // (decisions/2026/10, where decisions was the one refused).
  while (making && folder !== null && folder !== dirname(folder) && !existsSync(folder)) folder = dirname(folder);
  switch (String(cause.code)) {
    case "EACCES":
    case "EPERM":
      // Read or written: a folder it may not list (the preferences) is refused the same way.
      return `没有访问${folder === null ? "这个文件夹" : ` ${folder} `}的权限，请检查它的权限设置`;
    case "EROFS":
      return `${folder === null ? "要写入的文件夹" : `${folder} `}所在的磁盘是只读的`;
    case "ENOSPC":
    case "EDQUOT":
      return `磁盘空间不足${folder === null ? "" : `，没能写入 ${folder}`}，请清理出空间后再试`;
    default:
      return null;
  }
};

/** A file system refusal in words: "EACCES: permission denied, mkdir '…'" told the reader nothing to do. */
const persistenceReason = (cause: unknown, place = "仓库"): string => {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (code === "EACCES" || code === "EPERM") return `没有写入${place}目录的权限，请检查它的权限设置`;
  if (code === "EROFS") return `${place}所在的磁盘是只读的`;
  if (code === "ENOSPC" || code === "EDQUOT") return "磁盘空间不足";
  return cause instanceof Error ? cause.message : String(cause);
};

/**
 * A save that failed in the app's own recovery queue on this machine, not in the vault, and whether the note
 * was written before it: every failure was said to be Obsidian's, a note already written included.
 */
export class RecoveryQueueWriteError extends Error {
  constructor(cause: unknown, noteWritten: boolean) {
    const reason = persistenceReason(cause, "本机数据");
    super(noteWritten ? `决策已写入 Obsidian，但本机恢复队列没能更新：${reason}` : `决策没能写入本机恢复队列：${reason}`, { cause });
    this.name = "RecoveryQueueWriteError";
  }
}

export class LocalDecisionWriteError extends Error {
  constructor(cause: unknown) { super(`本机记录没能保存：${persistenceReason(cause)}`, { cause }); this.name = "LocalDecisionWriteError"; }
}

export class DecisionPersistenceError extends Error {
  readonly store: "vault" | "recovery_queue" | "local";

  constructor(cause: unknown) {
    super(
      cause instanceof RecoveryQueueWriteError || cause instanceof LocalDecisionWriteError ? cause.message : `决策没能写入 Obsidian：${persistenceReason(cause)}`,
      { cause },
    );
    this.name = "DecisionPersistenceError";
    this.store = cause instanceof RecoveryQueueWriteError ? "recovery_queue" : cause instanceof LocalDecisionWriteError ? "local" : "vault";
  }
}

export class RationaleQueue {
  readonly #waiting: RationaleCandidate[] = [];
  readonly #seen = new Set<string>();
  readonly #semanticOccurrences = new Map<
    string,
    SemanticOccurrence[]
  >();
  readonly #subscribers = new Set<
    (snapshot: RationaleQueueSnapshot) => void
  >();
  readonly #idFactory: IdFactory;
  readonly #onDisposition:
    | RationaleQueueOptions["onDisposition"]
    | undefined;
  #current: RationaleCandidate | null = null;
  #currentSubmission: RationaleSubmission | null = null;
  #persistenceFailed = false;
  #persistenceFailure: DecisionPersistenceError["store"] = "vault";

  constructor(
    idFactory: IdFactory = randomUUID,
    options: RationaleQueueOptions = {},
  ) {
    this.#idFactory = idFactory;
    this.#onDisposition = options.onDisposition;
  }

  ingest(input: CapturedDecisionEvent): CaptureReceipt {
    return this.#ingestDetailed(input, "fifo").receipt;
  }

  ingestDetailed(
    input: CapturedDecisionEvent,
  ): RationaleIngestResult {
    return this.#ingestDetailed(input, "fifo");
  }

  ingestPrioritized(
    input: CapturedDecisionEvent,
  ): CaptureReceipt {
    return this.ingestPrioritizedDetailed(input).receipt;
  }

  ingestPrioritizedDetailed(
    input: CapturedDecisionEvent,
  ): RationaleIngestResult {
    return this.#ingestDetailed(input, "priority");
  }

  #ingestDetailed(
    input: CapturedDecisionEvent,
    placement: IngestPlacement,
  ): RationaleIngestResult {
    const event = capturedDecisionEventSchema.parse(input);
    let accepted = 0;
    let duplicates = 0;
    const crossModeDuplicates: CrossModeDuplicate[] = [];
    const acceptedCandidates: RationaleCandidate[] = [];
    const questions = [...event.questions].sort(
      (left, right) => left.questionIndex - right.questionIndex,
    );

    for (const question of questions) {
      const candidateKey = rationaleCandidateKey(event, question);
      if (this.#seen.has(candidateKey)) {
        duplicates += 1;
        continue;
      }
      this.#seen.add(candidateKey);
      const semanticKey = rationaleSemanticKey(event, question);
      const primary = this.#takeCrossModeOccurrence(
        semanticKey,
        event,
      );
      if (primary !== null) {
        const promoted =
          event.captureMode === "structured_tool" &&
          primary.event.captureMode === "transcript" &&
          primary.status === "awaiting_rationale"
            ? this.#promoteCandidate(
                primary,
                event,
                question,
                candidateKey,
              )
            : primary;
        const duplicate =
          promoted === primary
            ? { event, question }
            : {
                event: primary.event,
                question: primary.question,
              };
        crossModeDuplicates.push({
          primaryCandidateId: promoted.candidateId,
          ...duplicate,
        });
        duplicates += 1;
        continue;
      }
      const candidate: RationaleCandidate = {
        status: "awaiting_rationale",
        candidateId: this.#idFactory(),
        event,
        question,
        candidateKey,
      };
      acceptedCandidates.push(candidate);
      this.#rememberSemanticOccurrence(
        semanticKey,
        candidate,
      );
      accepted += 1;
    }

    if (
      placement === "priority" &&
      acceptedCandidates.length > 0
    ) {
      if (this.#current?.status === "awaiting_rationale") {
        this.#waiting.unshift(this.#current);
        this.#current = null;
      }
      this.#waiting.unshift(...acceptedCandidates);
    } else {
      this.#waiting.push(...acceptedCandidates);
    }
    this.#advance();
    this.#publish();
    return {
      receipt: captureReceiptSchema.parse({
        accepted,
        duplicates,
      }),
      crossModeDuplicates,
    };
  }

  submit(submission: RationaleSubmission): Promise<void> {
    const current = this.#requireCurrent();
    if (current.status !== "awaiting_rationale") {
      return Promise.reject(
        new Error("The current rationale is awaiting persistence retry"),
      );
    }
    this.#validateSubmission(submission);
    this.#current = { ...current, status: "completed" };
    this.#replaceSemanticCandidate(current, this.#current);
    this.#currentSubmission = submission;
    this.#persistenceFailed = false;
    return this.#persist();
  }

  retryCurrentPersistence(): Promise<void> {
    if (
      this.#current === null ||
      this.#current.status !== "completed" ||
      this.#currentSubmission === null ||
      !this.#persistenceFailed
    ) {
      return Promise.reject(
        new Error("The current decision is not awaiting persistence retry"),
      );
    }
    this.#persistenceFailed = false;
    return this.#persist();
  }

  /** Whether a question was taken in, queued still or disposed of since: brought again, it is a duplicate. */
  has(candidateKey: string): boolean {
    return this.#seen.has(candidateKey);
  }

  snapshot(): RationaleQueueSnapshot {
    return {
      current: this.#current,
      waitingCount: this.#waiting.length,
      ...(this.#persistenceFailed
        ? { persistenceStatus: "failed" as const, persistenceFailure: this.#persistenceFailure }
        : this.#current?.status === "completed"
          ? { persistenceStatus: "saving" as const }
          : {}),
    };
  }

  subscribe(
    subscriber: (snapshot: RationaleQueueSnapshot) => void,
  ): () => void {
    this.#subscribers.add(subscriber);
    subscriber(this.snapshot());
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  #validateSubmission(submission: RationaleSubmission): void {
    const appliedPrincipleIds =
      "appliedPrincipleIds" in submission
        ? (submission.appliedPrincipleIds ?? [])
        : [];
    if (
      appliedPrincipleIds.length > 5 ||
      new Set(appliedPrincipleIds).size !== appliedPrincipleIds.length ||
      appliedPrincipleIds.some(
        (id) =>
          id.trim().length === 0 || id !== id.trim() || id.length > 200,
      )
    ) {
      throw new Error("Applied principle IDs are invalid");
    }
    const expected = "expectedOutcome" in submission ? submission.expectedOutcome : undefined;
    if (
      expected !== undefined &&
      (expected.trim().length === 0 || expected.length > 4_000)
    ) {
      throw new Error("An expected outcome needs 1 to 4000 characters");
    }
    if (submission.status !== "captured" && submission.status !== "local_only") {
      return;
    }
    const rationale = submission.rationale;
    const factorCount = submission.reasonFactors?.length ?? 0;
    if (
      (submission.status === "captured" && rationale === undefined &&
        factorCount === 0 &&
        appliedPrincipleIds.length === 0) ||
      (rationale !== undefined &&
        (rationale.trim().length === 0 ||
          rationale.length > 8_000))
    ) {
      throw new Error(
        "A rationale needs text, a structured factor, or an applied principle",
      );
    }
    if (factorCount > 8) {
      throw new Error("At most 8 rationale factors are allowed");
    }
  }

  #requireCurrent(): RationaleCandidate {
    if (this.#current === null) {
      throw new Error("No current rationale candidate");
    }
    return this.#current;
  }

  #persist(): Promise<void> {
    const current = this.#requireCurrent();
    const submission = this.#currentSubmission;
    if (submission === null) {
      return Promise.reject(new Error("Rationale submission is missing"));
    }
    this.#publish();

    let persistence: void | Promise<void>;
    try {
      persistence = this.#onDisposition?.(current, submission);
    } catch (error) {
      return Promise.reject(
        this.#recordPersistenceFailure(error),
      );
    }
    return Promise.resolve(persistence).then(
      () => {
        this.#current = null;
        this.#currentSubmission = null;
        this.#persistenceFailed = false;
        this.#advance();
        this.#publish();
      },
      (error: unknown) => {
        throw this.#recordPersistenceFailure(error);
      },
    );
  }

  #recordPersistenceFailure(
    error: unknown,
  ): DecisionPersistenceError {
    const failure = new DecisionPersistenceError(error);
    this.#persistenceFailed = true;
    this.#persistenceFailure = failure.store;
    this.#publish();
    return failure;
  }

  #advance(): void {
    if (this.#current !== null) {
      return;
    }
    this.#current = this.#waiting.shift() ?? null;
  }

  #promoteCandidate(
    primary: RationaleCandidate,
    event: CapturedDecisionEvent,
    question: CapturedQuestion,
    candidateKey: string,
  ): RationaleCandidate {
    const promoted = {
      ...primary,
      event,
      question,
      candidateKey,
    };
    if (this.#current?.candidateId === primary.candidateId) {
      this.#current = promoted;
    } else {
      const index = this.#waiting.findIndex(
        (candidate) =>
          candidate.candidateId === primary.candidateId,
      );
      if (index >= 0) {
        this.#waiting[index] = promoted;
      }
    }
    this.#replaceSemanticCandidate(primary, promoted);
    return promoted;
  }

  #takeCrossModeOccurrence(
    semanticKey: string,
    event: CapturedDecisionEvent,
  ): RationaleCandidate | null {
    const occurrences =
      this.#semanticOccurrences.get(semanticKey) ?? [];
    const capturedAt = Date.parse(event.capturedAt);
    const index = occurrences.findIndex(
      (occurrence) =>
        occurrence.candidate.event.captureMode !==
          event.captureMode &&
        Math.abs(occurrence.capturedAt - capturedAt) <=
          CROSS_MODE_WINDOW_MS,
    );
    if (index < 0) {
      return null;
    }
    const [matched] = occurrences.splice(index, 1);
    if (occurrences.length === 0) {
      this.#semanticOccurrences.delete(semanticKey);
    }
    return matched?.candidate ?? null;
  }

  #rememberSemanticOccurrence(
    semanticKey: string,
    candidate: RationaleCandidate,
  ): void {
    const occurrences =
      this.#semanticOccurrences.get(semanticKey) ?? [];
    occurrences.push({
      candidate,
      capturedAt: Date.parse(candidate.event.capturedAt),
    });
    this.#semanticOccurrences.set(semanticKey, occurrences);
  }

  #replaceSemanticCandidate(
    previous: RationaleCandidate,
    replacement: RationaleCandidate,
  ): void {
    for (const occurrences of this.#semanticOccurrences.values()) {
      const occurrence = occurrences.find(
        (item) =>
          item.candidate.candidateId === previous.candidateId,
      );
      if (occurrence !== undefined) {
        occurrence.candidate = replacement;
        occurrence.capturedAt = Date.parse(
          replacement.event.capturedAt,
        );
      }
    }
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) {
      subscriber(snapshot);
    }
  }
}
