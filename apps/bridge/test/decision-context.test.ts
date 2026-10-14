import { DecisionFeedbackService } from "../../desktop/src/main/decision-feedback-service.js";
import { createDecisionFeedbackStore } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import { RationaleQueue } from "@cognelis/decision-core";
import { decisionContextQuerySchema, decisionRelationUpdateSchema } from "@cognelis/decision-protocol";
import { DecisionContextRepository, DecisionScopeRepository, DecisionRelationRepository, DecisionStore, MarkdownRepository, ObsidianVaultRepository } from "@cognelis/decision-storage";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionContextService } from "../../desktop/src/main/decision-context-service.js";
import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { registerDecisionContextTool, searchDecisionContext } from "../src/mcp-context.js";
import { DecisionHandoffService } from "../../desktop/src/main/decision-handoff-service.js";
import { DecisionOutcomeService } from "../../desktop/src/main/decision-outcome-service.js";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { RuntimeClient } from "../src/runtime-client.js";

const roots: string[] = [];
const servers: LocalCaptureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-context-mcp-")); roots.push(root);
  const vault = join(root, "vault");
  await mkdir(join(vault, "Decision Journal/summarize"), { recursive: true });
  const path = join(vault, "Decision Journal/summarize/DEC-0001-业务标识.md");
  await writeFile(path, "---\nid: DEC-0001\ncreated: 2026-09-01\nstatus: accepted\nselected_option: 使用业务标识\nproject: web\nsession_id: source-session\n---\n# 决策\n可排序列表使用业务标识。\n");
  const scopes = new DecisionScopeRepository(vault);
  const relations = new DecisionRelationRepository(vault);
  const service = new DecisionContextService(new DecisionContextRepository(vault, scopes, relations), scopes, relations);
  const outcomeService = new DecisionOutcomeService(new DecisionStore(new MarkdownRepository(vault), {
    upsert: () => undefined, removePath: () => undefined, rebuild: () => undefined, close: () => undefined,
  }), vault);
  const opened: string[] = [];
  const handoffService = new DecisionHandoffService(new DecisionContextRepository(vault, scopes, relations), new ObsidianVaultRepository(vault), async (uri) => { opened.push(uri); });
  const feedbackService = new DecisionFeedbackService(new DecisionContextRepository(vault, scopes, relations), createDecisionFeedbackStore(vault));
  const queue = new RationaleQueue(() => "unused");
  const token = "t".repeat(64);
  const server = new LocalCaptureServer({ queue, token, searchContext: (query) => service.search(query), updateContextScope: (input) => service.updateScope(input), updateContextRelation: (input) => service.updateRelation(input), updateDecisionOutcome: (input) => outcomeService.update(input), prepareDecisionHandoff: (input) => handoffService.prepare(input), openDecisionSource: (input) => handoffService.openSource(input), saveDecisionContextFeedback: (input) => feedbackService.save(input), getDecisionContextFeedback: (input) => feedbackService.list(input) }); servers.push(server);
  const address = await server.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port: address.port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  return { root, vault, path, token, queue, opened, runtimeFile, url: `http://127.0.0.1:${address.port}`, runtime: new RuntimeClient({ runtimeFile }) };
};

