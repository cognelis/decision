import type {
  ObsidianIndexedChunk,
  ObsidianIndexedNoteInput,
  ObsidianIndexedNoteMetadata,
  ObsidianVaultWalkEntry,
  UnchangedNote,
} from "@cognelis/decision-storage";
import { foldedText, isIndexableNotePath, isObsidianSearchIndexDamage, searchTokens } from "@cognelis/decision-storage";

import type { EmbeddingBatch } from "../model/embedding-provider.js";
import { QwenEmbeddingProviderError } from "../semantic/qwen-embedding-provider.js";
import type {
  ObsidianSearchResponse,
  ObsidianSearchResult,
  ObsidianSearchStatus,
} from "../../shared/obsidian-search.js";
import { buildObsidianMarkdownDocument } from "./markdown-chunker.js";

interface VaultRepository {
  iterate(signal?: AbortSignal, unchanged?: UnchangedNote): AsyncIterable<ObsidianVaultWalkEntry>;
  resolveNotePath(relativePath: string): Promise<string>;
}

interface SearchIndex {
  semanticCoverage(model?: string): {
    totalNotes: number;
    semanticNotes: number;
    keywordOnlyNotes: number;
    mismatchedModelNotes: number;
  };
  noteMetadataForPath(relativePath: string): ObsidianIndexedNoteMetadata | null;
  hasNoteDescendant(relativeDirectory: string): boolean;
  replaceNote(note: ObsidianIndexedNoteInput): void;
  /** Records a note read again and found as indexed at its size and time now (index fixtures may leave it out). */
  refreshNoteSource?(relativePath: string, size: number, modifiedAtMs: number): void;
  /** Removes notes not among `activePaths`, keeping any under a folder in `keepUnder`. */
  prune(activePaths: readonly string[], keepUnder?: readonly string[]): void;
  markSynchronized(at: string): void;
  snapshot(): { noteCount: number; chunkCount: number; synchronizedAt: string | null };
  hasNote(relativePath: string): boolean;
  iterateChunks(model?: string): IterableIterator<ObsidianIndexedChunk>;
  close(): void;
}

interface EmbeddingGateway {
  // Synchronization and search may call the gateway concurrently; no
  // gateway-side serialization is assumed by this service.
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch>;
  close?(): Promise<void>;
}

interface VaultWatcher {
  start(): void;
  close(): Promise<unknown>;
}

type TimerHandle = unknown;

export interface ObsidianSearchServiceOptions {
  repository: VaultRepository;
  index: SearchIndex;
  embedding: EmbeddingGateway;
  watcherFactory: (onChange: () => void, onError: () => void) => VaultWatcher;
  openExternal: (url: string) => unknown | Promise<unknown>;
  now: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  shutdownTimeoutMs?: number;
  setShutdownTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearShutdownTimer?: (handle: TimerHandle) => void;
  /** @internal Verifies heavy candidate bounds without retaining note data. */
  onRankingDiagnostics?: (counts: { lexical: number; semantic: number }) => void;
  /** @internal Verifies synchronization does not retain streamed note bodies. */
  onSynchronizationDiagnostics?: (diagnostics: { retainedNoteBodies: number }) => void;
  /** The index found damaged by a read or a write while running, for the runtime to set it aside at the next rebuild. */
  onIndexDamaged?: () => void;
  yieldToMain?: () => Promise<void>;
}

interface RouteCandidate {
  relativePath: string;
  ordinal: number;
  score: number;
  exactTitle: boolean;
  phraseMatch: boolean;
  chunk: SearchChunk;
}

type SearchChunk = Pick<
  ObsidianIndexedChunk,
  "relativePath" | "ordinal" | "title" | "heading" | "text"
>;

const EMBEDDING_BATCH_SIZE = 16;
const MAX_ROUTE_CANDIDATES = 200;
const RRF_CONSTANT = 60;
const SEMANTIC_FLOOR = 0.42;
const WATCH_DEBOUNCE_MS = 500;
const RANKING_YIELD_INTERVAL = 128;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const UNAVAILABLE_MESSAGE = "本地嵌入模型未准备，当前仅使用关键词检索。";
const INDEX_FAILURE_MESSAGE = "部分 Obsidian 笔记暂时无法建立索引。";
const SYNC_FAILURE_MESSAGE = "Obsidian 笔记索引暂时无法同步。";
const WATCH_FAILURE_MESSAGE = "Obsidian 文件监听暂时不可用。";
const QUERY_FAILURE_MESSAGE = "本地语义检索暂时失败，当前仅使用关键词检索。";
const RUNTIME_FAILURE_MESSAGE = "本地嵌入模型暂时无法运行，当前仅使用关键词检索。";
const CLOSED_MESSAGE = "Obsidian 搜索服务已关闭。";
const CLOSE_FAILURE_MESSAGE = "Obsidian 搜索资源未能完整关闭。";
const SEARCH_FAILURE_MESSAGE = "无法执行 Obsidian 搜索。";
const OPEN_FAILURE_MESSAGE = "无法打开 Obsidian 笔记。";
const RETRIEVAL_INSTRUCTION =
  "Retrieve semantically relevant personal Obsidian notes from the local vault";
const MODEL_PROBE = "Obsidian local vault semantic search model probe";

const copyStatus = (status: ObsidianSearchStatus): ObsidianSearchStatus => ({ ...status });
const searchChunk = (chunk: ObsidianIndexedChunk): SearchChunk => ({
  relativePath: chunk.relativePath,
  ordinal: chunk.ordinal,
  title: chunk.title,
  heading: chunk.heading,
  text: chunk.text,
});
// Folded as the query's words are (searchTokens, foldedText), not by the system's language: under a Turkish one the
// note's "Istanbul" was "ıstanbul" and the query's "istanbul", and that word never matched.
const normalize = (value: string): string => foldedText(value).replace(/\s+/gu, " ").trim();
const codePointLength = (value: string): number => Array.from(value).length;

