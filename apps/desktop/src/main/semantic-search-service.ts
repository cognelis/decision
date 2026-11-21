import {
  buildMethodologyRecall,
  type MethodologyRecallInput,
  type MethodologyRecallMatch,
  type MethodologyRecord,
} from "@cognelis/decision-core";
import {
  type DecisionContextDocument,
  type DecisionContextSnapshot,
  type IndexedDecision,
  searchedContext,
  SemanticVectorIndex,
  type SemanticVectorEntityType,
  type SemanticVectorMetadata,
} from "@cognelis/decision-storage";
import { createHash } from "node:crypto";

import { type ContextSimilarity, noteText } from "./decision-context-service.js";
import type { EmbeddingBatch } from "./model/embedding-provider.js";

interface EmbeddingGateway {
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch>;
  close?(): Promise<void>;
}

interface SearchDocument {
  entityId: string;
  contentHash: string;
  /** The note its text was made from, by its content hash, and how (decisionSource): a decision's. */
  sourceHash?: string;
  text: string;
}

/** Every decision known by what changes with its note, and read whole only where its text is needed. */
interface DecisionSource {
  stamps(): ReadonlyArray<Pick<IndexedDecision, "id" | "contentHash">>;
  load(ids: string[]): IndexedDecision[];
}

interface CurrentSources {
  decisions: DecisionSource;
  methodologies: MethodologyRecord[];
}

/** `floor`: the least similarity kept (default 0.45); `nearest`: how many of the nearest are returned (default 20). */
export interface SimilarityOptions {
  floor?: number;
  nearest?: number;
}

export type EntrySimilarity =
  | { near: Array<{ id: string; similarity: number }>; pending: number }
  | { unavailable: "model_missing" | "timeout" | "failed" };

export interface SemanticDecisionMatch {
  decision: IndexedDecision;
  matchKind: "keyword" | "semantic" | "hybrid";
  relevance: number;
}

// The local embedding context is intentionally kept at 2,048 tokens for
// responsive search. Keep the most useful leading fields within a safe bound
// for Chinese, Markdown, and code-heavy decisions.
const MAX_DOCUMENT_CHARACTERS = 700;
// The local model embeds one text after another however many a call holds, and a search's query waits out the call
// under way: sixteen of 700 characters took about a second on an M-series Mac, a search's whole allowance (similarTo).
const EMBEDDING_BATCH_SIZE = 4;
// The bridge gives a context search five seconds, four of them the scan's: the query's embedding runs beside the scan
// and gets two and a half, and a slower one is a search without the supplement, not a search the agent never hears back
// from. One second was missed 33 to 42 times a run of sixteen scenarios at a load of 8 (R8), most just after a start.
const QUERY_DEADLINE_MS = 2_500;
// The nearest records judged for scope (assessDecisionApplicability): all of them, a PR's 3,000 files held the main
// process for seconds over records nobody would see. Past these, one in scope is not supplemented.
const NEAREST_RECORDS = 20;
// Records a search may embed itself, in scope and with no current vector (IMP-137), so one written a moment ago is found
// by meaning at once. More are left to the sync, the search keyword-only for them as before.
const MAX_FRESH_RECORDS = 4;
// What embedding them may add to a search, from its query's vector on, waiting behind a sync's batch (about a quarter
// second) included: one at a time, and those not done by then are left to the sync. Raced only against the query's own
// deadline, four long ones behind a batch took a search to it, and its supplement from vectors made already with it.
const FRESH_BUDGET_MS = 250;
// At most these without a vector judged for whether the search could show them, in the same budget: each judged against a
// PR's 3,000 files, two thousand of another project's took 869 ms (R10-CR). Not known by then to be few, none are embedded.
const MAX_FRESH_JUDGED = 32;
const SEMANTIC_FLOOR = 0.45;
// What a search waits for the vectors of preferences and ideas not yet made, once the query's is in hand.
const ENTRY_BUDGET_MS = 1_800;
const MAX_ENTRY_VECTORS = 5_000;
const ADAPTIVE_SEMANTIC_TRIGGER = 0.4;
const ADAPTIVE_SEMANTIC_FLOOR = 0.32;
const ADAPTIVE_SEMANTIC_WINDOW = 0.1;
const MAX_SEMANTIC_ONLY_RESULTS = 12;
const MAX_ADAPTIVE_SEMANTIC_RESULTS = 6;
const RETRIEVAL_INSTRUCTION =
  "Retrieve past software decisions and accepted operating principles that are semantically relevant to the user query";

const compactText = (parts: Array<string | null>): string =>
  parts
    .filter((value): value is string => value !== null)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n")
    .slice(0, MAX_DOCUMENT_CHARACTERS);

const documentHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * How a decision's text is made (decisionDocument), kept with the hash of the note a vector was made from: changed,
 * every decision is read once more and embedded again where its text came out different. Known by the note's hash
 * alone, a vector made the old way was taken as current for as long as its note stood unchanged.
 */
// v3: the context without the lines around an adopted summary (searchedContext).
const DECISION_DOCUMENT_RECIPE = "v3";
const decisionSource = (decision: Pick<IndexedDecision, "contentHash">): string =>
  `${DECISION_DOCUMENT_RECIPE}:${decision.contentHash}`;

