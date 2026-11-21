import type { DecisionContextDocument } from "@cognelis/decision-storage";
import { expect, it } from "vitest";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { harness } from "./pr-review-run-fakes.js";

const document = (id: string, title: string, summary: string): DecisionContextDocument => ({
  source: "summarize", kind: "summarized_decision", id, title, project: "app", status: "accepted", created: "2026-09-01", summary, appliesWhen: null,
  caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: `summarize/${id}.md`, client: "codex", sessionId: null, body: summary,
  bodyStartLine: 1, contentHash: id.replace(/\D/gu, "").padStart(64, "0"),
});

// A record the words did not find, supplemented by meaning, read to the reviewer as one more decision bearing on its
// group: what said otherwise (matchReason) was left out of what it was given.
it("tells the reviewer which decisions were found by meaning alone", async () => {
  const documents = [document("DEC-1", "请求超时", "请求超时后必须释放资源"), document("DEC-2", "调用挂起", "挂起的调用要能被取消")];
  const context = new DecisionContextService(
    { scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: 2, skipped: 0 }], documents }) },
    undefined, undefined,
    { similarTo: () => async (found) => ({ near: found.filter((item) => item.id === "DEC-2").map((item) => ({ document: item, similarity: 0.8 })), pending: 0 }) },
  );
  const test = harness(["src/request.ts"], "diff --git a/src/request.ts b/src/request.ts\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -1,2 +1,2 @@\n const timeout = 100;\n-old();\n+changed();\n",
    () => ({ action: "finish_review", summary: "已核对", findings: [] }), { searchDecisions: context.search.bind(context) });

  const report = await test.run();

  const prompt = test.requests[0]!.userPrompt;
  expect(prompt).toContain("DEC-2");
  expect(prompt).toContain("语义相近（本机向量，相似度 80%）");
  // The keyword match as it was: nothing more to read for it.
  expect(prompt.split("matchReason")).toHaveLength(2);
  const listed = report.history.flatMap((event) => event.decisions ?? []);
  expect(listed.find((item) => item.id === "DEC-2")?.summary).toMatch(/^（语义相近，非关键词命中）/u);
  expect(listed.find((item) => item.id === "DEC-1")?.summary).toBe("请求超时后必须释放资源");
});
