import { createJournalEntry } from "@cognelis/decision-core";
import { describe, expect, it } from "vitest";
import { DecisionContextService } from "../../desktop/src/main/decision-context-service.js";
import { ContextSearch } from "../../desktop/src/main/decision-context-signals.js";
import { searchDecisionContext } from "../src/mcp-context.js";

const entries = [
  createJournalEntry({ kind: "preference", title: "错误处理先抛出", content: "遇到不可恢复的错误直接抛出。", appliesWhen: "写 TypeScript 时", exceptions: "原型代码除外", strength: "hard_constraint" },
    { sourceKind: "app_manual", sourceForm: "user_original" }, "P-1", new Date("2026-10-03T00:00:00Z")),
  createJournalEntry({ kind: "idea", title: "待办做成时间线", content: "按完成时间排成一条线。" },
    { sourceKind: "app_manual", sourceForm: "user_original" }, "I-1", new Date("2026-10-04T00:00:00Z")),
];
const search = (semantics?: ConstructorParameters<typeof ContextSearch>[2]) => {
  const context = new ContextSearch(
    new DecisionContextService({ scan: async () => ({ documents: [], sources: [] }) }),
    { scan: async () => ({ entries, diagnostics: [] }) },
    semantics,
  );
  return { searchContext: (query: Parameters<ContextSearch["search"]>[0]) => context.search(query) };
};

it("labels a preference and an idea as the user's signals, not principles, and says what they may not be used for", async () => {
  const result = await searchDecisionContext({ source: ["preferences", "ideas"] }, search());
  const text = result.content[0]!.text;
  expect(text).toContain("P-1 · 错误处理先抛出（用户偏好，是信号不是原则；现行，仍需核对适用性）");
  expect(text).toContain("I-1 · 待办做成时间线（用户想法，是信号不是原则或决定；现行，仍需核对适用性）");
  expect(text).toContain("性质：偏好：当前立场，允许例外；未经方法论流程确认前不是已采纳原则；强度：hard_constraint");
  expect(text).toContain("适用条件：写 TypeScript 时");
  expect(text).toContain("注意事项：原型代码除外");
  expect(text).toContain("不得据此推断新的偏好、替用户做决定");
  expect(text).toMatch(/来源覆盖：preferences 1 条.*ideas 1 条/u);
});

it("prints the similarity of a record found by meaning and says when semantic search could not run", async () => {
  const near = await searchDecisionContext({ source: "preferences", query: "异常", mode: "semantic" },
    search({ similarEntries: async (_q, items) => ({ near: [{ id: items[0]!.id, similarity: 0.83 }], pending: 0 }) }));
  expect(near.content[0]!.text).toContain("语义相近，非关键词命中，相似度 83%");
  const down = await searchDecisionContext({ source: "preferences", query: "异常", mode: "semantic" },
    search({ similarEntries: async () => ({ unavailable: "model_missing" }) }));
  expect(down).toMatchObject({ isError: true, structuredContent: { availability: "semantic_unavailable" } });
  expect(down.content[0]!.text).toContain("没有退化成关键词结果");
});

it("refuses a semantic search without a query, with an id, or a similarity without semantic mode, saying what to change", async () => {
  for (const input of [{ mode: "semantic" as const }, { mode: "semantic" as const, query: "x", recordId: "P-1" }, { minSimilarity: 0.5 }]) {
    const result = await searchDecisionContext(input, search());
    expect(result).toMatchObject({ isError: true, structuredContent: { availability: "invalid_input" } });
    expect(result.content[0]!.text).toContain("输入不符合要求");
  }
});

it("sends no new field by default, so an App from before reads the same request", async () => {
  const seen: unknown[] = [];
  await searchDecisionContext({ query: "缓存" }, { searchContext: async (query) => { seen.push(query); return null; } });
  expect(seen[0]).not.toHaveProperty("mode");
  expect(seen[0]).not.toHaveProperty("source");
});

import { recordDecisionJournalEntry } from "../src/mcp-server.js";
import { updateDecisionJournalEntry } from "../src/mcp-context.js";

describe("update_decision_journal_entry", () => {
  const saved = { amendVersion: 1, status: "saved", revision: 2, relativePath: "Decision Journal/decision-amendments/x.md", originalUnchanged: true } as const;
  it("sends the client with the request and says what was kept where", async () => {
    let sent: unknown;
    const result = await updateDecisionJournalEntry({ action: "append", source: "preferences", recordId: "P-1", text: "循环变量可缩写", basis: "user_said" },
      { updateDecisionAmendment: async (request) => { sent = request; return saved; } }, "codex");
    expect(sent).toMatchObject({ sourceClient: "codex", action: "append", source: "preferences", recordId: "P-1", basis: "user_said" });
    expect(result.content[0]!.text).toContain("已保存增补，增补版本 2；原笔记未改写");
    expect(result).not.toHaveProperty("isError");
  });

  it("refuses an append without the user's basis, a revise without a hash, and a principle, saying what to change", async () => {
    const runtime = { updateDecisionAmendment: async () => saved };
    for (const input of [
      { action: "append" as const, source: "decisions" as const, recordId: "D", text: "x" },
      { action: "revise" as const, source: "decisions" as const, recordId: "D", fields: { summary: "x" }, reason: "r" },
      { action: "revise" as const, source: "decisions" as const, recordId: "D", expectedContentHash: "a".repeat(64), expectedRevision: 0, fields: {}, reason: "r" },
      { action: "append" as const, source: "principles" as never, recordId: "D", text: "x", basis: "user_said" as const },
    ]) {
      const result = await updateDecisionJournalEntry(input, runtime, "codex");
      expect(result).toMatchObject({ isError: true });
      expect(result.content[0]!.text).toContain("输入不符合要求");
    }
  });

  it("says why each refusal happened and treats them as errors", async () => {
    const refuse = (status: "source_changed" | "revision_conflict" | "not_allowed") =>
      updateDecisionJournalEntry({ action: "withdraw", source: "preferences", recordId: "P", expectedRevision: 0, reason: "r" },
        { updateDecisionAmendment: async () => ({ ...saved, status, revision: 0 }) }, "codex");
    expect((await refuse("source_changed")).content[0]!.text).toContain("原记录已改变");
    expect((await refuse("revision_conflict")).content[0]!.text).toContain("amendment.revision 对不上");
    expect(await refuse("not_allowed")).toMatchObject({ isError: true });
    const down = await updateDecisionJournalEntry({ action: "withdraw", source: "preferences", recordId: "P", expectedRevision: 0, reason: "r" }, {}, "codex");
    expect(down).toMatchObject({ isError: true });
  });
});

