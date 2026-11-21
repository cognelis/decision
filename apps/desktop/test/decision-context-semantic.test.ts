import type { MethodologyRecord } from "@cognelis/decision-core";
import { decisionContextQuerySchema, decisionContextResponseSchema } from "@cognelis/decision-protocol";
import { type DecisionContextDocument, type DecisionContextSnapshot, type IndexedDecision, SemanticVectorIndex } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { DecisionContextService } from "../src/main/decision-context-service.js";
import { SemanticSearchService } from "../src/main/semantic-search-service.js";

const QUERY = "重启后登录会掉";
const summary = (id: string, overrides: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
  id, source: "summarize", kind: "summarized_decision", title: `${id}-午餐`, project: "web", status: "accepted",
  created: "2026-09-01", summary: "午餐选清淡的。", appliesWhen: null, caution: null, tags: [],
  supersedes: [], supersededBy: [], relativePath: `Decision Journal/summarize/${id}.md`, client: null, sessionId: null,
  body: "## 决策问题\n吃什么？", bodyStartLine: 20, contentHash: hash(id), ...overrides,
});
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
// Shares 登录 with the query: found by its words.
const keyword = (id: string, overrides: Partial<DecisionContextDocument> = {}) =>
  summary(id, { title: `${id}-登录态`, summary: "登录态写进 Redis。", ...overrides });
// Shares no word with the query, and means what it asks: found by meaning alone.
const near = (id: string, overrides: Partial<DecisionContextDocument> = {}) =>
  summary(id, { title: `${id}-会话放在哪里`, summary: "会话交给外部存储，进程更替时用户无感。", ...overrides });
const query = (value: Parameters<typeof decisionContextQuerySchema.parse>[0]) => decisionContextQuerySchema.parse(value);

/** The query's vector [1, 0]; a text's, by what it says: `similar` maps a phrase in it to its similarity. */
const vectorFor = (similar: Record<string, number>) => (text: string): number[] => {
  if (text.includes(`Query:${QUERY}`)) return [1, 0];
  const found = Object.entries(similar).find(([phrase]) => text.includes(phrase))?.[1] ?? 0;
  return [found, Math.sqrt(1 - found ** 2)];
};

/** A vectors table from before summaries had them, which this start cannot widen: the release before holds its lock. */
const unwidened = (path: string): SemanticVectorIndex => {
  const previous = new DatabaseSync(path);
  previous.exec("PRAGMA journal_mode = WAL");
  previous.exec(`CREATE TABLE semantic_vectors (
    entity_type TEXT NOT NULL CHECK(entity_type IN ('decision', 'methodology')), entity_id TEXT NOT NULL, content_hash TEXT NOT NULL,
    model TEXT NOT NULL, dimension INTEGER NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL, source_hash TEXT,
    PRIMARY KEY(entity_type, entity_id))`);
  previous.exec("CREATE INDEX semantic_vectors_model ON semantic_vectors(entity_type, model)");
  previous.exec("BEGIN IMMEDIATE");
  try {
    return new SemanticVectorIndex(path);
  } finally {
    previous.exec("ROLLBACK");
    previous.close();
  }
};

const setup = async (
  documents: DecisionContextDocument[],
  options: {
    unwidened?: boolean;
    similar?: Record<string, number>;
    /** Stands in for the model's answer to a query, as asked. */
    answerQuery?: () => Promise<void>;
    /** Stands in for the model's answer to a sync's batch. */
    answerBatch?: (texts: string[]) => Promise<void>;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "context-semantic-"));
  const vectors = (options.unwidened ? unwidened : (path: string) => new SemanticVectorIndex(path))(join(root, "vectors.sqlite"));
  const queries: string[] = [];
  const gateway = {
    embed: async (texts: string[]) => {
      if (texts[0]?.startsWith("Instruct:")) {
        queries.push(texts[0]);
        await options.answerQuery?.();
      } else await options.answerBatch?.(texts);
      return { model: "test-embedding", vectors: texts.map(vectorFor(options.similar ?? { 会话交给外部存储: 0.8 })) };
    },
  };
  const scan = async (): Promise<DecisionContextSnapshot> => ({
    documents,
    sources: (["summarize", "decisions", "principles"] as const).map((source) => {
      const records = documents.filter((document) => document.source === source).length;
      return { source, records, skipped: 0, status: records > 0 ? "ready" as const : "empty" as const };
    }),
  });
  const semantic = new SemanticSearchService({ vectors, gateway, freshGateway: gateway, contextSnapshot: scan });
  return { semantic, vectors, queries, context: new DecisionContextService({ scan }, undefined, undefined, semantic) };
};

