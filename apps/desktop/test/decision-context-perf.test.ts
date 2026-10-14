import { decisionContextQuerySchema, decisionScopeSchema } from "@cognelis/decision-protocol";
import type { DecisionContextDocument } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";
import { DecisionContextService } from "../src/main/decision-context-service.js";

const document = (id: string, overrides: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
  id, source: "summarize", kind: "historical_decision", title: `${id} 列表稳定标识`, project: "web", status: "accepted",
  created: "2026-09-01", summary: "可排序列表采用稳定的业务标识。", appliesWhen: null, caution: null,
  tags: [], supersedes: [], supersededBy: [], relativePath: `Decision Journal/summarize/${id}.md`,
  client: null, sessionId: null, body: "# 列表标识\n\n使用稳定业务标识。", bodyStartLine: 4, ...overrides,
});
const service = (documents: DecisionContextDocument[]) => new DecisionContextService({
  scan: async () => ({ documents, sources: [{ source: "summarize", records: documents.length, skipped: 0, status: "ready" }] }),
});

// Applicability was worked out for every record before the ranking filter, so the records a query did not match
// at all still paid files x paths each: seconds for a PR's 3,000 files over ten thousand scoped notes.
describe("applicability cost for records the query never matches", () => {
  it("does not scale with records x files x paths for a no-match query", async () => {
    const scope = decisionScopeSchema.parse({
      paths: Array.from({ length: 20 }, (_, i) => `src/area${i}`),
      excludedPaths: Array.from({ length: 20 }, (_, i) => `src/area${i}/generated`),
    });
    const moderate = decisionScopeSchema.parse({ paths: ["apps/web/src/feature1", "apps/web/src/feature2"], excludedPaths: ["apps/web/src/feature1/generated"] });
    const files = Array.from({ length: 3_000 }, (_, i) => `apps/web/src/feature${i % 50}/file${i}.ts`);
    const timed = async (label: string, docs: DecisionContextDocument[], taskScope?: { files: string[] }) => {
      const search = service(docs);
      await search.search(decisionContextQuerySchema.parse({ query: "zzzz-no-such-word" }));
      const started = performance.now();
      const response = await search.search(decisionContextQuerySchema.parse({ query: "zzzz-no-such-word", project: "web", ...(taskScope ? { taskScope } : {}) }));
      const elapsed = performance.now() - started;
      expect(response.status, label).toBe("no_match");
      return elapsed;
    };
    await timed("10k unscoped records, no taskScope", Array.from({ length: 10_000 }, (_, i) => document(`DEC-${i}`)));
    const moderateMs = await timed("10k records with 2 paths + 1 excluded, 3000 files", Array.from({ length: 10_000 }, (_, i) => document(`DEC-${i}`, { scope: moderate, scopeState: "current", scopeRevision: 1 })), { files });
    const worstMs = await timed("10k records with 20 paths + 20 excluded, 3000 files", Array.from({ length: 10_000 }, (_, i) => document(`DEC-${i}`, { scope, scopeState: "current", scopeRevision: 1 })), { files });
    // Seconds before; a margin for a loaded machine.
    expect(moderateMs).toBeLessThan(1_500);
    expect(worstMs).toBeLessThan(1_500);
  });

  // Control: Han terms are looked for as substrings of each record's whole text. Logged only.
  it("answers a Chinese question over 10k records with 4 KB bodies in time", async () => {
    const paragraph = "本段讨论服务之间的重试、幂等与超时设置，以及错误码的统一约定。".repeat(60);
    const docs = Array.from({ length: 10_000 }, (_, i) => document(`DEC-${i}`, { body: `# 标题\n\n${paragraph}` }));
    const search = service(docs);
    await search.search(decisionContextQuerySchema.parse({ query: "预热" }));
    const started = performance.now();
    const response = await search.search(decisionContextQuerySchema.parse({ query: "我们之前关于订单列表排序是怎么决定的" }));
    // Timed only: 列表 and 排序 are the question's words the notes hold, so every note on 可排序列表 is found.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe("matched");
  });
});
