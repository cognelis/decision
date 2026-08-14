import {
  semanticDecisionPairSchema,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type SemanticPairAppendResult =
  | "accepted"
  | "duplicate";

interface SemanticPairSpoolOptions {
  now?: () => Date;
  maximumItems?: number;
}

interface PairEntry {
  pair: SemanticDecisionPair;
  path: string;
}

const pairKey = (pairId: string): string =>
  createHash("sha256").update(pairId, "utf8").digest("hex");

export class SemanticPairSpool {
  readonly path: string;
  readonly #now: () => Date;
  readonly #maximumItems: number;

  constructor(
    path: string,
    options: SemanticPairSpoolOptions = {},
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#maximumItems = options.maximumItems ?? 5_000;
    if (
      !Number.isInteger(this.#maximumItems) ||
      this.#maximumItems < 1
    ) {
      throw new Error(
        "Semantic pair spool maximum items must be a positive integer",
      );
    }
  }

  async append(
    input: SemanticDecisionPair,
  ): Promise<SemanticPairAppendResult> {
    const pair = semanticDecisionPairSchema.parse(input);
    await this.#secureDirectories();
    if (await this.isAcknowledged(pair.pairId)) {
      return "duplicate";
    }
    const target = this.#itemPath(pair.pairId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let accepted = false;
    try {
      await writeFile(temporary, JSON.stringify(pair), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await link(temporary, target);
        accepted = true;
        await chmod(target, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    if (await this.isAcknowledged(pair.pairId)) {
      await unlink(target).catch(() => undefined);
      return "duplicate";
    }
    await this.#listEntries();
    return accepted ? "accepted" : "duplicate";
  }

  async list(): Promise<SemanticDecisionPair[]> {
    return (await this.#listEntries()).map((entry) => entry.pair);
  }

  async acknowledge(pairId: string): Promise<void> {
    await this.#secureDirectories();
    const receipt = this.#receiptPath(pairId);
    await writeFile(receipt, "", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
    await chmod(receipt, 0o600);
    await unlink(this.#itemPath(pairId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      },
    );
  }

  async isAcknowledged(pairId: string): Promise<boolean> {
    await this.#secureDirectories();
    try {
      await access(this.#receiptPath(pairId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #listEntries(): Promise<PairEntry[]> {
    await this.#secureDirectories();
    const entries: PairEntry[] = [];
    for (const filename of await readdir(this.#itemsPath())) {
      if (!/^[a-f0-9]{64}\.json$/u.test(filename)) {
        continue;
      }
      const path = join(this.#itemsPath(), filename);
      try {
        const pair = semanticDecisionPairSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (
          (await this.isAcknowledged(pair.pairId)) ||
          Date.parse(pair.expiresAt) <= this.#now().getTime()
        ) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        entries.push({ pair, path });
      } catch {
        const quarantined = join(
          this.#quarantinePath(),
          `${filename}.corrupt-${this.#now().getTime()}-${randomUUID()}`,
        );
        await rename(path, quarantined).catch(() => undefined);
        await chmod(quarantined, 0o600).catch(() => undefined);
      }
    }
    entries.sort(
      (left, right) =>
        left.pair.capturedAt.localeCompare(
          right.pair.capturedAt,
        ) ||
        left.pair.pairId.localeCompare(right.pair.pairId),
    );
    const overflow = Math.max(
      0,
      entries.length - this.#maximumItems,
    );
    for (const entry of entries.slice(0, overflow)) {
      await unlink(entry.path).catch(() => undefined);
    }
    return entries.slice(overflow);
  }

  #itemsPath(): string {
    return join(this.path, "items");
  }

  #receiptsPath(): string {
    return join(this.path, "receipts");
  }

  #quarantinePath(): string {
    return join(this.path, "quarantine");
  }

  #itemPath(pairId: string): string {
    return join(this.#itemsPath(), `${pairKey(pairId)}.json`);
  }

  #receiptPath(pairId: string): string {
    return join(
      this.#receiptsPath(),
      `${pairKey(pairId)}.ack`,
    );
  }

  async #secureDirectories(): Promise<void> {
    for (const path of [
      this.path,
      this.#itemsPath(),
      this.#receiptsPath(),
      this.#quarantinePath(),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }
}
