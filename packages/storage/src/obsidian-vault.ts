import { createHash } from "node:crypto";
import { constants, watch as fsWatch } from "node:fs";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { watch as chokidarWatch } from "chokidar";

import { NoteCache, settled } from "./note-cache.js";

export interface ObsidianVaultNote {
  relativePath: string;
  content: string;
  contentHash: string;
  size: number;
  modifiedAtMs: number;
}

export interface ObsidianVaultDiagnostic {
  relativePath: string | null;
  reason: string;
}

export interface ObsidianVaultScan {
  notes: ObsidianVaultNote[];
  diagnostics: ObsidianVaultDiagnostic[];
}

export type ObsidianVaultScanEntry =
  | { kind: "note"; note: ObsidianVaultNote }
  | { kind: "diagnostic"; diagnostic: ObsidianVaultDiagnostic };

/** A walk's entry: also a note passed over unread, its file as the walker's `unchanged` said it last read it. */
export type ObsidianVaultWalkEntry = ObsidianVaultScanEntry | { kind: "unchanged"; relativePath: string };

/**
 * Whether a note, by its size and modification time (ms), is as it was last read: asked only of one written
 * longer ago than a coarse clock can tell two writes apart (settled), and only by a walk of the whole vault.
 */
export type UnchangedNote = (relativePath: string, size: number, modifiedAtMs: number) => Promise<boolean>;

const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const EXCLUDED = new Set([".obsidian", ".trash", ".git", ".hg", ".svn", "node_modules"]);

/** The vault folder this app writes its own Markdown into. */
export const DECISION_JOURNAL_FOLDER = "Decision Journal";

/**
 * True for Markdown this app authored — decisions, principles, practice assets,
 * journal entries. Each is searchable through its own structured service, so
 * the vault-wide note index leaves them out rather than returning one record
 * twice by two unrelated routes.
 */
export const isDecisionJournalPath = (relativePath: string): boolean => {
  // A case-insensitive volume (macOS, Windows) keeps the folder under the case it was made with: "decision
  // journal" is the app's own folder there, not notes to index a second time.
  const path = relativePath.toLowerCase();
  const folder = DECISION_JOURNAL_FOLDER.toLowerCase();
  return path === folder || path.startsWith(`${folder}/`);
};

const normalizedPath = (value: string): string => value.split(sep).join("/");
const isMarkdown = (value: string): boolean => value.toLowerCase().endsWith(".md");
// Every name starting with a dot, as Obsidian itself leaves them out: old copies kept in .stversions
// (Syncthing) or .history (VS Code) came up as more results under the same names.
const isExcluded = (value: string): boolean =>
  value.split(/[\\/]+/u).some((part) => part.startsWith(".") || EXCLUDED.has(part.toLowerCase()));
// What the note index's watcher leaves alone: the excluded folders, and the app's own, whose every write
// (a capture, an outcome) had the whole vault read again for notes the index never keeps.
const unwatched = (value: string): boolean => isExcluded(value) || isDecisionJournalPath(value);
const isOutsideRelativePath = (value: string): boolean => {
  const normalized = normalizedPath(value);
  return isAbsolute(value) || win32.isAbsolute(value) || normalized === ".." || normalized.startsWith("../");
};
const comparePaths = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const createAbortError = (): Error => {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw createAbortError();
};
const awaitFilesystem = async <T>(signal: AbortSignal | undefined, operation: () => PromiseLike<T>): Promise<T> => {
  throwIfAborted(signal);
  try {
    const result = await operation();
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    throw error;
  }
};
const acquireFilesystemResource = async <T>(
  signal: AbortSignal | undefined,
  acquire: () => PromiseLike<T>,
  release: (resource: T) => PromiseLike<unknown>,
): Promise<T> => {
  throwIfAborted(signal);
  let resource: T;
  try {
    resource = await acquire();
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    throw error;
  }
  if (signal?.aborted) {
    try {
      await release(resource);
    } catch { /* Abort remains the operation result even if cleanup fails. */ }
    throw createAbortError();
  }
  return resource;
};
const throwIfAbortError = (error: unknown, signal?: AbortSignal): void => {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw createAbortError();
};

interface VaultFilesystem {
  opendir: typeof opendir;
  lstat: typeof lstat;
  realpath: typeof realpath;
  open: typeof open;
  noFollowFlag: number | undefined;
}