// The reader's own words first, what was expected and what came of it among them, and the context captured with the
// question last: within the 700 characters, a long captured task and its framing (a quarter of the decisions) came
// before the outcome and the lesson and cut them off, the part of a decision most worth finding again.
const decisionDocument = (decision: IndexedDecision): SearchDocument => {
  const text = compactText([
    decision.question,
    decision.selectedAnswer,
    decision.rationale,
    decision.expectedOutcome ?? null,
    decision.outcome,
    decision.outcomeLesson,
    decision.project,
    decision.context === null ? null : searchedContext(decision.context),
  ]);
  return {
    entityId: decision.id,
    contentHash: documentHash(text),
    sourceHash: decisionSource(decision),
    text,
  };
};

/** As DECISION_DOCUMENT_RECIPE, for how a summary's text is made (summaryDocument). */
const SUMMARY_DOCUMENT_RECIPE = "v1";
const summarySource = (document: Pick<DecisionContextDocument, "contentHash">): string =>
  `${SUMMARY_DOCUMENT_RECIPE}:${document.contentHash ?? ""}`;

// What was chosen, what it was weighed against and what held it in, and only then the note's own account: the body runs
// past the 700 characters at the median (962), and the options are in the note's properties alone (IMP-117: 50 of 536
// appear in its text). Taken from the top, the body left them out.
const summaryDocument = (document: DecisionContextDocument): SearchDocument => {
  const text = compactText([
    document.title,
    document.summary,
    ...(document.optionsPresented ?? []),
    ...(document.constraintsRevealed ?? []),
    document.appliesWhen,
    document.caution,
    document.tags.join(" "),
    noteText(document),
  ]);
  return {
    entityId: document.id,
    contentHash: documentHash(text),
    sourceHash: summarySource(document),
    text,
  };
};
// Worked out once per note as read (a scan keeps an unchanged note's record): searches compare it every time.
const summaryDocuments = new WeakMap<DecisionContextDocument, SearchDocument>();
const summaryOf = (document: DecisionContextDocument): SearchDocument => {
  let found = summaryDocuments.get(document);
  if (found === undefined) {
    found = summaryDocument(document);
    summaryDocuments.set(document, found);
  }
  return found;
};

const methodologyDocument = (
  record: Pick<MethodologyRecord, "id" | "title" | "principle"> & { appliesWhen: string | null; caution: string | null },
): SearchDocument => {
  const text = compactText([
    record.title,
    record.principle,
    record.appliesWhen,
    record.caution,
  ]);
  return {
    entityId: record.id,
    contentHash: documentHash(text),
    text,
  };
};

const VECTOR_KIND = {
  summarize: "summary",
  decisions: "decision",
  principles: "methodology",
} as const satisfies Record<DecisionContextDocument["source"], SemanticVectorEntityType>;

/**
 * Whether a vector is of the note as it is now. A summary's by the very text it was made of: its title is its file's
 * name, which a rename changes and the note's hash does not, and known by the note a renamed summary was scored by its
 * old name. A decision's by the note it was made from, its text being the index's; a principle's by its text alone.
 */
const madeFrom = (document: DecisionContextDocument, stored: SemanticVectorMetadata): boolean =>
  document.source === "summarize"
    ? stored.contentHash === summaryOf(document).contentHash
    : document.source === "decisions"
      ? stored.sourceHash === decisionSource({ contentHash: document.contentHash ?? "" })
      : stored.contentHash === methodologyDocument({
          id: document.id,
          title: document.title,
          principle: document.summary,
          appliesWhen: document.appliesWhen,
          caution: document.caution,
        }).contentHash;

const cosine = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  if (left.length === 0 || left.length !== right.length) return -1;
  let value = 0;
  for (let index = 0; index < left.length; index += 1) {
    value += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return Math.max(-1, Math.min(1, value));
};

const semanticWeight = (similarity: number, baseline = 0.35): number =>
  Math.max(0, Math.min(1, (similarity - baseline) / 0.45));

/** `work`'s outcome, or a rejection once `ms` have passed: given up on, it runs its course unread. */
const within = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Local embedding did not answer in time")), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const retrievalQuery = (query: string): string =>
  `Instruct: ${RETRIEVAL_INSTRUCTION}\nQuery:${query}`;

const boundedLimit = (limit: number): number =>
  Math.max(1, Math.min(200, Math.trunc(limit)));