describe("record_decision_journal_entry duplicates", () => {
  it("tells the agent about near records, saying the entry was written and not merged", async () => {
    const result = await recordDecisionJournalEntry(
      { kind: "preference", title: "命名", content: "不缩写", project: "p" } as never,
      { sourceClient: "codex", runtime: { record: async () => ({ recordVersion: 1, status: "created", recordKind: "preference", recordId: "P-9", knowledgeStatus: "inbox", sensitivity: "private", storedTranscript: false,
        possibleDuplicates: [{ source: "preferences", id: "P-1", title: "命名用完整单词", similarity: 0.91 }] }) } as never },
    );
    expect(result.content[0]!.text).toContain("可能重复：preferences/P-1 《命名用完整单词》 相似度 91%");
    expect(result.content[0]!.text).toContain("没有自动合并");
    expect(result.content[0]!.text).toContain("update_decision_journal_entry");
  });
});

describe("update_decision_journal_entry on a decision's own words", () => {
  it("passes question, choice, rationale, context and expectedOutcome with the user's basis, and says when the basis is missing", async () => {
    let sent: unknown;
    const saved = { amendVersion: 1 as const, status: "saved" as const, revision: 1, relativePath: "x.md", originalUnchanged: true as const };
    const ok = await updateDecisionJournalEntry({ action: "revise", source: "decisions", recordId: "D-1", expectedContentHash: "a".repeat(64), expectedRevision: 0,
      fields: { question: "新问题", choice: "新选择", rationale: "新理由", context: null, expectedOutcome: "新预期" }, reason: "用户改了", basis: "user_said" },
    { updateDecisionAmendment: async (request) => { sent = request; return saved; } }, "claude-code");
    expect(ok).not.toHaveProperty("isError");
    expect(sent).toMatchObject({ sourceClient: "claude-code", source: "decisions", basis: "user_said", fields: { question: "新问题", choice: "新选择", rationale: "新理由", context: null, expectedOutcome: "新预期" } });
    const refused = await updateDecisionJournalEntry({ action: "revise", source: "decisions", recordId: "D-1", expectedContentHash: "a".repeat(64), expectedRevision: 0, fields: { rationale: "x" }, reason: "r" },
      { updateDecisionAmendment: async () => ({ ...saved, status: "basis_required" as const, revision: 0 }) }, "claude-code");
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0]!.text).toContain("需要用户在会话里明确说过");
  });

  it("advertises the decision's fields, and asks the agent to show old and new text first", async () => {
    let tool: { description: string; inputSchema: unknown } | undefined;
    const { registerDecisionContextTool } = await import("../src/mcp-context.js");
    registerDecisionContextTool({ registerTool: (name: string, definition: { description: string; inputSchema: unknown }) => { if (name === "update_decision_journal_entry") tool = definition; } } as never, {}, "codex");
    expect(tool!.description).toContain("question, choice, rationale, context, expectedOutcome");
    expect(tool!.description).toContain("always for a decision's own words");
    expect(tool!.description).toContain("amendment.originals");
  });
});

it("labels an adopted experience as one case, an agent's report as unverified, and lists none still pending (IMP-191)", async () => {
  const stored = (status: "active" | "pending", id: string) => ({
    path: `/vault/${id}.md`, relativePath: `Decision Journal/experiences/2026/11/${id}.md`, noteHash: "c".repeat(64),
    record: {
      id, revision: 1, status, project: "消息服务", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
      reporter: "agent" as const, verification: "agent_reported_unverified" as const, outcome: "effective" as const, adoptedFrom: "sug@r1", generator: null,
      body: { title: `重试场景验证 ${id}`, scene: "弱网自动重试", action: "带幂等键", observation: "Agent 报告：50 次无重复", inference: "自动重试路径有效", exceptions: "手动重发未验证" },
      sources: [{ key: "todo_item:L#12", label: "清单「消息」#12", excerpt: "50 次无重复", hash: null, at: null }],
    },
  });
  const context = new ContextSearch(
    new DecisionContextService({ scan: async () => ({ documents: [], sources: [] }) }),
    undefined, undefined, undefined,
    { scan: async () => ({ experiences: [stored("active", "E-1"), stored("pending", "E-2")], diagnostics: [] }) },
  );
  const result = await searchDecisionContext({ source: "experiences" }, { searchContext: (query) => context.search(query) });
  const text = result.content[0]!.text;
  expect(text).toContain("E-1 · 重试场景验证 E-1（执行经验，一次案例，不是原则或因果核验；现行，仍需核对适用性）");
  expect(text).toContain("核验：Agent 报告，未独立核验");
  expect(text).toContain("例外与未覆盖：手动重发未验证");
  expect(text).not.toContain("E-2");
});
