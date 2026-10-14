import {
  captureAuditReceiptSchema,
  type CaptureAuditErrorCode,
  type CaptureAuditReceipt,
  type CaptureAuditStage,
} from "@cognelis/decision-protocol";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
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
import { expireQuarantined } from "./quarantine.js";
import { renameReplacing } from "./replace-file.js";

/**
 * A safety valve, not the normal limit: the age below is what retention means.
 * Measured on a real store, receipts arrive at roughly 900 a day, so 5,000 cut
 * the window to six days and hid the tail of any week-long question.
 */
const DEFAULT_MAXIMUM_ITEMS = 10_000;
const DEFAULT_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const SUMMARY_MAXIMUM_AGE_MS = 60_000;
/**
 * Codes the pipeline recovers from, so they stay out of the failure count.
 * `pair_not_found` used to sit here because it fired on every session's first
 * prompt; that case is now its own stage, and so is a turn nobody answered.
 * What is left is a reader who did come back to an answer we could not use.
 */
const NON_TERMINAL_ERROR_CODES = new Set<CaptureAuditErrorCode>([
  "classification_timeout",
  "provider_unavailable",
  "provider_invalid_output",
  "model_missing",
  "checksum_failed",
  "runtime_unavailable",
  "helper_missing",
  "helper_crashed",
  "trace_write_failed",
  // Spooled first, so taken in when the App next reads the spool.
  "pair_delivery_failed",
]);
/**
 * A hook writes three receipts a turn and the client waits on each, so the
 * scan that applies retention (every receipt read and parsed: about a third of
 * a second at a week's worth) runs from `record` at most this often. `list`
 * and `summary` still apply it on every read.
 */
const RECORD_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const CLEANUP_MARKER = ".last-cleanup";

export type CaptureAuditRecordInput = Omit<
  CaptureAuditReceipt,
  | "version"
  | "receiptId"
  | "sessionFingerprint"
  | "turnFingerprint"
  | "createdAt"
> & {
  sessionId: string;
  turnId?: string;
};

export interface CaptureAuditSummary {
  total: number;
  processed: number;
  high: number;
  medium: number;
  failures: number;
  stages: Partial<Record<CaptureAuditStage, number>>;
  errorCodes: Partial<Record<CaptureAuditErrorCode, number>>;
}

interface CaptureAuditStoreOptions {
  now?: () => Date;
  maximumItems?: number;
  maximumAgeMs?: number;
  salt?: Buffer;
  idFactory?: () => string;
}

interface ReceiptEntry {
  receipt: CaptureAuditReceipt;
  path: string;
}

const increment = <Key extends string>(
  values: Partial<Record<Key, number>>,
  key: Key,
): void => {
  values[key] = (values[key] ?? 0) + 1;
};

export class CaptureAuditStore {
  readonly path: string;
  readonly #now: () => Date;
  readonly #maximumItems: number;
  readonly #maximumAgeMs: number;
  readonly #providedSalt: Buffer | undefined;
  readonly #idFactory: () => string;
  #saltPromise: Promise<Buffer> | null = null;
  #summary: { at: number; counts: Promise<CaptureAuditSummary> } | null = null;

  constructor(
    path: string,
    options: CaptureAuditStoreOptions = {},
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#maximumItems =
      options.maximumItems ?? DEFAULT_MAXIMUM_ITEMS;
    this.#maximumAgeMs =
      options.maximumAgeMs ?? DEFAULT_MAXIMUM_AGE_MS;
    this.#providedSalt = options.salt;
    this.#idFactory = options.idFactory ?? randomUUID;
    if (
      !Number.isInteger(this.#maximumItems) ||
      this.#maximumItems < 1
    ) {
      throw new Error(
        "Capture audit maximum items must be a positive integer",
      );
    }
    if (
      !Number.isInteger(this.#maximumAgeMs) ||
      this.#maximumAgeMs < 1
    ) {
      throw new Error(
        "Capture audit maximum age must be a positive integer",
      );
    }
    if (
      this.#providedSalt !== undefined &&
      this.#providedSalt.length !== 32
    ) {
      throw new Error("Capture audit salt must contain 32 bytes");
    }
  }

  async record(
    input: CaptureAuditRecordInput,
  ): Promise<CaptureAuditReceipt> {
    await this.#secureDirectories();
    const salt = await this.#salt();
    const receipt = captureAuditReceiptSchema.parse({
      version: 1,
      receiptId: this.#idFactory(),
      sourceClient: input.sourceClient,
      sessionFingerprint: this.#fingerprint(
        salt,
        input.sessionId,
      ),
      ...(input.turnId === undefined
        ? {}
        : {
            turnFingerprint: this.#fingerprint(
              salt,
              input.turnId,
            ),
          }),
      stage: input.stage,
      ...(input.textSource === undefined
        ? {}
        : { textSource: input.textSource }),
      ...(input.ruleBand === undefined
        ? {}
        : { ruleBand: input.ruleBand }),
      ...(input.modelBand === undefined
        ? {}
        : { modelBand: input.modelBand }),
      ...(input.finalBand === undefined
        ? {}
        : { finalBand: input.finalBand }),
      ...(input.errorCode === undefined
        ? {}
        : { errorCode: input.errorCode }),
      ...(input.durationMs === undefined
        ? {}
        : { durationMs: input.durationMs }),
      createdAt: this.#now().toISOString(),
    });
    const target = join(
      this.#itemsPath(),
      `${createHash("sha256")
        .update(receipt.receiptId, "utf8")
        .digest("hex")}.json`,
    );
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(receipt), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await renameReplacing(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    this.#summary = null;
    await this.#pruneIfDue().catch(() => undefined);
    return receipt;
  }

  async #pruneIfDue(): Promise<void> {
    const marker = join(this.path, CLEANUP_MARKER);
    const now = this.#now().getTime();
    const last = Number(await readFile(marker, "utf8").catch(() => ""));
    // A marker from the future (a clock set back) is not trusted to skip anything.
    if (last > 0 && now >= last && now - last < RECORD_CLEANUP_INTERVAL_MS) return;
    await this.#listEntries();
    await writeFile(marker, String(now), { encoding: "utf8", mode: 0o600 });
  }