describe("decision context client integration", () => {
  it("resolves the explicitly supplied task directory and sends no local path or remote credentials to the App", async () => {
    const fixture = await setup();
    let sent: unknown;
    const result = await searchDecisionContext({ query: "标识", repositoryPath: fixture.root, layer: "frontend", files: ["src/list.tsx"] }, {
      searchContext: async (query) => { sent = query; return fixture.runtime.searchContext(query); },
    }, async () => ({ id: `repo:${"a".repeat(64)}`, project: "web", relativeDirectory: "src", identitySource: "remote" }));
    expect(sent).toMatchObject({ taskScope: { repository: { project: "web", relativeDirectory: "src" }, layer: "frontend", files: ["src/list.tsx"] } });
    expect(JSON.stringify(sent)).not.toContain(fixture.root);
    expect(result).toMatchObject({ structuredContent: { availability: "available" } });
    // What a model sees in Claude Code, which shows only structuredContent when a result has one.
    expect(JSON.stringify(result.structuredContent)).toContain("includeOutOfScope");
    expect(JSON.stringify(result.structuredContent)).toContain("不构成当前任务授权");
    const failed = await searchDecisionContext({ query: "标识", repositoryPath: fixture.root }, { searchContext: async () => { throw new Error("must not run"); } }, async () => null);
    expect(failed).toMatchObject({ isError: true, structuredContent: { availability: "scope_unresolved" } });
    expect(JSON.stringify(failed.structuredContent)).toContain("repositoryPath");
  });

  it("saves explicit scope through authenticated transport and requires a current source revision", async () => {
    const fixture = await setup();
    const original = await readFile(fixture.path, "utf8");
    const context = await fixture.runtime.searchContext(decisionContextQuerySchema.parse({ recordId: "DEC-0001" }));
    const record = context!.results[0]!;
    const { decisionScopeUpdateSchema } = await import("@cognelis/decision-protocol");
    const input = decisionScopeUpdateSchema.parse({ source: record.source, recordId: record.id, expectedContentHash: record.sourceRef.contentHash, expectedRevision: record.scopeRevision,
      scope: { layers: ["frontend"] }, changeReason: "用户明确限定前端场景" });
    expect(await fixture.runtime.updateContextScope(input)).toMatchObject({ status: "saved", revision: 1 });
    expect(await fixture.runtime.updateContextScope(input)).toMatchObject({ status: "unchanged", revision: 1 });
    expect(await fixture.runtime.updateContextScope({ ...input, changeReason: "用户改口限定后端" })).toMatchObject({ status: "revision_conflict" });
    expect((await fetch(`${fixture.url}/v1/decision-context/scope`, { method: "POST", body: JSON.stringify(input) })).status).toBe(401);
    expect((await fetch(`${fixture.url}/v1/decision-context/scope`, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: JSON.stringify({ ...input, expectedContentHash: "" }) })).status).toBe(400);
    const scoped = await fixture.runtime.searchContext(decisionContextQuerySchema.parse({ query: "标识", taskScope: { layer: "backend" } }));
    expect(scoped).toMatchObject({ results: [], excludedByScope: 1 });
    expect(await readFile(fixture.path, "utf8")).toBe(original);
  });

  it("serves real vault evidence through MCP, HTTP and the runtime client without writing a decision", async () => {
    const fixture = await setup();
    const original = await readFile(fixture.path, "utf8");
    const server = createDecisionMcpServer({ sourceClient: "codex", runtime: fixture.runtime });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const pending = new Map<string | number, (message: unknown) => void>();
    clientTransport.onmessage = (message) => { if ("id" in message && message.id != null) pending.get(message.id)?.(message); };
    await Promise.all([clientTransport.start(), server.connect(serverTransport)]);
    const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP response timed out")), 5_000);
      pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
      void clientTransport.send({ jsonrpc: "2.0", id, method, params });
    });
    try {
      await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "context-test", version: "1" } });
      await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const result = await request(2, "tools/call", { name: "search_decision_context", arguments: { query: "业务标识", project: "web" } });
      expect(result).toMatchObject({ result: { structuredContent: { availability: "available", context: {
        status: "matched", coverage: "complete", results: [expect.objectContaining({ id: "DEC-0001", kind: "historical_decision", sourceRef: expect.objectContaining({ sessionId: "source-session" }) })],
      } } } });
      expect(JSON.stringify(result)).not.toContain(fixture.vault);
      expect(fixture.queue.snapshot().current).toBeNull();
      expect(await readFile(fixture.path, "utf8")).toBe(original);
      expect(await readdir(join(fixture.vault, "Decision Journal"))).toEqual(["summarize"]);
      const record = (await fixture.runtime.searchContext(decisionContextQuerySchema.parse({ recordId: "DEC-0001" })))!.results[0]!;
      const saved = await request(3, "tools/call", { name: "record_decision_scope", arguments: {
        source: record.source, recordId: record.id, expectedContentHash: record.sourceRef.contentHash,
        expectedRevision: record.scopeRevision, scope: { layers: ["frontend"] }, changeReason: "用户明确限定前端列表",
      } });
      expect(saved).toMatchObject({ result: { structuredContent: { scopeUpdate: { status: "saved", revision: 1, originalNoteUnchanged: true } } } });
      expect(await readFile(fixture.path, "utf8")).toBe(original);
      const secondPath = join(fixture.vault, "Decision Journal/summarize/DEC-0002.md");
      await writeFile(secondPath, original.replaceAll("DEC-0001", "DEC-0002"));
      const second = (await fixture.runtime.searchContext(decisionContextQuerySchema.parse({ recordId: "DEC-0002" })))!.results[0]!;
      const relation = await request(4, "tools/call", { name: "record_decision_relation", arguments: {
        first: { source: record.source, recordId: record.id, contentHash: record.sourceRef.contentHash },
        second: { source: second.source, recordId: second.id, contentHash: second.sourceRef.contentHash },
        disposition: "conflict", successor: null, reason: "用户确认两条历史判断冲突", expectedRevision: 0,
      } });
      expect(relation).toMatchObject({ result: { structuredContent: { relationUpdate: { status: "saved", revision: 1, originalNotesUnchanged: true } } } });
      const conflicts = await request(5, "tools/call", { name: "search_decision_context", arguments: { relation: "conflict" } });
      expect(conflicts).toMatchObject({ result: { structuredContent: { context: { total: 2 } } } });
      expect(await readFile(fixture.path, "utf8")).toBe(original);
      const appNote = await new MarkdownRepository(fixture.vault).write(recordFixture({ id: "APP-1" }));
      const outcome = await request(6, "tools/call", { name: "record_decision_outcome", arguments: {
        source: "decisions", recordId: appNote.id, expectedContentHash: appNote.contentHash,
        outcome: "实际使用两周后，检索时间减少", review: { verdict: "as_expected", lesson: "继续记录例外" },
      } });
      expect(outcome).toMatchObject({ result: { structuredContent: { outcomeUpdate: { status: "saved", indexed: true, state: { outcome: "实际使用两周后，检索时间减少", review: { verdict: "as_expected", lesson: "继续记录例外" } } } } } });
      const reread = await request(7, "tools/call", { name: "search_decision_context", arguments: { source: "decisions", recordId: appNote.id } });
      expect(reread).toMatchObject({ result: { structuredContent: { context: { results: [expect.objectContaining({ outcomeState: { expectedOutcome: null, outcome: "实际使用两周后，检索时间减少", review: expect.objectContaining({ verdict: "as_expected" }), reviewDueDate: null } })] } } } });
      expect(JSON.stringify(reread)).toContain("实际结果");
      const rejected = await request(8, "tools/call", { name: "record_decision_outcome", arguments: { source: "decisions", recordId: appNote.id, expectedContentHash: appNote.contentHash, outcome: "过期写入" } });
      expect(rejected).toMatchObject({ result: { isError: true, structuredContent: { outcomeUpdate: { status: "source_changed" } } } });
      const current = (await fixture.runtime.searchContext(decisionContextQuerySchema.parse({ source: "decisions", recordId: appNote.id })))!.results[0]!;
      const reference = { source: current.source, recordId: current.id, expectedContentHash: current.sourceRef.contentHash };
      const handoff = await request(9, "tools/call", { name: "prepare_decision_handoff", arguments: {
        objective: "继续验证检索效果", references: [reference], verification: ["调用方说明"], nextSteps: ["追踪例外"],
      } });
      expect(handoff).toMatchObject({ result: { structuredContent: { handoff: { status: "needs_review", evidence: [expect.objectContaining({ status: "verified" })], task: { verification: ["调用方说明"] }, boundary: { noNoteWritten: true, taskClaimsVerified: false } } } } });
      expect(fixture.opened).toEqual([]);
      const opened = await request(10, "tools/call", { name: "open_decision_source", arguments: reference });
      expect(opened).toMatchObject({ result: { structuredContent: { sourceOpen: { status: "opened", noNoteWritten: true } } } });
      expect(new URL(fixture.opened[0]!).searchParams.get("path")).toBe(appNote.path);
      const observation = { feedbackId: randomUUID(), expectedRevision: 0, reference, task: "检索结果用于下一轮迭代", rating: "insufficient_context", reason: "尚缺明确的模块适用范围" };
      const feedback = await request(11, "tools/call", { name: "record_decision_context_feedback", arguments: observation });
      expect(feedback).toMatchObject({ result: { structuredContent: { feedbackUpdate: { status: "saved", revision: 1, noDecisionChanged: true } } } });
      const repeated = await request(12, "tools/call", { name: "record_decision_context_feedback", arguments: observation });
      expect(repeated).toMatchObject({ result: { structuredContent: { feedbackUpdate: { status: "unchanged", revision: 1 } } } });
      const summary = await request(13, "tools/call", { name: "get_decision_context_feedback", arguments: { source: current.source, recordId: current.id } });
      expect(summary).toMatchObject({ result: { structuredContent: { feedback: { activeCount: 1, ratings: { insufficient_context: 1 }, results: [{ record: { task: observation.task } }] } } } });
      expect(await readFile(fixture.path, "utf8")).toBe(original);
    } finally { await Promise.all([clientTransport.close(), server.close()]); }
  });

  it("requires authentication and rejects invalid or oversized query contracts", async () => {
    const fixture = await setup();
    const url = `${fixture.url}/v1/decision-context`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    for (const input of [{ limit: 21 }, { offset: -1 }, { vaultPath: "/private" }, { recordId: "" }, { query: "x".repeat(2_001) }]) {
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: JSON.stringify(input) })).status).toBe(400);
    }
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: "x".repeat(257 * 1024) })).status).toBe(413);
    for (const route of ["handoff", "open-source", "feedback"]) {
      const target = `${fixture.url}/v1/decision-context/${route}`;
      expect((await fetch(target, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(target, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: "{}" })).status).toBe(400);
    }
    expect((await fetch(`${fixture.url}/v1/decision-context/feedback/query`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${fixture.url}/v1/decision-context/feedback/query`, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: JSON.stringify({ source: "decisions" }) })).status).toBe(400);
    const outcomeUrl = `${fixture.url}/v1/decision-context/outcome`;
    expect((await fetch(outcomeUrl, { method: "POST", body: "{}" })).status).toBe(401);
    for (const input of [{ source: "summarize", recordId: "DEC-0001", expectedContentHash: "a".repeat(64), outcome: "wrong source" }, { source: "decisions", recordId: "A", expectedContentHash: "a".repeat(64) }]) {
      expect((await fetch(outcomeUrl, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: JSON.stringify(input) })).status).toBe(400);
    }
    const relationUrl = `${fixture.url}/v1/decision-context/relation`;
    expect((await fetch(relationUrl, { method: "POST", body: "{}" })).status).toBe(401);
    const ref = { source: "summarize", recordId: "A", contentHash: "a".repeat(64) };
    const invalid = { first: ref, second: ref, disposition: "supersedes", successor: null, expectedRevision: 0, reason: "invalid" };
    expect(decisionRelationUpdateSchema.safeParse(invalid).success).toBe(false);
    expect((await fetch(relationUrl, { method: "POST", headers: { authorization: `Bearer ${fixture.token}` }, body: JSON.stringify(invalid) })).status).toBe(400);
  });

  it("flags as an error a scope or relation that was not saved, and a search that could not run", async () => {
    const tools = new Map<string, (input: unknown) => Promise<{ isError?: boolean }>>();
    const server = { registerTool: (name: string, _definition: unknown, handler: (input: unknown) => Promise<{ isError?: boolean }>) => tools.set(name, handler) };
    const hash = "a".repeat(64);
    registerDecisionContextTool(server as never, {
      updateContextScope: async () => ({ status: "source_changed" }) as never,
      updateContextRelation: async () => ({ status: "revision_conflict" }) as never,
    });

    const scope = await tools.get("record_decision_scope")!({ source: "summarize", recordId: "DEC-0001", expectedContentHash: hash, expectedRevision: 0, scope: {}, changeReason: "用户明确限定" });
    const relation = await tools.get("record_decision_relation")!({
      first: { source: "summarize", recordId: "A", contentHash: hash }, second: { source: "summarize", recordId: "B", contentHash: hash },
      disposition: "conflict", successor: null, expectedRevision: 0, reason: "用户确认冲突",
    });
    // Read as saved otherwise: Codex counts a call a success unless it says isError, as record_decision_outcome's does.
    expect([scope.isError, relation.isError]).toEqual([true, true]);
    expect((await searchDecisionContext({}, {})).isError).toBe(true);
  });

  it("takes the very write sent again as acknowledged, and a date on a reviewed decision as refused, in its own words", async () => {
    const tools = new Map<string, (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
    const hash = "a".repeat(64);
    registerDecisionContextTool({ registerTool: (name: string, _definition: unknown, handler: never) => tools.set(name, handler) } as never, {
      updateContextScope: async () => ({ status: "unchanged", revision: 1, originalNoteUnchanged: true }),
      updateContextRelation: async () => ({ status: "unchanged", revision: 2, originalNotesUnchanged: true }),
      updateDecisionOutcome: async () => ({ status: "review_completed", contentHash: null, relativePath: null, state: null, indexed: null, warnings: [] }),
    });
    const scope = await tools.get("record_decision_scope")!({ source: "summarize", recordId: "DEC-0001", expectedContentHash: hash, expectedRevision: 0, scope: {}, changeReason: "用户明确限定" });
    const relation = await tools.get("record_decision_relation")!({ first: { source: "summarize", recordId: "A", contentHash: hash }, second: { source: "summarize", recordId: "B", contentHash: hash }, disposition: "revoked", successor: null, expectedRevision: 2, reason: "用户撤回" });
    // Told of "a newer version" (its own) and flagged as an error, the agent was sent to reread and reconcile.
    expect([scope.isError, relation.isError]).toEqual([undefined, undefined]);
    expect(scope.content[0]!.text).toContain("适用范围未变化");
    expect(relation.content[0]!.text).toContain("人工关系未变化");
    const outcome = await tools.get("record_decision_outcome")!({ source: "decisions", recordId: "DEC-1", expectedContentHash: hash, reviewDueDate: "2026-10-01" });
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]!.text).toContain("已有复盘评价");
  });

  it("words what the App answered as its own pages do, leaving the raw values in structuredContent", async () => {
    type Result = { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    const tools = new Map<string, (input: unknown) => Promise<Result>>();
    const hash = "a".repeat(64);
    const feedbackId = randomUUID();
    const reference = { source: "decisions" as const, recordId: "DEC-1", contentHash: hash };
    registerDecisionContextTool({ registerTool: (name: string, _definition: unknown, handler: never) => tools.set(name, handler) } as never, {
      updateContextScope: async () => ({ status: "revision_conflict", revision: 3, originalNoteUnchanged: true }),
      updateContextRelation: async () => ({ status: "relation_not_found", revision: 0, originalNotesUnchanged: true }),
      openDecisionSource: async () => ({ status: "open_failed", relativePath: null, noNoteWritten: true }),
      saveDecisionContextFeedback: async () => ({ status: "feedback_not_found", feedbackId, revision: 0, noDecisionChanged: true }),
      getDecisionContextFeedback: async () => ({
        coverage: "partial", total: 1, nextOffset: null, activeCount: 1, withdrawnCount: 0, guidance: "只是观察。", noDecisionChanged: true,
        ratings: { helpful: 1, not_applicable: 0, insufficient_context: 0, irrelevant: 0 }, currentSourceRatings: { helpful: 0, not_applicable: 0, insufficient_context: 0, irrelevant: 0 },
        results: [{ sourceState: "changed", relativePath: "Decision Journal/feedback/1.md", record: {
          feedbackVersion: 1, feedbackId, revision: 1, updatedAt: "2026-08-02T10:00:00.000Z", history: [], withdrawn: false,
          reference: { source: "decisions", recordId: "DEC-1", expectedContentHash: hash }, task: "排序", rating: "helpful", reason: "用上了",
        } }],
      }),
      searchContext: async () => ({
        contextVersion: 1, status: "matched", coverage: "partial", total: 1, nextOffset: null, guidance: "仅供核对。",
        boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true },
        sources: [{ source: "decisions", status: "ready", records: 1, skipped: 0 }, { source: "summarize", status: "unavailable", records: 0, skipped: 2 }],
        results: [{
          source: "decisions", kind: "recorded_decision", id: "DEC-1", title: "用 SQLite", project: "web", status: "captured", current: true,
          summary: "选 SQLite", appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [], successors: [], unresolvedSuccessorIds: [],
          sourceRef: { relativePath: "Decisions/DEC-1.md", client: null, sessionId: null, excerpt: "选 SQLite", excerptStartLine: 1, truncated: false },
          matchReason: "编号", warnings: [],
          outcomeState: { expectedOutcome: "更快", outcome: "确实更快", review: { verdict: "as_expected", lesson: null, reviewedAt: "2026-08-02T10:00:00.000Z" }, reviewDueDate: null },
          relations: [{ relationId: "r-1", disposition: "conflict", state: "stale", revision: 2, updatedAt: "2026-08-03T10:00:00.000Z", reason: "用户确认冲突", successor: null,
            other: { source: "decisions", recordId: "DEC-2", title: null }, relativePath: "Decision Journal/decision-relations/r-1.md", historyCount: 0, first: reference, second: { ...reference, recordId: "DEC-2" }, history: [] }],
        }],
      }),
    } as never);

    const scope = await tools.get("record_decision_scope")!({ source: "summarize", recordId: "DEC-0001", expectedContentHash: hash, expectedRevision: 0, scope: {}, changeReason: "用户明确限定" });
    const relation = await tools.get("record_decision_relation")!({ first: reference, second: { ...reference, recordId: "DEC-2" }, disposition: "revoked", successor: null, expectedRevision: 0, reason: "用户撤回" });
    const opened = await tools.get("open_decision_source")!({ source: "decisions", recordId: "DEC-1", expectedContentHash: hash });
    const feedback = await tools.get("record_decision_context_feedback")!({ feedbackId, expectedRevision: 1, reference: { source: "decisions", recordId: "DEC-1", expectedContentHash: hash }, task: "排序", rating: "helpful", reason: "撤回", withdrawn: true });
    const feedbackList = await tools.get("get_decision_context_feedback")!({});
    const search = await tools.get("search_decision_context")!({ recordId: "DEC-1" });

    // The enum was the whole reason given, and relation_not_found (nothing to revoke) was answered with the general advice.
    expect(scope.content[0]!.text).toBe("未保存适用范围：适用范围已有更新的版本。请重新读取原记录与范围版本，按用户的意思核对后再保存，不要直接重试或扩大范围。");
    expect(relation.content[0]!.text).toBe("未记录人工关系：这两条决策之间没有记录过人工关系，没有可撤销的。");
    expect(opened.content[0]!.text).toBe("未打开来源：没能请求 Obsidian 打开原文，请检查 Obsidian 是否可用。");
    expect(feedback.content[0]!.text).toContain("没有找到要撤回的这条反馈");
    expect(feedbackList.content[0]!.text).toContain("覆盖：不完整，数量只是已读到的观察；");
    expect(feedbackList.content[0]!.text).toContain("全部反馈评价：确实有帮助 1，相关但不适用 0，信息不足 0，与任务无关 0；其中当前原文版本：确实有帮助 0，");
    expect(feedbackList.content[0]!.text).toContain("评价：确实有帮助；来源状态：对应旧版原文");
    expect(search.content[0]!.text).toContain("来源覆盖：decisions 1 条（已全部读取，跳过 0）；summarize 0 条（无法读取，跳过 2）。");
    expect(search.content[0]!.text).toMatch(/复盘：符合预期（2026年8月\d+日 \d{2}:\d{2}）/u);
    expect(search.content[0]!.text).toContain("人工关系：存在冲突（原文已变化，待核对），版本 2；");
    for (const result of [scope, relation, opened, feedback, feedbackList, search]) {
      expect(result.content[0]!.text).not.toMatch(/revision_conflict|relation_not_found|open_failed|feedback_not_found|partial|helpful|changed|ready|unavailable|as_expected|conflict|stale|2026-08-02T/u);
    }
    expect([scope.structuredContent.scopeUpdate, relation.structuredContent.relationUpdate, opened.structuredContent.sourceOpen]).toMatchObject([
      { status: "revision_conflict" }, { status: "relation_not_found" }, { status: "open_failed" },
    ]);
    expect(search.structuredContent).toMatchObject({ context: { results: [{ outcomeState: { review: { verdict: "as_expected", reviewedAt: "2026-08-02T10:00:00.000Z" } } }] } });
  });

  it("says over MCP what to change in a refused search, relation or outcome, not in the SDK's English", async () => {
    const sent: string[] = [];
    const server = createDecisionMcpServer({ sourceClient: "codex", runtime: {
      consult: async () => null,
      searchContext: async () => { sent.push("search"); return null; },
      updateContextRelation: async () => { sent.push("relation"); return null; },
      updateDecisionOutcome: async () => { sent.push("outcome"); return null; },
    } });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const waiting = new Map<number, (message: Record<string, unknown>) => void>();
    client.onmessage = (message) => { if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>); };
    await Promise.all([server.connect(transport), client.start()]);
    const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve) => { waiting.set(id, resolve); void client.send({ jsonrpc: "2.0", id, method, params }); });
    await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    const call = async (id: number, name: string, args: Record<string, unknown>) => (await request(id, "tools/call", { name, arguments: args })).result as Result;
    const hash = "a".repeat(64);
    const reference = { source: "summarize", recordId: "A", contentHash: hash };

    try {
      const relative = await call(2, "search_decision_context", { query: "缓存", repositoryPath: "relative/dir" });
      const outside = await call(3, "search_decision_context", { files: ["../outside"], limit: 50 });
      const relation = await call(4, "record_decision_relation", { first: reference, second: { ...reference, recordId: "B" }, disposition: "supersedes", successor: null, expectedRevision: 0, reason: "用户确认 B 替代 A" });
      const placeholder = await call(5, "record_decision_outcome", { source: "decisions", recordId: "DEC-1", expectedContentHash: hash, outcome: "（尚未记录）" });
      const nothing = await call(6, "record_decision_outcome", { source: "decisions", recordId: "DEC-1", expectedContentHash: hash });

      // Checked by the SDK against the advertised schema first, each reached the agent as zod's own English.
      expect(relative.content[0]!.text).toBe("没有检索：输入不符合要求（repositoryPath 需要是本机仓库目录的绝对路径）。按要求改正后再试。");
      expect(outside.content[0]!.text).toContain("limit超出长度或数量上限");
      expect(outside.content[0]!.text).toContain("module 和 files 需要是仓库内的相对路径");
      expect(relation.content[0]!.text).toMatch(/^未记录人工关系：输入不符合要求（.*supersedes 要用 successor 写明较新的一条/u);
      expect(placeholder.content[0]!.text).toMatch(/^未保存回填：输入不符合要求（.*不能是占位的「（尚未记录）」/u);
      expect(nothing.content[0]!.text).toContain("outcome、review、reviewDueDate 至少要提供一项");
      for (const result of [relative, outside, relation, placeholder, nothing]) {
        expect(result.isError).toBe(true);
        expect(result.structuredContent.message).toBe(result.content[0]!.text);
        expect(result.content[0]!.text).not.toMatch(/Expected|Provide|Relations require|Invalid|validation/u);
      }
      expect(sent).toEqual([]);
    } finally { await server.close(); }
  });

  it("counts the records it lists as out of scope, not only those it left out", async () => {
    const fixture = await setup();
    const record = (await fixture.runtime.searchContext(decisionContextQuerySchema.parse({ recordId: "DEC-0001" })))!.results[0]!;
    const { decisionScopeUpdateSchema } = await import("@cognelis/decision-protocol");
    await fixture.runtime.updateContextScope(decisionScopeUpdateSchema.parse({ source: record.source, recordId: record.id, expectedContentHash: record.sourceRef.contentHash,
      expectedRevision: record.scopeRevision, scope: { layers: ["backend"] }, changeReason: "用户明确只适用于后端" }));

    const result = await searchDecisionContext({ query: "业务标识", layer: "frontend", includeOutOfScope: true }, fixture.runtime);

    // Said to be none while it listed one marked 明确不适用.
    expect(result.structuredContent.message).toContain("本页列出的 1 条标为“明确不适用”");
    expect(result.structuredContent.message).toContain("因范围不匹配而未列出的相关记录：0 条");
  });

  it("tells the agent the App's own reason an outcome could not be written", async () => {
    const fixture = await setup();
    const note = await new MarkdownRepository(fixture.vault).write(recordFixture({ id: "APP-LONG", outcome: "短结果" }));
    // A log pasted into the outcome in Obsidian, past what the App may rewrite.
    await writeFile(note.path, (await readFile(note.path, "utf8")).replace("短结果", "日志".repeat(4_500)));
    const tools = new Map<string, (input: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent: unknown }>>();
    registerDecisionContextTool({ registerTool: (name: string, _definition: unknown, handler: never) => tools.set(name, handler) } as never, fixture.runtime);

    const result = await tools.get("record_decision_outcome")!({ source: "decisions", recordId: "APP-LONG", expectedContentHash: note.contentHash, outcome: "新的实际结果" });

    // Told only "missing, copied or broken", the agent looked for the wrong thing.
    expect(result).toMatchObject({ isError: true, structuredContent: { outcomeUpdate: { status: "source_unavailable", warnings: [expect.stringContaining("8000")] } } });
    expect(result.content[0]!.text).toContain("精简到 8000 字以内");
    expect(result.content[0]!.text).not.toContain("缺失、重复或损坏");
  });

  it("reports old or disconnected apps as unavailable and keeps invalid runtime files untouched", async () => {
    const fixture = await setup();
    const query = decisionContextQuerySchema.parse({ recordId: "DEC-0001" });
    const old = new RuntimeClient({ runtimeFile: fixture.runtimeFile, fetcher: async () => new Response("{}", { status: 404 }) });
    expect(await searchDecisionContext(query, old)).toMatchObject({ structuredContent: { availability: "unavailable", context: null } });
    const malformed = new RuntimeClient({ runtimeFile: fixture.runtimeFile, fetcher: async () => Response.json({ status: "matched" }) });
    expect(await malformed.searchContext(query)).toBeNull();
    const ref = { source: "decisions" as const, recordId: "A", expectedContentHash: "a".repeat(64) };
    expect(await old.openDecisionSource(ref)).toBeNull();
    expect(await malformed.prepareDecisionHandoff({ objective: "继续", references: [ref], openQuestions: [], nextSteps: [], verification: [] })).toBeNull();
    await writeFile(fixture.runtimeFile, "invalid runtime");
    expect(await fixture.runtime.searchContext(query)).toBeNull();
    expect(await readFile(fixture.runtimeFile, "utf8")).toBe("invalid runtime");
    expect(await searchDecisionContext({}, {})).toMatchObject({ structuredContent: { availability: "unavailable" } });
  });
});
