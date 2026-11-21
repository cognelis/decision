import { assessDecisionApplicability, type MethodologyRecord } from "@cognelis/decision-core";
import { adoptedSummaryContext, CONTEXT_SUMMARY_LINES, decisionContextQuerySchema, decisionScopeSchema } from "@cognelis/decision-protocol";
import type { DecisionContextDocument, DecisionContextSnapshot, IndexedDecision } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

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
  contextSnapshot?: () => Promise<DecisionContextSnapshot>,
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
  const options = { vectors, gateway, ...(contextSnapshot === undefined ? {} : { contextSnapshot }) };
  return {
    service: new SemanticSearchService(options),
    vectors,
    path,
    embedded,
    /** The service as the next start makes it, on the same vectors. */
    restart: () => new SemanticSearchService(options),
  };
};

const summary = (id: string, overrides: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
  id, source: "summarize", kind: "summarized_decision", title: `${id}-会话状态放在哪里`, project: "web", status: "accepted",
  created: "2026-09-01", summary: "会话状态放进 Redis，不放进程内存。", appliesWhen: null, caution: null, tags: ["缓存", "会话"],
  supersedes: [], supersededBy: [], relativePath: `Decision Journal/summarize/${id}.md`, client: null, sessionId: null,
  body: "## 决策问题\n会话状态放在哪里？", bodyStartLine: 20, contentHash: `note-${id}`, ...overrides,
});
/** The summarize notes as a scan reads them; `skipped`, it did not reach them all. */
const summaries = (documents: DecisionContextDocument[], skipped = 0) => async (): Promise<DecisionContextSnapshot> => ({
  documents,
  sources: [{ source: "summarize", records: documents.length, skipped, status: skipped > 0 ? "partial" : documents.length > 0 ? "ready" : "empty" }],
});
const notQueries = (texts: string[]) => texts.filter((text) => !text.startsWith("Instruct:"));
/** One call at a time, as a provider's context runs them (QwenEmbeddingProvider's #tail): one given up on runs on. */
const serial = (embed: (texts: string[]) => Promise<{ model: string; vectors: number[][] }>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    embed: (texts: string[]) => {
      const run = tail.then(() => embed(texts));
      tail = run.catch(() => undefined);
      return run;
    },
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
    // Twenty batches of four: a whole vault for a newly installed local model.
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

  it("recalls a principle through vectors when wording does not overlap, never as a strong match", async () => {
    const { service } = await makeService();
    const matches = await service.recallMethodologies(
      [
        methodology("safe", "先建立回退能力，再逐步扩大范围"),
        methodology("food", "优先选择清淡午餐"),
        methodology("shared", "控制上线风险时先分批实施"),
      ],
      {
        question: "怎样控制上线风险？",
        selectedAnswer: "分批实施",
        optionLabels: ["分批实施", "一次完成"],
        context: null,
      },
      3,
    );

    // Nothing it shares with the question to show for itself: counted as strong, a consultation
    // answered by vectors alone read as a rule that holds here, and the 强匹配 counts with it.
    const vectorsOnly = matches.find((match) => match.principleId === "safe");
    expect(vectorsOnly).toMatchObject({ strength: "possible", matchedTerms: [] });
    expect(vectorsOnly?.reason).toMatch(/本地语义向量/u);
    // One that shares the question's wording still can be.
    expect(matches.find((match) => match.principleId === "shared")).toMatchObject({ strength: "strong" });
    await service.close();
  });

  it("counts a principle by the words it shares with the question, though five others share more", async () => {
    // Closest by vectors; sixth by the words, past the five the lexical recall keeps.
    const { service } = await makeService((text) => (/怎样控制|回滚预案/u.test(text) ? [1, 0] : [0, 1]));
    const crowd = Array.from({ length: 5 }, (_, index) => methodology(`crowd-${index}`, `控制上线风险时先分批实施，第 ${index + 1} 种做法`));
    const matches = await service.recallMethodologies(
      [...crowd, methodology("rollback", "上线风险高时先确认回滚预案")],
      { question: "怎样控制上线风险？", selectedAnswer: "分批实施", optionLabels: ["分批实施", "一次完成"], context: null },
      6,
    );

    // Taken for vectors alone, it read as possible with nothing shared, whether it was strong hanging on how many others
    // shared the question's words.
    const rollback = matches.find((match) => match.principleId === "rollback");
    expect(rollback).toMatchObject({ strength: "strong" });
    expect(rollback?.matchedTerms.length).toBeGreaterThan(0);
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

  it("keeps a decision's outcome and lesson in what it embeds, ahead of a long captured context", async () => {
    const { service, embedded } = await makeService((text) => (/回滚|备份/u.test(text) ? [1, 0] : [0, 1]));
    // A captured task and its framing, as a quarter of the reader's decisions hold, past the 700 characters.
    const reviewed = {
      ...decision("reviewed", "上线方案怎么定？"),
      context: "当时在迁移订单服务，需要同时兼顾老客户端。".repeat(40),
      outcome: "上线当晚回滚过一次",
      outcomeVerdict: "worse",
      outcomeLesson: "回滚前先备份数据库",
    };

    const matches = await service.searchDecisions({
      query: "回滚之前要先做什么",
      ...atHand([reviewed, decision("other", "午餐选择什么？")]),
      lexical: [],
      limit: 10,
    });

    // The lesson came after the context and was cut off with it: the decision was not found by what it taught.
    expect(embedded.find((text) => text.startsWith("上线方案怎么定？"))).toContain("回滚前先备份数据库");
    expect(matches.map((match) => [match.decision.id, match.matchKind])).toEqual([["reviewed", "semantic"]]);
    await service.close();
  });

  it("embeds again a decision whose vector an earlier recipe made, though its note is unchanged", async () => {
    const { service, vectors, embedded } = await makeService();
    const reviewed = { ...decision("reviewed", "上线方案怎么定？"), context: "背景。".repeat(300), outcomeLesson: "先备份" };
    // As every vector before the recipe was versioned: made from the note (its hash alone), of other text.
    vectors.upsert([{
      entityType: "decision", entityId: "reviewed", model: "test-embedding", vector: [0, 1],
      sourceHash: reviewed.contentHash, contentHash: createHash("sha256").update("旧配方的文本", "utf8").digest("hex"),
    }]);

    await service.synchronize(indexed([reviewed]), []);

    // Known by the note's hash alone, it was taken as current: the new recipe never reached it.
    expect(embedded.filter((text) => !text.startsWith("Instruct:"))).toEqual([expect.stringContaining("先备份")]);
    expect(vectors.metadata("decision")[0]?.sourceHash).not.toBe(reviewed.contentHash);
    await service.close();
  });

  it("embeds a decision without the lines around its adopted summary, and again only those whose text that changes", async () => {
    const { service, vectors, embedded } = await makeService();
    const { change, views, decided } = CONTEXT_SUMMARY_LINES;
    const summary = [change, "给请求加了超时。", views, "- 超时写死不好调整", decided, "超时由网关约定的配置传入。"].join("\n");
    const adopted = { ...decision("adopted", "超时由谁决定？"), context: adoptedSummaryContext(summary, "PR：调整请求超时") };
    const plain = { ...decision("plain", "日志保留多久？"), context: "合规要求留 30 天。" };
    // Vectors the recipe before this one made: the lines in the adopted decision's text, the plain one's as it still is.
    const before = (item: IndexedDecision) => [item.question, item.selectedAnswer, item.project, item.context].join("\n");
    vectors.upsert([adopted, plain].map((item) => ({
      entityType: "decision" as const, entityId: item.id, model: "test-embedding", vector: [0, 1],
      sourceHash: `v2:${item.contentHash}`, contentHash: createHash("sha256").update(before(item), "utf8").digest("hex"),
    })));

    await service.synchronize(indexed([adopted, plain]), []);

    // Only the text that changed is embedded again; the plain one is known as current without a call to the model.
    const texts = notQueries(embedded);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("超时由网关约定的配置传入。");
    for (const line of Object.values(CONTEXT_SUMMARY_LINES)) expect(texts[0]).not.toContain(line);
    expect(vectors.metadata("decision").map((item) => item.sourceHash).sort()).toEqual([`v3:${adopted.contentHash}`, `v3:${plain.contentHash}`]);
    await service.close();
  });

  it("embeds every decision again for another embedding model, its dimension part of the model's name", async () => {
    const { service, vectors } = await makeService();
    const decisions = [decision("a", "先准备可回退路径"), decision("b", "分批上线")];
    await service.synchronize(indexed(decisions), []);
    const embedded: string[] = [];
    const larger = new SemanticSearchService({
      vectors,
      gateway: { embed: async (texts: string[]) => { embedded.push(...texts); return { model: "test-embedding:embedding-3", vectors: texts.map(() => [1, 0, 0]) }; } },
    });

    await larger.synchronize(indexed(decisions), []);

    expect(embedded.filter((text) => !text.startsWith("Instruct:"))).toHaveLength(2);
    expect(vectors.metadata("decision").map((item) => [item.model, item.dimension])).toEqual([["test-embedding:embedding-3", 3], ["test-embedding:embedding-3", 3]]);
    await larger.close();
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

describe("summary vectors", () => {
  it("embeds each summary once, what was chosen and weighed ahead of its body, within 700 characters", async () => {
    const long = summary("DEC-0001", {
      optionsPresented: ["放进程内存", "放 Redis"], constraintsRevealed: ["重启后不能丢登录"],
      body: `## 决策问题\n会话状态放在哪里？\n\n## 背景\n${"当时订单服务要同时兼顾老客户端。".repeat(60)}`,
    });
    const { service, vectors, embedded } = await makeService(defaultVector, summaries([long, summary("DEC-0002")]));

    await service.synchronizeSummaries();

    const text = notQueries(embedded).find((item) => item.startsWith("DEC-0001"));
    // The body runs past the window at the median (962 characters): first, it cut off the options the note keeps in
    // its properties alone (IMP-117: 50 of 536 appear in its text).
    expect(text?.split("\n").slice(0, 7)).toEqual([
      "DEC-0001-会话状态放在哪里", "会话状态放进 Redis，不放进程内存。", "放进程内存", "放 Redis", "重启后不能丢登录", "缓存 会话", "## 决策问题",
    ]);
    expect(text).toHaveLength(700);
    expect(vectors.metadata("summary").map((item) => [item.entityId, item.sourceHash])).toEqual([
      ["DEC-0001", "v1:note-DEC-0001"], ["DEC-0002", "v1:note-DEC-0002"],
    ]);
    // Nothing changed since: nothing embedded but the question whether the model is there.
    embedded.length = 0;
    await service.synchronizeSummaries();
    expect(notQueries(embedded)).toEqual([]);
    await service.close();
  });

  it("reads no note without a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-summary-missing-"));
    let reads = 0;
    const service = new SemanticSearchService({
      vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
      gateway: { embed: async () => { throw new Error("model_missing"); } },
      contextSnapshot: async () => { reads += 1; return summaries([summary("DEC-0001")])(); },
    });
    await expect(service.synchronizeSummaries()).rejects.toThrow("model_missing");
    expect(reads).toBe(0);
    await service.close();
  });

  it("embeds a summary again when its note changes, and drops the vector of one deleted", async () => {
    let documents = [summary("DEC-0001"), summary("DEC-0002"), summary("DEC-0003")];
    const { service, vectors, embedded } = await makeService(defaultVector, async () => summaries(documents)());
    await service.synchronizeSummaries();
    embedded.length = 0;

    documents = [summary("DEC-0001"), summary("DEC-0002", { contentHash: "note-DEC-0002-edited", summary: "会话状态改放数据库。" })];
    await service.synchronizeSummaries();

    expect(notQueries(embedded)).toEqual([expect.stringContaining("会话状态改放数据库。")]);
    expect(vectors.metadata("summary").map((item) => [item.entityId, item.sourceHash])).toEqual([
      ["DEC-0001", "v1:note-DEC-0001"], ["DEC-0002", "v1:note-DEC-0002-edited"],
    ]);
    await service.close();
  });

  it("embeds again a summary whose vector another recipe made, though its note is unchanged", async () => {
    const { service, vectors, embedded } = await makeService(defaultVector, summaries([summary("DEC-0001")]));
    vectors.upsert([{
      entityType: "summary", entityId: "DEC-0001", model: "test-embedding", vector: [0, 1],
      sourceHash: "v0:note-DEC-0001", contentHash: createHash("sha256").update("旧配方的文本", "utf8").digest("hex"),
    }]);

    await service.synchronizeSummaries();

    expect(notQueries(embedded)).toEqual([expect.stringContaining("会话状态放进 Redis")]);
    expect(vectors.metadata("summary")[0]?.sourceHash).toBe("v1:note-DEC-0001");
    await service.close();
  });

  it("takes the vector of a summary renamed since as made of other text, and asks for it again", async () => {
    let documents = [summary("DEC-0001")];
    const { service, embedded } = await makeService(
      (text) => (text.includes("Query:会话") || text.includes("会话状态放进") ? [1, 0] : [0, 1]),
      async () => summaries(documents)(),
    );
    await service.synchronizeSummaries();
    // Renamed in Obsidian: the same note, its title (its file's name) another.
    documents = [summary("DEC-0001", { title: "DEC-0001-登录态放在哪里", relativePath: "Decision Journal/summarize/DEC-0001-登录态放在哪里.md" })];

    // Known by its note's hash alone, which a rename leaves as it was, it was scored by its old name.
    expect(await service.similarTo("会话")(documents)).toEqual({ near: [], pending: 1 });
    await service.synchronizeSummaries();
    expect(notQueries(embedded).at(-1)).toContain("DEC-0001-登录态放在哪里");
    expect(await service.similarTo("会话")(documents)).toMatchObject({ pending: 0 });
    await service.close();
  });

  it("keeps the vectors of summaries a read did not reach", async () => {
    let read = summaries([summary("DEC-0001"), summary("DEC-0002")]);
    const { service, vectors } = await makeService(defaultVector, () => read());
    await service.synchronizeSummaries();

    // Cut short by the scan's budget, or a note iCloud holds: pruned, every summary it missed was embedded again.
    read = summaries([summary("DEC-0001")], 1);
    await service.synchronizeSummaries();

    expect(vectors.metadata("summary").map((item) => item.entityId)).toEqual(["DEC-0001", "DEC-0002"]);
    await service.close();
  });

  it("answers a principle consultation while every summary is being embedded, not after", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-summary-consult-"));
    let batches = 0;
    let underWay!: () => void;
    const started = new Promise<void>((resolve) => { underWay = resolve; });
    const service = new SemanticSearchService({
      vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
      gateway: {
        embed: async (texts: string[]) => {
          if (texts[0]!.startsWith("DEC-")) {
            batches += 1;
            underWay();
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return { model: "test-embedding", vectors: texts.map(defaultVector) };
        },
      },
      // Ten batches: the 299 summaries of a first start after the upgrade took 18 seconds.
      contextSnapshot: summaries(Array.from({ length: 40 }, (_, index) => summary(`DEC-${index}`))),
    });
    const sync = service.synchronizeSummaries();
    await started;

    const matches = await service.recallMethodologies(
      [methodology("safe", "先建立回退能力，再逐步扩大范围")],
      { question: "怎样控制上线风险？", selectedAnswer: null, optionLabels: [], context: null },
      3,
    );

    // Queued behind the whole sync, a consultation came back only after every batch, past the bridge's five seconds.
    expect(batches).toBeLessThan(10);
    expect(matches.map((match) => match.principleId)).toEqual(["safe"]);
    await sync;
    expect(batches).toBe(10);
    await service.close();
  });

  it("gives up on the vectors for a consultation past its deadline, and says so", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-consult-deadline-"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const service = new SemanticSearchService({
      vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
      gateway: {
        embed: async (texts: string[]) => {
          if (!texts[0]!.startsWith("Instruct:")) await held;
          return { model: "test-embedding", vectors: texts.map(defaultVector) };
        },
      },
    });
    // A decision sync holding the queue: a model loading, or a vault of new decisions.
    const sync = service.synchronize(indexed([decision("a", "先准备可回退路径")]), []);

    const recall = service.recallMethodologies(
      [methodology("safe", "先建立回退能力，再逐步扩大范围")],
      { question: "怎样控制上线风险？", selectedAnswer: null, optionLabels: [], context: null },
      3,
      100,
    );
    const outcome = await Promise.race([
      recall.then(() => "answered", (error: Error) => error.message),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);

    // Rejected, the consultation falls back to the principles' words (buildDecisionConsultation).
    expect(outcome).toBe("Local embedding did not answer in time");
    release();
    await sync;
    await service.close();
  });

  it("leaves a summary sync still waiting its turn at a quit undone: no model asked, no note read", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-summary-queued-close-"));
    let probes = 0;
    let reads = 0;
    let underWay!: () => void;
    const started = new Promise<void>((resolve) => { underWay = resolve; });
    let finishBatch!: () => void;
    const service = new SemanticSearchService({
      vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
      gateway: {
        embed: async (texts: string[]) => {
          if (texts[0]!.startsWith("Instruct:")) probes += 1;
          else if (probes === 1) {
            underWay();
            await new Promise<void>((resolve) => { finishBatch = resolve; });
          }
          return { model: "test-embedding", vectors: texts.map(defaultVector) };
        },
      },
      contextSnapshot: async () => { reads += 1; return summaries(Array.from({ length: 12 }, (_, index) => summary(`DEC-${index}`)))(); },
    });
    const first = service.synchronizeSummaries();
    await started;
    // Asked for meanwhile, as a search asks when it finds a summary without a vector.
    const second = service.synchronizeSummaries();

    const closed = service.close();
    finishBatch();
    await closed;
    await Promise.allSettled([first, second]);

    // Run at the quit, it asked the model and read every note again, and the quit waited on both.
    expect([probes, reads]).toEqual([1, 1]);
  });

  it("stops a summary sync at the batch it is on when closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "semantic-summary-close-"));
    const signals: Array<AbortSignal | undefined> = [];
    let batchUnderWay!: () => void;
    const underWay = new Promise<void>((resolve) => { batchUnderWay = resolve; });
    let finishBatch!: () => void;
    const service = new SemanticSearchService({
      vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
      gateway: {
        embed: async (texts: string[], signal?: AbortSignal) => {
          signals.push(signal);
          if (signals.length === 2) {
            batchUnderWay();
            await new Promise<void>((resolve) => { finishBatch = resolve; });
          }
          return { model: "test-embedding", vectors: texts.map(defaultVector) };
        },
      },
      // Every summary at the first start after the upgrade.
      contextSnapshot: summaries(Array.from({ length: 30 }, (_, index) => summary(`DEC-${index}`))),
    });
    const sync = service.synchronizeSummaries();
    await underWay;

    const closed = service.close();
    expect(signals[1]?.aborted).toBe(true);
    finishBatch();
    await closed;
    await sync.catch(() => undefined);
    expect(signals).toHaveLength(2);
  });
});


