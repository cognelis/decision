import {
  buildMethodologyRecall,
  type MethodologyRecallInput,
  type MethodologyRecallMatch,
  type MethodologyRecord,
} from "@cognelis/decision-core";
import {
  type IndexedDecision,
  SemanticVectorIndex,
  type SemanticVectorEntityType,
} from "@cognelis/decision-storage";
import { createHash } from "node:crypto";

import type { EmbeddingBatch } from "./model/embedding-provider.js";

interface EmbeddingGateway {
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatch>;
  close?(): Promise<void>;
}

interface SearchDocument {
  entityId: string;
  contentHash: string;
  /** The content hash of the note its text was made from (a decision's). */
  sourceHash?: string;
  text: string;
}

/** Every decision known by what changes with its note, and read whole only where its text is needed. */
interface DecisionSource {
  stamps(): ReadonlyArray<Pick<IndexedDecision, "id" | "contentHash">>;
  load(ids: string[]): IndexedDecision[];
}

export interface SemanticDecisionMatch {
  decision: IndexedDecision;
  matchKind: "keyword" | "semantic" | "hybrid";
  relevance: number;
}

// The local embedding context is intentionally kept at 2,048 tokens for
// responsive search. Keep the most useful leading fields within a safe bound
// for Chinese, Markdown, and code-heavy decisions.
const MAX_DOCUMENT_CHARACTERS = 700;
const EMBEDDING_BATCH_SIZE = 16;
const SEMANTIC_FLOOR = 0.45;
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

const decisionDocument = (decision: IndexedDecision): SearchDocument => {
  const text = compactText([
    decision.question,
    decision.selectedAnswer,
    decision.rationale,
    decision.context,
    decision.outcome,
    decision.outcomeLesson,
    decision.project,
  ]);
  return {
    entityId: decision.id,
    contentHash: documentHash(text),
    sourceHash: decision.contentHash,
    text,
  };
};

const methodologyDocument = (record: MethodologyRecord): SearchDocument => {
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

  constructor(options: {
    vectors: SemanticVectorIndex;
    gateway: EmbeddingGateway;
  }) {
    this.#vectors = options.vectors;
    this.#gateway = options.gateway;
  }

  async synchronize(
    decisions: DecisionSource,
    methodologies: MethodologyRecord[],
  ): Promise<void> {
    const methodologyDocuments = methodologies
      .filter((record) => record.status === "accepted")
      .map(methodologyDocument);
    await this.#exclusive(async () => {
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
        return vector === undefined || vector.sourceHash !== stamp.contentHash || vector.model !== probe.model;
      });
      await this.#synchronizeType("decision", decisions.load(changed.map((stamp) => stamp.id)).map(decisionDocument), probe.model, false);
      await this.#synchronizeType("methodology", methodologyDocuments, probe.model, true);
    });
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
        return vector === undefined || vector.sourceHash !== candidate.contentHash || vector.model !== embeddedQuery.model;
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

  async recallMethodologies(
    records: MethodologyRecord[],
    input: MethodologyRecallInput,
    limit = 3,
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
    return this.#exclusive(async () => {
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
          const lexicalMatch = lexicalById.get(record.id);
          const similarity = semanticById.get(record.id) ?? -1;
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
              strength: score >= 24 ? ("strong" as const) : ("possible" as const),
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
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Waited on whole, a sync under way at a quit embedded every batch left (a whole vault with a new local model),
    // and the quit with it: now it ends at the batch it is on.
    this.#closing.abort();
    await this.#tail.catch(() => undefined);
    await this.#gateway.close?.().catch(() => undefined);
    this.#vectors.close();
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
    if (stale.length > 0) this.#decoded.delete(entityType);
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
