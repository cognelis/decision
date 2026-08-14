import {
  capturedDecisionCandidateSchema,
  type CapturedDecisionCandidate,
} from "@cognelis/decision-protocol";

export interface CandidateQueueSnapshot {
  current: CapturedDecisionCandidate | null;
  count: number;
  persistenceStatus?: "saving" | "failed";
}

export interface CandidateQueueOptions {
  onPromote(
    candidate: CapturedDecisionCandidate,
  ): void | Promise<void>;
  onIgnore(
    candidate: CapturedDecisionCandidate,
  ): void | Promise<void>;
  now?: () => Date;
  maximumItems?: number;
}

type CandidateAction = "promote" | "ignore";

const compareCandidates = (
  left: CapturedDecisionCandidate,
  right: CapturedDecisionCandidate,
): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  left.candidateId.localeCompare(right.candidateId);

export class CandidatePersistenceError extends Error {
  constructor(cause: unknown) {
    super(
      `Candidate persistence failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "CandidatePersistenceError";
  }
}

export class DecisionCandidateQueue {
  readonly #options: CandidateQueueOptions;
  readonly #now: () => Date;
  readonly #maximumItems: number;
  readonly #waiting: CapturedDecisionCandidate[] = [];
  readonly #seen = new Set<string>();
  readonly #subscribers = new Set<
    (snapshot: CandidateQueueSnapshot) => void
  >();
  #current: CapturedDecisionCandidate | null = null;
  #action: CandidateAction | null = null;
  #persistenceFailed = false;
  #expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CandidateQueueOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#maximumItems = options.maximumItems ?? 100;
    if (
      !Number.isInteger(this.#maximumItems) ||
      this.#maximumItems < 1
    ) {
      throw new Error(
        "Candidate queue maximum items must be a positive integer",
      );
    }
  }

  ingest(input: CapturedDecisionCandidate): boolean {
    const candidate =
      capturedDecisionCandidateSchema.parse(input);
    const pruned = this.#prune();
    if (
      Date.parse(candidate.expiresAt) <= this.#now().getTime()
    ) {
      if (pruned) {
        this.#publish();
      }
      return false;
    }
    if (this.#seen.has(candidate.candidateId)) {
      if (pruned) {
        this.#publish();
      }
      return false;
    }
    this.#seen.add(candidate.candidateId);
    if (this.#current === null) {
      this.#current = candidate;
    } else if (
      this.#action === null &&
      compareCandidates(candidate, this.#current) < 0
    ) {
      this.#waiting.push(this.#current);
      this.#current = candidate;
    } else {
      this.#waiting.push(candidate);
    }
    this.#waiting.sort(compareCandidates);
    this.#prune();
    this.#publish();
    return true;
  }

  promote(candidateId: string): Promise<void> {
    return this.#begin("promote", candidateId);
  }

  ignore(candidateId: string): Promise<void> {
    return this.#begin("ignore", candidateId);
  }

  retryCurrentPersistence(): Promise<void> {
    if (
      this.#current === null ||
      this.#action === null ||
      !this.#persistenceFailed
    ) {
      return Promise.reject(
        new Error(
          "The current decision candidate is not awaiting persistence retry",
        ),
      );
    }
    this.#persistenceFailed = false;
    return this.#persist();
  }

  snapshot(): CandidateQueueSnapshot {
    this.#prune();
    this.#scheduleExpiry();
    return {
      current: this.#current,
      count:
        this.#waiting.length + (this.#current === null ? 0 : 1),
      ...(this.#persistenceFailed
        ? { persistenceStatus: "failed" as const }
        : this.#action === null
          ? {}
          : { persistenceStatus: "saving" as const }),
    };
  }

  subscribe(
    subscriber: (snapshot: CandidateQueueSnapshot) => void,
  ): () => void {
    this.#subscribers.add(subscriber);
    subscriber(this.snapshot());
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  #begin(
    action: CandidateAction,
    candidateId: string,
  ): Promise<void> {
    if (
      this.#current === null ||
      this.#current.candidateId !== candidateId
    ) {
      return Promise.reject(
        new Error("Input does not target the current decision candidate"),
      );
    }
    if (this.#action !== null) {
      return Promise.reject(
        new Error("The current decision candidate is already saving"),
      );
    }
    this.#action = action;
    this.#persistenceFailed = false;
    return this.#persist();
  }

  async #persist(): Promise<void> {
    const current = this.#current;
    const action = this.#action;
    if (current === null || action === null) {
      throw new Error("Decision candidate action is missing");
    }
    this.#publish();
    try {
      if (action === "promote") {
        await this.#options.onPromote(current);
      } else {
        await this.#options.onIgnore(current);
      }
      this.#current = null;
      this.#action = null;
      this.#persistenceFailed = false;
      this.#advance();
      this.#publish();
    } catch (error) {
      this.#persistenceFailed = true;
      this.#publish();
      throw new CandidatePersistenceError(error);
    }
  }

  #advance(): void {
    if (this.#current === null) {
      this.#current = this.#waiting.shift() ?? null;
    }
  }

  #prune(): boolean {
    const now = this.#now().getTime();
    let changed = false;
    for (let index = this.#waiting.length - 1; index >= 0; index -= 1) {
      const candidate = this.#waiting[index];
      if (
        candidate !== undefined &&
        Date.parse(candidate.expiresAt) <= now
      ) {
        this.#waiting.splice(index, 1);
        changed = true;
      }
    }
    if (
      this.#action === null &&
      this.#current !== null &&
      Date.parse(this.#current.expiresAt) <= now
    ) {
      this.#current = null;
      changed = true;
    }
    this.#advance();
    while (
      this.#waiting.length +
        (this.#current === null ? 0 : 1) >
      this.#maximumItems
    ) {
      if (this.#action === null && this.#current !== null) {
        this.#current = null;
        this.#advance();
      } else {
        this.#waiting.shift();
      }
      changed = true;
    }
    return changed;
  }

  #scheduleExpiry(): void {
    if (this.#expiryTimer !== null) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = null;
    }
    const candidates = [
      ...(this.#action === null && this.#current !== null
        ? [this.#current]
        : []),
      ...this.#waiting,
    ];
    if (candidates.length === 0) {
      return;
    }
    const earliest = Math.min(
      ...candidates.map((candidate) =>
        Date.parse(candidate.expiresAt),
      ),
    );
    const delay = Math.max(
      1,
      Math.min(
        earliest - this.#now().getTime() + 1,
        2_147_483_647,
      ),
    );
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = null;
      if (this.#prune()) {
        this.#publish();
      } else {
        this.#scheduleExpiry();
      }
    }, delay);
    this.#expiryTimer.unref();
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) {
      subscriber(snapshot);
    }
  }
}