export class SemanticSearchService {
  readonly #vectors: SemanticVectorIndex;
  readonly #gateway: EmbeddingGateway;
  // By kind, the vectors stored for one model, decoded once: every query read and decoded all of them, ten
  // million floats at ten thousand decisions. Dropped when new ones are written; a pruned one is never asked for.
  readonly #decoded = new Map<SemanticVectorEntityType, { model: string; byId: Map<string, Float32Array> }>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  // Aborted on close: a sync under way stops at the batch it is on, and the call for that batch is cut short.
  readonly #closing = new AbortController();
  /** The notes the agents' search reads (DecisionContextRepository.scan): the summaries' vectors are made from them. */
  readonly #contextSnapshot: (() => Promise<DecisionContextSnapshot>) | undefined;
  /** The summary sync under way, or the last one; the next follows it (synchronizeSummaries). */
  #summaryRun: Promise<void> = Promise.resolve();
  #summariesQueued: Promise<void> | null = null;
  /** Preferences' and ideas' vectors (similarEntries), by entry id, with the hash of the text each was made from. */
  readonly #entryVectors = new Map<string, { hash: string; model: string; vector: Float32Array }>();
  readonly #entryPending = new Set<string>();
  /** Moves for an entry each time it is let go of (forgetEntries): an embedding or a search begun before does not bring it back. */
  readonly #entryEpochs = new Map<string, number>();
  #entryRun: Promise<void> = Promise.resolve();
  readonly #currentSources: (() => Promise<CurrentSources>) | undefined;
  /** The decisions a search embeds itself are read whole from (#embedFresh). */
  readonly #decisions: DecisionSource | undefined;
  /**
   * What a search embeds records with (#embedFresh): a context of its own on the same model, so a call it gave up on, which
   * runs on regardless, holds up no query's vector after it. Without one, a search embeds none.
   */
  readonly #freshGateway: EmbeddingGateway | undefined;
  #synchronizationTimer: ReturnType<typeof setTimeout> | undefined;
  #synchronizationQueued = false;

  constructor(options: {
    vectors: SemanticVectorIndex;
    gateway: EmbeddingGateway;
    contextSnapshot?: () => Promise<DecisionContextSnapshot>;
    currentSources?: () => Promise<CurrentSources>;
    decisions?: DecisionSource;
    freshGateway?: EmbeddingGateway;
  }) {
    this.#vectors = options.vectors;
    this.#gateway = options.gateway;
    this.#contextSnapshot = options.contextSnapshot;
    this.#currentSources = options.currentSources;
    this.#decisions = options.decisions;
    this.#freshGateway = options.freshGateway;
  }