describe("fresh decision and principle vectors", () => {
  it("reports and repairs missing and changed vectors without restarting", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "fresh-vectors-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    let decisions = [decision("fresh", "先验证回退路径")];
    let principles = [methodology("principle", "先验证回退能力")];
    const documents = () => [
      summary("fresh", { source: "decisions", kind: "recorded_decision", contentHash: decisions[0]!.contentHash }),
      summary("principle", { source: "principles", kind: "adopted_principle", title: principles[0]!.title,
        summary: principles[0]!.principle, appliesWhen: principles[0]!.appliesWhen, caution: principles[0]!.caution }),
    ];
    const service = new SemanticSearchService({ vectors,
      gateway: { embed: async (texts) => ({ model: "test", vectors: texts.map(() => [1, 0]) }) },
      currentSources: async () => ({ decisions: indexed(decisions), methodologies: principles }),
    });
    try {
      expect(await service.similarTo("不同措辞")(documents())).toMatchObject({ near: [], pendingDecisions: 1, pendingPrinciples: 1 });
      await vi.advanceTimersByTimeAsync(250);
      const recalled = await service.similarTo("不同措辞")(documents());
      expect("near" in recalled && recalled.near.map((hit) => hit.document.id)).toEqual(["fresh", "principle"]);
      decisions = [{ ...decisions[0]!, contentHash: "reviewed", outcome: "验证失败后回退", outcomeLesson: "先验证" }];
      principles = [{ ...principles[0]!, principle: "先验证回退能力，再发布" }];
      expect(await service.similarTo("不同措辞")(documents())).toMatchObject({ near: [], pendingDecisions: 1, pendingPrinciples: 1 });
      await vi.advanceTimersByTimeAsync(250);
      const reviewed = await service.similarTo("不同措辞")(documents());
      expect("near" in reviewed && reviewed.near.map((hit) => hit.document.id)).toEqual(["fresh", "principle"]);
      expect(vectors.metadata("decision")[0]?.sourceHash).toBe("v3:reviewed");
    } finally { await service.close(); vi.useRealTimers(); }
  });

  it("embeds a few records it could show with no current vector during the search, for that search alone (IMP-137)", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-inline-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const decisions = ["a", "b", "c", "d", "e"].map((id) => decision(id, "先验证回退路径"));
    const asked: string[][] = [];
    const gateway = { embed: async (texts: string[]) => { asked.push(texts); return { model: "test", vectors: texts.map(() => [1, 0]) }; } };
    const service = new SemanticSearchService({ vectors, decisions: indexed(decisions), gateway, freshGateway: gateway });
    const document = (id: string, contentHash = `source-${id}`) =>
      summary(id, { source: "decisions", kind: "recorded_decision", contentHash });
    try {
      // Another project's: never shown, so never embedded here, and counted as before.
      const scoped = await service.similarTo("不同措辞")([document("a"), document("b")], (found) => found.id === "a");
      expect(scoped).toMatchObject({ near: [{ document: { id: "a" } }], pendingDecisions: 1 });
      // Not stored: the sync the write began does, in its turn after any deletion.
      expect(vectors.metadata("decision")).toEqual([]);
      // A retired principle: no sync keeps its vector, so none is made here.
      const retired = summary("retired", { source: "principles", kind: "adopted_principle", status: "retired" });
      expect(await service.similarTo("不同措辞")([retired], () => true)).toMatchObject({ near: [], pendingPrinciples: 1 });
      // Indexed from another version of the note than the one searched: left to the sync.
      expect(await service.similarTo("不同措辞")([document("c", "newer")], () => true)).toMatchObject({ near: [], pendingDecisions: 1 });
      // Past the few, none: the search costs what it did.
      asked.length = 0;
      const many = await service.similarTo("不同措辞")(["a", "b", "c", "d", "e"].map((id) => document(id)), () => true);
      expect(many).toMatchObject({ near: [], pendingDecisions: 5 });
      expect(notQueries(asked.flat())).toEqual([]);
    } finally { await service.close(); }
  });

  it("embeds fresh records one at a time within their own budget, the supplement from stored vectors kept whatever their pace", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-budget-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const decisions = ["kept", "a", "b", "c", "d"].map((id) => decision(id, "先验证回退路径"));
    let slow = false;
    // A record's text takes 150 ms once slow, as behind a sync's batch: the query's own vector does not.
    const gateway = { embed: async (texts: string[]) => {
      if (slow && !texts[0]!.startsWith("Instruct:")) await new Promise((resolve) => setTimeout(resolve, 150 * texts.length));
      return { model: "test", vectors: texts.map(() => [1, 0]) };
    } };
    const service = new SemanticSearchService({ vectors, decisions: indexed(decisions), gateway, freshGateway: gateway });
    const document = (id: string) => summary(id, { source: "decisions", kind: "recorded_decision", contentHash: `source-${id}` });
    try {
      await service.synchronize(indexed(decisions.slice(0, 1)), []);
      slow = true;
      const started = performance.now();
      const found = await service.similarTo("不同措辞")(["kept", "a", "b", "c", "d"].map(document), () => true);
      // Within the 250 ms budget and a call over: four in one call took 600 ms, and toward the query's deadline.
      expect(performance.now() - started).toBeLessThan(450);
      if (!("near" in found)) throw new Error("expected a supplement");
      expect(found.near.map((hit) => hit.document.id)).toContain("kept");
      // Those done are used, those left counted and asked of the sync.
      const embedded = found.near.length - 1;
      expect(embedded).toBeGreaterThanOrEqual(1);
      expect(embedded).toBeLessThan(4);
      expect(found.pendingDecisions).toBe(4 - embedded);
    } finally { await service.close(); }
  });

  it("judges at most a few records without a vector for whether they could be shown, and embeds none when that leaves it unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-judged-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const gateway = { embed: async (texts: string[]) => ({ model: "test", vectors: texts.map(() => [1, 0]) }) };
    const service = new SemanticSearchService({ vectors, gateway, freshGateway: gateway });
    // Two thousand of another project's without vectors: each judged against a PR's files, they held a search for 869 ms.
    const backlog = Array.from({ length: 2_000 }, (_, index) => summary(`other-${index}`, { project: "api" }));
    let judged = 0;
    try {
      const found = await service.similarTo("不同措辞")(backlog, () => { judged += 1; return false; });
      expect(judged).toBeLessThanOrEqual(32);
      expect(found).toMatchObject({ near: [], pending: 2_000 });
      // One of this project's past them: whether it is among few is not known, so it waits for the sync like the rest.
      const mine = summary("mine");
      expect(await service.similarTo("不同措辞")([...backlog, mine], (document) => document === mine))
        .toMatchObject({ near: [], pending: 2_001 });
    } finally { await service.close(); }
  });

  it("stops judging records by the clock once the budget is spent, the supplement from stored vectors kept", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-judged-clock-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const kept = summary("kept");
    const gateway = { embed: async (texts: string[]) => ({ model: "test", vectors: texts.map(() => [1, 0]) }) };
    const service = new SemanticSearchService({ vectors, gateway, freshGateway: gateway, contextSnapshot: summaries([kept]) });
    // Each judgment holds the main thread 100 ms, as one against long paths does: no timer can fire meanwhile.
    const slowly = () => { const until = performance.now() + 100; while (performance.now() < until); return false; };
    let judged = 0;
    try {
      await service.synchronizeSummaries();
      const started = performance.now();
      const found = await service.similarTo("会话")([kept, ...Array.from({ length: 10 }, (_, index) => summary(`slow-${index}`))],
        () => { judged += 1; return slowly(); });
      // Ten took a second; within the 250 ms budget and the judgment under way at it, three.
      expect(judged).toBeLessThanOrEqual(3);
      expect(performance.now() - started).toBeLessThan(450);
      expect(found).toMatchObject({ near: [{ document: { id: "kept" } }], pending: 10 });
    } finally { await service.close(); }
  });

  it("holds a search to its budget against a PR's files at the limits of their paths (R10-CR FW-R1)", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-judged-paths-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const prefix = "a/".repeat(480);
    const path = (index: number) => `${prefix}scope-${String(index).padStart(10, "0")}`;
    // Valid by the protocol: 3,000 files of 979 characters, and records of 20 paths that apply and 20 that do not.
    const scope = decisionScopeSchema.parse({ paths: [...Array.from({ length: 19 }, (_, index) => path(index)), "a"],
      excludedPaths: Array.from({ length: 20 }, (_, index) => path(index + 100)) });
    const task = decisionContextQuerySchema.parse({ query: "会话", project: "web",
      taskScope: { files: Array.from({ length: 3_000 }, (_, index) => `${prefix}files-${String(index).padStart(10, "0")}.ts`) } });
    const kept = summary("kept");
    const gateway = { embed: async (texts: string[]) => ({ model: "test", vectors: texts.map(() => [1, 0]) }) };
    const service = new SemanticSearchService({ vectors, gateway, freshGateway: gateway, contextSnapshot: summaries([kept]) });
    let judged = 0;
    try {
      await service.synchronizeSummaries();
      const records = Array.from({ length: 32 }, (_, index) => summary(`long-${index}`, { project: "api", scope, scopeState: "current" }));
      const started = performance.now();
      const found = await service.similarTo("会话")([kept, ...records], (document) => {
        judged += 1;
        return assessDecisionApplicability(document, task.taskScope, task.project).status !== "out_of_scope";
      });
      // All 32 held the main thread about six seconds, and the stored record's supplement with it.
      expect(judged).toBeLessThan(32);
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(found).toMatchObject({ near: [{ document: { id: "kept" } }] });
    } finally { await service.close(); }
  }, 20_000);

  it("drops a decision deleted while it was being embedded from the search under way", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-deleted-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const decisions = [decision("gone", "先验证回退路径")];
    let entered!: () => void;
    let release!: () => void;
    const embedding = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const gateway = { embed: async (texts: string[]) => {
      if (!texts[0]!.startsWith("Instruct:")) { entered(); await held; }
      return { model: "test", vectors: texts.map(() => [1, 0]) };
    } };
    const service = new SemanticSearchService({ vectors, decisions: indexed(decisions), gateway, freshGateway: gateway });
    const gone = summary("gone", { source: "decisions", kind: "recorded_decision", contentHash: "source-gone" });
    try {
      const searching = service.similarTo("不同措辞")([gone], () => true);
      await embedding;
      // Deleted meanwhile: gone from the index the search reads its decisions from.
      decisions.length = 0;
      release();
      expect(await searching).toMatchObject({ near: [], pendingDecisions: 1 });
    } finally { await service.close(); }
  });

  it("asks for the sync of records it embedded itself, so a new summary is stored once and not embedded at every search", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-summary-sync-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const documents: DecisionContextDocument[] = [];
    const embedded: string[] = [];
    const gateway = { embed: async (texts: string[]) => {
      embedded.push(...texts);
      return { model: "test", vectors: texts.map(() => [1, 0]) };
    } };
    const service = new SemanticSearchService({ vectors, gateway, freshGateway: gateway, contextSnapshot: summaries(documents) });
    try {
      // The start's sync over, a summary comes: no write asks for its sync, only the searches that find it unmade.
      await service.synchronizeSummaries();
      documents.push(summary("DEC-0001"));
      expect(await service.similarTo("会话")(documents, () => true)).toMatchObject({ near: [{ document: { id: "DEC-0001" } }], pending: 0 });
      for (let waited = 0; vectors.metadata("summary").length === 0 && waited < 2_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(vectors.metadata("summary")).toHaveLength(1);
      const before = notQueries(embedded).length;
      expect(await service.similarTo("会话")(documents, () => true)).toMatchObject({ near: [{ document: { id: "DEC-0001" } }], pending: 0 });
      expect(notQueries(embedded)).toHaveLength(before);
    } finally { await service.close(); }
  });

  it("embeds a search's own records apart from the queries, so one it gave up on holds up no query after it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-apart-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    const kept = summary("kept");
    const written = summary("written", { summary: "新写入的会话存储决定。" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The new record's text answers only once released, as a native call past its budget runs on regardless.
    const embed = async (texts: string[]) => {
      if (texts.some((text) => text.includes("新写入"))) await held;
      return { model: "test", vectors: texts.map(() => [1, 0]) };
    };
    const service = new SemanticSearchService({ vectors, gateway: serial(embed), freshGateway: serial(embed),
      contextSnapshot: summaries([kept]) });
    try {
      await service.synchronizeSummaries();
      const first = await service.similarTo("会话")([kept, written], () => true);
      expect(first).toMatchObject({ near: [{ document: { id: "kept" } }], pending: 1 });
      // The query after it, of stored vectors alone: on the queries' context, behind nothing.
      expect(await service.similarTo("会话", 600)([kept], () => true)).toMatchObject({ near: [{ document: { id: "kept" } }] });
    } finally { release(); await service.close(); }
  });

  it("debounces index changes, takes current sources in its turn and cancels queued work on close", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(join(tmpdir(), "fresh-vector-queue-"));
    const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
    let decisions = [decision("first", "验证回退")];
    const source = vi.fn(async () => ({ decisions: indexed(decisions), methodologies: [] }));
    const service = new SemanticSearchService({ vectors,
      gateway: { embed: async (texts) => ({ model: "test", vectors: texts.map(() => [1, 0]) }) }, currentSources: source,
    });
    try {
      service.scheduleSynchronization();
      await vi.advanceTimersByTimeAsync(100);
      service.scheduleSynchronization();
      decisions = [decision("latest", "验证回退")];
      await vi.advanceTimersByTimeAsync(149);
      expect(source).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(source).toHaveBeenCalledTimes(1);
      expect(vectors.metadata("decision").map((item) => item.entityId)).toEqual(["latest"]);
      service.scheduleSynchronization();
      await service.close();
      await vi.advanceTimersByTimeAsync(250);
      expect(source).toHaveBeenCalledTimes(1);
    } finally { await service.close(); vi.useRealTimers(); }
  });
});

