import { expect, it } from "vitest";
import type { DecisionContextDocument } from "@cognelis/decision-storage";
import { DecisionContextService } from "../../desktop/src/main/decision-context-service.js";
import { searchDecisionContext } from "../src/mcp-context.js";

const note = (n: number): DecisionContextDocument => ({
  source: "decisions", kind: "recorded_decision", id: `DEC-${n}`, title: `会话缓存 ${n}`, project: "app", status: "accepted", created: "2026-09-01", summary: `会话缓存方案 ${n}`,
  appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], relativePath: `decisions/DEC-${n}.md`, client: null, sessionId: null,
  body: `会话缓存的理由 ${n}：${"当时的上下文。".repeat(700)}`, bodyStartLine: 1, contentHash: String(n % 10).repeat(64),
});

// Claude Code gives a model a result past 25,000 tokens only as a file to go and read: 20 long notes ran to 85,000 characters.
it("moves records past a page's length to the next page, said, rather than handing back a result too long to be read", async () => {
  const documents = Array.from({ length: 20 }, (_, index) => note(index + 1));
  const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "decisions", status: "ready", records: 20, skipped: 0 }], documents }) });
  const result = await searchDecisionContext({ query: "会话缓存", limit: 20 }, { searchContext: (query) => context.search(query) });
  if (!("context" in result.structuredContent) || !result.structuredContent.context) throw new Error("没有检索结果");
  const page = result.structuredContent.context;
  expect(page.results.length).toBeGreaterThan(0);
  expect(page.results.length).toBeLessThan(20);
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(30_000);
  expect(page.nextOffset).toBe(page.results.length);
  expect(result.structuredContent.message).toContain(`本页篇幅较长，只列出 ${page.results.length} 条；其余用 offset=${page.results.length} 继续读取`);
});