  /** Queue behind an in-flight embedding so it cannot recreate a deleted vector after removal. */
  removeDecision(id: string): Promise<void> {
    return this.#exclusive(async () => {
      this.#vectors.remove("decision", id);
      this.#decoded.delete("decision");
    });
  }

  /** Coalesce writes; read the latest sources only when the shared indexing queue gives them a turn. */
  scheduleSynchronization(): void {
    if (this.#closed || this.#currentSources === undefined) return;
    if (this.#synchronizationTimer !== undefined) return;
    this.#synchronizationTimer = setTimeout(() => {
      this.#synchronizationTimer = undefined;
      if (this.#synchronizationQueued) return;
      this.#synchronizationQueued = true;
      void this.#exclusive(async () => {
        this.#synchronizationQueued = false;
        if (this.#closed) return;
        const sources = await this.#currentSources!();
        if (!this.#closed) await this.#synchronize(sources.decisions, sources.methodologies);
      }).catch(() => undefined);
    }, 250);
    this.#synchronizationTimer.unref();
  }

  /**
   * The summaries' vectors brought up to their notes, a batch at a time: every summary at the first start after the
   * upgrade. Off the queue the other syncs and searches take turns in (#exclusive): holding it for every batch, a first
   * start's 299 summaries kept a principle consultation waiting their 18 seconds, past the bridge's five. Nothing else
   * writes them, one run follows another, and the model takes one call at a time whoever asks. Asked again while a run
   * waits, that one serves: it reads the notes when it starts. One under way read them already, so another may follow.
   */
  synchronizeSummaries(): Promise<void> {
    const snapshot = this.#contextSnapshot;
    // A table this start could not widen keeps none: asked, the model was loaded and every note read for nothing.
    if (snapshot === undefined || !this.#vectors.holdsSummaries) return Promise.resolve();
    if (this.#summariesQueued === null) {
      const run = this.#summaryRun.then(async () => {
        this.#summariesQueued = null;
        // Its turn come at a quit: run, it asked the model and read every note again, and the quit waited on both.
        if (this.#closed) return;
        // Asked before any note is read, as a decision sync asks: with no model installed, nothing is read.
        const probe = await this.#gateway.embed([retrievalQuery("decision")]);
        const { documents, sources } = await snapshot();
        const read = sources.find((source) => source.source === "summarize")?.status;
        // Pruned only after a whole read: one cut short by the scan's budget, or a note iCloud holds, dropped the vectors
        // of every summary it missed, all embedded again at the next.
        await this.#synchronizeType(
          "summary",
          documents.filter((document) => document.source === "summarize").map(summaryOf),
          probe.model,
          read === "ready" || read === "empty",
        );
      });
      this.#summariesQueued = run;
      this.#summaryRun = run.catch(() => undefined);
    }
    return this.#summariesQueued;
  }

  /**
   * Records near a query in meaning, nearest first, by the vectors made from their notes as they are now. Begun as a
   * search begins, given a second, and past the queue (#exclusive): behind a first start's sync of every summary, a
   * search waited out the bridge's deadline. A summary with no vector of its note yet is left out, counted and asked for.
   */
  /**
   * One query's embedding, as the start's syncs begin: the model is loaded at its first call, which took the first
   * searches after a launch past their deadline (R9). Asked after the syncs, it came too late for them.
   */
  async warmQueries(): Promise<void> {
    if (this.#closed) return;
    // The searches' own context too: made at its first call, it took the first fresh record after a start past its budget.
    await Promise.all([this.#gateway, this.#freshGateway].map((gateway) =>
      gateway?.embed([retrievalQuery("decision")]).then(() => undefined, () => undefined)));
  }

  similarTo(
    query: string,
    withinMs = QUERY_DEADLINE_MS,
    options: SimilarityOptions = {},
  ): (
    documents: readonly DecisionContextDocument[],
    eligible?: (document: DecisionContextDocument) => boolean,
  ) => Promise<ContextSimilarity> {
    const floor = options.floor ?? SEMANTIC_FLOOR;
    const deadline = AbortSignal.timeout(withinMs);
    // By the clock as well: a timer's abort waits for the main thread, which a judgment of records can hold past it.
    const deadlineAt = performance.now() + withinMs;
    const answer = (this.#closed
      ? Promise.reject(new Error("Semantic search service is closed"))
      : this.#gateway.embed([retrievalQuery(query)], deadline)
    ).then((batch) => ({ batch }), (error: unknown) => ({ error }));
    const late = new Promise<"late">((resolve) => {
      deadline.addEventListener("abort", () => resolve("late"), { once: true });
    });
    return async (documents, eligibleGiven) => {
      const eligible = eligibleGiven ?? (() => false);
      // The answer first: come back while the notes were read, it is taken though its second has passed since.
      const settled = await Promise.race([answer, late]);
      if (settled === "late") return { unavailable: "timeout" };
      if ("error" in settled) {
        return { unavailable: (settled.error as { code?: unknown }).code === "model_missing" ? "model_missing" : "failed" };
      }
      const { model, vectors: [vector] } = settled.batch;
      if (vector === undefined || this.#closed) return { unavailable: "failed" };
      const made = new Map<SemanticVectorEntityType, Map<string, SemanticVectorMetadata>>();
      const madeOf = (kind: SemanticVectorEntityType) => {
        if (!made.has(kind)) made.set(kind, new Map(this.#vectors.metadata(kind).map((item) => [item.entityId, item])));
        return made.get(kind)!;
      };
      const unmade: DecisionContextDocument[] = [];
      const near = documents.flatMap((document) => {
        const kind = VECTOR_KIND[document.source];
        const stored = madeOf(kind).get(document.id);
        if (stored === undefined || stored.model !== model || !madeFrom(document, stored)) {
          unmade.push(document);
          return [];
        }
        const similarity = cosine(vector, this.#stored(kind, model).get(document.id) ?? []);
        return similarity >= floor ? [{ document, similarity }] : [];
      });
      // A few in scope with no current vector, written or changed a moment ago: embedded here for this search alone, the
      // sync asked for below storing them. Past the few, or the budget, they wait for the sync as before. The budget runs
      // from the query's vector on, judging which could be shown among it.
      const budget = AbortSignal.any([deadline, AbortSignal.timeout(FRESH_BUDGET_MS)]);
      const until = Math.min(deadlineAt, performance.now() + FRESH_BUDGET_MS);
      const fresh: DecisionContextDocument[] = [];
      let judged = 0;
      let known = this.#freshGateway !== undefined && eligibleGiven !== undefined;
      for (const document of known ? unmade : []) {
        // None the syncs would not keep: a summary where the table this start could not widen keeps none, a principle
        // not accepted (pruned at the next sync, it was embedded again at every search).
        if ((document.source === "summarize" && !this.#vectors.holdsSummaries) ||
          (document.source === "principles" && document.status !== "accepted")) continue;
        if (judged === MAX_FRESH_JUDGED || budget.aborted || performance.now() >= until) { known = false; break; }
        judged += 1;
        if (!eligible(document)) continue;
        fresh.push(document);
        if (fresh.length > MAX_FRESH_RECORDS) { known = false; break; }
      }
      const embedded = known ? await this.#embedFresh(fresh, model, budget, until) : new Map<DecisionContextDocument, Float32Array>();
      let pending = 0;
      let pendingDecisions = 0;
      let pendingPrinciples = 0;
      for (const document of unmade) {
        const made = embedded.get(document);
        if (made !== undefined) {
          const similarity = cosine(vector, made);
          if (similarity >= floor) near.push({ document, similarity });
        } else if (document.source === "summarize") pending += 1;
        else if (document.source === "decisions") pendingDecisions += 1;
        else pendingPrinciples += 1;
      }
      // Not waited on: made in the background, they are there for the searches after. Asked for every record without a
      // vector, those embedded here too: theirs are this search's alone, and a summary has no write to ask for its sync.
      if (unmade.some((document) => document.source === "summarize")) void this.synchronizeSummaries().catch(() => undefined);
      if (unmade.some((document) => document.source !== "summarize")) this.scheduleSynchronization();
      return {
        near: near.sort((left, right) => right.similarity - left.similarity).slice(0, options.nearest ?? NEAREST_RECORDS),
        pending,
        ...(pendingDecisions === 0 ? {} : { pendingDecisions }),
        ...(pendingPrinciples === 0 ? {} : { pendingPrinciples }),
        ...(this.#vectors.holdsSummaries ? {} : { summariesUnindexed: true as const }),
      };
    };
  }

  /**
   * Preferences and ideas near a query in meaning, nearest first. They are notes of the Decision Journal, not rows of the
   * vector index: their vectors are made here, one batch after another, and kept in memory by the text they came from. The
   * first search after a start embeds what it can in ENTRY_BUDGET_MS and counts the rest as pending, which go on in the
   * background for the next; a few hundred entries are a few seconds of the model's time, once.
   */
  async similarEntries(
    query: string,
    items: ReadonlyArray<{ id: string; text: string }>,
    options: SimilarityOptions = {},
    withinMs = QUERY_DEADLINE_MS,
  ): Promise<EntrySimilarity> {
    const floor = options.floor ?? SEMANTIC_FLOOR;
    const deadline = AbortSignal.timeout(withinMs);
    const late = new Promise<"late">((resolve) => deadline.addEventListener("abort", () => resolve("late"), { once: true }));
    const answer = (this.#closed
      ? Promise.reject(new Error("Semantic search service is closed"))
      : this.#gateway.embed([retrievalQuery(query)], deadline)
    ).then((batch) => ({ batch }), (error: unknown) => ({ error }));
    const settled = await Promise.race([answer, late]);
    if (settled === "late") return { unavailable: "timeout" };
    if ("error" in settled) return { unavailable: (settled.error as { code?: unknown }).code === "model_missing" ? "model_missing" : "failed" };
    const { model, vectors: [vector] } = settled.batch;
    if (vector === undefined || this.#closed) return { unavailable: "failed" };
    const hashed = items.map((item) => ({ ...item, hash: documentHash(item.text), epoch: this.#entryEpochs.get(item.id) ?? 0 }));
    const current = (item: { id: string; hash: string }) => {
      const kept = this.#entryVectors.get(item.id);
      return kept !== undefined && kept.hash === item.hash && kept.model === model ? kept.vector : undefined;
    };
    const missing = hashed.filter((item) => current(item) === undefined);
    if (missing.length > 0) {
      const waited = this.#embedEntries(missing, model);
      await Promise.race([waited, new Promise<void>((resolve) => setTimeout(resolve, ENTRY_BUDGET_MS))]);
    }
    const near: Array<{ id: string; similarity: number }> = [];
    let pending = 0;
    for (const item of hashed) {
      // Let go of while this search ran: not answered, whatever the vector says.
      if ((this.#entryEpochs.get(item.id) ?? 0) !== item.epoch) continue;
      const stored = current(item);
      if (stored === undefined) { pending += 1; continue; }
      const similarity = cosine(vector, stored);
      if (similarity >= floor) near.push({ id: item.id, similarity });
    }
    return { near: near.sort((left, right) => right.similarity - left.similarity).slice(0, options.nearest ?? NEAREST_RECORDS), pending };
  }

  /** Vectors kept for entries let go of (a forgotten experience or record, IMP-191): none is recalled again. */
  forgetEntries(ids: readonly string[]): void {
    for (const id of ids) {
      this.#entryVectors.delete(id);
      this.#entryEpochs.set(id, (this.#entryEpochs.get(id) ?? 0) + 1);
    }
  }

  /** Behind the one under way, so a text is embedded once however many searches ask; never rejects. */
  #embedEntries(entries: ReadonlyArray<{ id: string; hash: string; text: string; epoch?: number }>, model: string): Promise<void> {
    const todo = entries.filter((entry) => !this.#entryPending.has(entry.id));
    for (const entry of todo) this.#entryPending.add(entry.id);
    const run = this.#entryRun.then(async () => {
      try {
        for (let start = 0; start < todo.length && !this.#closed; start += EMBEDDING_BATCH_SIZE) {
          const batch = todo.slice(start, start + EMBEDDING_BATCH_SIZE);
          const embedded = await this.#gateway.embed(batch.map((entry) => entry.text), this.#closing.signal);
          if (embedded.model !== model || embedded.vectors.length !== batch.length) return;
          batch.forEach((entry, index) => {
            // Let go of while it was being embedded: not kept.
            if (entry.epoch !== undefined && (this.#entryEpochs.get(entry.id) ?? 0) !== entry.epoch) return;
            // Re-inserted, so the oldest by use is the first out: a search over some of the entries (one project's) takes
            // nothing from the others' vectors, and the cache holds at most MAX_ENTRY_VECTORS.
            this.#entryVectors.delete(entry.id);
            this.#entryVectors.set(entry.id, { hash: entry.hash, model, vector: Float32Array.from(embedded.vectors[index] ?? []) });
          });
          while (this.#entryVectors.size > MAX_ENTRY_VECTORS) this.#entryVectors.delete(this.#entryVectors.keys().next().value!);
        }
      } catch {
        // Left pending for the next search.
      } finally {
        for (const entry of todo) this.#entryPending.delete(entry.id);
      }
    });
    this.#entryRun = run;
    return this.#entryRun;
  }

  async synchronize(
    decisions: DecisionSource,
    methodologies: MethodologyRecord[],
  ): Promise<void> {
    await this.#exclusive(() => this.#synchronize(decisions, methodologies));
  }

  async #synchronize(decisions: DecisionSource, methodologies: MethodologyRecord[]): Promise<void> {
    const methodologyDocuments = methodologies
      .filter((record) => record.status === "accepted")
      .map(methodologyDocument);
    // Taken in turn, not when asked: waiting behind another sync or a search, a list made before them pruned the
    // vector of a decision come since, and compared notes as they were.
    const stamps = decisions.stamps();
    if (stamps.length === 0 && methodologyDocuments.length === 0) {
      this.#vectors.prune("decision", []);
      this.#vectors.prune("methodology", []);
      return;
    }
    // Asked before any decision is read: with no model installed, every one was read at every start, for nothing.
    const probe = await this.#gateway.embed([retrievalQuery("decision")]);
    this.#vectors.prune("decision", stamps.map((stamp) => stamp.id));
    // Read whole only a decision whose note changed since its vector was made from it, or that has none.
    const stored = new Map(this.#vectors.metadata("decision").map((item) => [item.entityId, item]));
    const changed = stamps.filter((stamp) => {
      const vector = stored.get(stamp.id);
      return vector === undefined || vector.sourceHash !== decisionSource(stamp) || vector.model !== probe.model;
    });
    await this.#synchronizeType("decision", decisions.load(changed.map((stamp) => stamp.id)).map(decisionDocument), probe.model, false);
    await this.#synchronizeType("methodology", methodologyDocuments, probe.model, true);
  }

  async searchDecisions(options: {
    query: string;
    /** Every decision the filters let through, newest first, known by what changes with its note. */
    candidates: ReadonlyArray<Pick<IndexedDecision, "id" | "contentHash" | "created">>;
    /** These decisions whole: read for those whose text is needed, and those shown. */
    load(ids: string[]): IndexedDecision[];
    lexical: IndexedDecision[];
    limit: number;
  }): Promise<SemanticDecisionMatch[]> {
    const whole = (ids: string[]): Map<string, IndexedDecision> =>
      new Map(options.load(ids).map((decision) => [decision.id, decision]));
    const query = options.query.trim();
    if (query.length === 0) {
      const first = options.candidates.slice(0, boundedLimit(options.limit));
      const loaded = whole(first.map((candidate) => candidate.id));
      return first.flatMap((candidate) => {
        const decision = loaded.get(candidate.id);
        return decision === undefined ? [] : [{ decision, matchKind: "keyword" as const, relevance: 1 }];
      });
    }
    return this.#exclusive(async () => {
      const embeddedQuery = await this.#gateway.embed([
        retrievalQuery(query),
      ]);
      const queryVector = embeddedQuery.vectors[0];
      if (queryVector === undefined) {
        throw new Error("Local embedding provider returned no query vector");
      }
      // Read whole and embedded again: a decision whose note changed since its vector was made from it, or whose
      // vector is missing or from another model.
      const vectors = new Map(this.#vectors.metadata("decision").map((item) => [item.entityId, item]));
      const unsynced = options.candidates.filter((candidate) => {
        const vector = vectors.get(candidate.id);
        return vector === undefined || vector.sourceHash !== decisionSource(candidate) || vector.model !== embeddedQuery.model;
      });
      if (unsynced.length > 0) {
        await this.#synchronizeType(
          "decision",
          options.load(unsynced.map((candidate) => candidate.id)).map(decisionDocument),
          embeddedQuery.model,
          false,
        );
      }
      const candidateById = new Map(
        options.candidates.map((candidate) => [candidate.id, candidate]),
      );
      const lexicalById = new Map(
        options.lexical.map((decision) => [decision.id, decision]),
      );
      const lexicalRank = new Map(
        options.lexical.map((decision, index) => [decision.id, index]),
      );
      const stored = this.#stored("decision", embeddedQuery.model);
      const semanticScores = new Map(
        [...candidateById.keys()].flatMap((id) => {
          const vector = stored.get(id);
          return vector === undefined ? [] : [[id, cosine(queryVector, vector)] as const];
        }),
      );
      const bestSemanticScore = Math.max(
        -1,
        ...semanticScores.values(),
      );
      const adaptiveSemanticSearch =
        options.lexical.length === 0 &&
        bestSemanticScore < SEMANTIC_FLOOR &&
        bestSemanticScore >= ADAPTIVE_SEMANTIC_TRIGGER;
      const effectiveSemanticFloor = adaptiveSemanticSearch
        ? Math.max(
            ADAPTIVE_SEMANTIC_FLOOR,
            bestSemanticScore - ADAPTIVE_SEMANTIC_WINDOW,
          )
        : SEMANTIC_FLOOR;
      const ranked = [...candidateById.values()]
        .flatMap((candidate) => {
          const keywordRank = lexicalRank.get(candidate.id);
          const similarity = semanticScores.get(candidate.id) ?? -1;
          const semantic = similarity >= effectiveSemanticFloor;
          if (keywordRank === undefined && !semantic) return [];
          const keywordScore =
            keywordRank === undefined ? 0 : 1 / (1 + keywordRank * 0.12);
          const semanticScore = semanticWeight(
            similarity,
            Math.min(0.35, effectiveSemanticFloor),
          );
          return [
            {
              candidate,
              matchKind:
                keywordRank !== undefined && semantic
                  ? ("hybrid" as const)
                  : keywordRank !== undefined
                    ? ("keyword" as const)
                    : ("semantic" as const),
              relevance: keywordScore * 0.62 + semanticScore * 0.38,
            },
          ];
        })
        .sort(
          (left, right) =>
            right.relevance - left.relevance ||
            right.candidate.created.localeCompare(left.candidate.created) ||
            left.candidate.id.localeCompare(right.candidate.id),
        );
      let semanticOnly = 0;
      const semanticOnlyLimit = adaptiveSemanticSearch
        ? MAX_ADAPTIVE_SEMANTIC_RESULTS
        : MAX_SEMANTIC_ONLY_RESULTS;
      const shown = ranked
        .filter((match) => {
          if (match.matchKind !== "semantic") return true;
          semanticOnly += 1;
          return semanticOnly <= semanticOnlyLimit;
        })
        .slice(0, boundedLimit(options.limit));
      const loaded = whole(shown.flatMap(({ candidate }) => (lexicalById.has(candidate.id) ? [] : [candidate.id])));
      return shown.flatMap(({ candidate, matchKind, relevance }) => {
        const decision = lexicalById.get(candidate.id) ?? loaded.get(candidate.id);
        return decision === undefined ? [] : [{ decision, matchKind, relevance }];
      });
    });
  }

  /** `withinMs`: past it the recall is given up on (a rejection), its caller left to the principles' words. */
  async recallMethodologies(
    records: MethodologyRecord[],
    input: MethodologyRecallInput,
    limit = 3,
    withinMs?: number,
  ): Promise<MethodologyRecallMatch[]> {
    const lexical = buildMethodologyRecall(records, input, 5);
    const accepted = records.filter((record) => record.status === "accepted");
    if (accepted.length === 0) return [];
    const query = compactText([
      input.question,
      input.selectedAnswer,
      input.optionLabels.join("\n"),
      input.context,
    ]);
    const recall = this.#exclusive(async () => {
      const embeddedQuery = await this.#gateway.embed([
        retrievalQuery(query),
      ]);
      const queryVector = embeddedQuery.vectors[0];
      if (queryVector === undefined) return lexical.slice(0, limit);
      await this.#synchronizeType(
        "methodology",
        accepted.map(methodologyDocument),
        embeddedQuery.model,
        true,
      );
      const lexicalById = new Map(
        lexical.map((match) => [match.principleId, match]),
      );
      const semanticById = new Map(
        [...this.#stored("methodology", embeddedQuery.model)].map(([id, vector]) => [
          id,
          cosine(queryVector, vector),
        ]),
      );
      return accepted
        .flatMap((record) => {
          const similarity = semanticById.get(record.id) ?? -1;
          // Past the five the lexical recall keeps, one sharing the question's words still shares them: taken for
          // vectors alone, it was possible with nothing shared, as strong or not as other principles matched.
          const lexicalMatch = lexicalById.get(record.id) ??
            (similarity >= SEMANTIC_FLOOR ? buildMethodologyRecall([record], input, 1)[0] : undefined);
          if (lexicalMatch === undefined && similarity < SEMANTIC_FLOOR) {
            return [];
          }
          const semanticScore = Math.round(semanticWeight(similarity) * 100);
          const score = Math.max(
            lexicalMatch?.score ?? 0,
            Math.round(
              (lexicalMatch?.score ?? 0) * 0.58 + semanticScore * 0.42,
            ),
            lexicalMatch === undefined
              ? Math.round(semanticScore * 0.72)
              : 0,
          );
          return [
            {
              principleId: record.id,
              score,
              // Vectors alone, nothing shared to show for it: never strong. Strong, an agent read a
              // principle no word of which met the question as one that holds, and 强匹配 counted it.
              strength: lexicalMatch !== undefined && score >= 24 ? ("strong" as const) : ("possible" as const),
              reason:
                lexicalMatch?.reason ??
                `原则与当前决策在本地语义向量中接近（相似度 ${Math.round(
                  similarity * 100,
                )}%）。`,
              matchedTerms: lexicalMatch?.matchedTerms ?? [],
              updatedAt: record.updatedAt,
            },
          ];
        })
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.principleId.localeCompare(right.principleId),
        )
        .slice(0, Math.max(1, Math.min(5, Math.trunc(limit))))
        .map(({ updatedAt: _updatedAt, ...match }) => match);
    });
    return withinMs === undefined ? recall : within(recall, withinMs);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#synchronizationTimer);
    // Waited on whole, a sync under way at a quit embedded every batch left (a whole vault with a new local model),
    // and the quit with it: now it ends at the batch it is on.
    this.#closing.abort();
    await Promise.all([this.#tail, this.#summaryRun]);
    await Promise.all([this.#gateway, this.#freshGateway].map((gateway) => gateway?.close?.().catch(() => undefined)));
    this.#vectors.close();
  }

  /**
   * These records' vectors, made as the syncs make them, one at a time while the budget lasts, by the searches' own
   * context: not stored (off the queue, a write could follow a deletion's removal), the sync asked for does. A decision
   * is embedded only as indexed from the very note searched, else its vector would be of another version, and kept only
   * if it is still so once embedded: one deleted meanwhile is not shown by the search under way.
   */
  async #embedFresh(
    documents: readonly DecisionContextDocument[],
    model: string,
    budget: AbortSignal,
    until: number,
  ): Promise<Map<DecisionContextDocument, Float32Array>> {
    const made = new Map<DecisionContextDocument, Float32Array>();
    const gateway = this.#freshGateway;
    if (documents.length === 0 || this.#closed || gateway === undefined) return made;
    // Raced, as the query is: a call waiting on the model is not cut short by its signal.
    const spent = new Promise<undefined>((resolve) => {
      if (budget.aborted) resolve(undefined);
      else budget.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const indexed = (ids: string[]) => new Map((this.#decisions?.load(ids) ?? []).map((decision) => [decision.id, decision]));
    const asIndexed = (decision: IndexedDecision | undefined, document: DecisionContextDocument) =>
      decision !== undefined && decision.contentHash === document.contentHash;
    const decisions = indexed(documents.filter((document) => document.source === "decisions").map((document) => document.id));
    for (const document of documents) {
      const text = document.source === "summarize" ? summaryOf(document)
        : document.source === "principles" ? methodologyDocument({ id: document.id, title: document.title,
          principle: document.summary, appliesWhen: document.appliesWhen, caution: document.caution })
        : asIndexed(decisions.get(document.id), document) ? decisionDocument(decisions.get(document.id)!)
        : undefined;
      if (text === undefined) continue;
      if (budget.aborted || performance.now() >= until || this.#closed) break;
      const embedded = await Promise.race([gateway.embed([text.text], budget).catch(() => undefined), spent]);
      const vector = embedded?.model === model ? embedded.vectors[0] : undefined;
      if (vector === undefined) break;
      made.set(document, Float32Array.from(vector));
    }
    const now = indexed([...made.keys()].filter((document) => document.source === "decisions").map((document) => document.id));
    for (const document of made.keys()) {
      if (document.source === "decisions" && !asIndexed(now.get(document.id), document)) made.delete(document);
    }
    return made;
  }

  async #synchronizeType(
    entityType: SemanticVectorEntityType,
    documents: SearchDocument[],
    model: string,
    prune: boolean,
  ): Promise<void> {
    if (prune) {
      this.#vectors.prune(
        entityType,
        documents.map((document) => document.entityId),
      );
    }
    const current = new Map(
      this.#vectors
        .metadata(entityType)
        .map((item) => [item.entityId, item]),
    );
    const stale: SearchDocument[] = [];
    const kept: Array<readonly [string, string]> = [];
    for (const document of documents) {
      const metadata = current.get(document.entityId);
      if (metadata === undefined || metadata.contentHash !== document.contentHash || metadata.model !== model) {
        stale.push(document);
      } else if (document.sourceHash !== undefined && metadata.sourceHash !== document.sourceHash) {
        // Its vector still of this text, now known as made from the note read: not read again at the next start.
        kept.push([document.entityId, document.sourceHash]);
      }
    }
    this.#vectors.keepSources(entityType, kept);
    for (let start = 0; start < stale.length; start += EMBEDDING_BATCH_SIZE) {
      // Closing: what is left is embedded at the next start, as a sync cut short by a crash is.
      if (this.#closed) return;
      const batch = stale.slice(start, start + EMBEDDING_BATCH_SIZE);
      const embedded = await this.#gateway.embed(
        batch.map((document) => document.text),
        this.#closing.signal,
      );
      if (
        embedded.model !== model ||
        embedded.vectors.length !== batch.length
      ) {
        throw new Error("Local embedding model changed during indexing");
      }
      this.#vectors.upsert(
        batch.map((document, index) => ({
          entityType,
          entityId: document.entityId,
          contentHash: document.contentHash,
          sourceHash: document.sourceHash ?? null,
          model,
          vector: embedded.vectors[index] ?? [],
        })),
      );
      // Dropped with each batch written, not once before the first: a search reads between a sync's batches
      // (similarTo), and what it decoded then stood in for every batch after.
      this.#decoded.delete(entityType);
    }
  }

  #stored(entityType: SemanticVectorEntityType, model: string): Map<string, Float32Array> {
    const kept = this.#decoded.get(entityType);
    if (kept?.model === model) return kept.byId;
    const byId = new Map(
      this.#vectors.list(entityType, model).map((record) => [record.entityId, Float32Array.from(record.vector)]),
    );
    this.#decoded.set(entityType, { model, byId });
    return byId;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("Semantic search service is closed"));
    }
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
