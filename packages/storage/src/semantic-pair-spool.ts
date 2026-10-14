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
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";

import { expireQuarantined, QUARANTINE_MAXIMUM_AGE_MS } from "./quarantine.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
// As long as the capture spool keeps its acknowledgements: a session resumed months later can form a pair again.
const RECEIPT_RETENTION_MS = 180 * DAY_MS;

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
  #receiptsPrunedAt = Number.NEGATIVE_INFINITY;

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
    const entries = await this.#listEntries();
    await this.#pruneReceipts().catch(() => undefined);
    return entries.map((entry) => entry.pair);
  }

  /**
   * Receipts older than a pair could be formed again, taken out at most once a day by the app, which lists the
   * spool; never by the bridge, which only appends, once per hook. Kept for good, one a turn grew past a hundred
   * thousand files a year.
   */
  async #pruneReceipts(): Promise<void> {
    const now = this.#now().getTime();
    if (now - this.#receiptsPrunedAt < DAY_MS) return;
    this.#receiptsPrunedAt = now;
    for (const name of await readdir(this.#receiptsPath())) {
      if (!name.endsWith(".ack")) continue;
      const path = join(this.#receiptsPath(), name);
      const written = await stat(path).then((status) => status.mtimeMs, () => Number.POSITIVE_INFINITY);
      if (written < now - RECEIPT_RETENTION_MS) await unlink(path).catch(() => undefined);
    }
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
        const now = this.#now().getTime();
        const captured = Date.parse(pair.capturedAt);
        if (
          (await this.isAcknowledged(pair.pairId)) ||
          Date.parse(pair.expiresAt) <= now ||
          // Captured further ahead than it lives: under a clock that ran ahead, it stayed until that date came round.
          captured - now > Date.parse(pair.expiresAt) - captured
        ) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        entries.push({ pair, path });
      } catch (error) {
        // Only one that does not parse is set aside: one not read now (too many files open, a disk error, a
        // virus scanner holding it) is kept, and read again next time, not deleted a week later as corrupt.
        if (!(error instanceof SyntaxError || error instanceof ZodError)) continue;
        const quarantined = join(
          this.#quarantinePath(),
          `${filename}.corrupt-${this.#now().getTime()}-${randomUUID()}`,
        );
        await rename(path, quarantined).catch(() => undefined);
        await chmod(quarantined, 0o600).catch(() => undefined);
      }
    }
    await expireQuarantined(this.#quarantinePath(), QUARANTINE_MAXIMUM_AGE_MS, this.#now().getTime());
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
