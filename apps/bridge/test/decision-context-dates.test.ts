import { expect, it } from "vitest";
import type { DecisionContextDocument } from "@cognelis/decision-storage";
import { DecisionContextService } from "../../desktop/src/main/decision-context-service.js";
import { searchDecisionContext } from "../src/mcp-context.js";

// A bridge already running shows what the App says of dates and pairs (IMP-175) as it shows every warning and the
// guidance, and cuts a long page after the App wrote them: nothing it then shows may count records it no longer lists.
const note = (n: number, occurred: string): DecisionContextDocument => ({
  source: "decisions", kind: "recorded_decision", id: `DEC-${n}`, title: `会话缓存 ${n}`, project: "app", status: "accepted",
  created: "2026-10-29T12:00:00.000Z", occurred, summary: `会话缓存方案 ${n}`, appliesWhen: null, caution: null, tags: [], supersedes: [],
  supersededBy: [], relativePath: `decisions/DEC-${n}.md`, client: null, sessionId: null, body: `会话缓存的理由 ${n}`, bodyStartLine: 1,
  contentHash: String(n).repeat(64),
  outcomeState: { expectedOutcome: "当时的预期。".repeat(1_300), outcome: "后来的结果。".repeat(1_300), review: null, reviewDueDate: null },
});

it("shows each record's date and the page's guidance in the text and the structured result, counting nothing a cut page lost", async () => {
  const documents = [note(1, "2026-03-02"), note(2, "2026-09-09")];
  const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "decisions", status: "ready", records: 2, skipped: 0 }], documents }) });
  const answered = await context.search({ query: "会话缓存", limit: 8, offset: 0, includeOutOfScope: false });
  expect(answered).toMatchObject({ nextOffset: null, results: [expect.anything(), expect.anything()] });
  const result = await searchDecisionContext({ query: "会话缓存" }, { searchContext: async () => answered });
  if (!("context" in result.structuredContent) || !result.structuredContent.context) throw new Error("没有检索结果");
  const page = result.structuredContent.context;
  // Cut short by the bridge: one record left, the next page at it.
  expect([page.results.length, page.nextOffset]).toEqual([1, 1]);
  const text = result.content[0]!.text;
  const shown = page.results[0]!;
  expect(shown.warnings[0]).toMatch(/^决策日期 2026-0[39]-0[29]。$/u);
  expect(text).toContain(shown.warnings[0]);
  for (const said of [page.guidance, text]) {
    expect(said).toContain("本页有未标记被替代、相互之间也没有登记替代、冲突或无关关系的决策记录，各条的日期写在它的警告里。");
    expect(said).not.toMatch(/本页有 ?\d|另 ?\d+ 条/u);
  }
});
