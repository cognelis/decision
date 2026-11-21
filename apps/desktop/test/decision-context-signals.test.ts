import { createJournalEntry, RationaleQueue, type JournalEntry, type JournalEntryDraft } from "@cognelis/decision-core";
import {
  CONTEXT_SHAPE,
  CONTEXT_SHAPE_HEADER,
  contextAsReleased,
  contextSourcesOf,
  decisionContextQuerySchema,
  decisionContextResponseSchema,
  queryNeedsContextShape,
} from "@cognelis/decision-protocol";
import type { DecisionContextDocument, DecisionContextSnapshot, StoredAmendment } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DecisionContextService } from "../src/main/decision-context-service.js";
import { ContextSearch, type SignalSemantics } from "../src/main/decision-context-signals.js";
import { LocalCaptureServer } from "../src/main/local-server.js";

const q = (value: Parameters<typeof decisionContextQuerySchema.parse>[0]) => decisionContextQuerySchema.parse(value);
const source = { sourceKind: "app_manual", sourceForm: "user_original" } as const;
const entry = (id: string, draft: JournalEntryDraft, project: string | null = null, at = "2026-10-01T00:00:00.000Z"): JournalEntry =>
  createJournalEntry(draft, { ...source, project }, id, new Date(at));
const pref = (id: string, title: string, content: string, project: string | null = null, at?: string) =>
  entry(id, { kind: "preference", title, content, appliesWhen: "写 TypeScript 时", exceptions: "原型代码除外" }, project, at);
const idea = (id: string, title: string, content: string, at?: string) => entry(id, { kind: "idea", title, content, whyInteresting: "省去一层转换" }, null, at);

const entries = [
  pref("P-1", "错误处理先抛出", "函数内部遇到不可恢复的错误直接抛出，不返回错误码。", "paraself", "2026-10-03T00:00:00.000Z"),
  pref("P-2", "命名用完整单词", "变量名不缩写，宁可长一点。", null, "2026-10-02T00:00:00.000Z"),
  pref("P-3", "注释写原因", "注释只解释为什么，不复述代码做了什么。", "other", "2026-10-01T00:00:00.000Z"),
  idea("I-1", "把待办做成时间线", "待办按完成时间排成一条线看进度。", "2026-10-04T00:00:00.000Z"),
];
const signals = (list = entries, diagnostics: Array<{ path: string }> = []) => ({
  scan: async () => ({ entries: list, diagnostics, relativePaths: new Map(list.map((item) => [item.id, `Decision Journal/${item.kind}s/${item.id}.md`])) }),
});
const decisionDoc = (id: string, title: string): DecisionContextDocument => ({
  id, source: "decisions", kind: "recorded_decision", title, project: "paraself", status: "accepted", created: "2026-09-01",
  summary: `${title}的决定`, appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [],
  relativePath: `Decision Journal/decisions/${id}.md`, client: null, sessionId: null, body: `## 决策\n${title}`, bodyStartLine: 1, contentHash: createHash("sha256").update(id).digest("hex"),
});
const decisionService = (documents: DecisionContextDocument[]) => new DecisionContextService({
  scan: async (): Promise<DecisionContextSnapshot> => ({
    documents,
    sources: (["summarize", "decisions", "principles"] as const).map((name) => {
      const records = documents.filter((document) => document.source === name).length;
      return { source: name, records, skipped: 0, status: records > 0 ? "ready" as const : "empty" as const };
    }),
  }),
});
/** Similarity by a phrase the entry's text holds. */
const meaning = (similar: Record<string, number>, pending = 0): SignalSemantics => ({
  similarEntries: async (_query, items, options) => ({
    near: items.flatMap((item) => {
      const found = Object.entries(similar).find(([phrase]) => item.text.includes(phrase))?.[1];
      return found !== undefined && found >= (options?.floor ?? 0.45) ? [{ id: item.id, similarity: found }] : [];
    }).sort((a, b) => b.similarity - a.similarity).slice(0, options?.nearest ?? 20),
    pending,
  }),
});
const ids = (response: { results: Array<{ id: string }> }) => response.results.map((record) => record.id);