// As NoteCache's settled: past a coarse clock's slot (FAT keeps two seconds), a note's size and time stand for its text.
const SETTLED_MS = 3_000;
/**
 * Whether a stamp the index holds was recorded after its save's clock slot closed. Recorded within it (the
 * watcher reads half a second after a save), a second save of the same size in that slot kept the same stamp,
 * and was never read.
 */
const stampSettled = (note: { indexedAt: string; modifiedAtMs: number }): boolean =>
  Date.parse(note.indexedAt) - note.modifiedAtMs > SETTLED_MS;

const isVector = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((component) => typeof component === "number" && Number.isFinite(component));

const cosine = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  if (!Number.isFinite(denominator) || denominator <= 0) return -1;
  return Math.max(-1, Math.min(1, dot / denominator));
};

/** A chunk as a search reads it: its text normalized and its vector decoded, once. */
interface SearchableChunk {
  chunk: SearchChunk;
  model: string | null;
  vector: Float32Array | null;
  title: string;
  heading: string;
  path: string;
  raw: string;
  plain: string;
}

const searchable = (chunk: ObsidianIndexedChunk): SearchableChunk => ({
  chunk: searchChunk(chunk),
  model: chunk.model,
  vector: isVector(chunk.vector) ? Float32Array.from(chunk.vector) : null,
  title: normalize(chunk.title),
  heading: normalize(chunk.heading ?? ""),
  // Without the ".md" every note's path ends with: "md" or "." found every note as a phrase.
  path: normalize(chunk.relativePath.replace(/\.md$/iu, "")),
  raw: normalize(chunk.text),
  // Also as its excerpt shows it: words copied from an excerpt found nothing where the note had them bold,
  // or behind a link's label.
  plain: normalize(plainText(chunk.text)),
});

const lexicalScore = (
  { title, heading, path, raw, plain }: SearchableChunk,
  phrase: string,
  terms: readonly string[],
): { score: number; exactTitle: boolean; phraseMatch: boolean } | null => {
  const inBody = (value: string): boolean => raw.includes(value) || plain.includes(value);
  const exactTitle = title === phrase;
  const phraseMatch = title.includes(phrase) || heading.includes(phrase) || path.includes(phrase) || inBody(phrase);
  let score = exactTitle ? 20_000 : 0;
  if (title.includes(phrase)) score += 4_000;
  if (heading.includes(phrase)) score += 2_000;
  if (path.includes(phrase)) score += 1_000;
  if (inBody(phrase)) score += 500;
  for (const term of terms) {
    const inTitle = title.includes(term);
    const inHeading = heading.includes(term);
    const inPath = path.includes(term);
    const inText = inBody(term);
    if (inTitle) score += 240;
    if (inHeading) score += 120;
    if (inPath) score += 60;
    if (inText) score += 24;
    // Each word found at all counts first, above all the places one word can be found (444): "预算 招聘"
    // put five notes with one word in their titles above the one note about both.
    if (inTitle || inHeading || inPath || inText) score += 500;
  }
  return score > 0 ? { score, exactTitle, phraseMatch } : null;
};

const candidateBefore = (left: RouteCandidate, right: RouteCandidate): boolean =>
  left.exactTitle !== right.exactTitle
    ? left.exactTitle
    : left.phraseMatch !== right.phraseMatch
      ? left.phraseMatch
      : left.score !== right.score
        ? left.score > right.score
        : left.relativePath !== right.relativePath
          ? left.relativePath < right.relativePath
          : left.ordinal < right.ordinal;

const offerCandidate = (candidates: Map<string, RouteCandidate>, candidate: RouteCandidate): void => {
  const path = candidate.relativePath;
  const current = candidates.get(path);
  if (current !== undefined) {
    if (candidateBefore(candidate, current)) candidates.set(path, candidate);
    return;
  }
  if (candidates.size < MAX_ROUTE_CANDIDATES) {
    candidates.set(path, candidate);
    return;
  }
  let worstPath: string | undefined;
  let worst: RouteCandidate | undefined;
  for (const [candidatePath, value] of candidates) {
    if (worst === undefined || candidateBefore(worst, value)) {
      worst = value;
      worstPath = candidatePath;
    }
  }
  if (worst !== undefined && worstPath !== undefined && candidateBefore(candidate, worst)) {
    candidates.delete(worstPath);
    candidates.set(path, candidate);
  }
};

/** A note's text as its excerpts show it: links as their labels, and no Markdown marks, tags or fences. */
export const plainText = (value: string): string => value
  .replace(/!\[\[/gu, "[[")
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2")
  .replace(/\[\[([^\]]+)\]\]/gu, "$1")
  .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
  .replace(/<[^>]*>/gu, " ")
  .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
  .replace(/```[^\n]*|~~~[^\n]*/gu, " ")
  .replace(/[`*_~]+/gu, "")
  .replace(/\s+/gu, " ")
  .trim();

