import { decisionContextQuerySchema } from "@cognelis/decision-protocol";
import type { DecisionContextDocument } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";
import { DecisionContextService } from "../src/main/decision-context-service.js";

const document = (id: string, overrides: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
  id, source: "summarize", kind: "historical_decision", title: id, project: "web", status: "accepted",
  created: "2026-09-01", summary: "", appliesWhen: null, caution: null,
  tags: [], supersedes: [], supersededBy: [], relativePath: `Decision Journal/summarize/${id}.md`,
  client: null, sessionId: null, body: "", bodyStartLine: 4, ...overrides,
});
const service = (documents: DecisionContextDocument[]) => new DecisionContextService({
  scan: async () => ({ documents, sources: [{ source: "summarize", records: documents.length, skipped: 0, status: "ready" }] }),
});
const ids = async (search: DecisionContextService, query: string) =>
  (await search.search(decisionContextQuerySchema.parse({ query }))).results.map((item) => item.id);

const CACHE = document("CACHE", { title: "会话缓存", summary: "会话缓存统一用Redis，不放进程内存。", body: "# 会话缓存\n\n会话缓存统一用Redis。" });
// Two ordinary records, about other subjects, written the way a journal is written.
const LOG = document("LOG", { title: "日志格式", summary: "我们之前讨论过日志格式，最后决定统一 JSON。", body: "我们之前讨论过日志格式，最后决定统一 JSON。" });
const CODES = document("CODES", { title: "接口错误码", summary: "关于错误码是怎么定的：对外接口都带错误码。", body: "关于错误码是怎么定的：对外接口都带错误码。" });

describe("heard: share of the query terms some note holds", () => {
  const question = "我们之前关于会话缓存是怎么决定的";

  it("finds the cache decision in a journal holding only it", async () => {
    expect(await ids(service([CACHE]), question)).toContain("CACHE");
  });

  it("still finds it once the journal also holds two ordinary records on other subjects", async () => {
    // Every term of the question but the junctions 前关/于会/存是/么决 is held by some ordinary record, so `heard`
    // is 11 and the cache decision (会话, 话缓, 缓存) is 3/11 < 0.3: it is dropped while LOG and CODES are returned.
    const found = await ids(service([CACHE, LOG, CODES]), question);
    expect(found).toContain("CACHE");
  });
});