describe("protocol", () => {
  it("takes one source or a list, and knows what only the new shape sends", () => {
    expect(contextSourcesOf(q({ source: "ideas" }).source)).toEqual(["ideas"]);
    expect(contextSourcesOf(q({ source: ["decisions", "preferences", "decisions"] }).source)).toEqual(["decisions", "preferences"]);
    expect(contextSourcesOf(q({}).source)).toBeUndefined();
    expect(queryNeedsContextShape(q({ source: "decisions" }))).toBe(false);
    expect(queryNeedsContextShape(q({ source: "preferences" }))).toBe(true);
    expect(queryNeedsContextShape(q({ source: ["decisions"] }))).toBe(true);
    expect(queryNeedsContextShape(q({ mode: "keyword" }))).toBe(true);
    expect(() => q({ source: "everything" })).toThrow();
    expect(() => q({ minSimilarity: 2 })).toThrow();
  });

  it("answers an old client without the keys its strict schema refuses", () => {
    const response = decisionContextResponseSchema.parse({
      contextVersion: 1, status: "matched", coverage: "complete", sources: [{ source: "preferences", status: "ready", records: 1, skipped: 0 }],
      results: [], total: 0, nextOffset: null, guidance: "x", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true },
    });
    const withSimilarity = { ...response, results: [{ ...decisionContextResponseSchema.shape.results.element.parse({
      source: "decisions", kind: "recorded_decision", id: "D", title: "t", project: null, status: "a", current: true, summary: "s", appliesWhen: null, caution: null,
      tags: [], supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
      sourceRef: { relativePath: "p", client: null, sessionId: null, excerpt: "e", excerptStartLine: 1, truncated: false }, matchReason: "语义相近", similarity: 0.7, warnings: [],
    }) }] };
    expect(contextAsReleased(withSimilarity).results[0]).not.toHaveProperty("similarity");
  });
});

