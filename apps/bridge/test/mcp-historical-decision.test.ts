import { RationaleQueue } from "@cognelis/decision-core";
import { HistoricalDecisionRepository } from "@cognelis/decision-storage";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoricalDecisionService } from "../../desktop/src/main/historical-decision-service.js";
import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { listHistoricalDecisions, recordHistoricalDecision, updateHistoricalDecision } from "../src/mcp-historical-decision.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { RuntimeClient } from "../src/runtime-client.js";

const options = { sourceClient: "codex", cwd: "/work/decision" };

const connect = async (server: ReturnType<typeof createDecisionMcpServer>) => {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message) => {
    if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>);
  };
  await Promise.all([server.connect(transport), client.start()]);
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5_000);
      waiting.set(current, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      void client.send({ jsonrpc: "2.0", id: current, method, params });
    });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "historical-test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
  return { call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result as Result };
};

const roots: string[] = [];
const closing: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("historical decision tools", () => {
  it("says what to change, in the agent's own fields, before the App is asked", async () => {
    const recordHistoricalDecisionRuntime = vi.fn();
    const refused = await recordHistoricalDecision({ title: "两行\n标题", decision: "", references: [{ url: "http://example.com/x" }] }, { recordHistoricalDecision: recordHistoricalDecisionRuntime }, options);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0]!.text).toMatch(/没有记录这条历史决定：输入不符合要求（.*只能写一行.*；decision为空或太短；.*https 链接.*）/u);
    expect(recordHistoricalDecisionRuntime).not.toHaveBeenCalled();

    const status = await updateHistoricalDecision({ id: "hdec-1", expectedRevision: 1, status: "withdrawn" }, {}, options);
    expect(status.content[0]!.text).toContain("改 status 时要带 expectedStatus");
    expect((await updateHistoricalDecision({ id: "hdec-1", expectedRevision: 1, promote: false }, {}, options)).content[0]!.text).toContain("至少要提供一项要改的内容");
  });

  it("does not take a read that never ran, or an index out of reach, for an empty ledger", async () => {
    const down = await listHistoricalDecisions({}, {});
    expect(down).toMatchObject({ isError: true, structuredContent: { records: null, total: null } });
    expect(down.content[0]!.text).toContain("不能据此认为没有记录");
    const unavailable = await listHistoricalDecisions({}, {
      listHistoricalDecisions: async () => ({ version: 1, records: [], total: 0, kept: 3, projects: [], tags: [], diagnostics: [], index: { state: "unavailable", message: "x", indexed: null, found: 3, syncedAt: null } }),
    });
    expect(unavailable).toMatchObject({ isError: true });
    expect(unavailable.content[0]!.text).toContain("重建索引");
  });

  it("records, lists, reads and changes a record in the vault through the App's own routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paraself-historical-mcp-"));
    roots.push(root);
    const vault = join(root, "vault");
    await mkdir(join(vault, "Decision Journal"), { recursive: true });
    let ids = 0;
    const promote = vi.fn(async () => "decision-7");
    const opened: string[] = [];
    const service = new HistoricalDecisionService({ repository: new HistoricalDecisionRepository(vault, { existingVault: true }), indexPath: join(root, "historical-decisions.sqlite"), idFactory: () => `${++ids}`, promote });
    const token = "t".repeat(64);
    const app = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      recordHistoricalDecision: (request) => service.record(request),
      listHistoricalDecisions: (request) => service.list(request),
      getHistoricalDecision: (request) => service.get(request),
      updateHistoricalDecision: (request) => service.update(request),
      // What the App would open on this machine, only once the record is found to name it.
      openHistoricalDecision: async ({ id, link, relatedNote }) => {
        const { record, notePath } = await service.get({ version: 1, id });
        if (link !== undefined && !record.references.some((reference) => reference.url === link)) throw new Error("这条历史决定里没有这个链接");
        opened.push(link ?? relatedNote ?? notePath);
        return { version: 1, opened: link !== undefined ? "link" : relatedNote !== undefined ? "relatedNote" : "note", target: link ?? relatedNote ?? notePath };
      },
    });
    closing.push(() => app.stop(), () => service.close());
    const { port } = await app.start();
    const runtimeFile = join(root, "runtime.json");
    await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
    const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: "/work/decision" }));

    const first = await mcp.call("record_historical_decision", { title: "首页待办入口放在哪一层？", decision: "放在首页卡片区第二屏", decidedOn: "2026-09-30" });
    expect(first.isError).toBeUndefined();
    // No project named: the one of the directory the session runs in, and an agent's record is one it captured.
    expect(first.structuredContent).toMatchObject({ status: "created", record: { id: "hdec-1", project: "decision", sourceKind: "agent_capture", sourceClient: "codex" } });
    expect(first.content[0]!.text).toContain("不进入 search_decision_context");
    expect(await readdir(join(vault, "Decision Journal"))).toEqual(["history"]);
    // Sent again, as after a lost answer: the one record, not two.
    expect((await mcp.call("record_historical_decision", { title: "首页待办入口放在哪一层？", decision: "放在首页卡片区第二屏", decidedOn: "2026-09-30" })).structuredContent).toMatchObject({ status: "duplicate", record: { id: "hdec-1" } });

    const second = await mcp.call("record_historical_decision", { title: "首页待办入口放在哪一层？", decision: "放进主导航第六项", decidedOn: "2026-11-12", supersedesId: "hdec-1", tags: ["导航"], references: [{ url: "https://example.com/pr/482" }] });
    expect(second.content[0]!.text).toContain("被它替代的 hdec-1 已标为「已替代」");

    // Opened on the user's machine: its note, or a link it names; never an address it does not.
    expect((await mcp.call("open_historical_decision", { id: "hdec-3" })).content[0]!.text).toMatch(/^已请求打开它的笔记：Decision Journal\/history\/2026\/.+在 Obsidian 里打开/u);
    expect((await mcp.call("open_historical_decision", { id: "hdec-3", link: "https://example.com/pr/482" })).structuredContent).toMatchObject({ opened: "link" });
    const elsewhere = await mcp.call("open_historical_decision", { id: "hdec-3", link: "https://example.com/other" });
    expect(elsewhere).toMatchObject({ isError: true });
    expect(elsewhere.content[0]!.text).toContain("只能打开这条记录的笔记");
    expect((await mcp.call("open_historical_decision", { id: "hdec-3", link: "https://example.com/pr/482", relatedNote: "x" })).content[0]!.text).toContain("没有打开：输入不符合要求");
    expect(opened).toEqual([expect.stringMatching(/^Decision Journal\/history\//u), "https://example.com/pr/482"]);

    const listed = await mcp.call("list_historical_decisions", { tag: "导航" });
    expect(listed.structuredContent).toMatchObject({ total: 1, nextOffset: null });
    expect(listed.content[0]!.text).toContain("hdec-3 [有效] 2026-11-12 首页待办入口放在哪一层？ → 放进主导航第六项（decision；替代 hdec-1）");
    expect((await mcp.call("list_historical_decisions", { status: "superseded" })).structuredContent).toMatchObject({ total: 1, records: [{ id: "hdec-1" }] });

    const read = await mcp.call("get_historical_decision", { id: "hdec-1" });
    expect(read.content[0]!.text).toMatch(/hdec-1 \[已替代\] 修订 2[\s\S]*后任：hdec-3 \[有效\][\s\S]*笔记：Decision Journal\/history\/2026\/[\s\S]*变更历史/u);

    // Changed on a revision no longer the latest: refused in the App's own words, and told to read again.
    const stale = await mcp.call("update_historical_decision", { id: "hdec-1", expectedRevision: 1, notes: "补一句" });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain("在你打开之后又被改过");

    const restored = await mcp.call("update_historical_decision", { id: "hdec-1", expectedRevision: 2, expectedStatus: "superseded", status: "active", statusNote: null });
    expect(restored.content[0]!.text).toContain("hdec-3 对它的替代关系已解除");
    const promoted = await mcp.call("update_historical_decision", { id: "hdec-3", expectedRevision: 2, promote: true });
    expect(promoted.structuredContent).toMatchObject({ promotedDecisionId: "decision-7", record: { promotedDecisionId: "decision-7" } });
    const withdrawn = await mcp.call("update_historical_decision", { id: "hdec-1", expectedRevision: 3, expectedStatus: "active", status: "withdrawn", statusNote: "记错了" });
    expect(withdrawn.content[0]!.text).toContain("已撤回的记录是只读的");
    // Its history says who changed what, and what a rewritten field read before.
    const traced = (await mcp.call("get_historical_decision", { id: "hdec-1" })).content[0]!.text;
    expect(traced).toMatch(/codex：状态：有效 → 已撤回\n    状态说明：（空） → 记错了/u);
    expect(traced).toContain("在 Obsidian 里直接改的不在其中");
    expect((await mcp.call("list_historical_decisions", {})).structuredContent).toMatchObject({ total: 1 });
    expect((await mcp.call("list_historical_decisions", { includeWithdrawn: true })).structuredContent).toMatchObject({ total: 2 });
  });
});
