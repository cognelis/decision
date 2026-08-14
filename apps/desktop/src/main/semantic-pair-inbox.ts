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

  constructor(options: SemanticPairInboxOptions) {
    this.#spool = options.spool;
    this.#consume = options.consume;
  }

  async enqueue(
    pair: SemanticDecisionPair,
  ): Promise<SemanticPairAppendResult> {
    const result = await this.#spool.append(pair);
    this.#schedule(pair);
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

  #schedule(pair: SemanticDecisionPair): void {
    if (this.#scheduled.has(pair.pairId)) {
      return;
    }
    this.#scheduled.add(pair.pairId);
    this.#tail = this.#tail
      .then(async () => {
        try {
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
