import {
  capturedDecisionCandidateSchema,
  type CapturedDecisionCandidate,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

interface CandidateSpoolOptions {
  now?: () => Date;
  maximumItems?: number;
}

interface CandidateEntry {
  candidate: CapturedDecisionCandidate;
  path: string;
}

const candidateKey = (candidateId: string): string =>
  createHash("sha256").update(candidateId, "utf8").digest("hex");

export class CandidateSpool {
  readonly path: string;
  readonly #now: () => Date;
  readonly #maximumItems: number;

  constructor(
    path: string,
    options: CandidateSpoolOptions = {},
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#maximumItems = options.maximumItems ?? 100;
    if (
      !Number.isInteger(this.#maximumItems) ||
      this.#maximumItems < 1
    ) {
      throw new Error(
        "Candidate spool maximum items must be a positive integer",
      );
    }
  }

  async append(
    input: CapturedDecisionCandidate,
  ): Promise<void> {
    const candidate =
      capturedDecisionCandidateSchema.parse(input);
    await this.#secureDirectories();
    if (await this.isAcknowledged(candidate.candidateId)) {
      return;
    }
    const path = this.#itemPath(candidate.candidateId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(candidate), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const itemCount = (
      await readdir(this.#itemsPath())
    ).filter((filename) =>
      /^[a-f0-9]{64}\.json$/u.test(filename),
    ).length;
    if (itemCount > this.#maximumItems) {
      await this.#listEntries();
    }
  }

  async list(): Promise<CapturedDecisionCandidate[]> {
    return (await this.#listEntries()).map(
      (entry) => entry.candidate,
    );
  }

  async acknowledge(candidateId: string): Promise<void> {
    await this.#secureDirectories();
    const receipt = this.#receiptPath(candidateId);
    const temporary = `${receipt}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, "", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, receipt);
      await chmod(receipt, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await unlink(this.#itemPath(candidateId)).catch(
      () => undefined,
    );
  }

  async isAcknowledged(candidateId: string): Promise<boolean> {
    await this.#secureDirectories();
    return this.#isAcknowledged(candidateId);
  }

  async #isAcknowledged(
    candidateId: string,
  ): Promise<boolean> {
    try {
      await access(this.#receiptPath(candidateId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #listEntries(): Promise<CandidateEntry[]> {
    await this.#secureDirectories();
    const entries: CandidateEntry[] = [];
    const filenames = await readdir(this.#itemsPath());
    for (const filename of filenames) {
      if (!/^[a-f0-9]{64}\.json$/u.test(filename)) {
        continue;
      }
      const path = join(this.#itemsPath(), filename);
      try {
        const candidate =
          capturedDecisionCandidateSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          );
        if (
          (await this.#isAcknowledged(candidate.candidateId)) ||
          Date.parse(candidate.expiresAt) <= this.#now().getTime()
        ) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        entries.push({ candidate, path });
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
        Date.parse(left.candidate.createdAt) -
          Date.parse(right.candidate.createdAt) ||
        left.candidate.candidateId.localeCompare(
          right.candidate.candidateId,
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

  #itemsPath(): string {
    return join(this.path, "items");
  }

  #receiptsPath(): string {
    return join(this.path, "receipts");
  }

  #quarantinePath(): string {
    return join(this.path, "quarantine");
  }

  #itemPath(candidateId: string): string {
    return join(
      this.#itemsPath(),
      `${candidateKey(candidateId)}.json`,
    );
  }

  #receiptPath(candidateId: string): string {
    return join(
      this.#receiptsPath(),
      `${candidateKey(candidateId)}.ack`,
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
