import { RationaleQueue } from "@cognelis/decision-core";
import type { LocalReviewState, ModelProviderProfile, PrConnection } from "@cognelis/decision-protocol";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { getLocalReviewJob, listLocalReviewJobs, recordLocalReviewJob, updateLocalReviewJob, type LocalReviewToolSources } from "../../desktop/src/main/local-review-agent-tools.js";
import { createLocalReviewPreview } from "../../desktop/src/renderer/preview-local-review.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { RuntimeClient } from "../src/runtime-client.js";

const roots: string[] = [];
const servers: LocalCaptureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const connect = async (server: ReturnType<typeof createDecisionMcpServer>) => {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message) => { if ("id" in message) waiting.get(message.id as number)?.(message as Record<string, unknown>); };
  await Promise.all([server.connect(transport), client.start()]);
  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve) => {
    const current = ++id;
    waiting.set(current, resolve);
    void client.send({ jsonrpc: "2.0", id: current, method, params });
  });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "local-review-test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  type Result = { isError?: boolean; content: Array<{ text: string }> };
  return { call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result as Result, close: () => Promise.all([client.close(), server.close()]) };
};

it("hands comments to the local review from a repository's changes or a PR, and reads, cancels and retries its tasks, through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-local-review-tools-"));
  roots.push(root);
  // The preview's local review: one repository (codex), one finished task with its PR opened.
  const preview = createLocalReviewPreview();
  let state = await preview.getLocalReviewState() as LocalReviewState;
  const repository = state.repositories[0]!;
  const connection = { id: "00000000-0000-4000-8000-0000000000c1", label: "团队 Bitbucket", platform: "bitbucket-server", baseUrl: "https://code.example" } as PrConnection;
  const profiles = [
    { version: 1, profileId: "qwen", kind: "qwen", label: "Qwen 本地模型", enabled: true, priority: 0, timeoutMs: 5_000, model: "qwen3.5" },
    { version: 1, profileId: "codex", kind: "codex-cli", label: "Codex CLI", enabled: true, priority: 1, timeoutMs: 5_000, model: "gpt-6-luna", executablePath: "/x/codex" },
  ] as ModelProviderProfile[];
  const calls: Array<[string, unknown]> = [];
  const sources: LocalReviewToolSources = {
    state: () => state,
    newSession: async (id) => { calls.push(["newSession", id]); return preview.startLocalReviewSession({ repositoryId: id }); },
    annotate: async (input) => {
      if (input.startLine > 10) throw new Error("意见行号超出固定提交的文件范围。");
      calls.push(["annotate", input]);
      return preview.saveLocalReviewAnnotation(input);
    },
    submit: async (repositoryId, sessionId, profileId, worker) => {
      calls.push(["submit", { repositoryId, profileId, worker }]);
      const id = await preview.submitLocalReview({ repositoryId, sessionId, profileId, ...(worker ? { worker } : {}) });
      state = await preview.getLocalReviewState() as LocalReviewState; return id;
    },
    submitFromPr: async (input) => { calls.push(["submitFromPr", input]); const id = await preview.submitLocalReviewFromPr(input); state = await preview.getLocalReviewState() as LocalReviewState; return id; },
    action: async (input) => { calls.push(["action", input]); await preview.actOnLocalReview(input); state = await preview.getLocalReviewState() as LocalReviewState; },
    profiles: async () => profiles,
    connections: async () => [connection],
  };
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token,
    recordLocalReviewJob: (request) => recordLocalReviewJob(request, sources), listLocalReviewJobs: async (query) => listLocalReviewJobs(query, sources),
    getLocalReviewJob: async (request) => getLocalReviewJob(request, sources), updateLocalReviewJob: (request) => updateLocalReviewJob(request, sources) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: root }));
  try {
    const both = await mcp.call("record_local_review_job", { repository: "示例工程", annotations: [{ path: "src/request.ts", line: 2, body: "加超时" }], reference: "TEAM/app#128", comments: ["21"] });
    expect(both.content[0]!.text).toBe("没有交给本地审阅：输入不符合要求（annotations（本地改动上的意见）和 reference（用户自己 PR 上的意见）二选一）。");
    const unknown = await mcp.call("record_local_review_job", { repository: "不存在", annotations: [{ path: "src/request.ts", line: 2, body: "加超时" }] });
    expect(unknown.content[0]!.text).toBe(`没有交给本地审阅：没有「不存在」这个工程。本地审阅里的工程：「示例工程」（id ${repository.id}）。`);
    const outside = await mcp.call("record_local_review_job", { repository: "示例工程", annotations: [{ path: "src/request.ts", line: 20, body: "加超时" }] });
    expect(outside.content[0]!.text).toBe("没有交给本地审阅：意见行号超出固定提交的文件范围。");

    // On the repository's changes: the profile that fits its worker (codex), the lines checked, then submitted.
    const local = await mcp.call("record_local_review_job", { repository: "示例工程", annotations: [{ path: "src/request.ts", line: 2, endLine: 3, body: "请求要能取消" }] });
    expect(local.isError).toBeUndefined();
    expect(local.content[0]!.text).toMatch(/^已交给本地审阅：任务 [0-9a-f-]{36}，1 条意见。[\s\S]*改好的每组会推到新分支并开 PR（涉及 CI、Git 行为文件等高风险改动的，等用户在 App 里确认）。$/u);
    expect(calls.filter(([name]) => name === "submit")).toEqual([["submit", { repositoryId: repository.id, profileId: "codex", worker: "codex" }]]);
    expect(calls.find(([name]) => name === "annotate")![1]).toMatchObject({ path: "src/request.ts", side: "new", startLine: 2, endLine: 3, body: "请求要能取消" });

    // On the user's own PR: the link resolved, the worker its profile runs as; the push left to the user.
    const fromPr = await mcp.call("record_local_review_job", { reference: "TEAM/app#128", comments: ["21"], model: "Qwen 本地模型" });
    const jobId = /任务 ([0-9a-f-]{36})/u.exec(fromPr.content[0]!.text)![1]!;
    expect(fromPr.content[0]!.text).toContain("TEAM/app#128 上的 1 条意见。它在后台评估、修改，用 get_local_review_job 看进度和结果。\n改好后由用户在 Paraself 评审页“我创建的”里确认，再作为新提交推到原 PR；推送不经工具。");
    expect(calls.find(([name]) => name === "submitFromPr")![1]).toEqual({ connectionId: connection.id, reference: "TEAM/app#128", commentIds: ["21"], profileId: "qwen", worker: "pi" });

    const listed = await mcp.call("list_local_review_jobs", {});
    expect(listed.content[0]!.text).toContain(`任务 ${jobId} · 示例工程 · 已结束 · 1 条意见 · 来自 TEAM/app#128，修复推到 feature/request\n  组 1「回应 PR 上的意见」：改好了，等用户在 App 里确认推送`);
    const got = await mcp.call("get_local_review_job", { id: jobId });
    expect(got.content[0]!.text).toContain("1. src/request.ts:12 示例审阅人 A 在 PR 上的意见： 超时后请求仍在运行。\n   评估：accept，预览演示：意见成立。\n   修改：fixed，超时改为取消底层请求。");
    expect(got.content[0]!.text).toContain(`组 1：提交 ${"d".repeat(12)}，改了 src/request.ts`);
    expect(got.content[0]!.text).toContain("推送后：0 条意见已回复已修，本轮变化没有写进 PR 描述。");

    // Finished, it is not cancelled; a group it does not have is not retried.
    const late = await mcp.call("update_local_review_job", { id: jobId, action: "cancel" });
    expect(late.content[0]!.text).toBe("没有取消：任务已经结束，不用取消。");
    const missing = await mcp.call("update_local_review_job", { id: jobId, action: "retry", group: 9 });
    expect(missing.content[0]!.text).toBe("没有重试：这个任务没有第 9 组。");
    const retried = await mcp.call("update_local_review_job", { id: jobId, action: "retry", group: 1 });
    expect(retried.content[0]!.text).toMatch(/^已重新排队。\n任务 /u);
    expect(calls.at(-1)).toEqual(["action", { repositoryId: repository.id, jobId, action: "retry", groupId: state.jobs.find((job) => job.id === jobId)!.groups[0]!.id }]);
  } finally {
    await mcp.close();
  }
});