export class ObsidianVaultRepository {
  readonly #vaultPath: string;
  readonly #root: string;
  readonly #fs: VaultFilesystem;
  /** By folder iterated, what its notes read as last time: the app's own folders are read again on every search. */
  readonly #folders = new Map<string, NoteCache<ObsidianVaultScanEntry>>();

  constructor(vaultPath: string, dependencies: Partial<VaultFilesystem> = {}) {
    this.#vaultPath = resolve(vaultPath);
    this.#root = this.#vaultPath;
    this.#fs = { opendir, lstat, realpath, open, noFollowFlag: constants.O_NOFOLLOW, ...dependencies };
  }

  async scan(signal?: AbortSignal): Promise<ObsidianVaultScan> {
    const notes: ObsidianVaultNote[] = [];
    const diagnostics: ObsidianVaultDiagnostic[] = [];
    for await (const entry of this.iterate(signal)) {
      if (entry.kind === "note") notes.push(entry.note);
      else if (entry.kind === "diagnostic") diagnostics.push(entry.diagnostic);
    }
    throwIfAborted(signal);
    notes.sort((a, b) => comparePaths(a.relativePath, b.relativePath));
    diagnostics.sort((a, b) => comparePaths(a.relativePath ?? "", b.relativePath ?? ""));
    return { notes, diagnostics };
  }

