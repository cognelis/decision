import { renameReplacing } from "@cognelis/decision-storage";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { misrecognitionReceiptSchema, type MisrecognitionReceipt, type MisrecognitionSummary } from "../shared/decision-deletion.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Receipts of decisions deleted as 识别错误, kept to tune recognition later.
 *
 * The line is drawn as for ratings: rule version, band, score, signals, client, option count and two times, never the
 * question, options, answer, project, ID or a hash of the note — nothing that leads back to the text. Kept in the
 * App's own data, not the vault, for good (no age limit, unlike the capture audit), and readable as it is
 * (`jq '.receipts'` over the file) without the App.
 */
const fileSchema = z.object({
  version: z.literal(1),
  // A receipt this version cannot read is skipped, not the whole file.
  receipts: z.array(z.unknown()).transform((receipts) => receipts.flatMap((receipt) => {
    const parsed = misrecognitionReceiptSchema.safeParse(receipt);
    return parsed.success ? [parsed.data] : [];
  })),
}).strip();

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

export class MisrecognitionReceiptStore {
  readonly #path: string;
  readonly #now: () => Date;
  /** Serialises writes so two quick deletions cannot lose one another. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = resolve(path);
    this.#now = now;
  }

  /** Stamped with the time of the deletion unless one is given. */
  async record(receipt: Omit<MisrecognitionReceipt, "deletedAt"> & { deletedAt?: string }): Promise<void> {
    const parsed = misrecognitionReceiptSchema.parse({ ...receipt, deletedAt: receipt.deletedAt ?? this.#now().toISOString() });
    const run = this.#tail.then(async () => {
      // An unreadable file throws here and is left as it is, not replaced by one holding this receipt alone.
      const receipts = await this.#read();
      // ponytail: every receipt kept, a few hundred bytes each; trim with a counted remainder if it ever grows large.
      await this.#write([...receipts, parsed]);
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async summary(days = 30): Promise<MisrecognitionSummary> {
    const summary: MisrecognitionSummary = { days, total: 0, byMode: { transcript: 0, structured_tool: 0 }, byBand: { high: 0, medium: 0, unknown: 0 }, bySignal: {}, byDetector: {} };
    const receipts = await this.#read().catch(() => null);
    // Unreadable is not the same as none deleted.
    if (receipts === null) return { ...summary, unavailable: true };
    const since = this.#now().getTime() - days * DAY_MS;
    for (const receipt of receipts) {
      if (Date.parse(receipt.deletedAt) < since) continue;
      summary.total++;
      summary.byMode[receipt.captureMode]++;
      summary.byBand[receipt.band ?? "unknown"]++;
      for (const signal of new Set(receipt.signals)) summary.bySignal[signal] = (summary.bySignal[signal] ?? 0) + 1;
      const detector = receipt.detectorVersion ?? "unknown";
      summary.byDetector[detector] = (summary.byDetector[detector] ?? 0) + 1;
    }
    return summary;
  }

  async #read(): Promise<MisrecognitionReceipt[]> {
    try { return fileSchema.parse(JSON.parse(await readFile(this.#path, "utf8"))).receipts; }
    catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async #write(receipts: MisrecognitionReceipt[]): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, receipts }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await renameReplacing(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
