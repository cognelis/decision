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

// A decision filed under the repository it was made in, with a confirmed scope naming the project it also
// applies to: the scope check says it applies, and the warnings on the same result say it belongs elsewhere.
describe("confirmed scope naming the queried project", () => {
  it("does not warn that the record belongs to another project", async () => {
    const search = service([document("DEC-1", {
      project: "legacy-web",
      scope: decisionScopeSchema.parse({ projects: ["web"], layers: ["frontend"] }), scopeState: "current", scopeRevision: 1,
    })]);
    const result = (await search.search(decisionContextQuerySchema.parse({ query: "列表标识", project: "web", taskScope: { layer: "frontend" } }))).results[0]!;
    expect(result.applicability?.status).toBe("scope_match");
    expect(result.warnings).not.toContain("记录属于其它项目，请核对适用范围。");
  });
});