  /**
   * The whole vault, note by note. Given `unchanged`, a note it says is as last read is passed over unread: read,
   * decoded and hashed whole on every sync, ten thousand notes were read again for each save Obsidian made.
   */
  async *iterate(signal?: AbortSignal, unchanged?: UnchangedNote): AsyncIterableIterator<ObsidianVaultWalkEntry> {
    throwIfAborted(signal);
    const root = { realPath: null as string | null, excluded: await this.#excludedInObsidian(signal) };
    yield* this.#iterateDirectory(this.#root, "", null, root, signal, undefined, unchanged);
    throwIfAborted(signal);
  }

  /**
   * What the reader excluded in Obsidian (设置 › 文件与链接 › 排除的文件): its plain paths, as the prefixes Obsidian
   * takes them for. Its regular expressions (/…/) are not followed. Read past, an excluded template or archive came
   * back in every search as a note.
   */
  async #excludedInObsidian(signal?: AbortSignal): Promise<string[]> {
    throwIfAborted(signal);
    const settings = join(this.#root, ".obsidian", "app.json");
    try {
      // Obsidian's own settings, not a note: read beside the walk's own file access, a small file or none.
      const file = await lstat(settings);
      if (!file.isFile() || file.size > 1024 * 1024) return [];
      const filters = (JSON.parse(await readFile(settings, "utf8")) as { userIgnoreFilters?: unknown } | null)?.userIgnoreFilters;
      return Array.isArray(filters)
        ? filters.filter((filter): filter is string => typeof filter === "string" && filter.length > 0 && !filter.startsWith("/"))
        : [];
    } catch {
      return [];
    } finally {
      throwIfAborted(signal);
    }
  }

  /** Whether `unchanged` says this note is as last read: its own file, settled, and of that size and time. */
  async #unread(absolute: string, relativePath: string, unchanged: UnchangedNote, signal?: AbortSignal): Promise<boolean> {
    try {
      const file = await awaitFilesystem(signal, () => this.#fs.lstat(absolute, { bigint: true }));
      if (!file.isFile() || file.isSymbolicLink() || !settled(file)) return false;
      return await unchanged(relativePath, Number(file.size), Number(file.mtimeNs) / 1_000_000);
    } catch (error) {
      throwIfAbortError(error, signal);
      // Read, as every note was: what cannot be said here is said by reading it.
      return false;
    }
  }

  /** Read a subtree while retaining the original vault's path validation. */
  async *iterateFolder(relativeDirectory: string, signal?: AbortSignal): AsyncIterableIterator<ObsidianVaultScanEntry> {
    const segments = relativeDirectory.split("/");
    if (!relativeDirectory || isOutsideRelativePath(relativeDirectory) || relativeDirectory.includes("\\") ||
        segments.some((part) => !part || part === "." || part === "..") || isExcluded(relativeDirectory)) {
      throw new Error("Invalid vault-relative directory");
    }
    try {
      // The vault itself may be reached through a link (iCloud, another disk); nothing within it may be one.
      const rootStat = await awaitFilesystem(signal, async () => this.#fs.lstat(await this.#fs.realpath(this.#root)));
      if (!rootStat.isDirectory()) throw new Error("Invalid directory");
      let directory = this.#root;
      for (const segment of segments) {
        directory = join(directory, segment);
        const stat = await awaitFilesystem(signal, () => this.#fs.lstat(directory));
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid directory");
      }
      const root = { realPath: await awaitFilesystem(signal, () => this.#fs.realpath(this.#root)) };
      // A note is still found, checked and listed here each time; only one unchanged since it was read is
      // not read again. Its file is the same inode with the same times, under folders checked just now.
      const cache = this.#folders.get(relativeDirectory) ?? new NoteCache(
        (path) => this.#fs.lstat(path, { bigint: true }),
        (entry: ObsidianVaultScanEntry) => entry.kind === "note",
      );
      this.#folders.set(relativeDirectory, cache);
      try {
        for await (const entry of this.#iterateDirectory(directory, relativeDirectory, null, root, signal, cache)) {
          if (entry.kind !== "unchanged") yield entry;
        }
      } finally {
        // Also when cut short: a reader stopping at its cap, or out of time.
        cache.sweep();
      }
    } catch (error) {
      throwIfAbortError(error, signal);
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        // An absent knowledge folder is an empty source, not a corrupt index.
        const vault = await awaitFilesystem(signal, async () => this.#fs.lstat(await this.#fs.realpath(this.#root))).catch(() => null);
        throwIfAborted(signal);
        if (vault?.isDirectory()) return;
      }
      yield { kind: "diagnostic", diagnostic: { relativePath: null, reason: "Unable to read directory" } };
    }
  }

  async *#iterateDirectory(
    directory: string,
    prefix: string,
    validatedParentPrefix: string | null,
    root: { realPath: string | null; excluded?: readonly string[] },
    signal?: AbortSignal,
    cache?: NoteCache<ObsidianVaultScanEntry>,
    unchanged?: UnchangedNote,
  ): AsyncGenerator<ObsidianVaultWalkEntry> {
    let openedDirectory;
    let diagnosticRelativePath = validatedParentPrefix;
    try {
      openedDirectory = await acquireFilesystemResource(
        signal,
        () => this.#fs.opendir(directory),
        (resource) => resource.close(),
      );
      const directoryReal = await awaitFilesystem(signal, () => this.#fs.realpath(directory));
      // The vault root may be a link to the vault (iCloud, another disk): it is checked as what it leads to.
      const isRoot = root.realPath === null && !prefix;
      const directoryStat = await awaitFilesystem(signal, () => this.#fs.lstat(isRoot ? directoryReal : directory));
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Invalid directory");
      if (root.realPath === null) {
        if (prefix) throw new Error("Vault root was not validated");
        root.realPath = directoryReal;
      } else {
        const inside = relative(root.realPath, directoryReal);
        if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          throw new Error("Directory escaped vault");
        }
      }
      diagnosticRelativePath = prefix || null;
      const iterator = openedDirectory[Symbol.asyncIterator]();
      while (true) {
        const result = await awaitFilesystem(signal, () => iterator.next());
        if (result.done) break;
        throwIfAborted(signal);
        const entry = result.value;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Moved off this Mac by iCloud ("Optimize Mac Storage"): its placeholder, .name.md.icloud, stands for a
        // note still in the vault, said as one not read (as the decision folders say it, evictedNote). Passed over
        // as a hidden file, the note left the whole-vault index and every search without a word.
        const excludedByReader = (path: string): boolean =>
          root.excluded?.some((filter) => path.startsWith(filter) || `${path}/`.startsWith(filter)) === true;
        // A folder's walk says it too: passed over there, a decision in iCloud left every search while the search said
        // its source was read in full.
        const evicted = entry.isFile() ? /^\.(.+\.md)\.icloud$/iu.exec(entry.name)?.[1] : undefined;
        if (evicted !== undefined) {
          // Excluded in Obsidian by its own name, it is left out evicted as it is on this Mac: said, it was counted
          // among the notes not indexed and kept in the results.
          const note = prefix ? `${prefix}/${evicted}` : evicted;
          if (!isExcluded(prefix) && !excludedByReader(note)) {
            yield { kind: "diagnostic", diagnostic: { relativePath: note, reason: "Markdown note is in iCloud, not on this Mac" } };
          }
          continue;
        }
        if (isExcluded(rel)) continue;
        if (excludedByReader(rel)) continue;
        // Not followed, as it may lead out of the vault. In a folder's walk (a decision source) a note behind a link is said
        // as one not read, as a linked folder is, or a search over the folder said it was read in full; the whole vault's
        // walk reads the note a link inside it points to where it is.
        if (entry.isSymbolicLink()) {
          if (cache !== undefined && /\.md$/iu.test(entry.name)) yield { kind: "diagnostic", diagnostic: { relativePath: rel, reason: "Symbolic link is not followed" } };
          continue;
        }
        // From the vault's root, as only the whole vault is walked (the note index): the app's own folder is
        // not opened. Read through and only then passed over, its ten thousand notes were read on every sync.
        if (!prefix && isDecisionJournalPath(rel)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          yield* this.#iterateDirectory(absolute, rel, diagnosticRelativePath, root, signal, cache, unchanged);
        } else if (entry.isFile() && isMarkdown(entry.name)) {
          // ponytail: size and modification time stand for the contents, as the index keeps them; a file replaced
          // by one of the same size and time (a tool restoring both) is not read until it changes again.
          if (unchanged !== undefined && await this.#unread(absolute, rel, unchanged, signal)) {
            yield { kind: "unchanged", relativePath: rel };
            continue;
          }
          const rootReal = root.realPath;
          const noteEntry = cache === undefined
            ? await this.#readNote(absolute, rel, rootReal, signal)
            : await cache.read(absolute, () => this.#readNote(absolute, rel, rootReal, signal));
          throwIfAborted(signal);
          // A note at the vault's top that is not the vault's (gone since it was listed, or listed through a handle
          // that led elsewhere) is no note of it: said with no folder to name, it made the whole scan unknown, and
          // nothing deleted anywhere was pruned.
          if (noteEntry.kind === "diagnostic" && noteEntry.diagnostic.relativePath === null) continue;
          yield noteEntry;
        }
      }
    } catch (error) {
      throwIfAbortError(error, signal);
      // Named by itself where it stands in the vault as a folder (a permission refused): what is indexed under it
      // is kept, and only that. Named by its parent, a top-level folder was the whole vault, and nothing deleted
      // anywhere was pruned. A name not there as a folder (gone, or listed through a handle that led out of the
      // vault) is not said: its parent stands for it.
      if (prefix && diagnosticRelativePath !== prefix) {
        const own = await this.#fs.lstat(directory).catch(() => null);
        throwIfAborted(signal);
        if (own?.isDirectory() === true && !own.isSymbolicLink()) diagnosticRelativePath = prefix;
      }
      yield {
        kind: "diagnostic",
        diagnostic: { relativePath: diagnosticRelativePath, reason: "Unable to read directory" },
      };
    } finally {
      try {
        await openedDirectory?.close();
        throwIfAborted(signal);
      } catch (error) {
        throwIfAbortError(error, signal);
        /* Async iteration closes native Dir handles automatically. */
      }
    }
  }

  async #readNote(
    absolute: string,
    relativePath: string,
    rootReal: string,
    signal?: AbortSignal,
  ): Promise<ObsidianVaultScanEntry> {
    const parentEnd = relativePath.lastIndexOf("/");
    let diagnosticRelativePath: string | null = parentEnd === -1 ? null : relativePath.slice(0, parentEnd);
    try {
      let cumulative = this.#root;
      const rootStat = await awaitFilesystem(signal, () => this.#fs.lstat(rootReal));
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Invalid vault root");
      const segments = relativePath.split("/");
      for (const [index, segment] of segments.entries()) {
        cumulative = join(cumulative, segment);
        const componentPath = cumulative;
        const component = await awaitFilesystem(signal, () => this.#fs.lstat(componentPath));
        const isFinal = index === segments.length - 1;
        if (component.isSymbolicLink() || (isFinal ? !component.isFile() : !component.isDirectory())) {
          throw new Error("Invalid note path component");
        }
      }
      const candidateReal = await awaitFilesystem(signal, () => this.#fs.realpath(absolute));
      const candidateRelative = relative(rootReal, candidateReal);
      if (!candidateRelative || candidateRelative === ".." || candidateRelative.startsWith(`..${sep}`) || isAbsolute(candidateRelative)) {
        throw new Error("Note escaped vault");
      }
      diagnosticRelativePath = relativePath;
      const handle = await acquireFilesystemResource(
        signal,
        () => this.#fs.open(absolute, constants.O_RDONLY | (this.#fs.noFollowFlag ?? 0)),
        (resource) => resource.close(),
      );
      try {
        const pathStat = await awaitFilesystem(signal, () => this.#fs.lstat(absolute, { bigint: true }));
        const openedReal = await awaitFilesystem(signal, () => this.#fs.realpath(absolute));
        const stat = await awaitFilesystem(signal, () => handle.stat({ bigint: true }));
        const openedRelative = relative(rootReal, openedReal);
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          pathStat.dev !== stat.dev ||
          pathStat.ino !== stat.ino ||
          !openedRelative ||
          openedRelative === ".." ||
          openedRelative.startsWith(`..${sep}`) ||
          isAbsolute(openedRelative)
        ) throw new Error("Opened note no longer matches vault path");
        if (stat.size > BigInt(MAX_NOTE_BYTES)) {
          return { kind: "diagnostic", diagnostic: { relativePath, reason: "Markdown note exceeds 5 MiB" } };
        }
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        const initialSize = Number(stat.size);
        while (bytesRead < MAX_NOTE_BYTES + 1) {
          throwIfAborted(signal);
          const remainingLimit = MAX_NOTE_BYTES + 1 - bytesRead;
          const knownRemaining = initialSize - bytesRead;
          const requested = Math.min(
            READ_CHUNK_BYTES,
            remainingLimit,
            knownRemaining > 0 ? knownRemaining + 1 : knownRemaining === 0 ? 1 : READ_CHUNK_BYTES,
          );
          const buffer = Buffer.allocUnsafe(requested);
          const result = await awaitFilesystem(signal, () => handle.read(buffer, 0, requested, bytesRead));
          if (result.bytesRead < 0 || result.bytesRead > requested) throw new Error("Invalid note read result");
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
          chunks.push(buffer.subarray(0, result.bytesRead));
          throwIfAborted(signal);
        }
        const finalStat = await awaitFilesystem(signal, () => handle.stat({ bigint: true }));
        if (
          stat.dev !== finalStat.dev ||
          stat.ino !== finalStat.ino ||
          stat.size !== finalStat.size ||
          stat.mtimeNs !== finalStat.mtimeNs ||
          finalStat.size !== BigInt(bytesRead)
        ) throw new Error("Note changed while reading");
        if (bytesRead > MAX_NOTE_BYTES) {
          return { kind: "diagnostic", diagnostic: { relativePath, reason: "Markdown note exceeds 5 MiB" } };
        }
        const noteDecoder = new TextDecoder("utf-8", { fatal: true });
        const hash = createHash("sha256");
        const contentParts: string[] = [];
        for (const chunk of chunks) {
          hash.update(chunk);
          contentParts.push(noteDecoder.decode(chunk, { stream: true }));
        }
        contentParts.push(noteDecoder.decode());
        return {
          kind: "note",
          note: {
            relativePath,
            content: contentParts.join(""),
            contentHash: hash.digest("hex"),
            size: Number(finalStat.size),
            modifiedAtMs: Number(finalStat.mtimeNs) / 1_000_000,
          },
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      throwIfAbortError(error, signal);
      return {
        kind: "diagnostic",
        diagnostic: { relativePath: diagnosticRelativePath, reason: "Unable to read Markdown note" },
      };
    }
  }

  /**
   * Whether a note is there, for telling one deleted or moved from one that cannot be read just now: false only
   * when the vault is there, the file is not, and iCloud holds no placeholder for it. Anything else (a link, a
   * folder it cannot read, the vault not mounted, an unsafe path) is no answer, and throws.
   */
  async noteExists(relativePath: string): Promise<boolean> {
    try {
      await this.resolveNotePath(relativePath);
      return true;
    } catch (unresolved) {
      const segments = relativePath.split("/");
      if (!isMarkdown(relativePath) || isAbsolute(relativePath) || relativePath.includes("\\") ||
        segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw unresolved;
      await this.#fs.lstat(this.#root);
      const placeholder = join(this.#root, ...segments.slice(0, -1), `.${segments.at(-1)!}.icloud`);
      if (await this.#fs.lstat(placeholder).then(() => true, () => false)) throw unresolved;
      const missing = await this.#fs.lstat(join(this.#root, ...segments))
        .then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      if (missing) return false;
      throw unresolved;
    }
  }

  async resolveNotePath(relativePath: string): Promise<string> {
    if (!relativePath || isAbsolute(relativePath) || win32.isAbsolute(relativePath) || relativePath.includes("\\") || !isMarkdown(relativePath)) {
      throw new Error("Invalid vault-relative Markdown path");
    }
    const normalized = normalizedPath(relativePath);
    if (normalized !== relativePath || normalized === "." || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("Invalid vault-relative Markdown path");
    }
    try {
      const absolute = resolve(this.#root, ...normalized.split("/"));
      const lexical = relative(this.#root, absolute);
      if (!lexical || lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
        throw new Error("Path escapes vault");
      }
      const segments = normalized.split("/");
      let cumulative = this.#root;
      for (const segment of segments) {
        cumulative = join(cumulative, segment);
        const component = await this.#fs.lstat(cumulative);
        if (component.isSymbolicLink()) throw new Error("Symlink path");
      }
      const stat = await this.#fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Note is not a regular file");
      const [rootReal, targetReal] = await Promise.all([this.#fs.realpath(this.#root), this.#fs.realpath(absolute)]);
      const realRelative = relative(rootReal, targetReal);
      if (!realRelative || realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
        throw new Error("Path escapes vault");
      }
      return absolute;
    } catch {
      throw new Error("Unable to resolve vault note");
    }
  }
}

interface WatcherLike {
  on(event: string, listener: (...args: unknown[]) => void): WatcherLike;
  close(): Promise<unknown>;
}

interface WatcherDependencies {
  watch?: (paths: string, options: object) => WatcherLike;
  relative?: typeof relative;
  platform?: NodeJS.Platform;
}

export class ObsidianVaultWatcher {
  readonly #vaultPath: string;
  readonly #onChange: () => void;
  readonly #onError: () => void;
  readonly #watch: (paths: string, options: object) => WatcherLike;
  readonly #relative: typeof relative;
  readonly #recursive: boolean;
  #watcher: WatcherLike | null = null;

  constructor(vaultPath: string, onChange: () => void, onError: () => void, dependencies: WatcherDependencies = {}) {
    this.#vaultPath = resolve(vaultPath);
    this.#onChange = onChange;
    this.#onError = onError;
    this.#relative = dependencies.relative ?? relative;
    const platform = dependencies.platform ?? process.platform;
    this.#recursive = dependencies.watch === undefined && (platform === "darwin" || platform === "win32");
    this.#watch = dependencies.watch ?? ((paths, options) =>
      chokidarWatch(paths, options as Parameters<typeof chokidarWatch>[1]));
  }

  start(): void {
    if (this.#watcher) return;
    if (this.#recursive) {
      this.#startRecursive();
      return;
    }
    this.#watcher = this.#watch(this.#vaultPath, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      ignored: (path: unknown, stats?: { isFile(): boolean }) => {
        const value = typeof path === "string" ? path : String(path);
        const relativeResult = this.#relative(this.#vaultPath, value);
        const rel = normalizedPath(relativeResult);
        if (isOutsideRelativePath(relativeResult) || unwatched(rel)) return true;
        return stats?.isFile() === true ? !isMarkdown(rel) : false;
      },
    });
    for (const event of ["add", "change", "unlink"]) {
      this.#watcher.on(event, (path) => {
        if (this.#isRelevantPath(path)) this.#onChange();
      });
    }
    this.#watcher.on("error", () => this.#onError());
  }

  /**
   * One handle for the whole vault, where the platform watches a tree at once (FSEvents, and Windows).
   * chokidar watched each note on its own there, and a vault of a few thousand notes ran the process out of
   * file descriptors, after which the scan could not open the notes either. A sync reads the vault through,
   * so what matters is only that a note, or a folder holding notes, changed.
   */
  #startRecursive(): void {
    const watcher = fsWatch(this.#vaultPath, { recursive: true });
    const adapter: WatcherLike = {
      on: () => adapter,
      close: async () => watcher.close(),
    };
    watcher.on("change", (_type, filename) => {
      if (filename === null) {
        this.#onChange();
        return;
      }
      const rel = normalizedPath(String(filename));
      if (unwatched(rel)) return;
      if (isMarkdown(rel)) {
        this.#onChange();
        return;
      }
      // A folder moved or removed takes its notes with it, and a folder can be
      // named "v1.2" as well as a file can: only a file that is not a note is
      // let pass. Gone already, it may have been either.
      void lstat(join(this.#vaultPath, rel)).then(
        (stats) => {
          if (stats.isDirectory() && this.#watcher === adapter) this.#onChange();
        },
        () => {
          if (this.#watcher === adapter) this.#onChange();
        },
      );
    });
    watcher.on("error", () => this.#onError());
    this.#watcher = adapter;
  }

  #isRelevantPath(path: unknown): boolean {
    const value = typeof path === "string" ? path : String(path);
    const relativeResult = this.#relative(this.#vaultPath, value);
    const rel = normalizedPath(relativeResult);
    return !isOutsideRelativePath(relativeResult) && !unwatched(rel) && isMarkdown(rel);
  }

  async close(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = null;
    await watcher?.close();
  }
}
