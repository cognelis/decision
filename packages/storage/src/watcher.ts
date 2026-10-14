import { watch } from "chokidar";
import { existsSync, mkdirSync, watch as watchTree } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type { DecisionIndex } from "./decision-store.js";
import {
  collectMarkdown,
  evictedNote,
  MarkdownRepository,
  stillThere,
  type NoteDiagnostic,
} from "./markdown.js";
import { fileStamp, settled } from "./note-cache.js";

/** Moved off this Mac by iCloud, not deleted: `.name.md.icloud` stands beside where it was. */
const evicted = (path: string): Promise<boolean> =>
  lstat(join(dirname(path), `.${basename(path)}.icloud`)).then(() => true, () => false);

export class DecisionWatcher {
  readonly #repository: MarkdownRepository;
  readonly #index: DecisionIndex;
  readonly #onDiagnostic: (diagnostic: NoteDiagnostic) => void;
  readonly #onSynchronized: (path: string) => void;
  #watcher: { close(): unknown } | null = null;
  #closed = false;
  readonly #pendingReads = new Map<string, symbol>();
  /** Watching the folder as one tree: the notes seen in it, so a folder moved away takes its notes along. */
  readonly #known = new Set<string>();
  readonly #settling = new Map<string | null, NodeJS.Timeout>();

  constructor(
    repository: MarkdownRepository,
    index: DecisionIndex,
    onDiagnostic: (diagnostic: NoteDiagnostic) => void = () => undefined,
    onSynchronized: (path: string) => void = () => undefined,
  ) {
    this.#repository = repository;
    this.#index = index;
    this.#onDiagnostic = onDiagnostic;
    this.#onSynchronized = onSynchronized;
  }