it.each([false, true])("queues fresh sources after active indexing and skips them on close=%s", async (closing) => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "fresh-vector-exclusive-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let decisions = [decision("before", "验证回退")];
  const sources = vi.fn(async () => ({ decisions: indexed(decisions), methodologies: [] }));
  const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
  const service = new SemanticSearchService({ vectors, currentSources: sources,
    gateway: { embed: async (texts) => { await gate; return { model: "test", vectors: texts.map(() => [1, 0]) }; } },
  });
  try {
    const active = service.synchronize(indexed(decisions), []);
    service.scheduleSynchronization();
    await vi.advanceTimersByTimeAsync(250);
    expect(sources).not.toHaveBeenCalled();
    decisions = [decision("after", "验证回退")];
    const closed = closing ? service.close() : undefined;
    release();
    await active;
    await vi.advanceTimersByTimeAsync(0);
    if (closing) {
      await closed;
      expect(sources).not.toHaveBeenCalled();
    } else {
      expect(sources).toHaveBeenCalledTimes(1);
      expect(vectors.metadata("decision").map((item) => item.entityId)).toEqual(["after"]);
    }
  } finally { release(); await service.close(); vi.useRealTimers(); }
});


it("removes a decision after an in-flight synchronization so the old embedding cannot restore its vector", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-remove-inflight-"));
  const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const service = new SemanticSearchService({ vectors, gateway: { embed: async texts => {
    if (first) { first = false; begin(); await blocked; }
    return { model: "test", vectors: texts.map(() => [1, 0]) };
  } } });
  try {
    const sync = service.synchronize(indexed([decision("gone", "合成决策")]), []);
    await started;
    const removed = service.removeDecision("gone");
    release(); await sync; await removed;
    expect(vectors.metadata("decision")).toEqual([]);
  } finally { release(); await service.close(); }
});