it("asks no record embedded on the spot for a task of more than 200 files (IMP-137)", async () => {
  const asked: Array<((document: DecisionContextDocument) => boolean) | undefined> = [];
  const semantic = { similarTo: () => async (_: readonly DecisionContextDocument[], eligible?: (document: DecisionContextDocument) => boolean) => {
    asked.push(eligible);
    return { near: [], pending: 0 };
  } };
  const scan = async (): Promise<DecisionContextSnapshot> => ({ documents: [near("N")], sources: [{ source: "summarize", records: 1, skipped: 0, status: "ready" }] });
  const context = new DecisionContextService({ scan }, undefined, undefined, semantic);
  const files = (count: number) => Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);
  await context.search(query({ query: QUERY, taskScope: { files: files(200) } }));
  await context.search(query({ query: QUERY, taskScope: { files: files(201) } }));
  // A question asked just after a write names a few files; a PR's search over hundreds is judged for nothing.
  expect(asked.map((eligible) => typeof eligible)).toEqual(["function", "undefined"]);
});

describe("semantic supplement to the context search", () => {
  // W holds 登录 alone, the query's commoner word: kept, but weak. O holds both words and is another project's, left out.
  const weakly = () => [
    summary("W", { summary: "登录页换了配色。" }),
    keyword("O", { project: "other", summary: "登录态在重启时写进 Redis。" }),
    near("N"),
    summary("F"),
  ];

  it("puts a current record near in meaning before keyword results that are all weak, when every result is on one page", async () => {
    const { semantic, context } = await setup(weakly());
    await semantic.synchronizeSummaries();

    const response = await context.search(query({ query: QUERY, project: "web" }));

    expect(response.results.map((result) => result.id)).toEqual(["N", "W"]);
    expect(response).toMatchObject({ total: 2, nextOffset: null });
    await semantic.close();
  });

  it("puts the current successor found by meaning before the replaced record on its page, however near", async () => {
    // P is found by its words and replaced by S, which only meaning finds, under the 0.55 a supplement needs to go first.
    const documents = () => [
      keyword("P", { status: "superseded", supersededBy: ["S"] }),
      near("S", { supersedes: ["P"] }),
      near("U", { summary: "会话交给外部存储，另一种。" }),
    ];
    const one = await setup(documents(), { similar: { "会话交给外部存储，进程": 0.47, 另一种: 0.46 } });
    await one.semantic.synchronizeSummaries();
    expect((await one.context.search(query({ query: QUERY }))).results.map((result) => result.id)).toEqual(["S", "P", "U"]);
    // Its page is all it moves on: on the next one, the order and what each page holds are as they were.
    const first = await one.context.search(query({ query: QUERY, limit: 1 }));
    expect(first.results.map((result) => result.id)).toEqual(["P"]);
    expect(first).toMatchObject({ total: 3, nextOffset: 1 });
    await one.semantic.close();
  });

  it("keeps the keyword results first over a page, or for a supplement not near enough", async () => {
    const paged = await setup(weakly());
    await paged.semantic.synchronizeSummaries();
    expect((await paged.context.search(query({ query: QUERY, project: "web", limit: 1 }))).results.map((result) => result.id)).toEqual(["W"]);
    await paged.semantic.close();

    const far = await setup(weakly(), { similar: { 会话交给外部存储: 0.5 } });
    await far.semantic.synchronizeSummaries();
    expect((await far.context.search(query({ query: QUERY, project: "web" }))).results.map((result) => result.id)).toEqual(["W", "N"]);
    await far.semantic.close();
  });

  it("finds a summary by meaning alone, after the keyword results, labelled with its similarity", async () => {
    const { semantic, context } = await setup([keyword("DEC-0001"), near("DEC-0002"), summary("DEC-0003")]);
    await semantic.synchronizeSummaries();

    const response = await context.search(query({ query: QUERY }));

    expect(response.results.map((result) => result.id)).toEqual(["DEC-0001", "DEC-0002"]);
    expect(response).toMatchObject({ status: "matched", total: 2, nextOffset: null });
    expect(response.results[1]?.matchReason).toContain("语义相近（本机向量，相似度 80%）");
    expect(response.results[0]?.matchReason).not.toContain("语义");
    expect(response.guidance).toContain("1 条只按含义找到");
    // A bridge already running reads the App's answer by the schema it was built with, strict to the field: one field
    // more, and it read none of the search.
    expect(() => decisionContextResponseSchema.parse(JSON.parse(JSON.stringify(response)))).not.toThrow();
    await semantic.close();
  });

  it("keeps the keyword results in their order, then at most three by meaning, paged without repeats or gaps", async () => {
    const keywords = Array.from({ length: 5 }, (_, index) => keyword(`K-${index}`, { created: `2026-09-0${index + 1}` }));
    const nearby = Array.from({ length: 5 }, (_, index) => near(`S-${index}`, { summary: `会话交给外部存储，第 ${index} 种。` }));
    const similar = Object.fromEntries(nearby.map((_, index) => [`第 ${index} 种`, 0.9 - index * 0.05]));
    const { semantic, context } = await setup([...keywords, ...nearby], { similar });
    await semantic.synchronizeSummaries();
    const lexical = (await new DecisionContextService({ scan: async () => ({ documents: keywords, sources: [{ source: "summarize", records: 5, skipped: 0, status: "ready" }] }) })
      .search(query({ query: QUERY, limit: 20 }))).results.map((result) => result.id);

    const pages: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await context.search(query({ query: QUERY, limit: 3, offset }));
      expect(page.total).toBe(8);
      pages.push(...page.results.map((result) => result.id));
      offset = page.nextOffset;
    }

    expect(pages).toEqual([...lexical, "S-0", "S-1", "S-2"]);
    expect((await context.search(query({ query: QUERY, limit: 20 }))).results.map((result) => result.id)).toEqual(pages);
    await semantic.close();
  });

  it("judges a supplement by scope and lifecycle as it does a keyword result, and counts the one it withholds", async () => {
    const { semantic, context } = await setup([
      keyword("DEC-0001"), near("DEC-0002", { project: "server" }), near("DEC-0003", { summary: "会话交给外部存储，进程重启时用户无感。" }),
    ], { similar: { 会话交给外部存储: 0.9, 进程重启时: 0.7 } });
    await semantic.synchronizeSummaries();

    const scoped = await context.search(query({ query: QUERY, project: "web" }));
    expect(scoped.results.map((result) => result.id)).toEqual(["DEC-0001", "DEC-0003"]);
    expect(scoped.excludedByScope).toBe(1);

    const shown = await context.search(query({ query: QUERY, project: "web", includeOutOfScope: true }));
    expect(shown.results.map((result) => [result.id, result.applicability?.status])).toEqual([
      ["DEC-0001", "needs_review"], ["DEC-0003", "needs_review"], ["DEC-0002", "out_of_scope"],
    ]);
    // A filter on the lifecycle holds for them as well: none of them was replaced.
    expect((await context.search(query({ query: QUERY, relation: "superseded" }))).results).toEqual([]);
    await semantic.close();
  });

  it("embeds no query for a record's id or a browse", async () => {
    const { semantic, context, queries } = await setup([keyword("DEC-0001"), near("DEC-0002")]);
    await semantic.synchronizeSummaries();
    queries.length = 0;

    expect((await context.search(query({ recordId: "DEC-0002" }))).results.map((result) => result.id)).toEqual(["DEC-0002"]);
    expect((await context.search(query({}))).results).toHaveLength(2);

    expect(queries).toEqual([]);
    await semantic.close();
  });

  it("returns the keyword results and says the supplement is unavailable when the model is missing", async () => {
    const { semantic, context } = await setup([keyword("DEC-0001"), near("DEC-0002")], {
      answerQuery: async () => { throw Object.assign(new Error("missing"), { code: "model_missing" }); },
    });

    const response = await context.search(query({ query: QUERY }));

    expect(response.results.map((result) => result.id)).toEqual(["DEC-0001"]);
    expect(response.guidance).toContain("语义补充这次不可用（未安装本机嵌入模型）");
    await semantic.close();
  });

  it("gives up on the query's embedding after two and a half seconds, answering with the keyword results", async () => {
    const { semantic, context } = await setup([keyword("DEC-0001"), near("DEC-0002")], { answerQuery: () => new Promise(() => undefined) });

    const started = performance.now();
    const response = await context.search(query({ query: QUERY }));

    // Waited on whole, a model loading or stuck held the search past the bridge's five seconds, and the agent got nothing.
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(response.results.map((result) => result.id)).toEqual(["DEC-0001"]);
    expect(response.guidance).toContain("语义补充这次不可用（本机嵌入未在时限内完成）");
  });

  it("answers by meaning while a sync is under way, not behind it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let batches = 0;
    const documents = [keyword("DEC-0001"), near("DEC-0002")];
    const { semantic, context } = await setup(documents, { answerBatch: async () => { if (++batches > 1) await held; } });
    await semantic.synchronizeSummaries();
    // A note come since, its batch held as a first start's 299 summaries are, for seconds.
    documents.push(near("DEC-0003", { summary: "会话交给外部存储，换个说法。" }));
    const sync = semantic.synchronizeSummaries();

    const response = await context.search(query({ query: QUERY }));

    // Queued behind the sync, the search waited out its second and found nothing by meaning.
    expect(response.results.map((result) => result.id)).toEqual(["DEC-0001", "DEC-0002"]);
    expect(response.guidance).toContain("还有 1 条历史沉淀的语义向量正在后台建立");
    release();
    await sync;
    expect((await context.search(query({ query: QUERY }))).results.map((result) => result.id)).toEqual(["DEC-0001", "DEC-0002", "DEC-0003"]);
    await semantic.close();
  });

  it("asks for the vectors of summaries that have none, past the few a search embeds, and finds them once made", async () => {
    const unmade = ["DEC-0002", "DEC-0003", "DEC-0004", "DEC-0005", "DEC-0006"];
    const { semantic, context, vectors } = await setup([keyword("DEC-0001"), ...unmade.map((id) => near(id))]);

    const first = await context.search(query({ query: QUERY }));
    expect(first.results.map((result) => result.id)).toEqual(["DEC-0001"]);
    // Counted among those the supplement would have looked at: the one its words found needs none.
    expect(first.guidance).toContain("还有 5 条历史沉淀的语义向量正在后台建立");

    // The sync that search asked for, waiting its turn: asking again finds them.
    await semantic.synchronizeSummaries();
    expect(vectors.metadata("summary")).toHaveLength(6);
    const next = await context.search(query({ query: QUERY }));
    expect(next.results).toHaveLength(4);
    expect(next.guidance).not.toContain("后台建立");
    await semantic.close();
  });

  it("embeds a few it could show that have no vector during the search, found by meaning at once (IMP-137)", async () => {
    let release!: () => void;
    const batch = new Promise<void>((resolve) => { release = resolve; });
    const { semantic, context, vectors } = await setup([keyword("DEC-0001"), near("DEC-0002"), near("DEC-0003", { project: "api" })], {
      answerBatch: async (texts) => { if (texts.length > 1) await batch; },
    });
    try {
      const response = await context.search(query({ query: QUERY, project: "web" }));
      expect(response.results.map((result) => result.id)).toEqual(["DEC-0001", "DEC-0002"]);
      // 显式留住后台批量写入，验证按需嵌入；不依赖响应恰好早于后台完成。
      expect(vectors.metadata("summary")).toEqual([]);
      expect(response.guidance).toContain("还有 1 条历史沉淀的语义向量正在后台建立");
    } finally {
      release(); await semantic.close();
    }
  });

  it("goes without the summaries' vectors, and says so, when the table could not be widened at this start", async () => {
    const { semantic, context, queries } = await setup([keyword("DEC-0001"), near("DEC-0002")], { unwidened: true });

    // Nothing to keep them in: the model is not asked, and no note is read for them.
    await semantic.synchronizeSummaries();
    expect(queries).toEqual([]);
    const response = await context.search(query({ query: QUERY }));

    expect(response.results.map((result) => result.id)).toEqual(["DEC-0001"]);
    expect(response.guidance).toContain("历史沉淀的语义向量这次无法建立");
    // Said to be on the way, they never came: each search asked again for a sync that could not keep one.
    expect(response.guidance).not.toContain("正在后台建立");
    await semantic.close();
  });

  it("supplements decisions and principles by their own vectors, while those match their notes", async () => {
    const decision = summary("DEC-0101", {
      source: "decisions", kind: "recorded_decision", title: "会话放在哪里？", summary: "交给外部存储", status: "completed", body: "## 决策点\n会话放在哪里？",
    });
    const principle = summary("PRI-0001", {
      source: "principles", kind: "adopted_principle", title: "状态外置", summary: "会话交给外部存储，进程可随时更替。", appliesWhen: "多实例部署时", caution: "外部存储要有高可用", project: null,
    });
    const { semantic, context, vectors } = await setup([keyword("DEC-0001"), decision, principle], { similar: { 交给外部存储: 0.8 } });
    // Made as the app makes them: from the decision index and the principles' own notes.
    const indexed: IndexedDecision = {
      id: decision.id, contentHash: decision.contentHash!, created: decision.created, question: "会话放在哪里？", selectedAnswer: "交给外部存储",
      status: "completed", sourceClient: "codex", project: "web", workflow: null, decisionType: "architecture", captureMode: null,
      captureSemanticKey: null, sourceEventId: null, batchId: null, questionIndex: null, rationaleStatus: "captured", filePath: "/vault/d.md",
      rationale: null, context: null, outcome: null, outcomeVerdict: null, outcomeLesson: null, outcomeReviewedAt: null, reviewDueDate: null,
      appliedPrincipleIds: [],
    };
    await semantic.synchronize({ stamps: () => [indexed], load: () => [indexed] }, [{
      id: principle.id, status: "accepted", title: principle.title, principle: principle.summary, appliesWhen: principle.appliesWhen!, caution: principle.caution!,
    } as MethodologyRecord]);

    expect((await context.search(query({ query: QUERY }))).results.map((result) => result.id)).toEqual(["DEC-0001", "DEC-0101", "PRI-0001"]);

    // A decision edited since its vector was made: left out until it is made again, not scored by what it said.
    vectors.keepSources("decision", [[decision.id, "v2:an-older-note"]]);
    expect((await context.search(query({ query: QUERY }))).results.map((result) => result.id)).toEqual(["DEC-0001", "PRI-0001"]);
    await semantic.close();
  });
});

it("tells callers which decision and principle vectors are not ready for the current model and content", async () => {
  const context = new DecisionContextService({ scan: async () => ({ documents: [], sources: [] }) }, undefined, undefined, {
    similarTo: () => async () => ({ near: [], pending: 0, pendingDecisions: 2, pendingPrinciples: 1 }),
  });
  const response = await context.search(query({ query: QUERY }));
  expect(response.guidance).toContain("有 2 条决策尚无可用于当前模型和内容版本的语义向量");
  expect(response.guidance).toContain("有 1 条已采纳原则尚无可用于当前模型和内容版本的语义向量");
  expect(response.guidance).toContain("这次未参与语义补充");
  expect(response.guidance).not.toContain("刚记录或刚更新");
});
