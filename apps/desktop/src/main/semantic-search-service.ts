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
  text: string;
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

const cosine = (left: number[], right: number[]): number => {
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
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: {
    vectors: SemanticVectorIndex;
    gateway: EmbeddingGateway;
  }) {
    this.#vectors = options.vectors;
    this.#gateway = options.gateway;
  }

  async synchronize(
    decisions: IndexedDecision[],
    methodologies: MethodologyRecord[],
  ): Promise<void> {
    const documents = [
      ...decisions.map(decisionDocument),
      ...methodologies
        .filter((record) => record.status === "accepted")
        .map(methodologyDocument),
    ];
    if (documents.length === 0) {
      return this.#exclusive(async () => {
        this.#vectors.prune("decision", []);
        this.#vectors.prune("methodology", []);
      });
    }
    await this.#exclusive(async () => {
      const probe = await this.#gateway.embed([documents[0]!.text]);
      await this.#synchronizeType(
        "decision",
        decisions.map(decisionDocument),
        probe.model,
        true,
      );
      await this.#synchronizeType(
        "methodology",
        methodologies
          .filter((record) => record.status === "accepted")
          .map(methodologyDocument),
        probe.model,
        true,
      );
    });
  }

  async searchDecisions(options: {
    query: string;
    candidates: IndexedDecision[];
    lexical: IndexedDecision[];
    limit: number;
  }): Promise<SemanticDecisionMatch[]> {
    const query = options.query.trim();
    if (query.length === 0) {
      return options.candidates.slice(0, boundedLimit(options.limit)).map(
        (decision) => ({
          decision,
          matchKind: "keyword" as const,
          relevance: 1,
        }),
      );
    }
    return this.#exclusive(async () => {
      const embeddedQuery = await this.#gateway.embed([
        retrievalQuery(query),
      ]);
      const queryVector = embeddedQuery.vectors[0];
      if (queryVector === undefined) {
        throw new Error("Local embedding provider returned no query vector");
      }
      const documents = options.candidates.map(decisionDocument);
      await this.#synchronizeType(
        "decision",
        documents,
        embeddedQuery.model,
        false,
      );
      const candidateById = new Map(
        options.candidates.map((decision) => [decision.id, decision]),
      );
      const lexicalRank = new Map(
        options.lexical.map((decision, index) => [decision.id, index]),
      );
      const semanticScores = new Map(
        this.#vectors
          .list("decision", embeddedQuery.model)
          .filter((record) => candidateById.has(record.entityId))
          .map((record) => [
            record.entityId,
            cosine(queryVector, record.vector),
          ]),
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
        .flatMap((decision) => {
          const keywordRank = lexicalRank.get(decision.id);
          const similarity = semanticScores.get(decision.id) ?? -1;
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
              decision,
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
            right.decision.created.localeCompare(left.decision.created) ||
            left.decision.id.localeCompare(right.decision.id),
        );
      let semanticOnly = 0;
      const semanticOnlyLimit = adaptiveSemanticSearch
        ? MAX_ADAPTIVE_SEMANTIC_RESULTS
        : MAX_SEMANTIC_ONLY_RESULTS;
      return ranked
        .filter((match) => {
          if (match.matchKind !== "semantic") return true;
          semanticOnly += 1;
          return semanticOnly <= semanticOnlyLimit;
        })
        .slice(0, boundedLimit(options.limit));
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
        this.#vectors
          .list("methodology", embeddedQuery.model)
          .map((record) => [
            record.entityId,
            cosine(queryVector, record.vector),
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
    const stale = documents.filter((document) => {
      const metadata = current.get(document.entityId);
      return (
        metadata === undefined ||
        metadata.contentHash !== document.contentHash ||
        metadata.model !== model
      );
    });
    for (let start = 0; start < stale.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = stale.slice(start, start + EMBEDDING_BATCH_SIZE);
      const embedded = await this.#gateway.embed(
        batch.map((document) => document.text),
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
          model,
          vector: embedded.vectors[index] ?? [],
        })),
      );
    }
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
