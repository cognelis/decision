import type { MethodologyRecord } from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SemanticVectorIndex } from "@cognelis/decision-storage";
import { SemanticSearchService } from "../src/main/semantic-search-service.js";

const decision = (id: string, question: string): IndexedDecision => ({
  id,
  created: "2026-08-01T00:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project: "decision",
  workflow: null,
  decisionType: "architecture",
  selectedAnswer: "先小步验证",
  captureMode: null,
  captureSemanticKey: null,
  sourceEventId: null,
  batchId: null,
  questionIndex: null,
  rationaleStatus: "captured",
  filePath: `/vault/${id}.md`,
  contentHash: `source-${id}`,
  question,
  rationale: null,
  context: null,
  outcome: null,
  outcomeVerdict: null,
  outcomeLesson: null,
  outcomeReviewedAt: null,
  reviewDueDate: null,
  appliedPrincipleIds: [],
});

const methodology = (id: string, principle: string): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  origin: "manual_entry",
  status: "accepted",
  confirmedAt: "2026-08-02T00:00:00.000Z",
  title: principle,
  principle,
  appliesWhen: "面对高不确定性时",
  caution: "成本过高时重新评估",
  evidenceSummary: "人工原则",
  sourceDecisionIds: [],
  confidence: "medium",
  generation: {
    requestId: "manual",
    profileId: "manual",
    provider: "manual",
    model: "manual",
  },
});

// Candidates whole already, read back as asked.
const atHand = (candidates: IndexedDecision[]) => ({
  candidates,
  load: (ids: string[]) => candidates.filter((candidate) => ids.includes(candidate.id)),
});

const defaultVector = (text: string): number[] =>
  /午餐/u.test(text)
    ? [0, 1]
    : /回退|验证|风险/u.test(text)
      ? [1, 0]
      : [0, 1];

// Indexed decisions: known by their notes' hashes, read whole as asked, and which were asked for.
const indexed = (decisions: IndexedDecision[], loads: string[][] = []) => ({
  stamps: () => decisions,
  load: (ids: string[]) => {
    loads.push(ids);
    return decisions.filter((decision) => ids.includes(decision.id));
  },
});

const makeService = async (
  vectorFor: (text: string) => number[] = defaultVector,
) => {
  const root = await mkdtemp(join(tmpdir(), "semantic-search-"));
  const path = join(root, "vectors.sqlite");
  const vectors = new SemanticVectorIndex(path);
  const embedded: string[] = [];
  const gateway = {
    embed: async (texts: string[]) => {
      if (texts.some((text) => text.length > 700)) {
        throw new Error("embedding context exceeded");
      }
      embedded.push(...texts);
      return {
        model: "test-embedding",
        vectors: texts.map(vectorFor),
      };
    },
  };
  return {
    service: new SemanticSearchService({ vectors, gateway }),
    vectors,
    path,
    embedded,
    /** The service as the next start makes it, on the same vectors. */
    restart: () => new SemanticSearchService({ vectors, gateway }),
  };
};

