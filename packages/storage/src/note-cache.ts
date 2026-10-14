import type { BigIntStats } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Written this recently, a note is read again every time: a clock too coarse to tell two writes apart
 * (FAT keeps two seconds) would otherwise leave what the first one wrote standing for the second.
 */
const SETTLED_MS = 3_000;

/** A file as one stamp: the same device and inode, size, and modification and change times. */
export const fileStamp = (file: BigIntStats): string => `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;

/** Written longer ago than a coarse clock can tell two writes apart, so that its stamp stands for its contents. */
export const settled = (file: BigIntStats): boolean => Date.now() - Number(file.mtimeNs / 1_000_000n) > SETTLED_MS;

/**
 * What reading a note gave, kept while its file is the same file with the same contents: the same device
 * and inode, size, and modification and change times. One stat in place of reading and parsing it again,
 * which at ten thousand notes was seconds on every search, list and lookup.
 */
export class NoteCache<T> {
  readonly #entries = new Map<string, { identity: string; value: T; listing: number }>();
  readonly #stat: (path: string) => Promise<BigIntStats>;
  readonly #keep: (value: T) => boolean;
  /** How many listings have ended: each note is marked with the one that last met it. */
  #listings = 0;

  /**
   * `keep` says which reads stand for the file: one that failed (a file held open by a sync client, the disk
   * busy) is read again next time, where kept it was the file's for good, until it changed or the app restarted.
   */
  constructor(
    statFile: (path: string) => Promise<BigIntStats> = (path) => stat(path, { bigint: true }),
    keep: (value: T) => boolean = () => true,
  ) {
    this.#stat = statFile;
    this.#keep = keep;
  }

  async read(path: string, load: () => Promise<T>): Promise<T> {
    // Gone or unreadable since it was listed: reading it says so, the way it always has.
    const file = await this.#stat(path).catch(() => null);
    if (typeof file?.mtimeNs !== "bigint") return load();
    const identity = fileStamp(file);
    const kept = this.#entries.get(path);
    if (kept?.identity === identity) {
      kept.listing = this.#listings;
      return kept.value;
    }
    const value = await load();
    if (this.#keep(value) && settled(file)) {
      this.#entries.set(path, { identity, value, listing: this.#listings });
    } else {
      this.#entries.delete(path);
    }
    return value;
  }

  /**
   * Ends a listing, whole or cut short (a cap reached, time run out): forgets a note none of the last three
   * listings met. Forgetting what one cut short did not reach would drop notes still there, and waiting for
   * one to run to the end kept a deleted note's text for good where none ever did.
   */
  sweep(): void {
    this.#listings += 1;
    for (const [path, entry] of this.#entries) {
      if (this.#listings - entry.listing > 3) this.#entries.delete(path);
    }
  }
}
