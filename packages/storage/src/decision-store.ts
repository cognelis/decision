import type { DecisionRecord } from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import type {
  DecisionLifecycleUpdate,
  AppliedPrinciplesUpdate,
  DeferredRationaleUpdate,
  NoteDiagnostic,
  OutcomeReviewUpdate,
  ParsedStoredNote,
  StoredNote,
} from "./markdown.js";
import { collectMarkdown, MarkdownRepository, parseDecision, serializeDecision, stillThere } from "./markdown.js";
import { fileStamp, settled } from "./note-cache.js";

export interface DecisionIndex {
  upsert(note: ParsedStoredNote): void;
  /** The id of the decision it removed, when it knows one. */
  removePath(path: string): string | null | void;
  /** `keep`: indexed paths whose rows are carried over as they are, their notes still there but not read now. */
  rebuild(notes: ParsedStoredNote[], keep?: string[]): void;
  close(): void;
  contentHashForPath?(path: string): string | null;
  /** Its note's file as it stood when read (fileStamp), and kept anew when read again and found as indexed. */
  stampForPath?(path: string): string | null;
  setStamp?(path: string, stamp: string): void;
  /** Without these, or when it says so, a reconcile is a rebuild. */
  readonly needsRebuild?: boolean;
  indexedPaths?(): string[];
  indexedStamps?(): Map<string, string | null>;
  pathOf?(id: string): string | null;
}

export interface SaveResult {
  note: StoredNote;
  indexed: boolean;
}

export interface RebuildReport {
  indexedCount: number;
  diagnostics: NoteDiagnostic[];
}

export class DecisionStore {
  readonly #repository: MarkdownRepository;
  readonly #index: DecisionIndex;
  readonly #onIndexError: (error: Error) => void;

  constructor(
    repository: MarkdownRepository,
    index: DecisionIndex,
    onIndexError: (error: Error) => void = () => undefined,
  ) {
    this.#repository = repository;
    this.#index = index;
    this.#onIndexError = onIndexError;
  }

  async save(record: DecisionRecord, content?: string): Promise<SaveResult> {
    const note = await this.#repository.write(record, content);
    try {
      this.#upsert(await this.#repository.read(note.path));
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  /** Paths written while a rebuild reads the vault, to be put into the index that rebuild ends with. */
  #writtenDuringRebuild: Set<string> | null = null;

  #upsert(note: ParsedStoredNote): void {
    this.#writtenDuringRebuild?.add(note.path);
    this.#index.upsert(note);
  }

  #removePath(path: string): void {
    this.#writtenDuringRebuild?.add(path);
    this.#index.removePath(path);
  }

  /**
   * The index as the watcher is to write to it. An edit saved in Obsidian while a rebuild reads the vault
   * reached the old database straight, and the database built from the earlier read was swapped in over it.
   */
  get watchedIndex(): DecisionIndex {
    const index = this.#index;
    return {
      upsert: (note) => this.#upsert(note),
      removePath: (path) => {
        this.#writtenDuringRebuild?.add(path);
        return index.removePath(path);
      },
      rebuild: (notes, keep) => index.rebuild(notes, keep),
      close: () => index.close(),
      ...(index.contentHashForPath === undefined ? {} : { contentHashForPath: (path: string) => index.contentHashForPath!(path) }),
      ...(index.stampForPath === undefined ? {} : { stampForPath: (path: string) => index.stampForPath!(path) }),
      ...(index.setStamp === undefined ? {} : { setStamp: (path: string, stamp: string) => index.setStamp!(path, stamp) }),
    };
  }

  #rebuilding: Promise<RebuildReport> | null = null;