describe("preferences and ideas in the context search", () => {
  const search = (semantics?: SignalSemantics, list = entries, diagnostics: Array<{ path: string }> = []) =>
    new ContextSearch(decisionService([decisionDoc("D-1", "缓存放 Redis"), decisionDoc("D-2", "日志用 JSON")]), signals(list, diagnostics), semantics);

  it("browses every preference and idea page by page, newest first, marked as signals", async () => {
    const context = search();
    const first = await context.search(q({ source: ["preferences", "ideas"], limit: 3 }));
    expect(ids(first)).toEqual(["I-1", "P-1", "P-2"]);
    expect(first).toMatchObject({ total: 4, nextOffset: 3, status: "matched" });
    const second = await context.search(q({ source: ["preferences", "ideas"], limit: 3, offset: 3 }));
    expect(ids(second)).toEqual(["P-3"]);
    expect(second.nextOffset).toBeNull();
    expect(first.results[1]).toMatchObject({ source: "preferences", kind: "preference", appliesWhen: "写 TypeScript 时", caution: "原型代码除外",
      sourceRef: { relativePath: "Decision Journal/preferences/P-1.md" }, signal: { standing: expect.stringContaining("不是已采纳原则") } });
    expect(first.guidance).toContain("不是已采纳原则或指令");
    expect((await context.search(q({ source: "ideas" }))).results[0]).toMatchObject({ kind: "idea", signal: { ideaForm: "possibility" } });
  });

  it("filters by project, keyword and id", async () => {
    const context = search();
    const project = await context.search(q({ source: "preferences", project: "paraself" }));
    // Another project's is left out and counted; one with no project stays, said.
    expect(ids(project)).toEqual(["P-1", "P-2"]);
    expect(project.excludedByScope).toBe(1);
    expect(project.results[1]!.warnings.join()).toContain("没有明确项目归属");
    expect(ids(await context.search(q({ source: "preferences", project: "paraself", includeOutOfScope: true })))).toEqual(["P-1", "P-2", "P-3"]);
    expect(ids(await context.search(q({ source: ["preferences", "ideas"], query: "错误处理", mode: "keyword" })))).toEqual(["P-1"]);
    expect(ids(await context.search(q({ source: ["preferences", "ideas"], query: "时间线" })))).toEqual(["I-1"]);
    expect(ids(await context.search(q({ source: ["preferences", "ideas"], recordId: "P-3" })))).toEqual(["P-3"]);
    expect(await context.search(q({ source: "preferences", query: "完全无关的火星话题" }))).toMatchObject({ status: "no_match", total: 0 });
  });

  it("says what does not apply to them instead of answering wrongly", async () => {
    const context = search();
    const scoped = await context.search(q({ source: "preferences", taskScope: { files: ["src/a.ts"] } }));
    expect(scoped.guidance).toContain("taskScope 对它们没有作用");
    expect(ids(scoped)).toHaveLength(3);
    const related = await context.search(q({ source: "preferences", relation: "conflict" }));
    expect(ids(related)).toEqual([]);
    expect(related.guidance).toContain("relation 筛选只适用于决策");
  });

  it("lists decisions first, then preferences and ideas together, in one list that pages", async () => {
    const context = search();
    const all = await context.search(q({ source: ["decisions", "preferences", "ideas"], limit: 20 }));
    expect(all.total).toBe(6);
    expect(all.results.map((record) => record.source)).toEqual(["decisions", "decisions", "ideas", "preferences", "preferences", "preferences"]);
    const page = await context.search(q({ source: ["decisions", "preferences", "ideas"], limit: 3, offset: 1 }));
    expect(ids(page)).toEqual(["D-2", "I-1", "P-1"]);
    expect(page.nextOffset).toBe(4);
    const tail = await context.search(q({ source: ["decisions", "preferences", "ideas"], limit: 3, offset: 4 }));
    expect(ids(tail)).toHaveLength(2);
    expect(tail.nextOffset).toBeNull();
  });

  it("does not include them unless named", async () => {
    const response = await search().search(q({}));
    expect(response.results.every((record) => record.source === "decisions")).toBe(true);
    expect(response.sources.map((item) => item.source)).not.toContain("preferences");
  });

  it("says when the notes could not be read, and does not call that none", async () => {
    const failing = new ContextSearch(decisionService([]), { scan: async () => { throw new Error("vault gone"); } });
    expect(await failing.search(q({ source: "preferences" }))).toMatchObject({ status: "unavailable", total: 0, sources: [{ source: "preferences", status: "unavailable" }] });
    const partial = await search(undefined, entries, [{ path: "/v/Decision Journal/preferences/坏.md" }]).search(q({ source: "preferences" }));
    expect(partial).toMatchObject({ coverage: "partial", sources: [{ source: "preferences", status: "partial", skipped: 1 }] });
  });

  describe("semantic mode", () => {
    const similar = { 完整单词: 0.9, 抛出: 0.7, 不复述代码: 0.5, 时间线: 0.3 };
    it("ranks by similarity, with it on each result, pages, and honours minSimilarity", async () => {
      const context = search(meaning(similar));
      const all = await context.search(q({ source: ["preferences", "ideas"], query: "命名习惯", mode: "semantic", limit: 2 }));
      expect(ids(all)).toEqual(["P-2", "P-1"]);
      expect(all.results.map((record) => record.similarity)).toEqual([0.9, 0.7]);
      expect(all).toMatchObject({ total: 3, nextOffset: 2 });
      expect(ids(await context.search(q({ source: ["preferences", "ideas"], query: "命名习惯", mode: "semantic", limit: 2, offset: 2 })))).toEqual(["P-3"]);
      expect(ids(await context.search(q({ source: ["preferences", "ideas"], query: "命名习惯", mode: "semantic", minSimilarity: 0.8 })))).toEqual(["P-2"]);
      expect(ids(await context.search(q({ source: ["preferences", "ideas"], query: "命名习惯", mode: "semantic", minSimilarity: 0.2 })))).toEqual(["P-2", "P-1", "P-3", "I-1"]);
      expect(all.results[0]!.matchReason).toContain("语义相近");
    });

    it("is unavailable, not another kind of result, when the model is", async () => {
      const down: SignalSemantics = { similarEntries: async () => ({ unavailable: "model_missing" }) };
      const response = await search(down).search(q({ source: "preferences", query: "命名习惯", mode: "semantic" }));
      expect(response).toMatchObject({ status: "unavailable", total: 0, results: [] });
      expect(response.guidance).toContain("没有退化成关键词结果");
      expect(await search(undefined).search(q({ source: "preferences", query: "命名习惯", mode: "semantic" }))).toMatchObject({ status: "unavailable", results: [] });
    });

    it("says how many are not embedded yet", async () => {
      const response = await search(meaning(similar, 2)).search(q({ source: "preferences", query: "命名习惯", mode: "semantic" }));
      expect(response.guidance).toContain("还有 2 条偏好或想法的向量正在后台建立");
    });
  });

  it("hybrid puts keyword matches first and at most 3 near in meaning after, keyword mode none", async () => {
    const similar = { 完整单词: 0.9, 抛出: 0.7, 不复述代码: 0.6, 时间线: 0.5 };
    const hybrid = await search(meaning(similar)).search(q({ source: ["preferences", "ideas"], query: "错误处理", limit: 20 }));
    expect(ids(hybrid)).toEqual(["P-1", "P-2", "P-3", "I-1"]);
    expect(hybrid.results.map((record) => record.similarity)).toEqual([undefined, 0.9, 0.6, 0.5]);
    expect(ids(await search(meaning(similar)).search(q({ source: ["preferences", "ideas"], query: "错误处理", mode: "keyword" })))).toEqual(["P-1"]);
    expect(ids(await search(meaning({ 完整单词: 0.9 })).search(q({ source: ["preferences", "ideas"], query: "错误处理" })))).toEqual(["P-1", "P-2"]);
  });
});