  async list(): Promise<CaptureAuditReceipt[]> {
    return (await this.#listEntries()).map(
      (entry) => entry.receipt,
    );
  }

  /**
   * The week's counts, kept a minute: worked out from every receipt each time the semantic status was (after
   * every agent turn), they read six thousand files a turn. A receipt this store writes drops them at once; one
   * the bridge writes counts within the minute.
   */
  summary(): Promise<CaptureAuditSummary> {
    const now = this.#now().getTime();
    const kept = this.#summary;
    // A clock set back is no reason to keep them longer.
    if (kept !== null && now >= kept.at && now - kept.at < SUMMARY_MAXIMUM_AGE_MS) return kept.counts;
    const counts = this.#counted();
    this.#summary = { at: now, counts };
    // One that failed is not kept.
    counts.catch(() => {
      if (this.#summary?.counts === counts) this.#summary = null;
    });
    return counts;
  }

  async #counted(): Promise<CaptureAuditSummary> {
    const receipts = await this.list();
    const summary: CaptureAuditSummary = {
      total: receipts.length,
      processed: 0,
      high: 0,
      medium: 0,
      failures: 0,
      stages: {},
      errorCodes: {},
    };
    for (const receipt of receipts) {
      increment(summary.stages, receipt.stage);
      if (receipt.stage === "classification_completed") {
        summary.processed += 1;
        if (receipt.finalBand === "high") {
          summary.high += 1;
        } else if (receipt.finalBand === "medium") {
          summary.medium += 1;
        }
      }
      if (
        receipt.stage === "failed" &&
        (receipt.errorCode === undefined ||
          !NON_TERMINAL_ERROR_CODES.has(receipt.errorCode))
      ) {
        summary.failures += 1;
      }
      if (receipt.errorCode !== undefined) {
        increment(summary.errorCodes, receipt.errorCode);
      }
    }
    return summary;
  }

  async fingerprint(value: string): Promise<string> {
    await this.#secureDirectories();
    return this.#fingerprint(await this.#salt(), value);
  }

  async #listEntries(): Promise<ReceiptEntry[]> {
    await this.#secureDirectories();
    const entries: ReceiptEntry[] = [];
    const filenames = await readdir(this.#itemsPath());
    // ponytail: retention still scans O(n), with 16 reads at once; index it if the 10k cap grows.
    for (let start = 0; start < filenames.length; start += 16) {
      await Promise.all(filenames.slice(start, start + 16).map(async (filename) => {
        if (!/^[a-f0-9]{64}\.json$/u.test(filename)) {
          return;
        }
        const path = join(this.#itemsPath(), filename);
        try {
          const receipt = captureAuditReceiptSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          );
          // Either way past its keeping: written under a clock that ran ahead, it stayed until that date came round.
          if (Math.abs(this.#now().getTime() - Date.parse(receipt.createdAt)) > this.#maximumAgeMs) {
            await unlink(path).catch(() => undefined);
            return;
          }
          entries.push({ receipt, path });
        } catch {
          const quarantined = join(
            this.#quarantinePath(),
            `${filename}.corrupt-${this.#now().getTime()}-${randomUUID()}`,
          );
          await rename(path, quarantined).catch(() => undefined);
          await chmod(quarantined, 0o600).catch(() => undefined);
        }
      }));
    }
    await expireQuarantined(this.#quarantinePath(), this.#maximumAgeMs, this.#now().getTime());
    entries.sort(
      (left, right) =>
        left.receipt.createdAt.localeCompare(
          right.receipt.createdAt,
        ) ||
        left.receipt.receiptId.localeCompare(
          right.receipt.receiptId,
        ),
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

  async #salt(): Promise<Buffer> {
    // Not kept when it failed (a read the disk refused once): kept, every receipt after it failed until a restart.
    this.#saltPromise ??= this.#loadOrCreateSalt().catch((error: unknown) => {
      this.#saltPromise = null;
      throw error;
    });
    return this.#saltPromise;
  }

  async #loadOrCreateSalt(): Promise<Buffer> {
    const path = join(this.path, "salt");
    const existing = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.length === 32) {
      await chmod(path, 0o600);
      return existing;
    }
    // Written whole under another name first: one cut short (the power went as it was written) refused every
    // receipt after it, for good. One cut short already is replaced; one another hook wrote first is used.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, this.#providedSalt ?? randomBytes(32), {
        mode: 0o600,
        flag: "wx",
      });
      if (existing === null) {
        await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      } else {
        await renameReplacing(temporary, path);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const salt = await readFile(path);
    if (salt.length !== 32) {
      throw new Error("Capture audit salt is invalid");
    }
    await chmod(path, 0o600);
    return salt;
  }

  #fingerprint(salt: Buffer, value: string): string {
    return createHmac("sha256", salt)
      .update(value, "utf8")
      .digest("hex");
  }

  #itemsPath(): string {
    return join(this.path, "items");
  }

  #quarantinePath(): string {
    return join(this.path, "quarantine");
  }

  async #secureDirectories(): Promise<void> {
    for (const path of [
      this.path,
      this.#itemsPath(),
      this.#quarantinePath(),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }
}
