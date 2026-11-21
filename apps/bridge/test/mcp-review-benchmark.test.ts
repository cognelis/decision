import { RationaleQueue } from "@cognelis/decision-core";
import type { ReviewBenchmarkCaseView, ReviewBenchmarkRecordResult } from "@cognelis/decision-protocol";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalCaptureServer } from "../../desktop/src/main/local-server.js";
import { ReviewBenchmarkService } from "../../desktop/src/main/review-benchmark-service.js";
import { createDecisionMcpServer } from "../src/mcp-server.js";
import { recordReviewBenchmarkCases, updateReviewBenchmarkCase } from "../src/mcp-review-benchmark.js";
import { RuntimeClient } from "../src/runtime-client.js";

const exec = promisify(execFile);
const options = { sourceClient: "codex", cwd: "/work/repo" };
const sha = "a".repeat(40);
const defect = (overrides: Record<string, unknown> = {}) => ({
  set: "defect" as const,
  title: "Change the API",
  headSha: sha,
  targetSha: "b".repeat(40),
  provenance: [{ kind: "fix_commit" as const, reference: "c".repeat(40) }],
  issues: [{ title: "返回 null", priority: "P1" as const, evidence: "修复提交改回返回值。", fixShas: ["c".repeat(40)], locations: [{ path: "api.ts", startLine: 1, endLine: 1 }] }],
  ...overrides,
});

describe("what the tools send", () => {
  it("refuses a batch it cannot send, each reason in Chinese where it is, and asks the App nothing", async () => {
    const recordReviewBenchmarkCases_ = vi.fn();
    const runtime = { recordReviewBenchmarkCases: recordReviewBenchmarkCases_ };
    const result = await recordReviewBenchmarkCases({ cases: [
      defect({ headSha: "abc", provenance: [{ kind: "task", reference: "T-1", url: "ftp://tracker/T-1" }], issues: [{ ...defect().issues[0], fixShas: undefined }] }),
      { ...defect(), set: "clean", mergedAt: "2026-02-01", cleanEvidence: "没有回滚。" },
      { ...defect(), set: undefined },
    ] } as never, runtime, options);
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("cases 第 1 个的 headSha：要写完整的提交号");
    expect(text).toContain("cases 第 1 个的 provenance 第 1 个的 url：要是 http 或 https 链接");
    expect(text).toContain("cases 第 1 个的 issues 第 1 个的 fixShas：要写修复提交 fixShas");
    expect(text).toContain("cases 第 2 个：issues 只用于缺陷集样本（set 为 defect）");
    expect(text).toContain("cases 第 3 个的 set：要是 defect（缺陷集）或 clean（干净集）");
    expect(text).toContain("这一批都没有发出");
    expect(recordReviewBenchmarkCases_).not.toHaveBeenCalled();
  });

  it("takes what a model filled with nothing as not given, and a relative path from where the server started", async () => {
    const answer: ReviewBenchmarkRecordResult = { reviewBenchmarkVersion: 1, status: "processed", repository: { id: `repo:${"1".repeat(64)}`, project: "repo" }, cases: [{ outcome: "recorded", caseId: "case-0123456789ab", status: "candidate", split: "dev", reasons: [] }] };
    const record = vi.fn(async () => answer);
    const result = await recordReviewBenchmarkCases({ repositoryPath: "packages/app", cases: [{
      ...defect({ scope: [], provenance: [{ kind: "fix_commit", reference: "c".repeat(40), url: "" }] }),
      mergedAt: "", cleanEvidence: "", knownFalsePositives: [],
    }] }, { recordReviewBenchmarkCases: record }, options);
    expect(result.isError).toBeUndefined();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      repositoryPath: "/work/repo/packages/app",
      sourceClient: "codex",
      cases: [expect.not.objectContaining({ scope: expect.anything(), mergedAt: expect.anything() })],
    }), expect.any(Function));
    expect(result.content[0]!.text).toContain("第 1 个：已录入为候选（case-0123456789ab，开发集）");
    expect(result.content[0]!.text).toContain("用户明确说核对过以后，再用 update_review_benchmark_case 设为 confirmed");
  });

  it("says an answer that never came may still have been saved, and how to check", async () => {
    const result = await recordReviewBenchmarkCases({ cases: [defect()] }, {
      recordReviewBenchmarkCases: async (_input, report) => { report?.({ reason: "no_answer" }); return null; },
    }, options);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("无法确认这批样本是否已录入");
    expect(result.content[0]!.text).toContain("用同样的内容重试不会重复录入");
  });

  it("confirms only with the user's words, and keeps a reason to a status change", async () => {
    const update = vi.fn();
    const runtime = { updateReviewBenchmarkCase: update };
    const unconfirmed = await updateReviewBenchmarkCase({ caseId: "case-0123456789ab", expectedStatus: "candidate", status: "confirmed" }, runtime, options);
    expect(unconfirmed.content[0]!.text).toContain("设为 confirmed 需要 userConfirmation：用户说已核对过的原话");
    const stray = await updateReviewBenchmarkCase({ caseId: "case-0123456789ab", expectedStatus: "candidate", reason: "不需要了", note: "" }, runtime, options);
    expect(stray.content[0]!.text).toContain("reason 只在设为 withdrawn 或 candidate 时提供");
    const withdrawn = await updateReviewBenchmarkCase({ caseId: "case-0123456789ab", expectedStatus: "candidate", status: "withdrawn" }, runtime, options);
    expect(withdrawn.content[0]!.text).toContain("设为 withdrawn 或 candidate 需要 reason");
    expect(update).not.toHaveBeenCalled();
  });
});