describe("semantic mode over the decisions", () => {
  const documents = [decisionDoc("D-1", "登录态放 Redis"), decisionDoc("D-2", "会话交给外部存储"), decisionDoc("D-3", "日志用 JSON")];
  const withSimilarity = (similar: Record<string, number>) => new DecisionContextService({ scan: async () => ({ documents, sources: [{ source: "decisions", records: 3, skipped: 0, status: "ready" }] }) }, undefined, undefined, {
    similarTo: (_query, _within, options) => async (found) => ({
      near: found.flatMap((document) => {
        const value = similar[document.id];
        return value !== undefined && value >= (options?.floor ?? 0.45) ? [{ document, similarity: value }] : [];
      }).sort((a, b) => b.similarity - a.similarity).slice(0, options?.nearest ?? 20),
      pending: 0,
    }),
  });

  it("ranks only by meaning, nearest first, paging and honouring minSimilarity", async () => {
    const service = withSimilarity({ "D-1": 0.6, "D-2": 0.9, "D-3": 0.5 });
    const first = await service.search(q({ query: "重启后登录会掉", mode: "semantic", limit: 2 }));
    // D-1 shares its words with the query too: in semantic mode no keyword puts it first.
    expect(ids(first)).toEqual(["D-2", "D-1"]);
    expect(first.results.map((record) => record.similarity)).toEqual([0.9, 0.6]);
    expect(first).toMatchObject({ total: 3, nextOffset: 2 });
    expect(ids(await service.search(q({ query: "重启后登录会掉", mode: "semantic", limit: 2, offset: 2 })))).toEqual(["D-3"]);
    expect(ids(await service.search(q({ query: "重启后登录会掉", mode: "semantic", minSimilarity: 0.7 })))).toEqual(["D-2"]);
  });

  it("is unavailable when the model is, and does not fall back to keywords", async () => {
    const down = new DecisionContextService({ scan: async () => ({ documents, sources: [{ source: "decisions", records: 3, skipped: 0, status: "ready" }] }) }, undefined, undefined,
      { similarTo: () => async () => ({ unavailable: "model_missing" }) });
    const answer = await down.search(q({ query: "登录态", mode: "semantic" }));
    expect(answer).toMatchObject({ status: "unavailable", results: [], total: 0 });
    expect(answer.guidance).toContain("未安装本机嵌入模型");
    expect((await new DecisionContextService({ scan: async () => ({ documents, sources: [] }) }).search(q({ query: "登录态", mode: "semantic" }))).status).toBe("unavailable");
  });

  it("keyword mode adds none by meaning", async () => {
    const service = withSimilarity({ "D-2": 0.9 });
    expect(ids(await service.search(q({ query: "登录态", mode: "keyword" })))).toEqual(["D-1"]);
    expect(ids(await service.search(q({ query: "登录态" })))).toEqual(["D-1", "D-2"]);
  });
});

