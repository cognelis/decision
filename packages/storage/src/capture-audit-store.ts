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
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAXIMUM_ITEMS = 5_000;
const DEFAULT_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const NON_TERMINAL_ERROR_CODES = new Set<CaptureAuditErrorCode>([
  "pair_not_found",
  "classification_timeout",
  "provider_unavailable",
  "provider_invalid_output",
  "model_missing",
  "checksum_failed",
  "runtime_unavailable",
  "helper_missing",
  "helper_crashed",
  "trace_write_failed",
]);

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
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.#listEntries();
    return receipt;
  }

  async list(): Promise<CaptureAuditReceipt[]> {
    return (await this.#listEntries()).map(
      (entry) => entry.receipt,
    );
  }

  async summary(): Promise<CaptureAuditSummary> {
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
    for (const filename of await readdir(this.#itemsPath())) {
      if (!/^[a-f0-9]{64}\.json$/u.test(filename)) {
        continue;
      }
      const path = join(this.#itemsPath(), filename);
      try {
        const receipt = captureAuditReceiptSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (
          this.#now().getTime() -
            Date.parse(receipt.createdAt) >
          this.#maximumAgeMs
        ) {
          await unlink(path).catch(() => undefined);
          continue;
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
    }
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
    this.#saltPromise ??= this.#loadOrCreateSalt();
    return this.#saltPromise;
  }

  async #loadOrCreateSalt(): Promise<Buffer> {
    const path = join(this.path, "salt");
    try {
      const existing = await readFile(path);
      if (existing.length !== 32) {
        throw new Error("Capture audit salt is invalid");
      }
      await chmod(path, 0o600);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const proposed = this.#providedSalt ?? randomBytes(32);
    try {
      await writeFile(path, proposed, {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(path, 0o600);
      return Buffer.from(proposed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = await readFile(path);
      if (existing.length !== 32) {
        throw new Error("Capture audit salt is invalid");
      }
      return existing;
    }
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