const plainSnippet = (value: string, query: string): string => {
  const plain = plainText(value);
  const graphemes = [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(plain)]
    .map((segment) => segment.segment);
  if (graphemes.length <= 260 && codePointLength(plain) <= 260) return plain;
  const normalizedPlain = plain.normalize("NFKC").toLocaleLowerCase();
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  let matchIndex = normalizedPlain.indexOf(normalizedQuery);
  if (matchIndex < 0) {
    const termMatches = searchTokens(normalizedQuery)
      .map((term) => normalizedPlain.indexOf(term))
      .filter((index) => index >= 0);
    if (termMatches.length > 0) matchIndex = Math.min(...termMatches);
  }
  const normalizedOffsets = [0];
  for (const grapheme of graphemes) {
    normalizedOffsets.push(normalizedOffsets[normalizedOffsets.length - 1]! + grapheme.normalize("NFKC").toLocaleLowerCase().length);
  }
  const effectiveMatchIndex = Math.max(0, matchIndex);
  let matchStart = normalizedOffsets.findIndex((offset, index) => index > 0 && offset > effectiveMatchIndex) - 1;
  if (matchStart < 0) matchStart = 0;
  const matchLimit = effectiveMatchIndex + Math.max(1, normalizedQuery.length);
  let matchEnd = normalizedOffsets.findIndex((offset) => offset >= matchLimit);
  if (matchEnd <= matchStart) matchEnd = matchStart + 1;
  matchEnd = Math.min(graphemes.length, matchEnd);

  let start = matchStart;
  let end = matchStart;
  let usedPoints = 0;
  const contentPointBudget = 258;
  while (end < matchEnd) {
    const points = Array.from(graphemes[end]!).length;
    if (usedPoints + points > contentPointBudget) break;
    usedPoints += points;
    end += 1;
  }
  let preferLeft = true;
  while (start > 0 || end < graphemes.length) {
    const candidate = preferLeft && start > 0 ? start - 1 : end < graphemes.length ? end : start - 1;
    const points = Array.from(graphemes[candidate]!).length;
    if (usedPoints + points > contentPointBudget) break;
    if (candidate < start) start = candidate;
    else end = candidate + 1;
    usedPoints += points;
    preferLeft = !preferLeft;
  }
  const prefix = start > 0;
  const suffix = end < graphemes.length;
  return `${prefix ? "…" : ""}${graphemes.slice(start, end).join("")}${suffix ? "…" : ""}`;
};

const isUnavailableError = (error: unknown): boolean =>
  error instanceof QwenEmbeddingProviderError &&
  (error.code === "model_missing" || error.code === "checksum_failed");

export class ObsidianSearchService {
  readonly #repository: VaultRepository;
  readonly #index: SearchIndex;
  readonly #embedding: EmbeddingGateway;
  readonly #watcherFactory: ObsidianSearchServiceOptions["watcherFactory"];
  readonly #openExternal: ObsidianSearchServiceOptions["openExternal"];
  readonly #now: () => Date;
  readonly #setTimer: NonNullable<ObsidianSearchServiceOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<ObsidianSearchServiceOptions["clearTimer"]>;
  readonly #onRankingDiagnostics: ObsidianSearchServiceOptions["onRankingDiagnostics"];
  readonly #onSynchronizationDiagnostics: ObsidianSearchServiceOptions["onSynchronizationDiagnostics"];
  readonly #onIndexDamaged: ObsidianSearchServiceOptions["onIndexDamaged"];
  readonly #yieldToMain: NonNullable<ObsidianSearchServiceOptions["yieldToMain"]>;
  readonly #shutdownTimeoutMs: number;
  readonly #setShutdownTimer: NonNullable<
    ObsidianSearchServiceOptions["setShutdownTimer"]
  >;
  readonly #clearShutdownTimer: NonNullable<
    ObsidianSearchServiceOptions["clearShutdownTimer"]
  >;
  readonly #abort = new AbortController();
  #indexTail: Promise<void> = Promise.resolve();
  #recoveryProbe: Promise<boolean> | null = null;
  #recoverySyncQueued = false;
  /** Notes the model would not embed, by path, at the content it would not take. */
  readonly #embeddingRejected = new Map<string, string>();
  /** Notes the last sync could not read and kept as indexed, by path, with the model they were embedded by (or none). */
  #unreadKept = new Map<string, string | null>();
  // ponytail: every chunk's vector held decoded (4 KB a chunk at 1,024 dimensions); an approximate index if
  // vaults outgrow it. Each query decoded them all and normalized every text again: half a second at three
  // thousand notes. Read on the first search after the index is written, and dropped by each write.
  #searchable: SearchableChunk[] | null = null;
  #watcher: VaultWatcher | null = null;
  #timer: TimerHandle | null = null;
  #run: Promise<void> | null = null;
  #operations = new Set<Promise<boolean>>();
  #pendingNormal = false;
  #pendingForce = false;
  #currentForce = false;
  #watcherFailed = false;
  #syncErrorActive = false;
  #queryRestore: Pick<ObsidianSearchStatus, "state" | "message"> | null = null;
  #started = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #status: ObsidianSearchStatus;

