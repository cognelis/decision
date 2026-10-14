import type {
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import type {
  SemanticPairAppendResult,
} from "@cognelis/decision-storage";

interface SemanticPairSpoolLike {
  append(
    pair: SemanticDecisionPair,
  ): Promise<SemanticPairAppendResult>;
  list(): Promise<SemanticDecisionPair[]>;
  acknowledge(pairId: string): Promise<void>;
  isAcknowledged(pairId: string): Promise<boolean>;
}

export type SemanticPairConsumeResult =
  | "processed"
  | "deferred";

interface SemanticPairInboxOptions {
  spool: SemanticPairSpoolLike;
  consume(
    pair: SemanticDecisionPair,
  ): Promise<SemanticPairConsumeResult>;
}

export class SemanticPairInbox {
  readonly #spool: SemanticPairSpoolLike;
  readonly #consume: SemanticPairInboxOptions["consume"];
  readonly #scheduled = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: SemanticPairInboxOptions) {
    this.#spool = options.spool;
    this.#consume = options.consume;
  }

  async enqueue(
    pair: SemanticDecisionPair,
  ): Promise<SemanticPairAppendResult> {
    const result = await this.#spool.append(pair);
    this.#schedule(pair);
    // One that failed earlier in this run is still in the spool: an arrival is when it is tried again,
    // rather than at the next start, by when it may have expired.
    void this.recover().catch(() => undefined);
    return result;
  }

  async recover(): Promise<void> {
    for (const pair of await this.#spool.list()) {
      this.#schedule(pair);
    }
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  /**
   * At quit: no further pair is taken up, and the one under way is waited on. Its model call is cut short first
   * (shutdownApplication), so it stays in the spool with the rest, for the next start.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  #schedule(pair: SemanticDecisionPair): void {
    if (this.#scheduled.has(pair.pairId)) {
      return;
    }
    this.#scheduled.add(pair.pairId);
    this.#tail = this.#tail
      .then(async () => {
        try {
          // Decided already, it is not decided again: a replay, or a second arrival of an answer the
          // hook could name only by its text, would come back a candidate nothing can record.
          if (this.#closed || (await this.#spool.isAcknowledged(pair.pairId))) return;
          const result = await this.#consume(pair);
          if (result === "processed") {
            await this.#spool.acknowledge(pair.pairId);
          }
        } finally {
          this.#scheduled.delete(pair.pairId);
        }
      })
      .catch(() => undefined);
  }
}