// A model loading under a busy Mac, or one never yet asked this start (no decisions to sync, its file hashed at the first
// call): a second was not enough, and a search went without the supplement it would have had (R8: 33–42 at load 8).
it("waits two and a half seconds for a query's embedding, and readies the model once the index is", async () => {
  const root = await mkdtemp(join(tmpdir(), "semantic-query-deadline-"));
  const asked: string[] = [];
  let delay = 0;
  const service = new SemanticSearchService({
    vectors: new SemanticVectorIndex(join(root, "vectors.sqlite")),
    gateway: {
      embed: async (texts: string[]) => {
        asked.push(...texts);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return { model: "test-embedding", vectors: texts.map(defaultVector) };
      },
    },
  });
  await service.warmQueries();
  expect(asked).toEqual([expect.stringContaining("Query:decision")]);
  delay = 1_500;
  expect(await service.similarTo("会话")([])).toMatchObject({ near: [], pending: 0 });
  await service.close();
  // Closed, or the model missing: warming asks nothing of it and fails nothing.
  await expect(service.warmQueries()).resolves.toBeUndefined();
});

describe("similarEntries (preferences and ideas)", () => {
  const make = async (embed: (texts: string[]) => Promise<{ model: string; vectors: number[][] }>) => {
    const vectors = new SemanticVectorIndex(join(await mkdtemp(join(tmpdir(), "entries-")), "vectors.sqlite"));
    return new SemanticSearchService({ vectors, gateway: { embed } });
  };
  const queryOrText = (similar: Record<string, number>) => async (texts: string[]) => ({
    model: "m",
    vectors: texts.map((text) => {
      if (text.startsWith("Instruct:")) return [1, 0];
      const value = Object.entries(similar).find(([phrase]) => text.includes(phrase))?.[1] ?? 0;
      return [value, Math.sqrt(1 - value ** 2)];
    }),
  });

  it("ranks by cosine, keeps each vector by its text, and embeds nothing twice", async () => {
    let embedded = 0;
    const embed = queryOrText({ 抛出: 0.9, 命名: 0.6, 注释: 0.2 });
    const service = await make(async (texts) => { embedded += texts.filter((text) => !text.startsWith("Instruct:")).length; return embed(texts); });
    const items = [{ id: "a", text: "抛出错误" }, { id: "b", text: "命名习惯" }, { id: "c", text: "注释原因" }];
    const first = await service.similarEntries("异常", items);
    expect(first).toEqual({ near: [{ id: "a", similarity: expect.closeTo(0.9) }, { id: "b", similarity: expect.closeTo(0.6) }], pending: 0 });
    expect(embedded).toBe(3);
    await service.similarEntries("异常", items, { floor: 0 });
    expect(embedded).toBe(3);
    // A changed text is embedded again, a gone one forgotten.
    const changed = await service.similarEntries("异常", [{ id: "a", text: "命名也抛出" }], { floor: 0 });
    expect(embedded).toBe(4);
    expect(changed).toMatchObject({ pending: 0 });
    await service.close();
  });

  it("keeps the vectors of entries a search did not ask about", async () => {
    let embedded = 0;
    const embed = queryOrText({ 抛出: 0.9, 命名: 0.6, 注释: 0.2 });
    const service = await make(async (texts) => { embedded += texts.filter((text) => !text.startsWith("Instruct:")).length; return embed(texts); });
    const items = [{ id: "a", text: "抛出错误" }, { id: "b", text: "命名习惯" }, { id: "c", text: "注释原因" }];
    await service.similarEntries("异常", items);
    // One project's search asks about a alone; b and c are not forgotten.
    await service.similarEntries("异常", [items[0]!]);
    await service.similarEntries("异常", items);
    expect(embedded).toBe(3);
    await service.close();
  });

  it("reports a missing model, and the entries it could not embed in time as pending", async () => {
    const missing = await make(async () => { throw Object.assign(new Error("no model"), { code: "model_missing" }); });
    expect(await missing.similarEntries("异常", [{ id: "a", text: "x" }])).toEqual({ unavailable: "model_missing" });
    const slow = await make(async (texts) => {
      if (texts[0]?.startsWith("Instruct:")) return { model: "m", vectors: [[1, 0]] };
      await new Promise(() => undefined);
      return { model: "m", vectors: [] };
    });
    expect(await slow.similarEntries("异常", [{ id: "a", text: "x" }])).toEqual({ near: [], pending: 1 });
  }, 10_000);
});