  /** One at a time: a second begun meanwhile is the first. Two at once each cleared what the other tracked. */
  rebuildIndex(): Promise<RebuildReport> {
    this.#rebuilding ??= this.#rebuild().finally(() => {
      this.#rebuilding = null;
    });
    return this.#rebuilding;
  }

  async #rebuild(): Promise<RebuildReport> {
    const written = new Set<string>();
    this.#writtenDuringRebuild = written;
    let scan;
    try {
      scan = await this.#repository.scan();
      // A note iCloud moved off this Mac, or in a folder it could not list for now, keeps its decision as last
      // read: rebuilt from what could be read, it was gone from every list until it came back. One read after all
      // (its placeholder not yet gone as it came back) is as read.
      const read = new Set(scan.notes.map((note) => note.path));
      const standing = stillThere(scan.diagnostics);
      this.#index.rebuild(scan.notes, this.#index.indexedPaths?.().filter((path) => !read.has(path) && standing(path)));
      // Saved or removed while the vault was being read, perhaps after its file was: the index built from
      // that read left a new capture out, and nothing brought it back until the next rebuild. Each such
      // note is read again as it now is.
      for (const path of written) {
        const note = await this.#repository.read(path).catch(() => null);
        if (note === null) this.#index.removePath(path);
        else this.#index.upsert(note);
      }
    } finally {
      this.#writtenDuringRebuild = null;
    }
    // Two notes with one id (an Obsidian copy, a sync conflict) leave all but one of them out of the
    // index: each is named, so the copy can be found and removed or given its own id.
    const pathsById = new Map<string, string[]>();
    for (const note of scan.notes) pathsById.set(note.id, [...(pathsById.get(note.id) ?? []), note.path]);
    const duplicates = [...pathsById.values()].filter((paths) => paths.length > 1).flatMap((paths) =>
      paths.map((path) => ({
        path,
        message: `与 ${paths.filter((other) => other !== path).map((other) => basename(other)).join("、")} 使用同一个决策 ID，列表里只会出现其中一篇`,
      })));
    return {
      indexedCount: pathsById.size,
      diagnostics: [...scan.diagnostics, ...duplicates],
    };
  }

  /**
   * The index brought up to the vault as it is now: a note read in again only where its file changed, came or
   * went. Rebuilt whole at every start, ten thousand decisions kept the window from opening for seconds. An
   * index that is new, or opened short of what only the notes hold, is rebuilt whole as before.
   */
  async reconcileIndex(): Promise<RebuildReport> {
    const index = this.#index;
    if (index.needsRebuild !== false || index.indexedPaths === undefined || index.pathOf === undefined || index.contentHashForPath === undefined) {
      return this.rebuildIndex();
    }
    const diagnostics: NoteDiagnostic[] = [];
    const paths = await collectMarkdown(this.#repository.decisionsPath, diagnostics);
    const present = new Set(paths);
    // As the watcher keeps them: a note iCloud moved off this Mac, or in a folder it could not list for now, is
    // still there. Taken out at each start, its decision was gone from every list, search and review.
    const standing = stillThere(diagnostics);
    const indexed = index.indexedStamps?.() ?? new Map(index.indexedPaths().map((path) => [path, null]));
    // Written as any write is: a rebuild running meanwhile reads them in again over its swap.
    for (const path of indexed.keys()) {
      if (!present.has(path) && !standing(path)) this.#removePath(path);
    }
    let indexedCount = 0;
    for (const path of paths) {
      // A file as it stood when last read is not read again: read and hashed at every start, ten thousand notes
      // held the window back a second, and the watcher's first look read them all once more.
      // ponytail: a note rewritten to the same size, inode and times to the nanosecond reads as unchanged; a
      // rebuild from Settings reads every note whatever its stamp.
      const file = await stat(path, { bigint: true }).catch(() => null);
      const stamp = file !== null && settled(file) ? fileStamp(file) : null;
      if (stamp !== null && indexed.get(path) === stamp) {
        indexedCount += 1;
        continue;
      }
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      if (index.contentHashForPath(path) === contentHash) {
        if (stamp !== null) index.setStamp?.(path, stamp);
        indexedCount += 1;
        continue;
      }
      let record: DecisionRecord;
      try {
        record = parseDecision(content);
      } catch (error) {
        // As a rebuild leaves it: a note it cannot read is out of the lists, and said.
        this.#removePath(path);
        diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const holder = index.pathOf(record.id);
      if (holder !== null && holder !== path && present.has(holder)) {
        diagnostics.push({ path, message: `与 ${basename(holder)} 使用同一个决策 ID，列表里只会出现其中一篇` });
        continue;
      }
      this.#upsert({ id: record.id, path, contentHash, record, stamp });
      indexedCount += 1;
    }
    return { indexedCount, diagnostics };
  }

  async keepDeferredLocally(id: string, local: { save(record: DecisionRecord, content?: string): void }, input: { rationale?: string; reasonFactors?: string[] }): Promise<SaveResult> {
    const note = await this.#repository.deferredLocalCopy(id, input);
    // Save the full source, including user-added sections, before removing the vault copy.
    local.save(note.record, note.content);
    const removed = await this.#repository.deleteDeferredRationale(id, note.contentHash);
    try { this.#removePath(removed.path); return { note: removed, indexed: true }; }
    catch (error) { this.#onIndexError(error instanceof Error ? error : new Error(String(error))); return { note: removed, indexed: false }; }
  }

  async publishLocal(record: DecisionRecord, content?: string): Promise<SaveResult> {
    const existing = await this.#repository.findDecision(record.id);
    // A previous attempt may have written the note: never overwrite subsequent Obsidian edits on retry.
    if (!existing) return this.save(record, content);
    if (content === undefined ? serializeDecision(existing.record) !== serializeDecision(record) : existing.contentHash !== createHash("sha256").update(content, "utf8").digest("hex")) throw new Error("知识库已有同编号的不同内容，未覆盖；本机记录仍保留，请核对后处理。");
    try { this.#upsert(existing); return { note: existing, indexed: true }; }
    catch (error) { this.#onIndexError(error instanceof Error ? error : new Error(String(error))); return { note: existing, indexed: false }; }
  }

  async completeDeferredRationale(
    id: string,
    input: DeferredRationaleUpdate,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateDeferredRationale(id, input);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async skipDeferredRationale(id: string): Promise<SaveResult> {
    const note = await this.#repository.skipDeferredRationale(id);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async deleteDeferredRationale(id: string): Promise<SaveResult> {
    const note = await this.#repository.deleteDeferredRationale(id);
    try {
      this.#removePath(note.path);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateLifecycle(id: string, input: DecisionLifecycleUpdate, expectedContentHash: string): Promise<{ note: ParsedStoredNote; indexed: boolean }> {
    const note = await this.#repository.updateLifecycle(id, input, expectedContentHash);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(error instanceof Error ? error : new Error(String(error)));
      return { note, indexed: false };
    }
  }

  async updateExpectedOutcome(
    id: string,
    expectedOutcome: string,
    basis?: string,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateExpectedOutcome(id, expectedOutcome, basis);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateOutcome(id: string, outcome: string, basis?: string): Promise<SaveResult> {
    const note = await this.#repository.updateOutcome(id, outcome, basis);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateReviewDueDate(
    id: string,
    reviewDueDate: string | null,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateReviewDueDate(id, reviewDueDate);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateAppliedPrinciples(
    id: string,
    input: AppliedPrinciplesUpdate,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateAppliedPrinciples(id, input);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateOutcomeReview(
    id: string,
    input: OutcomeReviewUpdate,
    basis?: string,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateOutcomeReview(id, input, basis);
    try {
      this.#upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }
}
