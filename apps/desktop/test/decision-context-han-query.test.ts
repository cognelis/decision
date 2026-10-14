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

// A natural Chinese question is split into character bigrams, and a record must contain 30% of them to be a
// match at all. The bigrams that straddle a function word ("该使", "用什", "么缓") can never be in a note, so a
// short, ordinary question loses the one decision that is literally about its subject.
describe("Han bigram threshold", () => {
  const vault = service([
    document("CACHE", { title: "会话缓存", summary: "会话缓存统一用Redis，不放进程内存。", body: "# 会话缓存\n\n会话缓存统一用Redis。" }),
    document("SORT", { title: "订单列表排序", summary: "订单列表按创建时间排序，并用主键作稳定次序。", body: "# 订单列表排序\n\n订单列表按创建时间排序，并用主键作稳定次序。" }),
    document("OTHER", { title: "日志格式", summary: "日志统一 JSON。", body: "日志统一 JSON。" }),
  ]);

  it("finds the cache decision for 应该使用什么缓存", async () => {
    // Bigrams after the stop list: 该使, 用什, 么缓, 缓存 -> the note holds one of four (25%).
    expect(await ids(vault, "应该使用什么缓存")).toContain("CACHE");
  });

  it("finds the sorting decision for a question that names its title", async () => {
    // 17 bigrams, the title "订单列表排序" holds five of them (29%).
    expect(await ids(vault, "我们之前关于订单列表排序是怎么决定的")).toContain("SORT");
  });

  it("finds it for the shorter 之前订单列表排序是怎么定的", async () => {
    expect(await ids(vault, "之前订单列表排序是怎么定的")).toContain("SORT");
  });
});
