import { RationaleQueue } from "@cognelis/decision-core";
import type { PrReviewReport, PrReviewSnapshot, ReviewBenchmarkStoredCase } from "@cognelis/decision-protocol";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { ReviewBenchmarkRuns } from "../../desktop/src/main/review-benchmark-runs.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { RuntimeClient } from "../src/runtime-client.js";

const exec = promisify(execFile);
const roots: string[] = [];
const servers: LocalCaptureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const git = async (directory: string, ...args: string[]) => (await exec("git", ["-C", directory, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();

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
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "benchmark-runs-test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  type Result = { isError?: boolean; content: Array<{ text: string }> };
  return { call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result as Result, close: () => Promise.all([client.close(), server.close()]) };
};

it("runs the benchmark when asked, lists the runs and reads one with its holdout cases kept back, through the App's own routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-benchmark-runs-tools-"));
  roots.push(root);
  const repo = join(root, "repo");
  await exec("mkdir", [repo]);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "lab@example.invalid"); await git(repo, "config", "user.name", "Lab");
  await writeFile(join(repo, "a.ts"), "const window = config.window;\n"); await git(repo, "add", "."); await git(repo, "commit", "-q", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "a.ts"), "const window = 30;\n"); await git(repo, "commit", "-q", "-am", "head");
  const head = await git(repo, "rev-parse", "HEAD");
  const item = { id: "case-0000000000aa", set: "defect", status: "confirmed", split: "holdout", title: "续期窗口写死", pr: null, headSha: head, targetSha: base, baseSha: base, scope: [], mergedAt: null,
    issues: [{ title: "窗口写死", priority: "P2", evidence: "改配置不生效。", fixShas: [head], tradeoff: false, locations: [{ path: "a.ts", side: "new", startLine: 1, endLine: 1 }] }], knownFalsePositives: null } as unknown as ReviewBenchmarkStoredCase;
  const runs = new ReviewBenchmarkRuns({ directory: join(root, "runs"), cases: async (_path, split) => ({ repository: { id: "repo", project: "org/app" }, cases: split === "holdout" ? [item] : [] }),
    models: async () => [{ profileId: "local", label: "本机", kind: "qwen", model: null, leavesDevice: false }],
    reviewer: () => ({ load: async () => ({ snapshotId: "s", risk: null }) as unknown as PrReviewSnapshot, cancel: () => undefined,
      run: async () => ({ status: "completed", findings: [{ priority: "P2", title: "窗口写死", body: "写死了。", path: "a.ts", side: "new", line: 1, decisionIndexes: [] }] }) as unknown as PrReviewReport }) });
  const token = "t".repeat(64);
  const app = new LocalCaptureServer({ queue: new RationaleQueue(), token,
    runReviewBenchmark: ({ reviewBenchmarkVersion: _, ...request }) => runs.start(request), listReviewBenchmarkRuns: (query) => runs.summaries(query.repositoryPath), getReviewBenchmarkRun: (query) => runs.result(query.id, query.compareTo) });
  servers.push(app);
  const { port } = await app.start();
  const runtimeFile = join(root, "runtime.json");
  await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
  const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: repo }));
  try {
    expect((await mcp.call("run_review_benchmark", { label: "基线", split: "dev" })).content[0]!.text).toBe("没有开始评测：这个仓库的开发集还没有确认入集的样本。");
    expect((await mcp.call("run_review_benchmark", { label: "基线", model: "云端" })).content[0]!.text).toBe("没有开始评测：没有「云端」这个模型。可用的：「本机」（id local）。");
    const started = await mcp.call("run_review_benchmark", { label: "基线" });
    const id = /运行 id ([0-9a-f-]{36})/u.exec(started.content[0]!.text)?.[1];
    expect(started.content[0]!.text).toMatch(/^已开始评测「基线」：org\/app 的留出集，1 个样本，模型 本机。\n运行 id [0-9a-f-]{36}。在 App 里后台进行/u);
    let read = "";
    for (let tries = 0; tries < 50 && !read.includes("已跑完"); tries++) { read = (await mcp.call("get_review_benchmark_run", { id })).content[0]!.text; await new Promise((resolve) => setTimeout(resolve, 20)); }
    expect(read).toContain("「基线」· org/app 的留出集 · 已跑完（1/1 个样本）");
    expect(read).toContain("  缺陷集 1 个：命中 1/1 个问题，核验误杀 0");
    expect(read).toContain("留出集的逐个样本不给看，只看总数，免得照着答案调。\n还没有可以对比的上一次评测。");
    expect((await mcp.call("list_review_benchmark_runs", {})).content[0]!.text).toMatch(/^评测 1 次，新的在前：\n[0-9a-f-]{36} · 「基线」/u);
  } finally {
    await mcp.close();
  }
});