describe("old clients on the local server", () => {
  const token = "context-token-".padEnd(64, "x");
  it("answers the request an old bridge sends in its own shape, and refuses one it could not have sent", async () => {
    const context = new ContextSearch(decisionService([decisionDoc("D-1", "登录态放 Redis")]), signals(), meaning({ 完整单词: 0.9 }));
    const server = new LocalCaptureServer({ queue: new RationaleQueue(), token, searchContext: (query) => context.search(query) });
    const { host, port } = await server.start();
    const post = (body: unknown, shaped: boolean) => fetch(`http://${host}:${port}/v1/decision-context`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(shaped ? { [CONTEXT_SHAPE_HEADER]: CONTEXT_SHAPE } : {}) },
      body: JSON.stringify(body),
    });
    try {
      const old = (await (await post({ query: "", source: "decisions" }, false)).json()) as { results: Array<Record<string, unknown>> };
      expect(old.results[0]).not.toHaveProperty("similarity");
      expect((await post({ source: "preferences" }, false)).status).toBe(400);
      expect((await post({ source: ["decisions"] }, false)).status).toBe(400);
      expect((await post({ mode: "keyword" }, false)).status).toBe(400);
      const fresh = (await (await post({ source: ["preferences", "ideas"], query: "命名", mode: "semantic" }, true)).json()) as { results: Array<Record<string, unknown>> };
      expect(fresh.results[0]).toMatchObject({ id: "P-2", similarity: 0.9, kind: "preference" });
      expect((await post({ source: "preferences", mode: "semantic" }, true)).status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("still answers a shape-2 bridge with its signals, and keeps experiences for shape 3 (IMP-191)", async () => {
    const context = new ContextSearch(decisionService([decisionDoc("D-1", "登录态放 Redis")]), signals(), meaning({ 完整单词: 0.9 }));
    const server = new LocalCaptureServer({ queue: new RationaleQueue(), token, searchContext: (query) => context.search(query) });
    const { host, port } = await server.start();
    const post = (body: unknown, shape: string) => fetch(`http://${host}:${port}/v1/decision-context`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, [CONTEXT_SHAPE_HEADER]: shape },
      body: JSON.stringify(body),
    });
    try {
      const two = (await (await post({ source: ["preferences", "ideas"], query: "命名", mode: "semantic" }, "2")).json()) as { results: Array<Record<string, unknown>> };
      expect(two.results[0]).toMatchObject({ id: "P-2", similarity: 0.9, kind: "preference" });
      expect(two.results[0]).toHaveProperty("signal");
      expect((await post({ source: "experiences" }, "2")).status).toBe(400);
      const three = (await (await post({ source: ["decisions", "experiences"], query: "" }, "3")).json()) as { sources: Array<{ source: string; status: string }>; results: Array<{ kind: string }> };
      // Not read yet: said unavailable, never answered as no experience.
      expect(three.sources).toContainEqual(expect.objectContaining({ source: "experiences", status: "unavailable" }));
      expect(three.results.every((result) => result.kind !== "experience")).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe("vectors still being made", () => {
  it("say partial, not complete, for the source they leave short", async () => {
    const context = new ContextSearch(decisionService([]), signals(), meaning({ 完整单词: 0.9 }, 2));
    const response = await context.search(q({ source: ["preferences", "ideas"], query: "命名习惯", mode: "semantic" }));
    expect(response.sources.every((item) => item.status === "partial")).toBe(true);
    expect(response.coverage).toBe("partial");
    expect((await new ContextSearch(decisionService([]), signals(), meaning({ 完整单词: 0.9 }, 0)).search(q({ source: "preferences", query: "命名习惯", mode: "semantic" }))).coverage).toBe("complete");
  });
});

describe("RSI-001: changes while retrieval waits", () => {
  const barrier = () => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    return { entered, release, wait: async () => { enter(); await waiting; } };
  };
  for (const action of ["delete", "rewrite", "archive", "unreadable"] as const) {
    it(`does not publish a stale preference after ${action}`, async () => {
      const gate = barrier();
      let list = [pref("P-live", "部署约定", "旧约定：每次发布都先清空缓存。")];
      let unreadable = false;
      const context = new ContextSearch(decisionService([]), { scan: async () => {
        if (unreadable) throw new Error("synthetic source unavailable");
        return { entries: structuredClone(list), diagnostics: [] };
      } }, { similarEntries: async (_query, items) => { await gate.wait(); return { near: items.map((item) => ({ id: item.id, similarity: 0.9 })), pending: 0 }; } });
      const pending = context.search(q({ source: "preferences", query: "发布约定", mode: "semantic" }));
      await gate.entered;
      if (action === "delete") list = [];
      if (action === "rewrite") list = [{ ...list[0]!, content: "新约定：保留缓存，只刷新变更项。" }];
      if (action === "archive") list = [{ ...list[0]!, knowledgeStatus: "archived" }];
      if (action === "unreadable") unreadable = true;
      gate.release();
      const answer = await pending;
      expect(answer.results.some((result) => result.id === "P-live" && result.current && result.summary.includes("清空缓存"))).toBe(false);
      if (action === "unreadable") expect(answer.coverage).toBe("unavailable");
      if (action === "rewrite") expect((await context.search(q({ source: "preferences", recordId: "P-live" }))).results[0]?.summary).toContain("保留缓存");
    });
  }
  it("rechecks signals after the other source in a mixed search has finished", async () => {
    const gate = barrier();
    let list = [idea("I-live", "缓存刷新", "已删除的旧想法")];
    const slow = { search: async () => { await gate.wait(); return decisionService([]).search(q({})); } };
    const context = new ContextSearch(slow, { scan: async () => ({ entries: structuredClone(list), diagnostics: [] }) });
    const pending = context.search(q({ source: ["decisions", "ideas"], query: "", limit: 1 }));
    await gate.entered;
    // Let the fast group finish before the other group completes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    list = []; gate.release();
    const answer = await pending;
    expect(answer.results).toEqual([]);
    expect(answer.nextOffset).toBeNull();
  });
  it("does not publish a decision deleted while semantic matching runs", async () => {
    const gate = barrier();
    let documents = [decisionDoc("D-live", "缓存刷新")];
    const service = new DecisionContextService({ scan: async () => ({ documents: structuredClone(documents), sources: [{ source: "decisions", status: "ready", records: documents.length, skipped: 0 }] }) }, undefined, undefined, {
      similarTo: () => async (items) => { await gate.wait(); return { near: items.map((document) => ({ document, similarity: 0.9 })), pending: 0 }; },
    });
    const pending = service.search(q({ source: "decisions", query: "部署约定", mode: "semantic" }));
    await gate.entered; documents = []; gate.release();
    expect((await pending).results).toEqual([]);
  });
  it("does not return a preference withdrawn while semantic matching runs, including in a mixed page", async () => {
    const gate = barrier();
    let records = new Map<string, StoredAmendment>();
    const amendments = { scan: async () => ({ records: structuredClone(records), unavailable: false }), relativePath: () => "amendments/p.md" };
    const context = new ContextSearch(decisionService([decisionDoc("D-stable", "稳定决定")]), signals([pref("P-live", "旧偏好", "旧偏好正文")]), {
      similarEntries: async (_query, items) => { await gate.wait(); return { near: items.map((item) => ({ id: item.id, similarity: 0.9 })), pending: 0 }; },
    }, amendments);
    const pending = context.search(q({ source: ["decisions", "preferences"], query: "旧偏好", limit: 1 }));
    await gate.entered;
    records = new Map([["preferences:P-live", { amendVersion: 1, source: "preferences", recordId: "P-live", revision: 1, updatedAt: "2026-11-14T00:00:00.000Z", amendments: [], overrides: null, withdrawn: { at: "2026-11-14T00:00:00.000Z", client: "manual", reason: "用户撤回" }, history: [] }]]);
    gate.release();
    const answer = await pending;
    expect(answer.results.some((result) => result.id === "P-live")).toBe(false);
    expect(answer.nextOffset === null || answer.nextOffset > 0).toBe(true);
    const fresh = await context.search(q({ source: "preferences", recordId: "P-live" }));
    expect(fresh.results).toEqual([]);
    expect((await context.search(q({ source: "preferences", recordId: "P-live", includeWithdrawn: true }))).results[0]).toMatchObject({ current: false, status: "withdrawn" });
  });
  it("validates a fast decision group after a slow signal group finishes", async () => {
    const gate = barrier();
    let documents = [decisionDoc("D-live", "命名规则")];
    const decisions = new DecisionContextService({ scan: async () => ({ documents: structuredClone(documents), sources: [{ source: "decisions", records: documents.length, skipped: 0, status: "ready" }] }) });
    const context = new ContextSearch(decisions, signals([pref("P-live", "命名", "使用完整单词")]), {
      similarEntries: async (_query, items) => { await gate.wait(); return { near: items.map((item) => ({ id: item.id, similarity: 0.9 })), pending: 0 }; },
    });
    const pending = context.search(q({ source: ["decisions", "preferences"], query: "命名", limit: 1 }));
    await gate.entered; documents = []; gate.release();
    const answer = await pending;
    expect(ids(answer)).toEqual(["P-live"]);
    expect(answer.coverage).toBe("partial");
    expect(answer.nextOffset).toBeNull();
  });
  it("keeps stable semantic pages unchanged and does not ask for embeddings again", async () => {
    let calls = 0;
    const context = new ContextSearch(decisionService([]), signals(entries), { similarEntries: async (_query, items) => {
      calls += 1;
      return { near: items.map((item, index) => ({ id: item.id, similarity: 0.9 - index / 100 })), pending: 0 };
    } });
    const first = await context.search(q({ source: ["preferences", "ideas"], query: "规定", mode: "semantic", limit: 2 }));
    const second = await context.search(q({ source: ["preferences", "ideas"], query: "规定", mode: "semantic", limit: 2, offset: first.nextOffset! }));
    expect([...ids(first), ...ids(second)]).toEqual(entries.map((entry) => entry.id));
    expect(calls).toBe(2);
    expect(second.nextOffset).toBeNull();
  });

});