  /** Again once it is not watching (a vault not there at start, a watch ended by an error): a rebuild watches again. */
  start(): void {
    if (this.#watcher !== null || this.#closed) {
      return;
    }
    // chokidar never picks up a folder that appears after it began waiting for it: in a vault that exists,
    // the decisions folder is made now, so the first save on a first run is watched like any later one. A
    // vault that is not there (an unmounted drive) is not made up.
    const decisions = this.#repository.decisionsPath;
    try {
      if (existsSync(dirname(dirname(decisions)))) mkdirSync(decisions, { recursive: true, mode: 0o700 });
    } catch (error) {
      // A folder it may not make (read-only, locked by a sync tool, a full disk) is said, not the app's end.
      this.#onDiagnostic({ path: decisions, message: error instanceof Error ? error.message : String(error) });
    }
    // Not watched while it is not there, so that a later start watches it: chokidar, begun on nothing, never did.
    if (!existsSync(decisions)) return;
    if (process.platform === "darwin" || process.platform === "win32") {
      this.#startTree(decisions);
      return;
    }
    const watcher = watch(decisions, {
      ignoreInitial: false,
      // Only notes are decisions: Finder's .DS_Store, an attachment, an iCloud placeholder or a write's
      // leftover .tmp read as one was a note that "could not be read", or a decision that was never saved.
      // Nor a hidden one, as Obsidian hides them: macOS's ._ copy of every note on exFAT or a share.
      ignored: (path: string, stats?: { isFile(): boolean }) =>
        stats?.isFile() === true && (!path.endsWith(".md") || basename(path).startsWith(".")),
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 50,
      },
    });
    watcher.on("add", (path) => {
      void this.synchronizePath(path);
    });
    watcher.on("change", (path) => {
      void this.synchronizePath(path);
    });
    watcher.on("unlink", (path) => {
      this.removePath(path);
    });
    watcher.on("error", (error) => {
      // Let go, as #startTree lets go of its own: kept, a rebuild's start() found it there and watched nothing.
      void watcher.close().catch(() => undefined);
      if (this.#watcher === watcher) this.#watcher = null;
      this.#onDiagnostic({
        path: this.#repository.decisionsPath,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.#watcher = watcher;
  }

  /**
   * One handle for the whole folder, where the platform watches a tree at once (FSEvents, and Windows).
   * chokidar watched each note on its own there, and a few thousand decisions ran the process out of file
   * descriptors, after which no capture could be saved and no rebuild could read the vault.
   */
  #startTree(decisions: string): void {
    try {
      const tree = watchTree(decisions, { recursive: true });
      tree.on("change", (_type, name) => this.#settle(name === null ? null : join(decisions, String(name))));
      tree.on("error", (error) => {
        // Of no more use once it errs (a drive taken away under it): let go, so that a rebuild watches again.
        tree.close();
        if (this.#watcher === tree) this.#watcher = null;
        this.#onDiagnostic({ path: decisions, message: error.message });
      });
      this.#watcher = tree;
    } catch (error) {
      // A vault that is not there is not watched, as chokidar did not; anything else is said.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#onDiagnostic({ path: decisions, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // What chokidar's first pass did: every note there now is read once.
    this.#settle(null);
  }

  /** As chokidar's awaitWriteFinish: read once a path has been still for a moment. null: the whole folder. */
  #settle(path: string | null): void {
    clearTimeout(this.#settling.get(path));
    this.#settling.set(path, setTimeout(() => {
      this.#settling.delete(path);
      if (this.#closed) return;
      void (path === null ? this.#sweep() : this.#settled(path));
    }, 300));
  }

  async #settled(path: string): Promise<void> {
    // An iCloud placeholder gone with its note not back in its place: deleted on another device, or on iCloud.com,
    // while off this Mac. Kept as evicted, its decision stayed listed, and failed to open, until a restart.
    const note = evictedNote(path);
    if (note !== null) {
      if ((await lstat(path).catch(() => null)) === null && (await lstat(note).catch(() => null)) === null) {
        this.#known.delete(note);
        this.removePath(note);
      }
      return;
    }
    // Hidden, as Obsidian hides it (macOS's ._ copy of every note on exFAT or a share): read as a decision, it
    // was one that could not be read, said again after every capture.
    if (basename(path).startsWith(".")) return;
    const stats = await lstat(path).catch(() => null);
    if (path.endsWith(".md")) {
      if (stats?.isFile() === true) {
        this.#known.add(path);
        await this.synchronizePath(path);
      } else if (stats === null && this.#known.has(path) && !(await evicted(path))) {
        this.#known.delete(path);
        this.removePath(path);
      }
      return;
    }
    // A folder made, moved or removed takes its notes along, and a folder can be named "v1.2"; any other
    // file (Finder's .DS_Store, an attachment, an iCloud placeholder, a write's .tmp gone into its note)
    // is no decision, and no reason to read the folder through.
    const heldNotes = stats === null && [...this.#known].some((known) => known.startsWith(`${path}${sep}`));
    if (stats?.isDirectory() === true || heldNotes) this.#settle(null);
  }

  async #sweep(): Promise<void> {
    let paths: string[];
    const unreadable: NoteDiagnostic[] = [];
    try {
      paths = await collectMarkdown(this.#repository.decisionsPath, unreadable);
    } catch (error) {
      this.#onDiagnostic({ path: this.#repository.decisionsPath, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const standing = stillThere(unreadable);
    const present = new Set(paths);
    for (const path of this.#known) {
      if (!present.has(path) && !standing(path)) {
        this.#known.delete(path);
        this.removePath(path);
      }
    }
    for (const diagnostic of unreadable) this.#onDiagnostic(diagnostic);
    for (const path of paths) {
      if (this.#closed) return;
      this.#known.add(path);
      await this.synchronizePath(path);
    }
  }

  async synchronizePath(path: string): Promise<void> {
    const request = Symbol();
    this.#pendingReads.set(path, request);
    try {
      // Its file as it stood when last read (the reconcile just before, at a start), it is not read: the sweep at
      // every start read all ten thousand notes again. Read and unchanged as indexed, it is not parsed.
      const file = await stat(path, { bigint: true }).catch(() => null);
      if (this.#pendingReads.get(path) !== request) return;
      const stamp = file !== null && settled(file) ? fileStamp(file) : null;
      if (stamp !== null && this.#index.stampForPath?.(path) === stamp) return;
      const indexed = this.#index.contentHashForPath?.(path);
      if (indexed !== undefined && indexed !== null) {
        const content = await readFile(path, "utf8");
        if (this.#pendingReads.get(path) !== request) return;
        if (createHash("sha256").update(content, "utf8").digest("hex") === indexed) {
          if (stamp !== null) this.#index.setStamp?.(path, stamp);
          return;
        }
      }
      const note = await this.#repository.read(path);
      if (this.#pendingReads.get(path) !== request) return;
      if (this.#index.contentHashForPath?.(path) === note.contentHash) {
        return;
      }
      this.#index.upsert(note);
      this.#onSynchronized(path);
    } catch (error) {
      if (this.#pendingReads.get(path) !== request) return;
      this.#onDiagnostic({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.#pendingReads.get(path) === request) {
        this.#pendingReads.delete(path);
      }
    }
  }

  removePath(path: string): void {
    this.#pendingReads.delete(path);
    try {
      const removed = this.#index.removePath(path);
      this.#onSynchronized(path);
      // A copy deleted in Obsidian may be the note the index pointed to: the decision it held is indexed
      // again from a note that still holds it, rather than gone from the list until a rebuild.
      if (typeof removed === "string") void this.#restore(removed, path);
    } catch (error) {
      this.#onDiagnostic({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #restore(id: string, removedPath: string): Promise<void> {
    try {
      // The last by name, as a rebuild indexes one of several notes holding one id.
      const note = (await this.#repository.notesFor(id, dirname(removedPath)))
        .filter((candidate) => candidate.path !== removedPath)
        .at(-1);
      if (this.#closed || note === undefined) return;
      this.#index.upsert(note);
      this.#onSynchronized(note.path);
    } catch (error) {
      this.#onDiagnostic({
        path: this.#repository.decisionsPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#pendingReads.clear();
    for (const timer of this.#settling.values()) clearTimeout(timer);
    this.#settling.clear();
    const watcher = this.#watcher;
    this.#watcher = null;
    await watcher?.close();
  }
}