  constructor(options: ObsidianSearchServiceOptions) {
    this.#repository = options.repository;
    this.#index = options.index;
    this.#embedding = options.embedding;
    this.#watcherFactory = options.watcherFactory;
    this.#openExternal = options.openExternal;
    this.#now = options.now;
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onRankingDiagnostics = options.onRankingDiagnostics;
    this.#onSynchronizationDiagnostics = options.onSynchronizationDiagnostics;
    this.#onIndexDamaged = options.onIndexDamaged;
    this.#yieldToMain = options.yieldToMain ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    this.#setShutdownTimer =
      options.setShutdownTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clearShutdownTimer =
      options.clearShutdownTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const snapshot = this.#index.snapshot();
    const semanticAvailable = this.#index.semanticCoverage().semanticNotes > 0;
    this.#status = {
      state: snapshot.noteCount > 0 ? "ready" : "idle",
      discoveredNotes: snapshot.noteCount,
      indexedNotes: snapshot.noteCount,
      chunkCount: snapshot.chunkCount,
      processedNotes: 0,
      totalNotes: snapshot.noteCount,
      skippedNotes: 0,
      failedNotes: 0,
      synchronizedAt: snapshot.synchronizedAt,
      semanticAvailable,
      message: null,
    };
  }

  start(): void {
    this.#assertOpen();
    if (this.#started) return;
    this.#started = true;
    this.#openWatcher();
    void this.#enqueueSynchronization(false).catch(() => this.#setSynchronizationError());
  }

  #openWatcher(): void {
    try {
      const watcher = this.#watcherFactory(
        () => this.#debounceSynchronization(),
        () => this.#setWatcherFailure(),
      );
      this.#watcher = watcher;
      try {
        watcher.start();
      } catch {
        this.#setWatcherFailure();
        this.#watcher = null;
        try { void Promise.resolve(watcher.close()).catch(() => undefined); } catch { /* Partial watcher cleanup is best-effort. */ }
      }
    } catch {
      this.#setWatcherFailure();
    }
  }

  status(): ObsidianSearchStatus {
    return copyStatus(this.#status);
  }

  #setWatcherFailure(): void {
    if (this.#closed) return;
    this.#watcherFailed = true;
    this.#queryRestore = null;
    this.#status = { ...this.#status, state: "error", message: WATCH_FAILURE_MESSAGE };
  }

  #applyQueryFailure(error: unknown): void {
    const unavailable = isUnavailableError(error);
    const higherPriority = this.#watcherFailed || this.#status.state === "indexing" || this.#syncErrorActive;
    if (!higherPriority && this.#queryRestore === null) {
      this.#queryRestore = { state: this.#status.state, message: this.#status.message };
    }
    // The index answered (the keyword results are there): only the semantic half failed. Said as "error", the
    // page called the whole index unavailable beside its own results, and asked for a rebuild that changes nothing.
    this.#status = higherPriority
      ? { ...this.#status, semanticAvailable: false }
      : {
          ...this.#status,
          state: "unavailable",
          semanticAvailable: false,
          message: unavailable ? UNAVAILABLE_MESSAGE : QUERY_FAILURE_MESSAGE,
        };
  }

  #clearQueryFailure(): void {
    const restore = this.#queryRestore;
    this.#queryRestore = null;
    if (this.#watcherFailed || this.#status.state === "indexing" || this.#syncErrorActive || restore === null) {
      this.#status = { ...this.#status, semanticAvailable: true };
      return;
    }
    this.#status = { ...this.#status, ...restore, semanticAvailable: true };
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(
      () => false,
      () => true,
    );
    this.#operations.add(settled);
    void settled.then(() => this.#operations.delete(settled));
    return operation;
  }

  async #withIndexLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#indexTail;
    let release = (): void => undefined;
    this.#indexTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.#closed || this.#abort.signal.aborted) throw new Error(CLOSED_MESSAGE);
      return await operation();
    } catch (error) {
      // Every read and write of the index comes through here: damage any of them finds is said once, where the
      // search and the sync each turned it into their own failure and nothing ever set the database aside.
      if (isObsidianSearchIndexDamage(error)) {
        try { this.#onIndexDamaged?.(); } catch { /* Reporting damage never changes the failure. */ }
      }
      throw error;
    } finally {
      release();
    }
  }

  /** A write to the index, under the lock searches read it under: what they keep of it goes with it. */
  #writeIndex(operation: () => void): Promise<void> {
    return this.#withIndexLock(() => {
      this.#searchable = null;
      operation();
    });
  }

  #probeForInstalledModel(): Promise<boolean> {
    if (this.#recoveryProbe !== null) return this.#recoveryProbe;
    const probe = (async () => {
      try {
        const embedded = await this.#embedding.embed([MODEL_PROBE], this.#abort.signal);
        return typeof embedded.model === "string" && embedded.model.length > 0 &&
          embedded.vectors.length === 1 && isVector(embedded.vectors[0]);
      } catch {
        return false;
      }
    })();
    this.#recoveryProbe = probe;
    void probe.finally(() => {
      if (this.#recoveryProbe === probe) this.#recoveryProbe = null;
    });
    return probe;
  }

  #queueRecoverySynchronization(): void {
    if (this.#recoverySyncQueued || this.#closed) return;
    this.#recoverySyncQueued = true;
    this.#status = {
      ...this.#status,
      state: "indexing",
      processedNotes: 0,
      totalNotes: 0,
      failedNotes: 0,
      message: null,
    };
    queueMicrotask(() => {
      if (this.#closed) { this.#recoverySyncQueued = false; return; }
      // An ordinary sync embeds what is keyword-only or of another model, and nothing else; forced, every
      // note in the vault was embedded again on each search while one stayed keyword-only.
      void this.#enqueueSynchronization(false).finally(() => { this.#recoverySyncQueued = false; });
    });
  }

  async search(options: { query: string; limit?: number }): Promise<ObsidianSearchResponse> {
    this.#assertOpen();
    return this.#trackOperation(this.#search(options));
  }

  async #search(options: { query: string; limit?: number }): Promise<ObsidianSearchResponse> {
    const query = typeof options.query === "string" ? options.query.trim() : "";
    const limit = options.limit ?? 20;
    if (
      codePointLength(query) < 1 ||
      codePointLength(query) > 500 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) throw new Error(SEARCH_FAILURE_MESSAGE);

    let queryModel: string | null = null;
    let queryVector: number[] | null = null;
    let coverage: ReturnType<SearchIndex["semanticCoverage"]>;
    try {
      coverage = await this.#withIndexLock(() => this.#index.semanticCoverage());
    } catch {
      throw new Error(SEARCH_FAILURE_MESSAGE);
    }
    const canAttemptSemantic = coverage.semanticNotes > 0;
    // Keyword-only notes beyond those the model would not take, and those a sync cannot read (kept as they were):
    // those are there to be embedded. Counted among them, one unreadable note had every search read the whole
    // vault again, to embed nothing.
    const recoverable = (keywordOnlyNotes: number): boolean => keywordOnlyNotes > new Set([
      ...this.#embeddingRejected.keys(),
      ...[...this.#unreadKept].filter(([, model]) => model === null).map(([path]) => path),
    ]).size;
    const mismatched = (mismatchedModelNotes: number, model: string): boolean =>
      mismatchedModelNotes > [...this.#unreadKept.values()].filter((kept) => kept !== null && kept !== model).length;
    if (!canAttemptSemantic && recoverable(coverage.keywordOnlyNotes)) {
      const installed = await this.#probeForInstalledModel();
      this.#assertOpen();
      if (installed) this.#queueRecoverySynchronization();
    }
    if (canAttemptSemantic) {
      let embeddedQuery: { model: string; vector: number[] } | null = null;
      try {
        const embedded = await this.#embedding.embed([
          `Instruct: ${RETRIEVAL_INSTRUCTION}\nQuery: ${query}`,
        ], this.#abort.signal);
        this.#assertOpen();
        if (
          typeof embedded.model !== "string" ||
          embedded.model.length === 0 ||
          embedded.vectors.length !== 1 ||
          !isVector(embedded.vectors[0])
        ) throw new Error("invalid query embedding");
        embeddedQuery = { model: embedded.model, vector: embedded.vectors[0]! };
      } catch (error) {
        this.#assertOpen();
        this.#applyQueryFailure(error);
      }
      if (embeddedQuery !== null) {
        let modelCoverage: ReturnType<SearchIndex["semanticCoverage"]>;
        try {
          modelCoverage = await this.#withIndexLock(() => this.#index.semanticCoverage(embeddedQuery.model));
        } catch {
          throw new Error(SEARCH_FAILURE_MESSAGE);
        }
        queryModel = embeddedQuery.model;
        queryVector = embeddedQuery.vector;
        this.#clearQueryFailure();
        if (recoverable(modelCoverage.keywordOnlyNotes) || mismatched(modelCoverage.mismatchedModelNotes, embeddedQuery.model)) {
          this.#queueRecoverySynchronization();
        }
      }
    }

    const phrase = normalize(query);
    // As the decisions in the same box are looked for: "Redis、缓存" and "使用Redis缓存" are words, not one string
    // found in no note.
    const terms = [...new Set(searchTokens(query))];
    try {
      const results = await this.#withIndexLock(async () => {
        // RRF ranks are intentionally defined only inside each retained
        // top-200 route cutoff so note text and vectors stay strictly bounded.
        const lexical = new Map<string, RouteCandidate>();
        const semantic = new Map<string, RouteCandidate>();
        let streamedChunks = 0;
        const kept = this.#searchable;
        const read: SearchableChunk[] = [];
        const index = this.#index;
        for (const item of kept ?? (function* () { for (const chunk of index.iterateChunks()) yield searchable(chunk); })()) {
          this.#assertOpen();
          if (kept === null) read.push(item);
          const { chunk } = item;
          const lexicalMatch = lexicalScore(item, phrase, terms);
          if (lexicalMatch !== null) {
            offerCandidate(lexical, {
              relativePath: chunk.relativePath,
              ordinal: chunk.ordinal,
              score: lexicalMatch.score,
              exactTitle: lexicalMatch.exactTitle,
              phraseMatch: lexicalMatch.phraseMatch,
              chunk,
            });
          }
          if (
            queryModel !== null &&
            queryVector !== null &&
            item.model === queryModel &&
            item.vector !== null
          ) {
            const similarity = cosine(queryVector, item.vector);
            if (similarity >= SEMANTIC_FLOOR) {
              offerCandidate(semantic, {
                relativePath: chunk.relativePath,
                ordinal: chunk.ordinal,
                score: similarity,
                exactTitle: false,
                phraseMatch: false,
                chunk,
              });
            }
          }
          streamedChunks += 1;
          if (streamedChunks % RANKING_YIELD_INTERVAL === 0) {
            await this.#yieldToMain();
            this.#assertOpen();
          }
        }
        // Read through: kept for the next query, until a write drops it (under this same lock).
        if (kept === null) this.#searchable = read;
        try { this.#onRankingDiagnostics?.({ lexical: lexical.size, semantic: semantic.size }); } catch { /* Internal diagnostics never affect search. */ }
        const lexicalRanked = [...lexical.values()].sort((left, right) => candidateBefore(left, right) ? -1 : candidateBefore(right, left) ? 1 : 0);
        const semanticRanked = [...semantic.values()].sort((left, right) => candidateBefore(left, right) ? -1 : candidateBefore(right, left) ? 1 : 0);
        const lexicalRanks = new Map(lexicalRanked.map((candidate, index) => [candidate.relativePath, index + 1]));
        const semanticRanks = new Map(semanticRanked.map((candidate, index) => [candidate.relativePath, index + 1]));
        const paths = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
        return [...paths].map((relativePath) => {
          const lexicalCandidate = lexical.get(relativePath);
          const semanticCandidate = semantic.get(relativePath);
          const lexicalRank = lexicalRanks.get(relativePath);
          const semanticRank = semanticRanks.get(relativePath);
          return {
            relativePath,
            lexicalCandidate,
            semanticCandidate,
            score: (lexicalRank === undefined ? 0 : 1 / (RRF_CONSTANT + lexicalRank)) +
              (semanticRank === undefined ? 0 : 1 / (RRF_CONSTANT + semanticRank)),
            exactTitle: lexicalCandidate?.exactTitle === true,
            exactPhrase: lexicalCandidate?.phraseMatch === true,
          };
        }).sort((left, right) =>
          Number(right.exactTitle) - Number(left.exactTitle) ||
          Number(right.exactPhrase) - Number(left.exactPhrase) ||
          right.score - left.score ||
          (right.lexicalCandidate?.score ?? -1) - (left.lexicalCandidate?.score ?? -1) ||
          (right.semanticCandidate?.score ?? -1) - (left.semanticCandidate?.score ?? -1) ||
          (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
        ).slice(0, limit).map((match): ObsidianSearchResult => {
          const chunk = match.lexicalCandidate?.chunk ?? match.semanticCandidate!.chunk;
          return {
            relativePath: chunk.relativePath,
            title: chunk.title,
            heading: chunk.heading,
            snippet: plainSnippet(chunk.text, phrase),
            matchKind: match.lexicalCandidate !== undefined && match.semanticCandidate !== undefined
              ? "hybrid"
              : match.lexicalCandidate !== undefined ? "keyword" : "semantic",
          };
        });
      });
      this.#assertOpen();
      return { query, results, status: this.status() };
    } catch {
      throw new Error(SEARCH_FAILURE_MESSAGE);
    }
  }

  async rebuild(): Promise<ObsidianSearchStatus> {
    this.#assertOpen();
    // Once it erred (a folder unreadable for a moment), watching was said to be off until a restart, and
    // no rebuild could clear that: a rebuild watches again.
    if (this.#started && this.#watcherFailed) {
      const previous = this.#watcher;
      this.#watcher = null;
      if (previous !== null) {
        try { void Promise.resolve(previous.close()).catch(() => undefined); } catch { /* Closing the old watcher is best-effort. */ }
      }
      this.#watcherFailed = false;
      this.#openWatcher();
    }
    await this.#enqueueSynchronization(true);
    this.#assertOpen();
    return this.status();
  }

  async openNote(relativePath: string): Promise<void> {
    this.#assertOpen();
    return this.#trackOperation(this.#openNote(relativePath));
  }

  async #openNote(relativePath: string): Promise<void> {
    try {
      if (!await this.#withIndexLock(() => this.#index.hasNote(relativePath))) throw new Error("not indexed");
      const absolute = await this.#repository.resolveNotePath(relativePath);
      this.#assertOpen();
      const url = new URL("obsidian://open");
      url.searchParams.set("path", absolute);
      await this.#openExternal(url.toString().replace(/\+/gu, "%20"));
      this.#assertOpen();
    } catch {
      this.#assertOpen();
      throw new Error(OPEN_FAILURE_MESSAGE);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    const activeRun = this.#run;
    const activeOperations = [...this.#operations];
    this.#closed = true;
    if (this.#run !== null) this.#cancelledSynchronization();
    this.#abort.abort();
    this.#pendingNormal = false;
    this.#pendingForce = false;
    this.#closePromise = (async () => {
      let cleanupFailed = false;
      const waitForCleanup = async (
        promises: readonly Promise<unknown>[],
      ): Promise<void> => {
        let rejected = false;
        const monitored = promises.map((promise) =>
          promise.then(
            () => undefined,
            () => { rejected = true; },
          ),
        );
        if (!(await this.#waitForShutdown(monitored)) || rejected) {
          cleanupFailed = true;
        }
      };
      const watcher = this.#watcher;
      this.#watcher = null;
      let watcherClosed: Promise<unknown> | undefined;
      try {
        watcherClosed = watcher === null ? undefined : Promise.resolve(watcher.close());
      } catch { cleanupFailed = true; }
      const timer = this.#timer;
      this.#timer = null;
      if (timer !== null) {
        try { this.#clearTimer(timer); } catch { cleanupFailed = true; }
      }
      if (watcherClosed !== undefined) {
        await waitForCleanup([watcherClosed]);
      }
      const activeCleanup: Promise<unknown>[] = [
        ...(activeRun === null ? [] : [activeRun]),
        ...activeOperations.map((operation) =>
          operation.then((failed) => {
            if (failed) cleanupFailed = true;
          }),
        ),
      ];
      await waitForCleanup(activeCleanup);
      try {
        const embeddingClose = this.#embedding.close?.();
        if (embeddingClose !== undefined) {
          await waitForCleanup([embeddingClose]);
        }
      } catch { cleanupFailed = true; }
      try { this.#index.close(); } catch { cleanupFailed = true; }
      if (cleanupFailed) throw new Error(CLOSE_FAILURE_MESSAGE);
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(CLOSED_MESSAGE);
  }

  async #waitForShutdown(
    promises: readonly Promise<unknown>[],
  ): Promise<boolean> {
    if (promises.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: TimerHandle | undefined;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        let timerCleared = true;
        if (timer !== undefined) {
          try { this.#clearShutdownTimer(timer); } catch { timerCleared = false; }
        }
        resolve(completed && timerCleared);
      };
      try {
        timer = this.#setShutdownTimer(
          () => finish(false),
          this.#shutdownTimeoutMs,
        );
        if (settled) {
          try { this.#clearShutdownTimer(timer); } catch { /* Already failed. */ }
        }
      } catch {
        finish(false);
      }
      void Promise.allSettled(promises).then(() => finish(true));
    });
  }

  #debounceSynchronization(): void {
    if (this.#closed) return;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      if (!this.#closed) void this.#enqueueSynchronization(false);
    }, WATCH_DEBOUNCE_MS);
  }

  #enqueueSynchronization(force: boolean): Promise<void> {
    if (this.#closed) return Promise.reject(new Error(CLOSED_MESSAGE));
    if (force) {
      if (!this.#currentForce) this.#pendingForce = true;
    } else {
      this.#pendingNormal = true;
    }
    if (this.#run === null) {
      const run: Promise<void> = this.#drainSynchronizations().finally(() => {
        if (this.#run === run) this.#run = null;
      });
      this.#run = run;
    }
    return this.#run;
  }

  async #drainSynchronizations(): Promise<void> {
    while (!this.#closed && (this.#pendingForce || this.#pendingNormal)) {
      const force = this.#pendingForce;
      this.#pendingForce = false;
      this.#pendingNormal = false;
      this.#currentForce = force;
      try {
        await this.#synchronize(force);
      } catch {
        this.#setSynchronizationError();
      } finally {
        this.#currentForce = false;
      }
    }
    // Let go in the same turn as the last look for more: let go only in `.finally`, a sync asked for in between
    // found a run still there, joined it, and was never run (同步中 for good).
    this.#run = null;
  }

  #setSynchronizationError(): void {
    if (this.#closed) return;
    this.#syncErrorActive = true;
    this.#queryRestore = null;
    this.#status = {
      ...this.#status,
      state: "error",
      message: this.#watcherFailed ? WATCH_FAILURE_MESSAGE : SYNC_FAILURE_MESSAGE,
    };
  }

  #cancelledSynchronization(): boolean {
    if (!this.#closed) return false;
    this.#syncErrorActive = true;
    this.#queryRestore = null;
    this.#status = {
      ...this.#status,
      state: "error",
      message: SYNC_FAILURE_MESSAGE,
    };
    return true;
  }

  async #synchronize(force: boolean): Promise<void> {
    this.#queryRestore = null;
    this.#status = {
      ...this.#status,
      state: "indexing",
      processedNotes: 0,
      totalNotes: 0,
      skippedNotes: 0,
      failedNotes: 0,
      message: this.#watcherFailed ? WATCH_FAILURE_MESSAGE : null,
    };
    let previous: ReturnType<SearchIndex["snapshot"]>;
    try {
      previous = await this.#withIndexLock(() => this.#index.snapshot());
    } catch {
      this.#setSynchronizationError();
      return;
    }
    this.#syncErrorActive = false;
    this.#status = {
      ...this.#status,
      indexedNotes: previous.noteCount,
      chunkCount: previous.chunkCount,
    };
    let model: string | null = null;
    let semanticAvailable = false;
    let providerFailed = false;
    let runtimeFailed = false;
    try {
      const probe = await this.#embedding.embed(
        [MODEL_PROBE],
        this.#abort.signal,
      );
      if (this.#cancelledSynchronization()) return;
      if (
        typeof probe.model !== "string" ||
        probe.model.length === 0 ||
        probe.vectors.length !== 1 ||
        !isVector(probe.vectors[0])
      ) throw new Error("invalid model probe");
      model = probe.model;
      semanticAvailable = true;
    } catch (error) {
      if (this.#cancelledSynchronization()) return;
      if (isUnavailableError(error)) {
        model = null;
      } else if (error instanceof QwenEmbeddingProviderError && error.code === "runtime_unavailable") {
        // The model there but not running (it could not load on this Mac): the pass goes on by keyword, and a
        // vault read through is a sync done. Called a failure, a complete keyword index was said unavailable
        // and 最近同步 never set, whatever was rebuilt; the next pass embeds once the model runs again.
        model = null;
        runtimeFailed = true;
      } else {
        // Not said what (a probe answered with no vectors, say): this pass is not counted done.
        providerFailed = true;
      }
    }

    let failedNotes = 0;
    let processedNotes = 0;
    let discoveredNotes = 0;
    let skippedNotes = 0;
    let completeScan = true;
    // Folders holding one this scan could not read, as near as the scan names it (the folder that listed
    // it): what was indexed under them is kept, and only that.
    const unreadableFolders: string[] = [];
    const unreadKept = new Map<string, string | null>();
    let scanFinished = false;
    let indexFailed = false;
    const activePaths = new Set<string>();
    // A note of the size and time the index has for it, needing no embedding under the model now, is not read:
    // every sync read, decoded and hashed the whole vault for each save Obsidian made.
    const unchanged: UnchangedNote = async (relativePath, size, modifiedAtMs) => {
      if (force || !isIndexableNotePath(relativePath)) return false;
      const current = await this.#withIndexLock(() => this.#index.noteMetadataForPath(relativePath));
      if (current === null || !stampSettled(current) || current.size !== size || current.modifiedAtMs !== modifiedAtMs) return false;
      return !(semanticAvailable && current.model !== model && this.#embeddingRejected.get(relativePath) !== current.contentHash);
    };
    try {
      for await (const entry of this.#repository.iterate(this.#abort.signal, unchanged)) {
        if (this.#cancelledSynchronization()) return;
        if (entry.kind === "unchanged") {
          discoveredNotes += 1;
          processedNotes += 1;
          activePaths.add(entry.relativePath);
          this.#status = { ...this.#status, discoveredNotes, totalNotes: discoveredNotes, processedNotes };
          continue;
        }
        // Our own Markdown answers to the decision services, not to the note index: the walk does not go into
        // it (isDecisionJournalPath), and what an earlier build indexed there is pruned, never being active.
        if (entry.kind === "diagnostic") {
          skippedNotes += 1;
          const path = entry.diagnostic.relativePath;
          if (path === null) {
            // Nothing known of where it is: what is indexed cannot be pruned against this scan.
            completeScan = false;
          } else if (!path.toLocaleLowerCase().endsWith(".md")) {
            unreadableFolders.push(path);
          } else if (isIndexableNotePath(path)) {
            // A folder named like a note keeps what is under it; a note that could not be read, itself.
            if (await this.#withIndexLock(() => this.#index.hasNoteDescendant(path))) unreadableFolders.push(path);
            else {
              activePaths.add(path);
              const kept = await this.#withIndexLock(() => this.#index.noteMetadataForPath(path));
              if (kept !== null) unreadKept.set(path, kept.model);
            }
          }
          this.#status = { ...this.#status, skippedNotes };
          continue;
        }

        const note = entry.note;
        // A name the index cannot hold, nor the app open: a "\" from a Windows zip, or "C:" from a name typed
        // with a "/" in Finder. Left out as unreadable; thrown at the lookups below, it stopped the whole sync
        // there, every note after it unindexed and nothing deleted pruned.
        if (!isIndexableNotePath(note.relativePath)) {
          skippedNotes += 1;
          this.#status = { ...this.#status, skippedNotes };
          continue;
        }
        discoveredNotes += 1;
        activePaths.add(note.relativePath);
        this.#status = { ...this.#status, discoveredNotes, totalNotes: discoveredNotes };
        const current = await this.#withIndexLock(() => this.#index.noteMetadataForPath(note.relativePath));
        // A note the model would not take at this content is not tried again until it changes (or a rebuild
        // asks): tried on every sync, and every search, it had the whole vault embedded over and over.
        const rejected = this.#embeddingRejected.get(note.relativePath) === note.contentHash;
        const stale = force || current === null || current.contentHash !== note.contentHash ||
          (semanticAvailable && current.model !== model && !rejected);
        if (stale) {
          let document: ReturnType<typeof buildObsidianMarkdownDocument> | null = null;
          let vectors: Array<number[] | null> | null = null;
          let embeddedModel: string | null = null;
          try {
            document = buildObsidianMarkdownDocument(note);
            if (model !== null && !providerFailed && (force || !rejected)) {
              const embeddedVectors: number[][] = [];
              for (let start = 0; start < document.chunks.length; start += EMBEDDING_BATCH_SIZE) {
                if (this.#cancelledSynchronization()) return;
                const batch = document.chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
                const embedded = await this.#embedding.embed(
                  batch.map((chunk) => chunk.embeddingText),
                  this.#abort.signal,
                );
                if (this.#cancelledSynchronization()) return;
                if (
                  embedded.model !== model ||
                  embedded.vectors.length !== batch.length ||
                  !embedded.vectors.every(isVector)
                ) throw new Error("invalid embedding batch");
                embeddedVectors.push(...embedded.vectors);
              }
              if (embeddedVectors.length !== document.chunks.length) throw new Error("incomplete embedding batch");
              vectors = embeddedVectors;
              embeddedModel = model;
              this.#embeddingRejected.delete(note.relativePath);
            }
          } catch {
            if (this.#cancelledSynchronization()) return;
            // Not embedded (a chunk past the model's context, say): kept findable by keyword. Left out, and
            // with every note while the model would not start, a note could not be found by its very title.
            if (document !== null) this.#embeddingRejected.set(note.relativePath, note.contentHash);
            vectors = null;
            embeddedModel = null;
          }
          if (document === null) {
            failedNotes += 1;
          } else {
            const built = document;
            try {
              if (this.#cancelledSynchronization()) return;
              await this.#writeIndex(() => this.#index.replaceNote({
                relativePath: note.relativePath,
                title: built.title,
                contentHash: built.contentHash,
                size: note.size,
                modifiedAtMs: note.modifiedAtMs,
                model: embeddedModel,
                chunks: built.chunks.map((chunk, index) => ({
                  id: chunk.id,
                  ordinal: chunk.ordinal,
                  heading: chunk.heading,
                  text: chunk.text,
                  contentHash: chunk.contentHash,
                  vector: vectors?.[index] ?? null,
                })),
              }));
            } catch {
              if (this.#cancelledSynchronization()) return;
              failedNotes += 1;
            }
          }
        } else if (current !== null && Date.now() - note.modifiedAtMs > SETTLED_MS &&
          (current.size !== note.size || current.modifiedAtMs !== note.modifiedAtMs || !stampSettled(current))) {
          // Read again and found as indexed, now settled: its stamp recorded as it stands, so the next sync need not
          // read it. Left at its first reading, one read within its save's slot, or touched since, was read every sync.
          try {
            await this.#writeIndex(() => this.#index.refreshNoteSource?.(note.relativePath, note.size, note.modifiedAtMs));
          } catch {
            // Read again next time, as it was.
          }
        }
        processedNotes += 1;
        this.#status = { ...this.#status, processedNotes, failedNotes };
        try { this.#onSynchronizationDiagnostics?.({ retainedNoteBodies: 0 }); } catch { /* Internal diagnostics never affect sync. */ }
      }
      scanFinished = true;
      this.#unreadKept = unreadKept;
    } catch {
      if (this.#cancelledSynchronization()) return;
      this.#setSynchronizationError();
      return;
    }

    if (this.#cancelledSynchronization()) return;
    if (completeScan) {
      // A note gone from the vault is no longer one the model refused: still
      // counted, it held back re-embedding the notes the model can take.
      for (const path of this.#embeddingRejected.keys()) {
        if (!activePaths.has(path)) this.#embeddingRejected.delete(path);
      }
      try {
        // What is under a folder it could not read is kept, and only that: one such folder stopped pruning
        // the whole vault, and a note renamed or deleted anywhere stayed in the results and failed to open.
        await this.#writeIndex(() => this.#index.prune([...activePaths].sort(), unreadableFolders));
      } catch {
        indexFailed = true;
      }
    }

    let snapshot = {
      noteCount: this.#status.indexedNotes,
      chunkCount: this.#status.chunkCount,
      synchronizedAt: previous.synchronizedAt,
    };
    try {
      snapshot = await this.#withIndexLock(() => this.#index.snapshot());
    } catch {
      indexFailed = true;
    }
    // Notes left out one by one (an encoding it cannot read, a note too large, a folder locked) leave the
    // rest indexed and found: a sync that read the vault through is done, and says how many it left out.
    // Called a failure, the page said the whole index was unavailable beside its own results, and asked
    // for a rebuild that could change nothing.
    // Every note it tried failing is no longer some notes left out (a full disk, a broken index): a failure.
    const everyNoteFailed = processedNotes > 0 && failedNotes === processedNotes;
    const successfulSync = scanFinished && completeScan && !providerFailed && !indexFailed && !everyNoteFailed;
    if (successfulSync) {
      try {
        const nextSynchronizedAt = this.#now().toISOString();
        await this.#withIndexLock(() => this.#index.markSynchronized(nextSynchronizedAt));
        snapshot = { ...snapshot, synchronizedAt: nextSynchronizedAt };
      } catch {
        indexFailed = true;
      }
    }
    const unavailable = !semanticAvailable && !providerFailed;
    const synchronizationFailed = providerFailed || indexFailed || !completeScan || everyNoteFailed;
    this.#syncErrorActive = synchronizationFailed;
    this.#status = {
      state: this.#watcherFailed || synchronizationFailed
        ? "error"
        : unavailable
          ? "unavailable"
          : "ready",
      discoveredNotes,
      indexedNotes: snapshot.noteCount,
      chunkCount: snapshot.chunkCount,
      processedNotes,
      totalNotes: discoveredNotes,
      skippedNotes,
      failedNotes,
      synchronizedAt: snapshot.synchronizedAt,
      semanticAvailable,
      message: this.#watcherFailed
        ? WATCH_FAILURE_MESSAGE
        : providerFailed || indexFailed || !completeScan
          ? SYNC_FAILURE_MESSAGE
          : failedNotes > 0 || skippedNotes > 0
            ? INDEX_FAILURE_MESSAGE
            : unavailable
              ? runtimeFailed ? RUNTIME_FAILURE_MESSAGE : UNAVAILABLE_MESSAGE
              : null,
    };
  }
}
