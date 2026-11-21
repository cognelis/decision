import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  PR_REVIEW_HISTORY_LIMITS,
  prReviewHistoryEntrySchema,
  type PrReviewHistoryEntry,
  type PrReviewHistoryList,
  type PrReviewHistorySave,
  type PrReviewHistorySaveResult,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";

const FILE = /^[0-9a-f-]{36}\.json$/u;

/**
 * 评审历史 in the main process, one file per record under userData, so a long history no longer crowds the page's own
 * storage out, and what reads the history (MCP, statistics) reads it here. A file that cannot be read is left as it is
 * and counted; the others are read regardless.
 */
export class PrReviewHistoryStore {
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  #file(id: string): string {
    return join(this.directory, `${id}.json`);
  }

  async #names(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((name) => FILE.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #read(name: string): Promise<PrReviewHistoryEntry | null> {
    try {
      return prReviewHistoryEntrySchema.parse(JSON.parse(await readFile(join(this.directory, name), "utf8")));
    } catch {
      return null;
    }
  }

  /** Newest first, by when each began. */
  async list(): Promise<PrReviewHistoryList> {
    const read = await Promise.all((await this.#names()).map((name) => this.#read(name)));
    const entries = read.filter((entry): entry is PrReviewHistoryEntry => entry !== null)
      .sort((first, second) => second.at.localeCompare(first.at) || first.id.localeCompare(second.id));
    return { entries, unreadable: read.length - entries.length };
  }

  async get(id: string): Promise<PrReviewHistoryEntry | null> {
    return FILE.test(`${id}.json`) ? this.#read(`${id}.json`) : null;
  }

  /** Writes each changed record whole and deletes the removed, one save after another. */
  save(input: PrReviewHistorySave): Promise<PrReviewHistorySaveResult> {
    const run = this.#tail.then(() => this.#save(input));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #save({ entries, removed }: PrReviewHistorySave): Promise<PrReviewHistorySaveResult> {
    const logDropped: string[] = [];
    const refused: string[] = [];
    for (const entry of entries.map((item) => prReviewHistoryEntrySchema.parse(item))) {
      let text = JSON.stringify(entry);
      // What makes one record that large is mostly its process log: kept without it rather than not at all, and said.
      if (Buffer.byteLength(text) > PR_REVIEW_HISTORY_LIMITS.entryBytes && entry.events.length > 0) {
        text = JSON.stringify({ ...entry, events: [] });
        logDropped.push(entry.id);
      }
      if (Buffer.byteLength(text) > PR_REVIEW_HISTORY_LIMITS.entryBytes) {
        refused.push(entry.id);
        continue;
      }
      await atomicWrite(this.#file(entry.id), text);
    }
    await Promise.all(removed.map((id) => rm(this.#file(id), { force: true })));
    return { dropped: await this.#trim(), logDropped, refused };
  }

  /** Past the limit, the records changed longest ago give way. */
  async #trim(): Promise<number> {
    const names = await this.#names();
    if (names.length <= PR_REVIEW_HISTORY_LIMITS.entries) return 0;
    const changed = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(this.directory, name))).mtimeMs })));
    const oldest = changed.sort((first, second) => first.at - second.at).slice(0, names.length - PR_REVIEW_HISTORY_LIMITS.entries);
    await Promise.all(oldest.map(({ name }) => rm(join(this.directory, name), { force: true })));
    return oldest.length;
  }
}