/** An MCP client on the other end of an in-memory transport, as Claude Code or Codex would be. */
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
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 10_000);
      waiting.set(current, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      void client.send({ jsonrpc: "2.0", id: current, method, params });
    });
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "benchmark-test", version: "1" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent: { message: string; reviewBenchmark: unknown } };
  return {
    call: async (name: string, args: Record<string, unknown>) => (await request("tools/call", { name, arguments: args })).result as Result,
    close: () => Promise.all([client.close(), server.close()]),
  };
};

const roots: string[] = [];
const servers: LocalCaptureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("through the App's own routes", () => {
  it("records, lists, reads and confirms cases checked against a real repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "paraself-benchmark-mcp-"));
    roots.push(root);
    const repository = join(root, "repo");
    // A fixed remote and fixed dates: the same repository id and commit ids, so the same splits, each run.
    const environment = {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    };
    const git = async (...args: string[]) => (await exec("git", ["-C", repository, ...args], { env: environment })).stdout.trim();
    await exec("git", ["init", "-q", "-b", "main", repository], { env: environment });
    await git("remote", "add", "origin", "https://example.test/demo/benchmark.git");
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    for (const file of files) await writeFile(join(repository, file), "one\n");
    await writeFile(join(repository, "api.ts"), "throw error;\n");
    await git("add", ".");
    await git("commit", "-qm", "Initial");
    const target = await git("rev-parse", "HEAD");
    for (const file of files) await writeFile(join(repository, file), "one\ntwo\n");
    await writeFile(join(repository, "api.ts"), "return null;\n");
    await git("commit", "-qam", "Change the API");
    const head = await git("rev-parse", "HEAD");
    await writeFile(join(repository, "api.ts"), "return value;\n");
    await git("commit", "-qam", "Fix the API");
    const fix = await git("rev-parse", "HEAD");

    const service = new ReviewBenchmarkService(join(root, "review-benchmark"));
    const token = "t".repeat(64);
    const app = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      recordReviewBenchmarkCases: (request) => service.record(request),
      listReviewBenchmarkCases: (request) => service.list(request),
      getReviewBenchmarkCase: (request) => service.get(request),
      updateReviewBenchmarkCase: (request) => service.update(request),
    });
    servers.push(app);
    const { port } = await app.start();
    const runtimeFile = join(root, "runtime.json");
    await writeFile(runtimeFile, JSON.stringify({ protocolVersion: 1, port, token, pid: process.pid, startedAt: new Date().toISOString() }));
    const mcp = await connect(createDecisionMcpServer({ sourceClient: "codex", runtime: new RuntimeClient({ runtimeFile }), cwd: repository }));

    try {
      const issue = { title: "返回 null 让调用方崩溃", priority: "P1", evidence: "修复提交改回返回值。", fixShas: [fix], locations: [{ path: "api.ts", startLine: 1, endLine: 1 }] };
      const cases = [
        { set: "defect", title: "Change the API", headSha: head, targetSha: target, provenance: [{ kind: "fix_commit", reference: fix }], issues: [issue] },
        ...files.map((file) => ({ set: "clean", title: "Change the API", headSha: head, targetSha: target, scope: [file], provenance: [{ kind: "sampling", reference: `sample-${file}` }], mergedAt: "2026-02-01", cleanEvidence: "合并后没有回滚。" })),
      ];
      const saved = await mcp.call("record_review_benchmark_cases", { cases });
      expect(saved.isError).toBeUndefined();
      expect(saved.content[0]!.text).toContain("评测集（项目 repo）：7 个样本里录入 7 个、已有 0 个、退回 0 个。");
      const recorded = (saved.structuredContent.reviewBenchmark as ReviewBenchmarkRecordResult).cases;
      expect(new Set(recorded.map((item) => item.split))).toEqual(new Set(["dev", "holdout"]));
      const again = await mcp.call("record_review_benchmark_cases", { cases: [cases[0]] });
      expect(again.content[0]!.text).toContain(`第 1 个：已经录过（${recorded[0]!.caseId}，候选），这次没有重复写入`);

      const listed = await mcp.call("list_review_benchmark_cases", { set: "clean", limit: 2 });
      expect(listed.content[0]!.text).toContain("缺陷集 候选 1，已确认 0（开发集 0，留出集 0），已撤回 0；干净集 候选 6");
      expect(listed.content[0]!.text).toContain("符合条件的 6 个，这一页 2 个：");
      expect(listed.content[0]!.text).toContain("还有更多：offset 传 2");
      expect(listed.content[0]!.text).not.toContain("合并后没有回滚");
      expect((await mcp.call("list_review_benchmark_cases", { provenance: fix })).content[0]!.text).toContain(recorded[0]!.caseId!);

      const holdout = recorded.find((item) => item.split === "holdout")!;
      const hidden = await mcp.call("get_review_benchmark_case", { caseId: holdout.caseId });
      expect(hidden.content[0]!.text).toContain("它在留出集：标注和备注不经 MCP 返回");
      expect(JSON.stringify(hidden.structuredContent)).not.toContain("合并后没有回滚");
      const dev = recorded.find((item, index) => index > 0 && item.split === "dev")!;
      expect((await mcp.call("get_review_benchmark_case", { caseId: dev.caseId })).content[0]!.text).toContain("合并于 2026-02-01；为什么算干净：合并后没有回滚。");

      const unconfirmed = await mcp.call("update_review_benchmark_case", { caseId: dev.caseId, expectedStatus: "candidate", status: "confirmed" });
      expect(unconfirmed.isError).toBe(true);
      const confirmed = await mcp.call("update_review_benchmark_case", { caseId: dev.caseId, expectedStatus: "candidate", status: "confirmed", userConfirmation: "这几个我核对过了，入集。" });
      expect(confirmed.content[0]!.text).toContain("现在是「已确认」（原来是「候选」）");
      const relabelled = await mcp.call("update_review_benchmark_case", { caseId: dev.caseId, expectedStatus: "confirmed", cleanEvidence: "合并后 90 天没有回滚，也没有相关缺陷单。" });
      expect(relabelled.content[0]!.text).toContain("标注改了，样本从「已确认」退回「候选」");
      const read = (await mcp.call("get_review_benchmark_case", { caseId: dev.caseId })).structuredContent.reviewBenchmark as { case: ReviewBenchmarkCaseView };
      expect(read.case.history.map((event) => [event.previous, event.status])).toEqual([[null, "candidate"], ["candidate", "confirmed"], ["confirmed", "candidate"]]);
      expect(read.case.history[1]!.userConfirmation).toBe("这几个我核对过了，入集。");

      const elsewhere = await mcp.call("list_review_benchmark_cases", { repositoryPath: root });
      expect(elsewhere.isError).toBe(true);
      expect(elsewhere.content[0]!.text).toContain("不在 Git 仓库里");
    } finally {
      await mcp.close();
    }
  });
});