describe("SemanticSearchService", () => {
  it("stops a sync under way at the batch it is on when closed, and cuts that batch's call short", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-search-close-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const signals: Array<AbortSignal | undefined> = [];
    let batchUnderWay!: () => void;
    const underWay = new Promise<void>((resolve) => {
      batchUnderWay = resolve;
    });
    let finishBatch!: () => void;
    const gateway = {
      embed: async (texts: string[], signal?: AbortSignal) => {
        signals.push(signal);
        // The probe answers at once; the first batch of decisions is the one under way at the quit.
        if (signals.length === 2) {
          batchUnderWay();
          await new Promise<void>((resolve) => {
            finishBatch = resolve;
          });
        }
        return { model: "test-embedding", vectors: texts.map(defaultVector) };
      },
    };
    const service = new SemanticSearchService({ vectors, gateway });
    // Five batches of sixteen: a whole vault for a newly installed local model.
    const decisions = Array.from({ length: 80 }, (_, index) => decision(`d${index}`, `第 ${index} 条决策`));
    const sync = service.synchronize({ stamps: () => decisions, load: (ids) => decisions.filter((item) => ids.includes(item.id)) }, []);
    await underWay;

    const closed = service.close();
    // The batch under way is told to stop; waited on whole, the quit sat behind every batch left.
    expect(signals[1]?.aborted).toBe(true);
    finishBatch();
    await closed;
    await sync.catch(() => undefined);
    expect(signals).toHaveLength(2);
  });

  it("takes the decisions as they are when a sync's turn comes, not as they were when it was asked for", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-search-turn-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = {
      embed: async (texts: string[]) => {
        await gate;
        return { model: "test-embedding", vectors: texts.map(defaultVector) };
      },
    };
    const service = new SemanticSearchService({ vectors, gateway });
    const decisions = [decision("first", "先准备可回退路径")];
    const source = { stamps: () => [...decisions], load: (ids: string[]) => decisions.filter((item) => ids.includes(item.id)) };

    const running = service.synchronize(source, []);
    const queued = service.synchronize(source, []);
    // Come while the first still waits on the model: listed when asked, it was left without a vector.
    decisions.push(decision("later", "先验证再扩大"));
    release();
    await Promise.all([running, queued]);

    expect(vectors.metadata("decision").map((item) => item.entityId).sort()).toEqual(["first", "later"]);
    await service.close();
  });

  it("adds semantic-only decisions without displacing exact keyword matches", async () => {
    const { service } = await makeService();
    const exact = decision("exact", "如何部署服务？");
    const semantic = decision("semantic", "先准备可回退路径再扩大改动");
    const unrelated = decision("unrelated", "午餐选择什么？");

    const matches = await service.searchDecisions({
      query: "如何降低上线风险？",
      ...atHand([exact, semantic, unrelated]),
      lexical: [exact],
      limit: 10,
    });

    expect(matches.map((match) => [match.decision.id, match.matchKind])).toEqual([
      ["exact", "hybrid"],
      ["semantic", "semantic"],
    ]);
    await service.close();
  });

  it("recalls a principle through vectors when wording does not overlap", async () => {
    const { service } = await makeService();
    const matches = await service.recallMethodologies(
      [
        methodology("safe", "先建立回退能力，再逐步扩大范围"),
        methodology("food", "优先选择清淡午餐"),
      ],
      {
        question: "怎样控制上线风险？",
        selectedAnswer: "分批实施",
        optionLabels: ["分批实施", "一次完成"],
        context: null,
      },
      3,
    );

    expect(matches[0]).toMatchObject({
      principleId: "safe",
      strength: "strong",
      matchedTerms: [],
    });
    expect(matches[0]?.reason).toMatch(/本地语义向量/u);
    await service.close();
  });

  it("indexes later batches even when a decision contains a very long rationale", async () => {
    const { service, vectors } = await makeService();
    const decisions = Array.from({ length: 17 }, (_, index) => ({
      ...decision(`decision-${index}`, `第 ${index + 1} 个上线方案`),
      rationale:
        index === 16
          ? "先验证回退路径。".repeat(600)
          : "保留回退路径。",
    }));

    await service.synchronize(indexed(decisions), []);

    expect(vectors.metadata("decision")).toHaveLength(17);
    await service.close();
  });

  it("reads no decision whole without a model, and at a later start only those whose notes changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-missing-"));
    const missing = new SemanticSearchService({
      vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
      gateway: { embed: async () => { throw new Error("model_missing"); } },
    });
    const decisions = [decision("a", "先准备可回退路径"), decision("b", "分批上线"), decision("c", "午餐选择什么？")];
    const loads: string[][] = [];
    // Every decision read whole at every start, to be dropped: the longest hold of the window after it opened.
    await expect(missing.synchronize(indexed(decisions, loads), [])).rejects.toThrow("model_missing");
    expect(loads).toEqual([]);
    await missing.close();

    const { service, embedded, restart } = await makeService();
    await service.synchronize(indexed(decisions, loads), []);
    expect(loads).toEqual([["a", "b", "c"]]);
    // The next start, one note edited in Obsidian since.
    loads.length = 0;
    embedded.length = 0;
    const next = restart();
    await next.synchronize(indexed([decisions[0]!, { ...decisions[1]!, contentHash: "source-b-2", question: "分批上线，先灰度" }, decisions[2]!], loads), []);
    expect(loads).toEqual([["b"]]);
    // The model asked once to know it is there, and the edited one embedded again.
    expect(embedded).toHaveLength(2);
    await next.close();
  });

  it("keeps vectors made before their notes were recorded, read once and not embedded again", async () => {
    const { service, path, embedded, restart } = await makeService();
    const decisions = [decision("a", "先准备可回退路径"), decision("b", "分批上线")];
    await service.synchronize(indexed(decisions), []);
    // Vectors from before: which note each was made from not kept.
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path);
    database.exec("UPDATE semantic_vectors SET source_hash = NULL");
    database.close();

    const loads: string[][] = [];
    embedded.length = 0;
    await restart().synchronize(indexed(decisions, loads), []);
    expect(loads).toEqual([["a", "b"]]);
    expect(embedded).toHaveLength(1);
    loads.length = 0;
    const last = restart();
    await last.synchronize(indexed(decisions, loads), []);
    expect(loads).toEqual([[]]);
    await last.close();
  });

  it("accepts calibrated related results while excluding lower-similarity noise", async () => {
    const { service } = await makeService((text) => {
      if (text.includes("改写后的问题")) return [1, 0];
      if (text.includes("目标方案")) {
        return [0.5, Math.sqrt(0.75)];
      }
      return [0.4, Math.sqrt(0.84)];
    });

    const matches = await service.searchDecisions({
      query: "改写后的问题",
      ...atHand([
        decision("related", "目标方案"),
        decision("noise", "其它主题"),
      ]),
      lexical: [],
      limit: 10,
    });

    expect(matches.map((match) => match.decision.id)).toEqual(["related"]);
    await service.close();
  });

  it("recalls a compact topic when its best matches sit just below the fixed floor", async () => {
    const { service } = await makeService((text) => {
      if (text.includes("Query:命名规范")) return [1, 0];
      if (text.includes("限流配置改成什么名字")) {
        return [0.433, Math.sqrt(1 - 0.433 ** 2)];
      }
      if (text.includes("字段改叫什么名")) {
        return [0.413, Math.sqrt(1 - 0.413 ** 2)];
      }
      if (text.includes("午餐")) {
        return [0.31, Math.sqrt(1 - 0.31 ** 2)];
      }
      return [0, 1];
    });

    const matches = await service.searchDecisions({
      query: "命名规范",
      ...atHand([
        decision("config-name", "限流配置改成什么名字？"),
        decision("field-name", "字段改叫什么名？"),
        decision("food", "午餐选择什么？"),
      ]),
      lexical: [],
      limit: 10,
    });

    expect(matches.map((match) => match.decision.id)).toEqual([
      "config-name",
      "field-name",
    ]);
    await service.close();
  });

  it("does not manufacture results when even the best semantic match is weak", async () => {
    const { service } = await makeService((text) =>
      text.includes("Query:天气")
        ? [1, 0]
        : [0.39, Math.sqrt(1 - 0.39 ** 2)],
    );

    const matches = await service.searchDecisions({
      query: "天气",
      ...atHand([decision("unrelated", "部署方式怎么选？")]),
      lexical: [],
      limit: 10,
    });

    expect(matches).toEqual([]);
    await service.close();
  });

  it("reads whole only the decisions whose notes changed, and those it shows", async () => {
    const { service } = await makeService();
    const candidates = [
      decision("exact", "如何部署服务？"),
      decision("semantic", "先准备可回退路径再扩大改动"),
      decision("unrelated", "午餐选择什么？"),
    ];
    const loaded: string[][] = [];
    const search = (rows: IndexedDecision[]) =>
      service.searchDecisions({
        query: "如何降低上线风险？",
        candidates: rows,
        load: (ids) => {
          loaded.push(ids);
          return rows.filter((row) => ids.includes(row.id));
        },
        lexical: [],
        limit: 10,
      });

    await search(candidates);
    expect(loaded).toEqual([["exact", "semantic", "unrelated"], ["exact", "semantic"]]);
    // Every search read every decision whole, text and all: ten thousand of them for one query.
    loaded.length = 0;
    expect((await search(candidates)).map((match) => match.decision.id)).toEqual(["exact", "semantic"]);
    expect(loaded).toEqual([["exact", "semantic"]]);
    loaded.length = 0;
    await search([candidates[0]!, candidates[1]!, { ...candidates[2]!, contentHash: "source-unrelated-edited" }]);
    expect(loaded).toEqual([["unrelated"], ["exact", "semantic"]]);
    await service.close();
  });
});
