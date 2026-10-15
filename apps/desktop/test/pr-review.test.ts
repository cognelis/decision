import { ProfiledModelGatewayError } from "../src/main/model/profiled-model-gateway.js";
import { ModelProviderError } from "../src/main/model/http-model-transport.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { modelProviderProfileSchema, prReviewReportSchema, prReviewSnapshotSchema, prReviewUnitChars, type StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { plannedGroups } from "../src/renderer/components/pages/pr-review/PrReviewScopeDialog.js";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";
import { PrPlatformError, PrPlatformUnreachable, parsePrReference, type PrReviewClient } from "../src/main/pr-platform-client.js";
import { parseStructuredJson } from "../src/main/model/structured-provider.js";
import { PrReviewService, batchIntro, fitJson } from "../src/main/pr-review-service.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import type { AssistantGatewayLike } from "../src/main/decision-assistant-service.js";

const patch = "diff --git a/src/request.ts b/src/request.ts\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -1,2 +1,2 @@\n const timeout = 100;\n-old();\n+changed();\n";
const pr = { title: "请求超时", description: "为请求添加超时", source: { repository: "~author/app", commit: "a".repeat(40) }, destination: { repository: "AI/app", commit: "b".repeat(40) } };
const finding = { priority: "P2", title: "请求仍未取消", body: "超时时仍在执行，会占用资源。应传入取消信号。", path: "src/request.ts", side: "new", line: 2, decisionIndexes: [1] };
const profile = modelProviderProfileSchema.parse({ version: 1, profileId: "local", kind: "qwen", model: "qwen3.5-2b-q4-k-m", label: "本机", enabled: true, priority: 0, timeoutMs: 30_000 });
/** The guides a review reads at the repository's root. */
const GUIDE = /^(CLAUDE|AGENTS)\.md$/u;

function setup(actions: unknown[]) {
  const client: PrReviewClient = { get: vi.fn(), files: vi.fn(), diff: vi.fn(), readFileContent: vi.fn(), readFile: vi.fn() };
  const get = vi.spyOn(client, "get").mockResolvedValue(pr);
  vi.spyOn(client, "files").mockResolvedValue([{ path: "src/request.ts", status: "modified" }]);
  vi.spyOn(client, "diff").mockResolvedValue(patch);
  const readFile = vi.spyOn(client, "readFile").mockResolvedValue("const timeout = 100;\nchanged();");
  // The file at the source commit, which a review reads for the context around each hunk; the repository keeps no guides.
  vi.spyOn(client, "readFileContent").mockImplementation(async (_pr, path) => {
    if (GUIDE.test(path)) throw new PrPlatformError(404);
    return "const timeout = 100;\nchanged();";
  });
  const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: 1, skipped: 0 }], documents: [{
    source: "summarize", kind: "historical_decision", id: "DEC-1", title: "请求超时", project: "app", status: "accepted", created: "2026-09-01", summary: "请求超时后必须释放资源", appliesWhen: "请求取消", caution: "后台任务另议", tags: [], supersedes: [], supersededBy: [], relativePath: "summarize/DEC-1.md", client: "codex", sessionId: null, body: "请求超时后取消实际调用", bodyStartLine: 1, contentHash: "e".repeat(64),
  }] }) });
  const search = vi.fn(context.search.bind(context));
  const requests: StructuredGenerationRequest[] = [];
  const gateway: AssistantGatewayLike = {
    listGenerationProfiles: async () => [profile],
    generate: async (request, parse, signal) => {
      signal?.throwIfAborted(); requests.push(request);
      // Verification confirms every candidate, unless a test queues verdicts of its own.
      const queued = actions[0];
      const confirming = request.promptVersion.startsWith("pr-review-verify") && !(queued && typeof queued === "object" && "verdicts" in queued);
      const action = confirming ? { verdicts: (JSON.parse(request.userPrompt).candidates as Array<{ id: number }>).map(({ id }) => ({ id, score: 90, reason: "证据确凿。" })) } : actions.shift();
      if (action instanceof Error || action === undefined) throw action ?? new Error("No actions");
      return { requestId: request.requestId, attemptId: randomUUID(), profileId: "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
    },
  };
  const onProgress = vi.fn();
  const service = new PrReviewService({ gateway, searchDecisions: search, createClient: async () => client, onProgress });
  const run = async () => { const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" }); return service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" }); };
  return { client, service, get, readFile, search, requests, gateway, run, onProgress };
}

describe("fitJson", () => {
  it("cuts a file of quotes to fit without holding the process, and never half a pair", () => {
    // Each quote is two characters encoded: shortened a character at a time, this took seconds.
    const quotes = '"'.repeat(1_300_000);
    const started = performance.now();
    const fitted = fitJson(quotes, 50_000);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(50_000);
    expect(JSON.stringify(fitted).length).toBeGreaterThan(49_990);
    expect(fitJson(`${"a".repeat(9)}😀`, 12)).toBe("a".repeat(9));
  });
});

describe("PR snapshot limits", () => {
  it("opens a PR whose one file has more than 5,000 hunks, its total size kept", async () => {
    const test = setup([]);
    // A version field bumped in 5,001 records of a data file, ten lines apart: each its own hunk.
    const hunks = Array.from({ length: 5_001 }, (_, index) =>
      `@@ -${index * 10 + 4},3 +${index * 10 + 4},3 @@\n   "id": ${index},\n-  "v": 1,\n+  "v": 2,\n   "ok": true`);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "test/data.json", status: "modified" }]);
    vi.mocked(test.client.diff).mockResolvedValue(`diff --git a/test/data.json b/test/data.json\n--- a/test/data.json\n+++ b/test/data.json\n${hunks.join("\n")}\n`);

    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    // As many as there were broke the snapshot's own limit at the IPC boundary: the PR could not be opened.
    expect(view.fileHunks?.["test/data.json"]).toHaveLength(5_000);
    expect(prReviewSnapshotSchema.safeParse(view).success).toBe(true);
  });

  it("opens and reviews a PR of more than 100 files, and names in one line those it has no diff for", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    // Short names, so the 105 picked still make one of a local model's small groups.
    const paths = Array.from({ length: 150 }, (_, index) => `f${index}.ts`);
    const images = Array.from({ length: 8 }, (_, index) => `assets/i${index}.png`);
    vi.mocked(test.client.files).mockResolvedValue([...paths, ...images].map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`).join(""));

    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(prReviewSnapshotSchema.safeParse(view).success).toBe(true);
    expect(view.files).toHaveLength(158);
    // A line per file was past what a snapshot holds.
    expect(view.warnings.filter((warning) => warning.includes("没有可解析的文本 diff"))).toEqual([expect.stringMatching(/^assets\/i0\.png、assets\/i1\.png、assets\/i2\.png、assets\/i3\.png、assets\/i4\.png 等 8 个文件：/u)]);
    const report = await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", paths: paths.slice(0, 105) });
    expect(report.status).toBe("completed");
    expect(report.reviewedFiles).toHaveLength(105);
    // One small group: its decisions are searched with every file in it, not refused past 100.
    expect(test.search.mock.calls[0]?.[0].taskScope?.files).toHaveLength(105);
  });

  it("says when a file's diff is not UTF-8, rather than letting the garble pass for its code", async () => {
    const test = setup([]);
    // A GBK comment read as UTF-8: the reviewer and the model see only replacement characters.
    vi.mocked(test.client.diff).mockResolvedValue("diff --git a/src/request.ts b/src/request.ts\n--- a/src/request.ts\n+++ b/src/request.ts\n@@ -1,1 +1,1 @@\n-// �� old\n+// �� new\n");

    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(view.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^src\/request\.ts 不是 UTF-8 编码/u)]));
  });
});

describe("PR snapshot cache", () => {
  const connectionId = "00000000-0000-4000-8000-000000000001";

  it("asks the platform only whether an unchanged PR moved, and reads it again once it did", async () => {
    const test = setup([]);
    const first = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(await test.service.peek({ connectionId, reference: "AI/app#1" })).toMatchObject({ snapshotId: first.snapshotId });
    const gets = test.get.mock.calls.length;
    const second = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(test.get.mock.calls.length).toBe(gets + 1);
    expect(test.client.files).toHaveBeenCalledTimes(1);
    expect(test.client.diff).toHaveBeenCalledTimes(1);

    test.get.mockResolvedValue({ ...pr, source: { ...pr.source, commit: "c".repeat(40) } });
    const third = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(third.snapshotId).not.toBe(first.snapshotId);
    expect(third.sourceCommit).toBe("c".repeat(40));
    expect(test.client.diff).toHaveBeenCalledTimes(2);
  });

  it("reads only the comments again when the PR changed without new commits", async () => {
    const test = setup([]);
    const comments = vi.fn(async () => []);
    test.client.comments = comments;
    await test.service.load({ connectionId, reference: "AI/app#1", updatedAt: "2026-09-28T10:00:00Z" });
    await test.service.load({ connectionId, reference: "AI/app#1", updatedAt: "2026-09-28T10:00:00Z" });
    expect(comments).toHaveBeenCalledTimes(1);
    await test.service.load({ connectionId, reference: "AI/app#1", updatedAt: "2026-09-28T11:00:00Z" });
    expect(comments).toHaveBeenCalledTimes(2);
    // A failed read is tried again, and a reference typed in has no list time to trust.
    comments.mockRejectedValueOnce(new Error("offline"));
    await test.service.load({ connectionId, reference: "AI/app#1", updatedAt: "2026-09-28T12:00:00Z" });
    await test.service.load({ connectionId, reference: "AI/app#1", updatedAt: "2026-09-28T12:00:00Z" });
    await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(comments).toHaveBeenCalledTimes(5);
    expect(test.client.diff).toHaveBeenCalledTimes(1);
  });

  it("keeps several PRs ready and reviews any of them", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    const first = await test.service.load({ connectionId, reference: "AI/app#1" });
    await test.service.load({ connectionId, reference: "AI/app#2" });
    const report = await test.service.run({ snapshotId: first.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.status).toBe("completed");
  });

  it("reads ahead only what changed and stops when the platform refuses", async () => {
    const test = setup([]);
    const items = [{ reference: "AI/app#1", updatedAt: "t1" }, { reference: "AI/app#2", updatedAt: "t1" }];
    await test.service.prefetch({ connectionId, items });
    expect(test.client.diff).toHaveBeenCalledTimes(2);
    const gets = test.get.mock.calls.length;
    // Nothing moved in the list: not even a request.
    await test.service.prefetch({ connectionId, items });
    expect(test.get.mock.calls.length).toBe(gets);

    test.get.mockRejectedValueOnce(new PrPlatformError(429));
    await test.service.prefetch({ connectionId, items: [{ reference: "AI/app#3" }, { reference: "AI/app#4" }] });
    expect(test.get.mock.calls.length).toBe(gets + 1);

    // Opening one that was read ahead costs one request.
    await test.service.load({ connectionId, reference: "AI/app#2", updatedAt: "t1" });
    expect(test.client.diff).toHaveBeenCalledTimes(2);
  });

  it("forgets a removed connection's snapshots in memory and on disk, and drops old cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-pr-cache-"));
    try {
      // Named before snapshots were filed by connection: never read again.
      await writeFile(join(directory, `${"a".repeat(40)}.json`), "{}");
      const test = setup([]);
      const other = "00000000-0000-4000-8000-000000000002";
      const service = new PrReviewService({ gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, cacheDirectory: directory });
      await service.load({ connectionId, reference: "AI/app#1" });
      await service.load({ connectionId: other, reference: "AI/app#1" });
      await vi.waitFor(async () => expect((await readdir(directory)).sort()).toEqual([expect.stringMatching(`^${connectionId}-`), expect.stringMatching(`^${other}-`)]));
      await service.forget(connectionId);
      expect(await readdir(directory)).toEqual([expect.stringMatching(`^${other}-`)]);
      expect(await service.peek({ connectionId, reference: "AI/app#1" })).toBeNull();
      expect(await service.peek({ connectionId: other, reference: "AI/app#1" })).not.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("opens a PR whose description is longer than a snapshot holds, and says it was cut", async () => {
    const test = setup([]);
    test.get.mockResolvedValue({ ...pr, description: "长".repeat(20_001) });
    const view = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(view.description).toHaveLength(20_000);
    expect(view.warnings).toContain("PR 描述超过 20000 字，只读取了前 20000 字。");
  });

  it("reviews the rest of a PR with a file name a review cannot carry, and names that file", async () => {
    const test = setup([]);
    vi.mocked(test.client.files).mockResolvedValue([
      { path: "src/request.ts", status: "modified" },
      { path: "test/fixtures/url?query.txt", status: "added", unsupported: true },
    ]);
    const view = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(view.files.map((file) => file.path)).toEqual(["src/request.ts"]);
    expect(view.warnings.some((warning) => warning.includes("url?query.txt") && warning.includes("未纳入评审"))).toBe(true);
  });

  it("does not put back what a removed connection was still reading", async () => {
    const test = setup([]);
    let release: (() => void) | undefined;
    test.get.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(pr); }));
    const loading = test.service.load({ connectionId, reference: "AI/app#1" });
    await vi.waitFor(() => expect(release).toBeDefined());

    await test.service.forget(connectionId);
    release?.();

    await expect(loading).rejects.toThrow("平台连接已删除或更换了凭据");
    expect(await test.service.peek({ connectionId, reference: "AI/app#1" })).toBeNull();
  });

  it("reads a file with the client that first read its commits, however often the PR is opened again", async () => {
    const test = setup([]);
    let created = 0;
    const readers: number[] = [];
    const service = new PrReviewService({
      gateway: test.gateway,
      searchDecisions: test.search,
      createClient: async () => {
        const id = ++created;
        return { ...test.client, readFileContent: vi.fn(async (...[, path]: Parameters<PrReviewClient["readFileContent"]>) => {
          if (GUIDE.test(path)) throw new PrPlatformError(404);
          readers.push(id); return "const timeout = 100;";
        }) };
      },
    });
    const first = await service.load({ connectionId, reference: "AI/app#1" });
    await service.load({ connectionId, reference: "AI/app#1" });

    await service.loadFile({ connectionId, reference: "AI/app#1", sourceCommit: first.sourceCommit, destinationCommit: first.destinationCommit, path: "src/request.ts", side: "new" });

    // That client holds what it read for these commits; a second one would ask the platform again.
    expect(readers).toEqual([1]);
  });

  it("opens a PR read before a restart at once, and still confirms its commits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-pr-cache-"));
    try {
      const test = setup([]);
      const options = { gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, cacheDirectory: directory };
      const view = await new PrReviewService(options).load({ connectionId, reference: "AI/app#1", updatedAt: "t1" });
      await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(1));

      const restarted = new PrReviewService(options);
      const gets = test.get.mock.calls.length;
      expect(await restarted.peek({ connectionId, reference: "AI/app#1" })).toMatchObject({ snapshotId: view.snapshotId, title: pr.title });
      expect((await restarted.loadDiff({ connectionId, reference: "AI/app#1", sourceCommit: view.sourceCommit, destinationCommit: view.destinationCommit })).diff).toBe(patch);
      expect(test.get.mock.calls.length).toBe(gets);
      await restarted.load({ connectionId, reference: "AI/app#1", updatedAt: "t1" });
      expect(test.get.mock.calls.length).toBe(gets + 1);
      expect(test.client.diff).toHaveBeenCalledTimes(1);
      expect(await restarted.peek({ connectionId, reference: "AI/app#9" })).toBeNull();
    } finally {
      // The last load writes its snapshot in the background; retry while that settles.
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

describe("pi PR review", () => {
  it("reviews against the local rules matched to the target repository and branch", async () => {
    const test = setup([{ action: "finish_review", summary: "已按规则核对", findings: [] }]);
    test.get.mockResolvedValue({ ...pr, destinationBranch: "main" });
    const loadRules = vi.fn(async () => ({ instructions: "## Ruleset 1\n\n禁止在请求路径里吞掉超时错误。", rules: [{ id: "team/timeout.md", source: "code-meeseeks" as const }], warnings: ["Decision 评审规则 broken.md 已跳过：applies_to.repo 不是有效的正则表达式"] }));
    const service = new PrReviewService({ gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, loadRules });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(loadRules).toHaveBeenCalledWith({ project: "AI", repo: "app", targetBranch: "main" });
    expect(view.rules).toEqual([{ id: "team/timeout.md", source: "code-meeseeks" }]);
    expect(view.warnings).toContain("Decision 评审规则 broken.md 已跳过：applies_to.repo 不是有效的正则表达式");
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(test.requests[0]!.userPrompt).toContain("禁止在请求路径里吞掉超时错误。");
    expect(test.requests[0]!.systemPrompt).toContain("reviewRules");

    // Follow-ups, /improve included, answer under the same rules.
    test.gateway.generate = async (request, parse) => {
      test.requests.push(request);
      const answer = { answer: "按规则应把超时错误抛给调用方。" };
      return { requestId: request.requestId, attemptId: randomUUID(), profileId: "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(answer), parsedOutput: parse(answer), usage: { source: "unavailable" }, providerDurationMs: 1 };
    };
    const { history: _history, ...contextReport } = report;
    await service.followUp({ runId: randomUUID(), profileId: "local", snapshot: view, report: contextReport, excerpts: "", messages: [], question: "/improve" });
    expect(test.requests.at(-1)!.userPrompt).toContain("禁止在请求路径里吞掉超时错误。");
    expect(test.requests.at(-1)!.systemPrompt).toContain("reviewRules");
  });

  it("re-evaluates one finding against its file's diff and keeps a replacement only when replacing", async () => {
    const test = setup([
      { verdict: "keep", reason: "第 2 行确实没有取消请求。", replacement: { title: "多余", body: "保留时不应带替代评论。" } },
      { verdict: "replace", reason: "表述不准确。", replacement: null },
      { verdict: "drop", reason: "旧提交上的误报。", replacement: null },
    ]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const request = { runId: randomUUID(), profileId: "local", snapshot: view, finding: { ...finding, priority: "P2" as const, side: "new" as const }, summary: "发现一处问题" };
    await expect(test.service.reevaluate(request)).resolves.toEqual({ verdict: "keep", reason: "第 2 行确实没有取消请求。", replacement: null });
    expect(test.requests[0]!.userPrompt).toContain("changed();");
    expect(test.requests[0]!.systemPrompt).toContain("keep");
    await expect(test.service.reevaluate({ ...request, runId: randomUUID() })).rejects.toThrow(/没有给出替代评论/);
    // After a restart nothing is cached: an older review re-reads its own pinned commits.
    const restarted = new PrReviewService({ gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client });
    const diffReads = vi.mocked(test.client.diff).mock.calls.length;
    await expect(restarted.reevaluate({ ...request, runId: randomUUID(), connectionId: "00000000-0000-4000-8000-000000000001" })).resolves.toMatchObject({ verdict: "drop" });
    expect(vi.mocked(test.client.diff).mock.calls.length).toBe(diffReads + 1);
    expect(test.requests[2]!.userPrompt).toContain("changed();");
  });

  it("says in the reader's words why a re-evaluation did not finish, and that it was stopped when it was", async () => {
    const test = setup([new Error("Model provider output failed application schema validation")]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const request = { runId: randomUUID(), profileId: "local", snapshot: view, finding: { ...finding, priority: "P2" as const, side: "new" as const }, summary: "发现一处问题" };
    await expect(test.service.reevaluate(request)).rejects.toThrow(/^模型调用或结构化输出失败/u);
    const stopped = test.service.reevaluate({ ...request, runId: randomUUID() });
    test.service.cancel();
    await expect(stopped).rejects.toThrow("复评已停止。");
  });

  it("asks whether a finding from an earlier commit is still there on the current one", async () => {
    const test = setup([{ verdict: "drop", reason: "第 2 行已改为传入 AbortSignal。", replacement: null }]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    await expect(test.service.reevaluate({ runId: randomUUID(), profileId: "local", snapshot: view, finding: { ...finding, priority: "P2" as const, side: "new" as const },
      summary: "上次的评审", earlierCommit: "c".repeat(40) })).resolves.toMatchObject({ verdict: "drop" });
    expect(JSON.parse(test.requests[0]!.userPrompt)).toMatchObject({ raisedAtCommit: "c".repeat(12) });
    expect(test.requests[0]!.systemPrompt).toContain("raisedAtCommit");
  });

  it("trims long rules to the room a group leaves instead of failing the group", async () => {
    // Counted as escaped, the file of quotes is three groups; the later ones carry what the earlier ones said.
    const test = setup(Array.from({ length: 3 }, () => ({ action: "finish_review", summary: "已核对".padEnd(2_000, "核"), findings: [] })));
    // Quotes double under JSON escaping, so this batch is small on disk but large in the prompt.
    const quoted = Array.from({ length: 50 }, (_, index) => `+const value${index} = "${'\\"'.repeat(35)}";`).join("\n");
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/quotes.ts", status: "added" }]);
    vi.mocked(test.client.diff).mockResolvedValue(`diff --git a/src/quotes.ts b/src/quotes.ts\n--- /dev/null\n+++ b/src/quotes.ts\n@@ -0,0 +1,50 @@\n${quoted}\n`);
    test.get.mockResolvedValue({ ...pr, description: "描".repeat(1_000) });
    test.client.comments = vi.fn(async () => [{ id: "1", url: "https://code.example/c/1", author: "bob", path: null, line: null, body: "已有评论。".repeat(50), createdAt: "2026-09-27T08:00:00Z" }]);
    const loadRules = vi.fn(async () => ({ instructions: "规".repeat(3_000), rules: [{ id: "long.md", source: "decision" as const }], warnings: [] }));
    const service = new PrReviewService({ gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, loadRules });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "焦".repeat(2_000) });
    expect(report.status).toBe("completed");
    expect(report.warnings).toContain("本组上下文较大，评审规则只纳入了前一部分。");
    expect(report.warnings).toContain("本组上下文较大，已有评论只纳入了前一部分。");
    expect(test.requests[0]!.userPrompt).toContain("规规规");
  });

  it("tells each batch what is already said on its file and on the PR, and reviews anyway when comments cannot be read", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    test.client.comments = vi.fn(async () => [
      { id: "1", url: "https://code.example/c/1", author: "bob", path: "src/request.ts", line: 2, body: "这里超时后\n没有取消请求。", createdAt: "2026-09-27T08:00:00Z" },
      { id: "2", url: "https://code.example/c/2", author: "carol", path: "src/other.ts", line: 1, body: "别的文件。", createdAt: "2026-09-27T07:00:00Z" },
      { id: "3", url: "https://code.example/c/3", author: "dan", path: null, line: null, body: "整体思路没问题。", createdAt: "2026-09-27T06:00:00Z" },
    ]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    const prompt = test.requests[0]!.userPrompt;
    expect(prompt).toContain("@bob (src/request.ts:2) 2026-09-27: 这里超时后 没有取消请求。");
    expect(prompt).toContain("@dan 2026-09-27: 整体思路没问题。");
    expect(prompt).not.toContain("别的文件。");
    expect(test.requests[0]!.systemPrompt).toContain("existingComments");

    const failing = setup([]);
    failing.client.comments = vi.fn(async () => { throw new PrPlatformError(403); });
    const view = await failing.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(view.warnings).toContain("读取 PR 已有评论失败，本次评审不参考已有评论。");
    expect(view.existingComments).toBeUndefined();
  });

  it("keeps whole rules when the rule set is over its limit", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    const loadRules = vi.fn(async () => ({ instructions: `## Ruleset 1\n\n${"甲".repeat(2_000)}\n\n## Ruleset 2\n\n不允许吞掉错误，除非${"乙".repeat(2_000)}`, rules: [{ id: "a.md", source: "decision" as const }, { id: "b.md", source: "decision" as const }], warnings: [] }));
    const service = new PrReviewService({ gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, loadRules });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(view.warnings).toContain("命中的评审规则合计超过 3000 字，超出部分未纳入本次评审。");
    await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(test.requests[0]!.userPrompt).toContain("甲甲甲");
    expect(test.requests[0]!.userPrompt).not.toContain("不允许吞掉错误");
  });

  it("re-evaluates with what was already said on the finding's file", async () => {
    const test = setup([{ verdict: "drop", reason: "bob 已指出同一问题。", replacement: null }]);
    test.client.comments = vi.fn(async () => [
      { id: "1", url: "https://code.example/c/1", author: "bob", path: "src/request.ts", line: 2, body: "已提过：请求没有取消。", createdAt: "2026-09-27T08:00:00Z" },
      { id: "2", url: "https://code.example/c/2", author: "carol", path: "src/other.ts", line: 1, body: "别的文件。", createdAt: "2026-09-27T07:00:00Z" },
    ]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    await expect(test.service.reevaluate({ runId: randomUUID(), profileId: "local", snapshot: view, finding: { ...finding, priority: "P2" as const, side: "new" as const }, summary: "一处问题" })).resolves.toMatchObject({ verdict: "drop" });
    expect(test.requests[0]!.userPrompt).toContain("@bob (src/request.ts:2) 2026-09-27: 已提过：请求没有取消。");
    expect(test.requests[0]!.userPrompt).not.toContain("别的文件。");
    expect(JSON.parse(test.requests[0]!.userPrompt)).toMatchObject({ existingCommentsTruncated: false });
    expect(test.requests[0]!.systemPrompt).toContain("existingComments");
  });

  it("says what each priority means, and to take the lower one when unsure", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    await test.run();
    expect(test.requests[0]!.systemPrompt).toMatch(/P1＝.*P2＝.*P3＝/u);
    expect(test.requests[0]!.systemPrompt).toContain("拿不准时取较低一级");
  });

  it("sends no rule section when no rule applies", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    await test.run();
    expect(test.requests[0]!.userPrompt).not.toContain("reviewRules");
  });

  it("reads many small files together in one group, as the whole PR, without spending calls on pagination", async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const test = setup([{ action: "finish_review", summary: "当前变更已核对", findings: [] }]);
    vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+const value = 1;\n`).join(""));
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(report.readFiles).toEqual(paths);
    expect(report).toMatchObject({ steps: 1, groups: 1 });
    const diff = JSON.parse(test.requests[0]!.userPrompt.split("\n最近步骤")[0]!).currentDiff as Array<{ path: string }>;
    expect(diff.map((file) => file.path).sort()).toEqual([...paths].sort());
  });

  it("tells each batch which other files the PR changes, within the room rules and comments leave", async () => {
    // Each file is too large to share a local model's group with another.
    const added = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+export const value${i} = "${"x".repeat(60)}";`).join("\n")}\n`;
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const test = setup(paths.map(() => ({ action: "finish_review", summary: "已核对", findings: [] })));
    vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => added(path, 30)).join(""));
    await test.run();
    expect(test.requests[0]!.userPrompt).toContain('"otherChangedFiles":["added src/b.ts","added src/c.ts"]');
    expect(test.requests[2]!.userPrompt).toContain('"otherChangedFiles":["added src/a.ts","added src/b.ts"]');
    expect(test.requests[0]!.systemPrompt).toContain("otherChangedFiles");

    // A PR of many files lists what fits and says how many more there are.
    const many = Array.from({ length: 60 }, (_, index) => `packages/module-${index}/src/components/deeply/nested/file.ts`);
    const wide = setup(many.map(() => ({ action: "finish_review", summary: "已核对", findings: [] })));
    vi.mocked(wide.client.files).mockResolvedValue(many.map((path) => ({ path, status: "modified" })));
    vi.mocked(wide.client.diff).mockResolvedValue(many.map((path) => added(path, 30)).join(""));
    const report = await wide.run();
    expect(report.status).toBe("completed");
    const listed = JSON.parse(wide.requests[0]!.userPrompt.split("\n最近步骤")[0]!).otherChangedFiles as string[];
    expect(listed.at(-1)).toMatch(/^…另有 \d+ 个文件$/u);
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(800);
  });

  it("lists other files only in the room the recent steps leave", () => {
    const files = Array.from({ length: 20 }, (_, index) => `modified packages/module-${index}/src/file.ts`);
    const said = { context: "x".repeat(9_500) };
    // Room to spare: every file.
    expect(JSON.parse(batchIntro(said, files.slice(0, 10), 0)).otherChangedFiles).toHaveLength(10);
    // A long first step keeps its place; the list shrinks to what is left.
    const tight = batchIntro(said, files, 8_900);
    expect(tight.length + 8_900).toBeLessThanOrEqual(19_000);
    expect(JSON.parse(tight).otherChangedFiles.at(-1)).toMatch(/^…另有 \d+ 个文件$/u);
    // No room at all: no list, the rest untouched.
    expect(batchIntro(said, files, 9_480)).toBe(JSON.stringify(said));
  });

  it("cuts a file too large for one group into pieces and reviews every piece", async () => {
    const lines = Array.from({ length: 1_500 }, (_, i) => `+const value${i} = ${i};`);
    const test = setup(Array.from({ length: 25 }, () => ({ action: "finish_review", summary: "本组已核对", findings: [] })));
    vi.mocked(test.client.diff).mockResolvedValue(`diff --git a/src/request.ts b/src/request.ts\n--- /dev/null\n+++ b/src/request.ts\n@@ -0,0 +1,1500 @@\n${lines.join("\n")}\n`);
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(report.groups).toBeGreaterThan(1);
    expect(report.steps).toBe(report.groups);
    expect(report.reviewedFiles).toEqual(["src/request.ts"]);
    expect(test.requests[0]!.userPrompt).toContain("+const value0 = 0;");
    expect(test.requests[0]!.userPrompt).toContain(`"part":"1/${report.groups}"`);
    expect(test.requests.at(-1)!.userPrompt).toContain("+const value1499 = 1499;");
    expect(report.history.find((event) => event.id === "batch-0")?.message).toBe(`评审分组 1/${report.groups}：src/request.ts（第 1/${report.groups} 段）`);
  });

  it("leaves lockfiles and minified output out of review batches and answers, and says so", async () => {
    const lock = Array.from({ length: 300 }, (_, i) => `+    "dep-${i}": "1.0.${i}",`);
    const test = setup([{ action: "finish_review", summary: "当前变更已核对", findings: [] }, { answer: "只改了请求。" }]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/request.ts", status: "modified" }, { path: "package-lock.json", status: "modified" }, { path: "dist/app.min.js", status: "added" }]);
    vi.mocked(test.client.diff).mockResolvedValue(`${patch}diff --git a/package-lock.json b/package-lock.json\n--- /dev/null\n+++ b/package-lock.json\n@@ -0,0 +1,300 @@\n${lock.join("\n")}\ndiff --git a/dist/app.min.js b/dist/app.min.js\n--- /dev/null\n+++ b/dist/app.min.js\n@@ -0,0 +1 @@\n+var a=1;\n`);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(snapshot.batchCount).toBe(1);
    expect(snapshot.skippedFiles).toEqual(["package-lock.json", "dist/app.min.js"]);
    const report = await test.service.run({ snapshotId: snapshot.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report).toMatchObject({ status: "completed", steps: 1, reviewedFiles: ["src/request.ts"], unreviewedFiles: [] });
    expect(report.summary).toContain("分 1 组评审了 1/1 个文件（另有 2 个锁定或生成文件未送模型）");
    await test.service.followUp({ runId: randomUUID(), profileId: "local", snapshot, excerpts: "", messages: [], question: "改了什么？" });
    const prompt = JSON.parse(test.requests[1]!.userPrompt);
    expect(prompt.diff).toContain("changed()");
    expect(prompt.diff).not.toContain("dep-0");
    expect(prompt.lockOrGeneratedFilesOmittedFromDiff).toEqual(["package-lock.json", "dist/app.min.js"]);
  });

  it("counts the lines a change adds and removes, and its tests and other code, leaving lockfiles out", async () => {
    const test = setup([]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/request.ts", status: "modified" }, { path: "test/request.test.ts", status: "added" }, { path: "docs/timeout.md", status: "added" }, { path: "package-lock.json", status: "modified" }]);
    vi.mocked(test.client.diff).mockResolvedValue(`${patch}diff --git a/test/request.test.ts b/test/request.test.ts\n--- /dev/null\n+++ b/test/request.test.ts\n@@ -0,0 +1,2 @@\n+it("cancels");\n+expect(1);\n`
      + "diff --git a/docs/timeout.md b/docs/timeout.md\n--- /dev/null\n+++ b/docs/timeout.md\n@@ -0,0 +1,1 @@\n+超时说明\n"
      + "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,1 +1,1 @@\n-\"a\"\n+\"b\"\n");
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(view.changeSize).toEqual({ added: 4, removed: 1, testFiles: 1, codeFiles: 1 });
  });

  it("leaves out a lockfile whose diff the platform truncated, without counting it as missed", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/request.ts", status: "modified" }, { path: "yarn.lock", status: "modified" }]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(view.skippedFiles).toEqual(["yarn.lock"]);
    expect(view.warnings.join("\n")).not.toContain("yarn.lock");
    const report = await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report).toMatchObject({ status: "completed", reviewedFiles: ["src/request.ts"], unreviewedFiles: [] });
  });

  it("reviews only the files picked, and says how many were left for another review", async () => {
    const paths = ["src/a.ts", "src/b.ts", "test/a.test.ts"];
    const test = setup(paths.map(() => ({ action: "finish_review", summary: "已核对", findings: [] })));
    vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+const value = 1;\n`).join(""));
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    expect(view.fileBatches).toEqual({ "src/a.ts": 1, "src/b.ts": 1, "test/a.test.ts": 1 });
    // Hunk sizes in review order: a file's tests right after it.
    expect(Object.keys(view.fileHunks!)).toEqual(["src/a.ts", "test/a.test.ts", "src/b.ts"]);
    expect(view.fileHunks!["src/a.ts"]).toEqual([22]);
    // One digest per file with a diff; the same change reads the same.
    expect(Object.keys(view.fileDigests!)).toEqual(paths);
    expect(new Set(Object.values(view.fileDigests!)).size).toBe(1);
    expect(view.fileDigests!["src/a.ts"]).toMatch(/^[a-f0-9]{16}$/u);
    const report = await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", paths: ["src/a.ts", "src/b.ts"] });
    expect(report).toMatchObject({ status: "completed", steps: 1, groups: 1, reviewedFiles: ["src/a.ts", "src/b.ts"], unreviewedFiles: [] });
    expect(report.summary).toContain("分 1 组评审了 2/2 个文件（另有 1 个文件未选入这次评审）");
  });

  it("adds up what the review's model calls reported and prices it at the chosen backend's own rate", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }, { answer: "取消底层请求。" }]);
    const priced = modelProviderProfileSchema.parse({ ...profile, pricing: { currency: "¥", inputPerMillion: 2, outputPerMillion: 8 } });
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: {
      listGenerationProfiles: async () => [priced],
      generate: async (request, parse, signal) => ({ ...(await test.gateway.generate(request, parse, signal)), usage: { source: "provider_reported", inputTokens: 1_500, outputTokens: 500 } }),
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.usage).toEqual({ input: 1_500, output: 500, unreportedCalls: 0, cost: { currency: "¥", amount: 0.007 } });
    // An answer about the PR says what its one call spent.
    expect(await service.followUp({ runId: randomUUID(), profileId: "local", snapshot: view, excerpts: "", messages: [], question: "怎么修？" }))
      .toEqual({ answer: "取消底层请求。", usage: { input: 1_500, output: 500, unreportedCalls: 0, cost: { currency: "¥", amount: 0.007 } } });
    // A backend that reports nothing leaves a count of calls, not a made-up total.
    expect((await setup([{ action: "finish_review", summary: "已核对", findings: [] }]).run()).usage).toEqual({ input: 0, output: 0, unreportedCalls: 1 });
  });

  it("prices each call at its own hour and its cached input at the cached rate, as the call's trace does", async () => {
    const test = setup([{ answer: "取消底层请求。" }]);
    // DeepSeek's: the base rates are off-peak, peak hours double them, a cache hit is a tenth of the input rate.
    const pricing = { currency: "¥", inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.2, peak: { inputPerMillion: 4, outputPerMillion: 16, cachedInputPerMillion: 0.4, holidayYear: 2026, holidays: ["2026-10-01"] } };
    const priced = modelProviderProfileSchema.parse({ ...profile, pricing });
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: {
      listGenerationProfiles: async () => [priced],
      generate: async (request, parse, signal) => ({ ...(await test.gateway.generate(request, parse, signal)), usage: { source: "provider_reported", inputTokens: 1_500, cachedInputTokens: 1_000, outputTokens: 500 } }),
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    vi.setSystemTime(new Date("2026-10-12T02:00:00.000Z")); // Monday 10:00 in Beijing: peak
    try {
      const { usage } = await service.followUp({ runId: randomUUID(), profileId: "local", snapshot: view, excerpts: "", messages: [], question: "怎么修？" });
      // At the base rate for every token it said 0.007, against the trace's 0.0104.
      expect(usage?.cost?.amount).toBeCloseTo((500 * 4 + 1_000 * 0.4 + 500 * 16) / 1e6, 9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds up what a failed call reported it spent, as answers do", async () => {
    // Answered and billed, then refused (not in the shape asked): the gateway says what it cost, and the
    // review's totals were a floor below what was known.
    const spent = (inputTokens: number, outputTokens: number) => ({ source: "provider_reported" as const, inputTokens, outputTokens });
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [finding] }]);
    let refused = false;
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: {
      listGenerationProfiles: test.gateway.listGenerationProfiles,
      generate: async (request, parse, signal) => {
        // The review's first call, and the call verifying its finding (structured).
        if (request.promptVersion.startsWith("pr-review-verify")) throw new ProfiledModelGatewayError("refused", "invalid_output", spent(2_000, 50));
        if (!refused) { refused = true; throw new ProfiledModelGatewayError("refused", "invalid_output", spent(8_000, 400)); }
        return { ...(await test.gateway.generate(request, parse, signal)), usage: spent(1_000, 100) };
      },
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.usage).toEqual({ input: 11_000, output: 550, unreportedCalls: 0 });
  });

  it("accepts a valid conclusion when the native grammar also fills unrelated action fields", async () => {
    const test = setup([{ action: "finish_review", path: "src/request.ts", offset: 0, startLine: 1, query: "", recordId: "", source: "summarize", summary: "已核对", findings: [finding] }]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    // One review call, then one verifying its finding.
    expect(report.steps).toBe(2);
    expect(report.findings).toEqual([finding]);
  });

  it("accepts identical repeated conclusions as one action without discarding distinct results", async () => {
    const conclusion = { action: "finish_review", summary: "已核对", findings: [finding] };
    const report = await setup([{ actions: [conclusion, conclusion] }]).run();
    expect(report.status).toBe("completed");
    expect(report.steps).toBe(2);
    expect(report.findings).toEqual([finding]);
  });

  it("recovers from a provider returning DSML instead of the requested JSON", async () => {
    let invalid: Error;
    try { parseStructuredJson('[path]</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ calls>', undefined, "stop"); }
    catch (error) { invalid = error as Error; }
    const test = setup([{ action: "read_diff", path: "src/request.ts" }, invalid!,
      { action: "finish_review", summary: "完成", findings: [finding] }]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(test.onProgress.mock.calls.some(([event]) => event.kind === "model" && event.status === "running")).toBe(true);
    expect(test.onProgress.mock.calls.some(([event]) => event.kind === "tool" && event.status === "done")).toBe(true);
    expect(report.findings).toEqual([finding]);
    expect(report.steps).toBe(4);
  });

  it("dispatches a bounded JSON action batch through pi before generating the report", async () => {
    const test = setup([{ actions: [
      { action: "read_diff", path: "src/request.ts" },
      { action: "search_decisions", query: "请求超时", path: "src/request.ts" },
    ] }, { actions: [{ action: "finish_review", summary: "完成", findings: [finding] }] }]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(report.steps).toBe(3);
    expect(report.readFiles).toEqual(["src/request.ts"]);
    expect(report.history.some((event) => event.kind === "tool" && event.status === "done")).toBe(true);
    expect(test.requests[0]?.maxOutputTokens).toBe(8_192);
    expect(report.history[0]?.id).toBe("batch-0");
    expect(report.history.filter(event => event.kind === "status").some(event => /读取变更：|读取源码：|核对历史决策与适用范围/.test(event.message))).toBe(false);
    expect(new Set(report.history.map(event => event.id)).size).toBe(report.history.length);
  });

  it("keeps read progress and sends plain JSON actions instead of native tool-call envelopes", async () => {
    const test = setup([{ action: "read_diff", path: "src/request.ts" },
      { action: "read_diff", path: "src/request.ts" },
      { action: "finish_review", summary: "完成", findings: [] }]);
    await test.run();
    expect(test.requests[1]!.userPrompt).not.toContain('"type":"toolCall"');
    expect(test.requests[1]!.userPrompt).toContain('"nextOffset":null');
    expect(test.requests[2]!.userPrompt).toContain('"alreadyRead":true');
  });

  it("reports configuration failures without retrying an unchanged invalid configuration", async () => {
    const test = setup([new ProfiledModelGatewayError("failed", "invalid_configuration")]);
    const report = await test.run();
    expect(report.steps).toBe(1);
    expect(report.warnings.join(" ")).toContain("模型配置或输出格式不受支持");
    expect(report.history.some((event) => event.kind === "retry")).toBe(false);
  });

  it("does not retry a model that is out of credit", async () => {
    // A top-up is not minutes away: two retries at once could only fail the same way.
    const test = setup([new ProfiledModelGatewayError("failed", "quota_exhausted")]);
    const report = await test.run();
    expect(report.steps).toBe(1);
    expect(report.warnings.join(" ")).toContain("额度或余额不足");
    expect(report.history.some((event) => event.kind === "retry")).toBe(false);
  });

  it("stops the model loop and remaining tool batch on platform authentication failure", async () => {
    const test = setup([{ actions: [{ action: "read_file", path: "src/request.ts" }, { action: "read_file", path: "src/other.ts" }] }, { action: "finish_review", summary: "done", findings: [] }]);
    test.readFile.mockRejectedValue(new PrPlatformError(401));
    const report = await test.run();
    expect(report.status).toBe("failed");
    expect(report.steps).toBe(1);
    expect(test.readFile).toHaveBeenCalledTimes(1);
    expect(report.warnings.join(" ")).toContain("HTTP 401");
  });

  it("uses the real pi loop to read pinned code, retrieve decisions and validate a cited finding", async () => {
    const test = setup([{ action: "read_diff", path: "src/request.ts" }, { action: "read_file", path: "src/request.ts", startLine: 1 }, { action: "search_decisions", query: "请求超时", path: "src/request.ts" }, { action: "finish_review", summary: "发现超时资源泄漏", findings: [finding] }]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(report.findings).toEqual([finding]);
    expect(report.evidence[0]?.record).toMatchObject({ id: "DEC-1", kind: "historical_decision", applicability: { status: "needs_review" } });
    expect(test.readFile).toHaveBeenCalledWith(pr, "src/request.ts", 1, expect.any(AbortSignal));
    expect(test.search).toHaveBeenLastCalledWith(expect.objectContaining({ project: "app", taskScope: { files: ["src/request.ts"] } }));
    expect(report.readFiles).toEqual(["src/request.ts"]);
    expect(prReviewReportSchema.parse(report)).toEqual(report);
    expect(test.requests.every((request) => request.userPrompt.length <= 20_000 && request.purpose === "pr-review")).toBe(true);
  });

  it("does not accept invented line positions or evidence references", async () => {
    const test = setup([{ action: "read_diff", path: "src/request.ts" },
      { action: "finish_review", summary: "错误定位", findings: [{ ...finding, line: 999 }] },
      { action: "finish_review", summary: "错误引用", findings: [{ ...finding, decisionIndexes: [99] }] },
      { action: "finish_review", summary: "已纠正", findings: [finding] }]);
    const report = await test.run();
    expect(report.steps).toBe(5);
    expect(report.findings).toEqual([finding]);
    expect(test.requests[2]?.userPrompt).toContain("问题必须定位到已读取");
    expect(test.requests[3]?.userPrompt).toContain("不存在的决策证据");
  });

  it("asks a group once more, without steps, when its steps end without a conclusion", async () => {
    // Answers of the wrong shape, past the retries: the group used to fail, and with it the review.
    const shape = () => new Error("输出不符合 Schema");
    const test = setup([shape(), shape(), shape(), { summary: "一次性评审", findings: [finding] }]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(report.findings).toEqual([finding]);
    expect(test.requests.map((request) => request.promptVersion)).toContain("pr-review-direct-v1");
    expect(report.history.some((event) => event.message === "一次性评审本组：1 个问题" && event.status === "done")).toBe(true);
  });

  it("says why a group asked once more still has no conclusion, when the model refuses", async () => {
    const shape = () => new Error("输出不符合 Schema");
    const test = setup([shape(), shape(), shape(), new ProfiledModelGatewayError("额度不足", "quota_exhausted")]);
    const report = await test.run();
    expect(report.status).toBe("failed");
    // Said only in a step's line, the report read as if the model had simply not answered.
    expect(report.warnings).toContain("模型服务的额度或余额不足，请到服务商处充值或检查套餐后再试。");
    expect(report.warnings).not.toContain("本组模型没有给出结论。");
  });

  it("keeps what each step read or found for the page to open: the code, the decisions, a refused answer as it was", async () => {
    const refused = new ProfiledModelGatewayError("格式不对", "invalid_output", undefined, "好的，我来评审这段代码。");
    const test = setup([{ action: "read_file", path: "src/request.ts", startLine: 1 }, { action: "search_decisions", query: "请求超时" }, refused,
      { action: "finish_review", summary: "已核对", findings: [] }]);
    const report = await test.run();
    const read = report.history.find((event) => event.kind === "tool" && event.message.startsWith("读取源码 src/request.ts"));
    expect(read).toMatchObject({ code: { path: "src/request.ts", side: "new", line: 1, view: "file" } });
    expect(read?.detail).toContain("    1  const timeout = 100;");
    const searched = report.history.find((event) => event.kind === "tool" && event.message.startsWith("检索决策「请求超时」"));
    expect(searched?.decisions).toEqual([expect.objectContaining({ source: "summarize", id: "DEC-1", title: "请求超时", relativePath: "summarize/DEC-1.md" })]);
    // "错误类别：invalid_output" alone said nothing of what the model wrote.
    expect(report.history.some((event) => event.kind === "model" && event.status === "error" && event.detail?.includes("模型原始输出：\n好的，我来评审这段代码。"))).toBe(true);
  });

  it("reviews the code without decisions when they cannot be searched, and says so", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    test.search.mockRejectedValue(new Error("决策索引无法读取"));
    const report = await test.run();
    expect(report).toMatchObject({ status: "incomplete", reviewedFiles: ["src/request.ts"] });
    expect(report.warnings).toContain("决策检索不可用，本次没有核对历史决策。");
    expect(report.history.some((event) => event.status === "error" && event.message === "检索与本组相关的决策：决策索引无法读取")).toBe(true);
  });

  it("takes the group's last conclusion as it is: a finding a line off moves to the change, one far off is set aside", async () => {
    const reads = [1, 2, 3, 4, 5].map((startLine) => ({ action: "read_file", path: "src/request.ts", startLine }));
    const test = setup([...reads, { action: "finish_review", summary: "最后一次", findings: [
      { ...finding, line: 1, decisionIndexes: [] }, { ...finding, title: "离变更很远", line: 50, decisionIndexes: [] }] }]);
    const report = await test.run();
    expect(report.findings).toEqual([{ ...finding, line: 2, decisionIndexes: [] }]);
    expect(report.history.some((event) => event.message === "提交本组结论：1 个问题（另有 1 条没能定位到变更行，已略去）")).toBe(true);
  });

  it("distinguishes delivered diff from a successfully reviewed batch", async () => {
    const report = await setup([new ProfiledModelGatewayError("failed", "invalid_configuration")]).run();
    expect(report).toMatchObject({ status: "failed", readFiles: ["src/request.ts"], reviewedFiles: [], unreviewedFiles: ["src/request.ts"] });
  });

  it("reuses source reads and forces a batch conclusion after repeated requests", async () => {
    const test = setup([{ action: "read_file", path: "src/request.ts", startLine: 1 }, { action: "read_file", path: "src/request.ts", startLine: 1 }, { action: "read_file", path: "src/request.ts", startLine: 1 }, { action: "finish_review", path: "src/request.ts", offset: 0, summary: "已核对", findings: [] }]);
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(test.readFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(test.requests[3]?.outputSchema)).not.toContain('"const":"read_file"');
  });

  it("retains earlier batch findings when a later batch fails", async () => {
    const test = setup([{ action: "finish_review", summary: "发现问题", findings: [finding] }, new ProfiledModelGatewayError("failed", "invalid_configuration")]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/request.ts", status: "modified" }, { path: "src/second.ts", status: "added" }]);
    // Too large to share the first file's group.
    const second = Array.from({ length: 60 }, (_, i) => `+new${i}("${"x".repeat(60)}");`);
    vi.mocked(test.client.diff).mockResolvedValue(`${patch}diff --git a/src/second.ts b/src/second.ts\n--- /dev/null\n+++ b/src/second.ts\n@@ -0,0 +1,60 @@\n${second.join("\n")}\n`);
    const report = await test.run();
    expect(report.findings).toEqual([finding]);
    expect(report.reviewedFiles).toEqual(["src/request.ts"]);
    expect(report.unreviewedFiles).toEqual(["src/second.ts"]);
  });

  it("invalidates a report when either PR commit changes", async () => {
    const test = setup([{ action: "read_diff", path: "src/request.ts" }, { action: "finish_review", summary: "完成", findings: [] }]);
    test.get.mockResolvedValueOnce(pr).mockResolvedValueOnce(pr).mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, destination: { ...pr.destination, commit: "c".repeat(40) } });
    expect((await test.run()).status).toBe("stale");
  });

  it("cancels the running model and keeps results distinct from a completed review", async () => {
    const test = setup([]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const id = randomUUID();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    test.gateway.generate = async (_request, _parse, signal) => { started(); await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); throw new Error("unreachable"); };
    const running = test.service.run({ snapshotId: view.snapshotId, runId: id, profileId: "local", focus: "" });
    await ready;
    test.service.cancel(id);
    expect((await running).status).toBe("cancelled");
  });

  it("reads another PR while a review runs, and leaves the running one alone", async () => {
    const test = setup([]);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const id = randomUUID();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    test.gateway.generate = async (_request, _parse, signal) => { started(); await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); throw new Error("unreachable"); };
    const running = test.service.run({ snapshotId: view.snapshotId, runId: id, profileId: "local", focus: "" });
    await ready;
    const other = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#2" });
    expect(other.snapshotId).not.toBe(view.snapshotId);
    test.service.cancel(id);
    expect((await running).status).toBe("cancelled");
  });

  it("bounds a repeating agent and treats provider failure as failure", async () => {
    const report = await setup(Array.from({ length: 20 }, () => ({ action: "read_diff", path: "src/request.ts" }))).run();
    expect(report.status).toBe("failed");
    expect(report.steps).toBeLessThanOrEqual(6);
    expect(report.reviewedFiles).toEqual([]);
    expect((await setup([new Error("failed")]).run()).status).toBe("failed");
  });

  it("rechecks cited decision versions before declaring completion", async () => {
    const test = setup([{ action: "read_diff", path: "src/request.ts" }, { action: "finish_review", summary: "发现问题", findings: [finding] }]);
    const response = await test.search({ query: "", limit: 5, offset: 0, includeOutOfScope: false });
    test.search.mockResolvedValueOnce(response).mockResolvedValue({ ...response, results: response.results.map((record) => ({ ...record, sourceRef: { ...record.sourceRef, contentHash: "f".repeat(64) } })) });
    const report = await test.run();
    expect(report.status).toBe("incomplete");
    expect(report.warnings.join(" ")).toContain("已变化或无法确认版本");
  });

  it("labels unavailable decision coverage incomplete", async () => {
    const test = setup([{ action: "read_diff", path: "src/request.ts" }, { action: "finish_review", summary: "完成", findings: [] }]);
    const response = await test.search({ query: "", limit: 5, offset: 0, includeOutOfScope: false });
    test.search.mockResolvedValue({ ...response, coverage: "partial" });
    expect((await test.run()).status).toBe("incomplete");
  });
});

describe("Bitbucket review boundaries", () => {
  it("validates neutral references without interpreting links as API targets", () => {
    expect(parsePrReference("group/subgroup/repo#12")).toEqual({ repository: "group/subgroup/repo", number: "12" });
    for (const value of ["https://host/repo#1", "AI/../app#1", "AI/app#0", "--allow-writes"]) expect(() => parsePrReference(value)).toThrow();
  });
  it("refuses a truncated hunk instead of presenting it as a complete diff", () => {
    expect(() => parseReviewDiff(patch.replace("+changed();\n", ""))).toThrow(/截断/);
  });
  it("preserves old/new hunk line numbers, including deletions and +++ code lines", () => {
    const parsed = parseReviewDiff(patch + "diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -9,1 +0,0 @@\n-removed\n");
    expect(parsed.get("src/request.ts")).toEqual([{ text: " const timeout = 100;", old: 1, new: 1, changed: false }, { text: "-old();", old: 2, new: null, changed: true }, { text: "+changed();", old: null, new: 2, changed: true }]);
    expect(parsed.get("gone.ts")?.[0]).toMatchObject({ old: 9, new: null });
    expect(parseReviewDiff(patch.replace("+changed();", "+++code" )).get("src/request.ts")?.[2]?.text).toBe("+++code");
  });
});


describe("PR follow-up", () => {
  it("answers against the selected report and conversation, using only a matching cached diff", async () => {
    const test = setup([{ answer: "取消底层请求。" }, { answer: "旧提交缺少原始 diff。" }]);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = prReviewReportSchema.parse({ status: "completed", summary: "请求未取消", findings: [], evidence: [], readFiles: [], unreadFiles: [], warnings: [], steps: 1 });
    const { history: _history, ...savedReport } = report;
    const input = { runId: randomUUID(), profileId: "local", snapshot, report: savedReport, excerpts: "原始证据", messages: [{ role: "user" as const, content: "为什么？" }, { role: "assistant" as const, content: "请求仍在运行" }], question: "怎么修复？" };
    expect(await test.service.followUp(input)).toMatchObject({ answer: "取消底层请求。" });
    const prompt = JSON.parse(test.requests[0]!.userPrompt);
    expect(prompt.question).toBe("怎么修复？");
    expect(prompt.messages).toEqual(input.messages);
    expect(prompt.context).toContain("请求未取消");
    expect(prompt.diff).toContain("changed()");
    expect(test.requests[0]!.systemPrompt).toContain("非可信材料");
    await test.service.followUp({ ...input, runId: randomUUID(), snapshot: { ...snapshot, sourceCommit: "c".repeat(40) } });
    expect(JSON.parse(test.requests[1]!.userPrompt).diffAvailable).toBe(false);
  });

  it("answers about a PR never reviewed from its diff, also once only the disk cache has it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decision-pr-cache-"));
    try {
      const test = setup([{ answer: "这是概览。" }]);
      const connectionId = "00000000-0000-4000-8000-000000000001";
      const options = { gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, cacheDirectory: directory };
      const snapshot = await new PrReviewService(options).load({ connectionId, reference: "AI/app#1" });
      await vi.waitFor(async () => expect(await readdir(directory)).toHaveLength(1));
      // A fresh service, as after a restart: the snapshot is only on disk.
      const restarted = new PrReviewService(options);
      expect(await restarted.followUp({ runId: randomUUID(), profileId: "local", connectionId, snapshot, excerpts: "", messages: [], question: "按 PR 概览格式回答" })).toMatchObject({ answer: "这是概览。" });
      const prompt = JSON.parse(test.requests[0]!.userPrompt);
      expect(prompt.diff).toContain("changed()");
      expect(JSON.parse(prompt.context)).not.toHaveProperty("report");
      expect(test.requests[0]!.systemPrompt).toContain("还没有评审报告");
      expect(test.requests[0]!.systemPrompt).toContain("不要在回答里复述");
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("cancels follow-ups and rejects overlapping work", async () => {
    const test = setup([]);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = prReviewReportSchema.parse({ status: "completed", summary: "完成", findings: [], evidence: [], readFiles: [], unreadFiles: [], warnings: [], steps: 1 });
    const { history: _history, ...savedReport } = report;
    vi.spyOn(test.gateway, "generate").mockImplementation((_request, _parse, signal) => new Promise((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }));
    const input = { runId: randomUUID(), profileId: "local", snapshot, report: savedReport, excerpts: "", messages: [], question: "解释一下" };
    const pending = test.service.followUp(input);
    await expect(test.service.followUp({ ...input, runId: randomUUID() })).rejects.toThrow("已有评审");
    test.service.cancel(input.runId);
    await expect(pending).rejects.toThrow("aborted");
    await expect(test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" })).resolves.toHaveProperty("snapshotId");
  });
});

it("reuses the pinned diff without overwriting a review snapshot when browsing other PRs", async () => {
  const test = setup([]);
  const connectionId = randomUUID();
  const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });
  const request = { connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit };
  expect(await test.service.loadDiff(request)).toEqual({ diff: patch });
  expect(test.client.diff).toHaveBeenCalledTimes(1);
  await test.service.loadDiff({ ...request, connectionId: randomUUID() });
  expect(test.client.diff).toHaveBeenCalledTimes(2);
  await test.service.loadDiff(request);
  expect(test.client.diff).toHaveBeenCalledTimes(2);
});

it("rejects changed and racing PR versions instead of attaching current code to an old review", async () => {
  const test = setup([]);
  const request = { connectionId: randomUUID(), reference: "AI/app#1", sourceCommit: "c".repeat(40), destinationCommit: pr.destination.commit };
  await expect(test.service.loadDiff(request)).rejects.toThrow(/提交已变化/);
  expect(test.client.diff).not.toHaveBeenCalled();
  test.get.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, source: { ...pr.source, commit: "c".repeat(40) } });
  await expect(test.service.loadDiff({ ...request, sourceCommit: pr.source.commit })).rejects.toThrow(/读取期间/);
});

it("reads full content from immutable commit context and validates file paths", async () => {
  const test = setup([]);
  vi.mocked(test.client.readFileContent).mockResolvedValue("text\ncontent");
  const request = { connectionId: randomUUID(), reference: "AI/app#1", sourceCommit: pr.source.commit, destinationCommit: pr.destination.commit, path: "src/request.ts", side: "old" as const };
  expect(await test.service.loadFile(request)).toEqual({ content: "text\ncontent", binary: false });
  expect(test.client.readFileContent).toHaveBeenCalledWith(pr, "src/request.ts", "old");
  await expect(test.service.loadFile({ ...request, path: "../secret" })).rejects.toThrow();
  vi.mocked(test.client.readFileContent).mockResolvedValue("binary\0content");
  expect(await test.service.loadFile(request)).toEqual({ content: "", binary: true });
});

describe("grouped review with verification", () => {
  const remote = modelProviderProfileSchema.parse({ version: 1, profileId: "remote", kind: "openai-compatible", model: "test-model", label: "远端", enabled: true, priority: 1,
    baseUrl: "https://llm.example.com/v1", apiProtocol: "chat-completions", credentialRef: "remote-key", timeoutMs: 30_000 });
  const oldSide = { priority: "P3" as const, title: "旧调用的返回值被忽略", body: "删掉的 old() 原本会返回错误码。", path: "src/request.ts", side: "old" as const, line: 2, decisionIndexes: [] };

  it("checks every finding on its own and keeps an unconvincing one aside, with its score and why", async () => {
    const test = setup([{ action: "finish_review", summary: "两处问题", findings: [finding, oldSide] },
      { verdicts: [{ id: 1, score: 90, reason: "第 2 行确实没有传入取消信号。" }, { id: 2, score: 40, reason: "old() 的返回值此前也没人用，是变更前就有的情况。" }] }]);
    const report = await test.run();
    expect(report.findings).toEqual([finding]);
    expect(report.filtered).toEqual([{ finding: oldSide, score: 40, reason: "old() 的返回值此前也没人用，是变更前就有的情况。" }]);
    expect(report.summary).toContain("形成 1 条问题；另有 1 条候选经核验把握不足，未列入");
    const verify = test.requests.find((request) => request.promptVersion === "pr-review-verify-v3")!;
    expect(verify.systemPrompt).toContain("0：完全没有把握");
    expect(JSON.parse(verify.userPrompt)).toMatchObject({ candidates: [{ id: 1, title: finding.title }, { id: 2, title: oldSide.title }], diffs: [{ path: "src/request.ts", lines: ["1/1  const timeout = 100;", "2/- -old();", "-/2 +changed();"] }] });
    expect(report.history.some((event) => event.message === "核验候选问题 1/1" && event.status === "done")).toBe(true);
  });

  it("gives the verifier the decisions a candidate was raised for, to check that they apply", async () => {
    const test = setup([{ action: "finish_review", summary: "两处问题", findings: [finding, oldSide] }]);
    await test.run();
    const verify = test.requests.find((request) => request.promptVersion === "pr-review-verify-v3")!;
    expect(verify.systemPrompt).toContain("因决策提出的问题，要核对决策确实点名了这种做法");
    const said = JSON.parse(verify.userPrompt);
    expect(said.candidates[0]).toMatchObject({ id: 1, decisionIndexes: [1] });
    expect(said.candidates[1]).not.toHaveProperty("decisionIndexes");
    expect(said.decisions).toEqual([{ index: 1, source: "summarize", id: "DEC-1", title: "请求超时", detail: expect.stringContaining("请求超时后必须释放资源") }]);
  });

  it("keeps the findings a failed verification could not check, and says so", async () => {
    const test = setup([{ action: "finish_review", summary: "一处问题", findings: [finding] }]);
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: {
      listGenerationProfiles: test.gateway.listGenerationProfiles,
      generate: async (request, parse, signal, profileId) => {
        if (request.promptVersion.startsWith("pr-review-verify")) throw new Error("模型不可用");
        return test.gateway.generate(request, parse, signal, profileId);
      },
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.findings).toEqual([finding]);
    expect(report.warnings).toContain("1 条问题没能完成核验，按原样保留。");
  });

  it("reads a large PR in groups after a brief of the whole, with a remote model", async () => {
    const big = (path: string) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+export const value${i} = "${"x".repeat(60)}";`).join("\n")}\n`;
    const test = setup([{ summary: "为两个模块添加常量表。", areas: [{ files: ["src/a.ts", "src/b.ts"], change: "新增常量" }], risks: ["a 与 b 的常量名可能冲突"] },
      { action: "finish_review", summary: "a 已核对", findings: [] }, { action: "finish_review", summary: "b 已核对", findings: [] }]);
    test.gateway.listGenerationProfiles = async () => [profile, remote];
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/a.ts", status: "added" }, { path: "src/b.ts", status: "added" }]);
    vi.mocked(test.client.diff).mockResolvedValue(big("src/a.ts") + big("src/b.ts"));
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    expect(report).toMatchObject({ status: "completed", groups: 2, steps: 3, reviewedFiles: ["src/a.ts", "src/b.ts"] });
    expect(test.requests.map((request) => request.promptVersion)).toEqual(["pr-review-brief-v1", "pr-review-v10", "pr-review-v10"]);
    for (const request of test.requests.slice(1)) expect(request.userPrompt).toContain("需要跨文件核对：\\n- a 与 b 的常量名可能冲突");
    expect(report.summary.startsWith("为两个模块添加常量表。")).toBe(true);
    // A remote model reads a whole 30,000-character file in one group; a local one would need eight.
    expect(JSON.parse(test.requests[1]!.userPrompt.split("\n最近步骤")[0]!).currentDiff).toHaveLength(1);
  });

  it("lets a group read another group's diff, and reports a problem both raise once", async () => {
    const second = Array.from({ length: 60 }, (_, i) => `+call${i}("${"x".repeat(60)}");`);
    const onSecond = { ...finding, title: "第二个文件没有取消请求", path: "src/second.ts", line: 3, decisionIndexes: [] };
    const test = setup([{ action: "read_diff", path: "src/second.ts" }, { action: "finish_review", summary: "看过第二个文件", findings: [onSecond] },
      { action: "finish_review", summary: "第二个文件", findings: [{ ...onSecond, priority: "P1" }] }, { action: "finish_review", summary: "第二个文件其余部分", findings: [] }]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/request.ts", status: "modified" }, { path: "src/second.ts", status: "added" }]);
    vi.mocked(test.client.diff).mockResolvedValue(`${patch}diff --git a/src/second.ts b/src/second.ts\n--- /dev/null\n+++ b/src/second.ts\n@@ -0,0 +1,60 @@\n${second.join("\n")}\n`);
    const report = await test.run();
    expect(test.requests[1]!.userPrompt).toContain('"path":"src/second.ts","lines":["-/1 +call0');
    expect(report.findings).toEqual([{ ...onSecond, priority: "P1" }]);
  });
});

describe("groups at once", () => {
  const remote = modelProviderProfileSchema.parse({ version: 1, profileId: "remote", kind: "openai-compatible", model: "test-model", label: "远端", enabled: true, priority: 1,
    baseUrl: "https://llm.example.com/v1", apiProtocol: "chat-completions", credentialRef: "remote-key", timeoutMs: 30_000 });
  const added = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+export const value${i} = "${"x".repeat(60)}";`).join("\n")}\n`;
  const groupOf = (request: StructuredGenerationRequest) => JSON.parse(request.userPrompt.split("\n最近步骤")[0]!).currentDiff[0].path as string;
  const onFile = (path: string) => ({ priority: "P3" as const, title: `${path} 的常量没有导出类型`, body: "调用方拿不到类型。", path, side: "new" as const, line: 1, decisionIndexes: [] });
  /** Each path its own added file; the model answers after `delay` ms and counts the calls it is working on at once. */
  const serviceOver = async (paths: string[], lines: number, answer: (request: StructuredGenerationRequest) => unknown, delay: (request: StructuredGenerationRequest) => number = () => 5) => {
    const test = setup([]);
    vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => added(path, lines)).join(""));
    const seen = { busy: 0, most: 0, requests: [] as StructuredGenerationRequest[] };
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: {
      listGenerationProfiles: async () => [profile, remote],
      generate: async (request, parse, signal) => {
        signal?.throwIfAborted(); seen.requests.push(request);
        seen.busy++; seen.most = Math.max(seen.most, seen.busy);
        try { await new Promise((resolve) => setTimeout(resolve, delay(request))); } finally { seen.busy--; }
        const action = request.promptVersion.startsWith("pr-review-verify")
          ? { verdicts: (JSON.parse(request.userPrompt).candidates as Array<{ id: number }>).map(({ id }) => ({ id, score: 90, reason: "成立。" })) }
          : answer(request);
        if (action instanceof Error) throw action;
        return { requestId: request.requestId, attemptId: randomUUID(), profileId: "remote", backend: "openai-compatible", provider: "remote", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
      },
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    return { service, view, seen };
  };
  const brief = { summary: "四个模块各加一组常量。", areas: [{ files: ["src/a.ts"], change: "新增常量" }], risks: [] };

  it("reviews up to three groups at once with a remote model, and reports them in the groups' order", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    // The first groups take the longest, so the groups finish in the reverse of their order.
    const { service, view, seen } = await serviceOver(paths, 400, (request) => request.promptVersion === "pr-review-brief-v1" ? brief
      : { action: "finish_review", summary: `${groupOf(request)} 已核对`, findings: [onFile(groupOf(request))] },
    (request) => request.promptVersion === "pr-review-v10" ? 40 - paths.indexOf(groupOf(request)) * 10 : 1);
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    expect(seen.most).toBe(3);
    expect(report).toMatchObject({ status: "completed", groups: 4, reviewedFiles: paths });
    expect(report.findings.map((finding) => finding.path)).toEqual(paths);
    const listed = paths.map((path) => report.summary.indexOf(`- ${path}：${path} 已核对`));
    expect(listed.every((at, index) => at >= 0 && (index === 0 || at > listed[index - 1]!))).toBe(true);
    // Each group's conclusion apart, for the page to list; in the text, what was found before how much was covered.
    expect(report.overview).toBe("四个模块各加一组常量。");
    expect(report.conclusions).toEqual(paths.map((path) => ({ label: path, text: `${path} 已核对` })));
    expect(report.summary.indexOf("分 4 组")).toBeGreaterThan(listed.at(-1)!);
    // Groups at work together say which one a step is from, and none waits on another's conclusion.
    expect(report.history.some((event) => event.group === 1 && event.message === "第 1 次调用模型完成")).toBe(true);
    expect(seen.requests.filter((request) => request.promptVersion === "pr-review-v10").every((request) => JSON.parse(request.userPrompt.split("\n最近步骤")[0]!).previous === "")).toBe(true);
  });

  it("reviews a local model's groups one at a time, each told what the ones before it concluded", async () => {
    const { service, view, seen } = await serviceOver(["src/a.ts", "src/b.ts"], 30, (request) => ({ action: "finish_review", summary: `${groupOf(request)} 已核对`, findings: [] }));
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report).toMatchObject({ status: "completed", groups: 2 });
    expect(seen.most).toBe(1);
    expect(JSON.parse(seen.requests[1]!.userPrompt.split("\n最近步骤")[0]!).previous).toBe("src/a.ts：src/a.ts 已核对");
    expect(report.history.some((event) => event.group === 0 && event.message === "第 1 次调用模型完成")).toBe(true);
  });

  it("starts no more groups once one fails, and keeps what the groups already at work found", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const { service, view, seen } = await serviceOver(paths, 400, (request) => request.promptVersion === "pr-review-brief-v1" ? brief
      : groupOf(request) === "src/a.ts" ? new ProfiledModelGatewayError("凭据不可用", "authentication_failed")
      : { action: "finish_review", summary: `${groupOf(request)} 已核对`, findings: [onFile(groupOf(request))] },
    (request) => request.promptVersion === "pr-review-v10" && groupOf(request) !== "src/a.ts" ? 20 : 1);
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    expect(report.status).toBe("failed");
    expect(seen.requests.filter((request) => request.promptVersion === "pr-review-v10").map(groupOf)).not.toContain("src/d.ts");
    expect(report.reviewedFiles).toEqual(["src/b.ts", "src/c.ts"]);
    expect(report.findings.map((finding) => finding.path)).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("gives a remote model each decision whole and leaves more matches to it, saying neither to the reader", async () => {
    const test = setup([]);
    const body = `请求超时后取消实际调用。${"细节".repeat(1_400)}结尾标记`;
    const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: 7, skipped: 0 }], documents: Array.from({ length: 7 }, (_, index) => ({
      source: "summarize" as const, kind: "historical_decision" as const, id: `DEC-${index + 1}`, title: `请求超时 ${index + 1}`, project: "app", status: "accepted", created: "2026-09-01", summary: "请求超时后必须释放资源", appliesWhen: "请求取消", caution: "后台任务另议",
      tags: [], supersedes: [], supersededBy: [], relativePath: `summarize/DEC-${index + 1}.md`, client: "codex", sessionId: null, body, bodyStartLine: 1, contentHash: String(index).repeat(64),
    })) }) });
    const requests: StructuredGenerationRequest[] = [];
    const service = new PrReviewService({ searchDecisions: context.search.bind(context), createClient: async () => test.client, gateway: {
      listGenerationProfiles: async () => [remote],
      generate: async (request, parse) => {
        requests.push(request);
        const action = { action: "finish_review", summary: "已核对", findings: [] };
        return { requestId: request.requestId, attemptId: randomUUID(), profileId: "remote", backend: "openai-compatible", provider: "remote", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
      },
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    // Both stood under nearly every review: a record whose excerpt ran past the cap, and a search that found more than
    // the five it returns. The conditions are whole; only the excerpt gives way, and the model is told so.
    expect(report.warnings.filter((warning) => /超出预算|超过单次返回上限/u.test(warning))).toEqual([]);
    const request = requests.find((item) => item.promptVersion === "pr-review-v10")!;
    expect(request.userPrompt).toContain('"moreMatches":true');
    expect(request.userPrompt).toContain('"excerptTruncated":true');
    expect(request.userPrompt).toContain("后台任务另议");
    expect(request.userPrompt).not.toContain("结尾标记");
    // The model reads what these mean where it reads its tools: the system prompt (tool descriptions never reach it).
    expect(request.systemPrompt).toMatch(/moreMatches 为 true[\s\S]*excerptTruncated/u);
  });

  it("reviews a PR of thousands of files, its brief and overview prompts within budget and still holding diff lines", async () => {
    const paths = Array.from({ length: 3_000 }, (_, index) => `src/module-${index}/file.ts`);
    const { service, view, seen } = await serviceOver(paths, 1, (request) => request.promptVersion === "pr-review-brief-v1" ? brief
      : request.promptVersion === "pr-review-describe-final-v1" ? { type: "新功能", summary: "各模块加常量。", focus: [] }
      : request.promptVersion === "pr-review-describe-chunk-v1" ? { walkthrough: [{ files: ["src/module-0/file.ts"], change: "新增常量" }], summary: "常量" }
      : { action: "finish_review", summary: "已核对", findings: [] }, () => 0);
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    expect({ status: report.status, warnings: report.warnings }).toEqual({ status: "completed", warnings: ["PR 的变更文件达到读取上限 3000 个，超出的文件（如有）没有读取，不计为已审查。"] });
    expect(report.reviewedFiles).toHaveLength(3_000);
    await service.followUp({ runId: randomUUID(), profileId: "remote", snapshot: view, excerpts: "", messages: [], question: "按 PR 概览格式回答", command: "describe" });
    const prompts = seen.requests.filter((request) => /^pr-review-(?:brief|describe)/u.test(request.promptVersion));
    expect(new Set(prompts.map((request) => request.promptVersion))).toEqual(new Set(["pr-review-brief-v1", "pr-review-describe-chunk-v1", "pr-review-describe-final-v1"]));
    // All 3,000 names went in whole, past the whole budget, before a line of diff.
    expect(Math.max(...prompts.map((request) => request.userPrompt.length))).toBeLessThanOrEqual(100_000);
    expect(prompts.filter((request) => request.promptVersion !== "pr-review-describe-final-v1").every((request) => request.userPrompt.includes("+export const value0"))).toBe(true);
  });

  it("reviews the other groups when one fails on its own, and names that one", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const { service, view } = await serviceOver(paths, 400, (request) => request.promptVersion === "pr-review-brief-v1" ? brief
      // The first group's answers are of the wrong shape each time, asked once more included.
      : groupOf(request) === "src/a.ts" ? new Error("输出不符合 Schema")
      : { action: "finish_review", summary: `${groupOf(request)} 已核对`, findings: [] });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    // One bad group stopped them all, and failed a review of the whole PR.
    expect(report.status).toBe("incomplete");
    expect(report.reviewedFiles).toEqual(["src/b.ts", "src/c.ts"]);
    expect(report.warnings).toContain("第 1 组（src/a.ts）没能评完，其余各组照常评审。");
  });

  it("keeps where a read of another file's change sits, at its first change, for the page to open it there", async () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const done = { action: "finish_review", summary: "已核对", findings: [] };
    // Each file a group of its own: the first group's reviewer reads the second file's change.
    const test = setup([{ action: "read_diff", path: "src/b.ts" }, done, done]);
    vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => added(path, 40)).join(""));
    const report = await test.run();
    const read = report.history.find((event) => event.kind === "tool" && event.message.startsWith("读取 src/b.ts 的变更"));
    expect(read).toMatchObject({ code: { path: "src/b.ts", side: "new", line: 1, view: "diff" } });
    expect(read?.detail).toMatch(/^-\/1 \+export const value0/u);
  });

  it("fits a group near a remote model's unit, with the code around its hunks and a long description, rather than failing it", async () => {
    // A modified file of 290 hunks, each a context line and a changed one ten source lines apart: a little under a group.
    const manyHunks = (path: string) => {
      const text = (i: number) => `const value${i} = "${"x".repeat(20)}";`;
      const body = Array.from({ length: 290 }, (_, i) => `@@ -${i * 10 + 5},2 +${i * 10 + 5},2 @@\n ${text(i * 10 + 5)}\n-${text(i * 10 + 6)}\n+${text(i * 10 + 6)}//changed`).join("\n");
      const source = Array.from({ length: 2_910 }, (_, i) => `${text(i + 1)}${(i + 1) % 10 === 6 ? "//changed" : ""}`).join("\n");
      return { diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`, source };
    };
    const a = manyHunks("src/a.ts"), b = manyHunks("src/b.ts");
    const test = setup([]);
    const requests: StructuredGenerationRequest[] = [];
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: {
      listGenerationProfiles: async () => [remote],
      generate: async (request, parse) => {
        requests.push(request);
        const action = request.promptVersion === "pr-review-brief-v1"
          // Long enough that the group, its diff counted as escaped, still needs the brief cut.
          ? { summary: "两个模块各改了 290 处。".padEnd(1_500, "梗"), areas: [{ files: ["src/a.ts"], change: "改 a".padEnd(400, "改") }, { files: ["src/b.ts"], change: "改 b".padEnd(400, "改") }], risks: [] }
          : { action: "finish_review", summary: "已核对", findings: [] };
        return { requestId: request.requestId, attemptId: randomUUID(), profileId: "remote", backend: "openai-compatible", provider: "remote", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
      },
    } });
    test.get.mockResolvedValue({ ...pr, description: "描述".repeat(2_000) });
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "modified" }]);
    vi.mocked(test.client.diff).mockResolvedValue(a.diff + b.diff);
    // The repository keeps no guides, as setup()'s does not.
    vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) => {
      if (GUIDE.test(path)) throw new PrPlatformError(404);
      return path === "src/a.ts" ? a.source : b.source;
    });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "" });
    // Every group of such a PR failed with "PR 上下文过大", before a model was asked.
    expect(report).toMatchObject({ status: "completed", groups: 2, reviewedFiles: ["src/a.ts", "src/b.ts"] });
    expect(requests.filter((request) => request.promptVersion === "pr-review-v10")).toHaveLength(2);
    expect(requests.filter((request) => request.promptVersion === "pr-review-v10").every((request) => request.userPrompt.split("\n最近步骤")[0]!.length <= 70_000)).toBe(true);
    // The description and brief gave way, the code around each hunk stayed: a context line from before the first hunk.
    expect(report.warnings).toContain("本组内容较多，PR 描述与梗概只纳入了开头。");
    expect(report.warnings.filter((warning) => warning.startsWith("本组内容较多"))).toHaveLength(1);
    expect(requests.find((request) => request.promptVersion === "pr-review-v10")!.userPrompt).toContain('2/2  const value2 = ');
  });

  it("counts a selection's groups as the review packs them, a test without its source included", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }, { action: "finish_review", summary: "已核对", findings: [] }, { action: "finish_review", summary: "已核对", findings: [] }]);
    const files = [["src/a.ts", 10], ["test/a.test.ts", 20], ["src/b.ts", 40], ["src/c.ts", 20]] as const;
    vi.mocked(test.client.files).mockResolvedValue(files.map(([path]) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(files.map(([path, lines]) => added(path, lines)).join(""));
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    // Its source not picked, the test goes after the rest in the review; counted in the whole PR's order, it did not.
    const chosen = ["test/a.test.ts", "src/b.ts", "src/c.ts"];
    const report = await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", paths: chosen });
    expect(report.status).toBe("completed");
    expect(plannedGroups(view, chosen, prReviewUnitChars("qwen"))).toBe(report.groups);
  });

  it("stops the groups not yet begun when the platform refuses, and says how many", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    vi.mocked(test.client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
    vi.mocked(test.client.diff).mockResolvedValue(paths.map((path) => added(path, 40)).join(""));
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    // The token gone mid-review: every group would meet it, each named as if it had failed on its own.
    test.get.mockRejectedValue(new PrPlatformError(401));
    const report = await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.status).toBe("failed");
    expect(report.warnings).toContain("另有 2 组因此没有开始评审。");
    expect(report.warnings.filter((warning) => warning.includes("没能评完"))).toEqual([]);
  });

  it("verifies what one reviewer of a deep review found when the other failed on its own", async () => {
    const { service, view, seen } = await serviceOver(["src/a.ts"], 30, (request) => request.systemPrompt.includes("你只核对两类问题") && !request.promptVersion.startsWith("pr-review-verify")
      ? new Error("输出不符合 Schema")
      : { action: "finish_review", summary: "已核对", findings: [onFile("src/a.ts")] });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "remote", focus: "", depth: "deep" });
    // The one group counted as failed whole: its other reviewer's finding went into the report unverified.
    expect(report.status).toBe("incomplete");
    expect(report.findings.map((finding) => finding.path)).toEqual(["src/a.ts"]);
    expect(seen.requests.some((request) => request.promptVersion.startsWith("pr-review-verify"))).toBe(true);
    expect(report.warnings).toContain("第 1 组（src/a.ts）没能评完。");
  });

  it("writes a large PR's overview chunk by chunk at once with a remote model, in the chunks' order", async () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const { service, view, seen } = await serviceOver(paths, 400, (request) => request.promptVersion === "pr-review-describe-final-v1"
      ? { type: "新功能", summary: "三个模块各加一组常量。", focus: [] }
      : { walkthrough: [{ files: JSON.parse(request.userPrompt).files, change: `${JSON.parse(request.userPrompt).files[0]} 新增常量` }], summary: "常量" },
    (request) => request.promptVersion === "pr-review-describe-chunk-v1" ? 30 - paths.indexOf(JSON.parse(request.userPrompt).files[0]) * 10 : 1);
    const result = await service.followUp({ runId: randomUUID(), profileId: "remote", snapshot: view, excerpts: "", messages: [], question: "按 PR 概览格式回答", command: "describe" });
    expect(seen.most).toBe(3);
    const rows = paths.map((path) => result.answer.indexOf(`| \`${path}\` | ${path} 新增常量 |`));
    expect(rows.every((at, index) => at >= 0 && (index === 0 || at > rows[index - 1]!))).toBe(true);
  });
});

describe("rate limits", () => {
  const limited = () => new ModelProviderError("rate_limited", "Model API returned HTTP 429");
  const serviceWith = (test: ReturnType<typeof setup>, retryAfterMs: number, gateway = test.gateway) =>
    new PrReviewService({ gateway, searchDecisions: test.search, createClient: async () => test.client, retryAfterMs });
  const runOn = async (service: PrReviewService, runId = randomUUID()) => {
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    return service.run({ snapshotId: view.snapshotId, runId, profileId: "local", focus: "" });
  };

  it("waits a rate limit out before a group tries again, and says so", async () => {
    const test = setup([limited(), { action: "finish_review", summary: "已核对", findings: [] }]);
    const report = await runOn(serviceWith(test, 1));
    expect(report.status).toBe("completed");
    expect(report.steps).toBe(2);
    expect(report.history.some((event) => /^服务限流，\d+ 秒后保留已读进度重试（1\/2）$/u.test(event.message))).toBe(true);
  });

  it("gives the next model turn its own retries and keeps the source already read", async () => {
    const timeout = () => new ModelProviderError("timeout", "deadline");
    const test = setup([timeout(), timeout(), { action: "read_file", path: "src/request.ts", startLine: 1 },
      timeout(), { action: "finish_review", summary: "已核对", findings: [] }]);
    const report = await runOn(serviceWith(test, 1));
    expect(report.status).toBe("completed");
    expect(report.steps).toBe(5);
    expect(test.readFile).toHaveBeenCalledTimes(1);
    expect(test.requests[4]!.userPrompt).toContain("changed();");
    expect(report.history.filter((event) => event.kind === "retry").map((event) => event.message)).toEqual([
      "保留已读进度重试（1/2）", "保留已读进度重试（2/2）", "保留已读进度重试（1/2）",
    ]);
  });

  it.each(["timeout", "network_error"] as const)("retries a transient %s on the final direct review", async (code) => {
    const failure = () => new ModelProviderError(code, "temporary failure");
    const test = setup([failure(), failure(), failure(), failure(), { summary: "已核对", findings: [] }]);
    const report = await runOn(serviceWith(test, 1));
    expect(report.status).toBe("completed");
    expect(test.requests.filter((request) => request.promptVersion === "pr-review-direct-v1")).toHaveLength(2);
    expect(report.reviewedFiles).toEqual(["src/request.ts"]);
  });

  it("waits a rate limit out on a verification too, instead of leaving the findings unchecked", async () => {
    const test = setup([{ action: "finish_review", summary: "一处问题", findings: [finding] }]);
    let refused = false;
    const report = await runOn(serviceWith(test, 1, { listGenerationProfiles: test.gateway.listGenerationProfiles, generate: async (request, parse, signal, profileId) => {
      if (request.promptVersion.startsWith("pr-review-verify") && !refused) { refused = true; throw limited(); }
      return test.gateway.generate(request, parse, signal, profileId);
    } }));
    expect(refused).toBe(true);
    expect(report.findings).toEqual([finding]);
    expect(report.warnings.some((warning) => warning.includes("没能完成核验"))).toBe(false);
    expect(report.history.some((event) => event.message === "核验候选问题 1/1" && event.status === "done")).toBe(true);
  });

  it("stops at once when stopped while waiting a rate limit out", async () => {
    const test = setup([limited(), { action: "finish_review", summary: "已核对", findings: [] }]);
    const service = serviceWith(test, 60_000);
    const runId = randomUUID();
    const running = runOn(service, runId);
    // The first call was refused: the group is waiting its minute out when it is stopped.
    await vi.waitFor(() => expect(test.requests).toHaveLength(1));
    service.cancel(runId);
    const report = await running;
    expect(report.status).toBe("cancelled");
    expect(test.requests).toHaveLength(1);
    // The refused call reads as stopped, not as about to be tried again.
    expect(report.history.find((event) => event.kind === "model")).toMatchObject({ status: "cancelled", message: "模型调用已停止" });
  });
});

describe("findings turned down before", () => {
  const turnedDown = { title: "请求仍未取消", body: "超时时仍在执行。", path: "src/request.ts", reason: "有意为之：超时由上层统一取消。" };
  const reviewWith = async (actions: unknown[], dismissed: Array<typeof turnedDown>) => {
    const test = setup(actions);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    return { test, report: await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", dismissed }) };
  };

  it("tells the reviewer and the verification what the reviewer turned down, and sets aside a candidate like one", async () => {
    const { test, report } = await reviewWith([{ action: "finish_review", summary: "一处问题", findings: [finding] },
      { verdicts: [{ id: 1, score: 0, reason: "与不采纳的「请求仍未取消」同类，那条的原因同样适用。" }] }], [turnedDown]);
    const reviewer = test.requests.find((request) => request.promptVersion === "pr-review-v10")!;
    expect(reviewer.systemPrompt).toContain("dismissedFindings 是评审者以前在这个仓库不采纳的问题和原因");
    expect(JSON.parse(reviewer.userPrompt.split("\n最近步骤")[0]!).dismissedFindings).toEqual([turnedDown]);
    const verify = test.requests.find((request) => request.promptVersion === "pr-review-verify-v3")!;
    expect(verify.systemPrompt).toContain("时给 0 分");
    expect(JSON.parse(verify.userPrompt).dismissedFindings).toEqual([turnedDown]);
    expect(report.findings).toEqual([]);
    expect(report.filtered).toEqual([{ finding, score: 0, reason: "与不采纳的「请求仍未取消」同类，那条的原因同样适用。" }]);
  });

  it("gives a local model the five latest, each body cut short", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ ...turnedDown, title: `问题 ${index}`, body: "长".repeat(1_000) }));
    const { test } = await reviewWith([{ action: "finish_review", summary: "已核对", findings: [] }], many);
    const sent = JSON.parse(test.requests[0]!.userPrompt.split("\n最近步骤")[0]!).dismissedFindings as Array<typeof turnedDown>;
    expect(sent.map((item) => item.title)).toEqual(["问题 0", "问题 1", "问题 2", "问题 3", "问题 4"]);
    expect(sent[0]!.body).toHaveLength(300);
  });

  it("leaves a local verification's diffs a third of the prompt, the oldest turned-down findings left out first", async () => {
    const candidates = ["甲", "乙", "丙"].map((title) => ({ ...finding, title, body: "证".repeat(2_000), decisionIndexes: [] }));
    const test = setup([{ action: "finish_review", summary: "三处问题", findings: candidates }]);
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client, gateway: test.gateway,
      loadRules: async () => ({ instructions: `## Ruleset 1\n\n${"规".repeat(2_900)}`, rules: [{ id: "long.md", source: "decision" as const }], warnings: [] }) });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const long = Array.from({ length: 5 }, (_, index) => ({ title: `不采纳 ${index} ${"题".repeat(190)}`, body: "长".repeat(300), path: "src/request.ts", reason: "因".repeat(500) }));
    await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", dismissed: long });
    const { diffs, ...said } = JSON.parse(test.requests.find((request) => request.promptVersion === "pr-review-verify-v3")!.userPrompt);
    expect(diffs).toBeDefined();
    expect(JSON.stringify(said).length).toBeLessThanOrEqual(19_000 * 2 / 3);
    const kept = (said.dismissedFindings as typeof long).map((item) => item.title);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(long.slice(0, kept.length).map((item) => item.title));
    expect(kept.length).toBeLessThan(5);
  });

  it("says nothing of it when nothing was turned down", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    await test.run();
    expect(test.requests[0]!.userPrompt).not.toContain("dismissedFindings");
  });
});

describe("findings published before", () => {
  const posted = { title: "超时后没有释放连接", path: "src/request.ts" };
  const reviewWith = async (actions: unknown[], published: Array<typeof posted>) => {
    const test = setup(actions);
    const view = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    return { test, report: await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", published }) };
  };

  it("tells the reviewer and the verification what the reviewer put on PRs as comments, the team caring about its like", async () => {
    const { test, report } = await reviewWith([{ action: "finish_review", summary: "一处问题", findings: [finding] },
      { verdicts: [{ id: 1, score: 85, reason: "与发布过的「超时后没有释放连接」同类，第 2 行确实没有取消。" }] }], [posted]);
    const reviewer = test.requests.find((request) => request.promptVersion === "pr-review-v10")!;
    expect(reviewer.systemPrompt).toContain("publishedFindings 是评审者以前在这个仓库发布成 PR 评论的问题");
    expect(JSON.parse(reviewer.userPrompt.split("\n最近步骤")[0]!).publishedFindings).toEqual([posted]);
    const verify = test.requests.find((request) => request.promptVersion === "pr-review-verify-v3")!;
    expect(verify.systemPrompt).toContain("不要只因为它像吹毛求疵或影响小而给低分");
    expect(JSON.parse(verify.userPrompt).publishedFindings).toEqual([posted]);
    expect(report.findings).toEqual([finding]);
  });

  it("gives a local model the five latest, and says nothing of it when nothing was published", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ ...posted, title: `问题 ${index}` }));
    const { test } = await reviewWith([{ action: "finish_review", summary: "已核对", findings: [] }], many);
    const sent = JSON.parse(test.requests[0]!.userPrompt.split("\n最近步骤")[0]!).publishedFindings as Array<typeof posted>;
    expect(sent.map((item) => item.title)).toEqual(["问题 0", "问题 1", "问题 2", "问题 3", "问题 4"]);
    const none = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    await none.run();
    expect(none.requests[0]!.userPrompt).not.toContain("publishedFindings");
  });
});

describe("repository guides", () => {
  const connectionId = "00000000-0000-4000-8000-000000000001";

  it("reads the root guides at the source commit, follows an import, and gives them to the reviewer and the verifier", async () => {
    const test = setup([{ action: "finish_review", summary: "一处问题", findings: [finding] }]);
    vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) =>
      path === "CLAUDE.md" ? "@AGENTS.md\n" : path === "AGENTS.md" ? "## 命名\n\n函数名用动词开头。" : "const timeout = 100;\nchanged();");
    const view = await test.service.load({ connectionId, reference: "AI/app#1" });
    // CLAUDE.md only imports AGENTS.md: read once, said once.
    expect(view.guides).toEqual(["AGENTS.md"]);
    await test.service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    const [review, verify] = ["pr-review-v10", "pr-review-verify-v3"].map((version) => test.requests.find((request) => request.promptVersion === version)!);
    expect(review!.userPrompt).toContain("函数名用动词开头");
    expect(verify!.userPrompt).toContain("函数名用动词开头");
    // Claude Code's: what a rule names but the code silences is no finding, and a nearby comment's constraint is a rule too.
    expect(review!.systemPrompt).toContain("代码里显式忽略的");
    expect(review!.systemPrompt).toContain("改动违反它也算问题");
    expect(verify!.systemPrompt).toContain("代码里显式忽略的");
  });

  // A local model's prompts are small: 3,000 characters of guides and as many of rules leave little room.
  const tight = (documents: number, actions: (request: StructuredGenerationRequest) => unknown, client: PrReviewClient) => {
    const requests: StructuredGenerationRequest[] = [];
    const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: documents, skipped: 0 }], documents: Array.from({ length: documents }, (_, index) => ({
      source: "summarize" as const, kind: "historical_decision" as const, id: `DEC-${index + 1}`, title: `请求超时 ${index + 1}`, project: "app", status: "accepted", created: "2026-09-01", summary: "请求超时后必须释放资源", appliesWhen: null, caution: null,
      tags: [], supersedes: [], supersededBy: [], relativePath: `summarize/DEC-${index + 1}.md`, client: "codex", sessionId: null, body: `DEC-${index + 1} 的来源原文：${"正".repeat(3_000)}`, bodyStartLine: 1, contentHash: String(index).repeat(64),
    })) }) });
    const service = new PrReviewService({ searchDecisions: context.search.bind(context), createClient: async () => client,
      loadRules: async () => ({ instructions: `## Ruleset 1\n\n${"规".repeat(2_980)}`, rules: [{ id: "r.md", source: "decision" as const }], warnings: [] }),
      gateway: { listGenerationProfiles: async () => [profile], generate: async (request, parse) => {
        requests.push(request);
        const action = request.promptVersion.startsWith("pr-review-verify")
          ? { verdicts: (JSON.parse(request.userPrompt).candidates as Array<{ id: number }>).map(({ id }) => ({ id, score: 90, reason: "成立。" })) }
          : actions(request);
        return { requestId: request.requestId, attemptId: randomUUID(), profileId: "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
      } } });
    return { service, requests };
  };
  // Each line a whole rule of two sentences, its exception in the long second one (where a cut almost surely lands):
  // "不要直连数据库。" without "除非…。" says the opposite.
  const longGuides = Array.from({ length: 200 }, (_, index) => `${index + 1}. 不要直连数据库。除非是迁移脚本或测试夹具，且在 PR 描述中写明原因与回滚方式，已在评审规则里登记过例外。`).join("\n");

  it("gives a group's room to what the reviewer dismissed before the guides, and cuts the guides at a whole line", async () => {
    const test = setup([]);
    const lines = Array.from({ length: 50 }, (_, index) => `export const value${index} = compute(${index}); // 填充`);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/big.ts", status: "added" }]);
    vi.mocked(test.client.diff).mockResolvedValue(`diff --git a/src/big.ts b/src/big.ts\n--- /dev/null\n+++ b/src/big.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`);
    vi.mocked(test.client.get).mockResolvedValue({ ...pr, description: "述".repeat(1_000) });
    vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) => (path === "CLAUDE.md" ? longGuides : lines.join("\n")));
    const { service, requests } = tight(1, () => ({ action: "finish_review", summary: "已核对", findings: [] }), test.client);
    const dismissed = Array.from({ length: 5 }, (_, index) => ({ title: `以前不采纳的问题 ${index}`, body: "体".repeat(300), path: "src/big.ts", reason: "由".repeat(200) }));
    const view = await service.load({ connectionId, reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", dismissed });
    const said = JSON.parse(requests.find((request) => request.promptVersion === "pr-review-v10")!.userPrompt.split("\n最近步骤")[0]!) as { dismissedFindings?: unknown[]; repoGuides?: string };
    // Ahead of them, the guides took the room of one: the reviewer raised it again.
    expect(said.dismissedFindings).toHaveLength(5);
    expect(said.repoGuides).toMatch(/登记过例外。$/u);
    expect(report.warnings).toContain("仓库规范较长，本组只纳入了前一部分。");
  });

  it("cuts guides written as one long paragraph at a sentence, not down to their heading", async () => {
    const test = setup([]);
    vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) =>
      (path === "CLAUDE.md" ? longGuides.replaceAll("\n", "") : "const timeout = 100;\nchanged();"));
    const { service, requests } = tight(1, () => ({ action: "finish_review", summary: "已核对", findings: [] }), test.client);
    const view = await service.load({ connectionId, reference: "AI/app#1" });
    await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    const said = JSON.parse(requests.find((request) => request.promptVersion === "pr-review-v10")!.userPrompt.split("\n最近步骤")[0]!) as { repoGuides?: string };
    // Cut at its last line break, only "## CLAUDE.md" was left of it.
    expect(said.repoGuides).toMatch(/^## CLAUDE\.md\n\n1\. 不要.+。$/su);
  });

  it("cuts guides that open with many headings without holding the process", async () => {
    const test = setup([]);
    // Markdown's two trailing spaces after each heading: a pattern for "only headings" took minutes over thirty of them.
    vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) =>
      (path === "CLAUDE.md" ? `${"## 约定  \n".repeat(30)}${longGuides}` : "const timeout = 100;\nchanged();"));
    const { service, requests } = tight(1, () => ({ action: "finish_review", summary: "已核对", findings: [] }), test.client);
    const view = await service.load({ connectionId, reference: "AI/app#1" });
    const started = performance.now();
    await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    // Minutes before; a margin for a loaded machine.
    expect(performance.now() - started).toBeLessThan(10_000);
    const said = JSON.parse(requests.find((request) => request.promptVersion === "pr-review-v10")!.userPrompt.split("\n最近步骤")[0]!) as { repoGuides?: string };
    expect(said.repoGuides).toMatch(/登记过例外。$/u);
  });

  it("gives the verifier every decision its candidates cite ahead of the guides", async () => {
    const test = setup([]);
    vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path) => (path === "CLAUDE.md" ? longGuides : "const timeout = 100;\nchanged();"));
    const findings = (["超时未取消", "资源泄漏", "并发竞争"] as const).map((title, index) => ({
      priority: "P3", title, body: `${title}：${"体".repeat(800)}`, path: "src/request.ts", side: "new", line: 2, decisionIndexes: [index + 1],
    }));
    const { service, requests } = tight(3, () => ({ action: "finish_review", summary: "三处违反决策", findings }), test.client);
    const view = await service.load({ connectionId, reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.findings.map((item) => item.decisionIndexes)).toEqual([[1], [2], [3]]);
    const said = JSON.parse(requests.find((request) => request.promptVersion === "pr-review-verify-v3")!.userPrompt) as { decisions?: Array<{ index: number }>; repoGuides?: string };
    // Behind 3,000 characters of guides, the third was left out and its candidate scored as a matter of style.
    expect(said.decisions?.map((decision) => decision.index)).toEqual([1, 2, 3]);
    expect(said.repoGuides).toMatch(/登记过例外。$/u);
  });

  it("says so when the guides cannot be read, and reads them again on the next open", async () => {
    const test = setup([]);
    vi.mocked(test.client.readFileContent).mockRejectedValueOnce(new PrPlatformError(503));
    const first = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(first.warnings).toContain("读取仓库规范（根目录的 CLAUDE.md、AGENTS.md）失败，本次评审不参考仓库规范。");
    const second = await test.service.load({ connectionId, reference: "AI/app#1" });
    expect(second.warnings.some((warning) => warning.startsWith("读取仓库规范"))).toBe(false);
  });
});

describe("deep review", () => {
  it("sends two reviewers at each group at once, one for defects and one for the team's rules and decisions", async () => {
    const test = setup([]);
    const onRule = { priority: "P3" as const, title: "违反超时规则", body: "团队规则要求超时后释放资源（规则：超时必须取消底层请求）。", path: "src/request.ts", side: "old" as const, line: 2, decisionIndexes: [] };
    const queues: Record<"bugs" | "rules", unknown[]> = {
      bugs: [{ action: "finish_review", summary: "缺陷已核对", findings: [finding] }],
      rules: [{ action: "finish_review", summary: "规则已核对", findings: [onRule] }],
    };
    const requests: StructuredGenerationRequest[] = [];
    const service = new PrReviewService({ searchDecisions: test.search, createClient: async () => test.client,
      loadRules: async () => ({ instructions: "## Ruleset 1\n\n超时必须取消底层请求。", rules: [{ id: "timeout.md", source: "decision" as const }], warnings: [] }),
      gateway: {
        listGenerationProfiles: test.gateway.listGenerationProfiles,
        generate: async (request, parse, signal) => {
          signal?.throwIfAborted(); requests.push(request);
          // The two reviewers run at once: each takes its own answers, whichever asks first.
          const action = request.promptVersion.startsWith("pr-review-verify")
            ? { verdicts: (JSON.parse(request.userPrompt).candidates as Array<{ id: number }>).map(({ id }) => ({ id, score: 90, reason: "成立。" })) }
            : queues[request.systemPrompt.includes("你只核对两类问题") ? "rules" : "bugs"].shift();
          if (action === undefined) throw new Error("No actions");
          return { requestId: request.requestId, attemptId: randomUUID(), profileId: "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
        },
      } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", depth: "deep" });
    const reviewers = requests.filter((request) => request.promptVersion === "pr-review-v10");
    expect(reviewers.map((request) => request.systemPrompt.includes("你只找缺陷与安全问题") ? "bugs" : "rules").sort()).toEqual(["bugs", "rules"]);
    // Only the rules reviewer judges a decision without a recorded scope for itself, rather than only raising it to check.
    expect(reviewers.filter((request) => request.systemPrompt.includes("不必只列为待核对事项")).map((request) => request.systemPrompt.includes("你只核对两类问题"))).toEqual([true]);
    expect(reviewers.every((request) => request.userPrompt.includes("超时必须取消底层请求"))).toBe(true);
    expect(report).toMatchObject({ status: "completed", depth: "deep", groups: 1, steps: 3, reviewedFiles: ["src/request.ts"] });
    expect(report.findings).toEqual(expect.arrayContaining([finding, onRule]));
    expect(report.summary).toContain("每组两位审查者（缺陷；规则与决策）");
    expect(report.summary).toContain("（缺陷）：缺陷已核对");
    expect(report.summary).toContain("（规则与决策）：规则已核对");
  });

  it("lets only the rules reviewer read what other projects decided, after this project's own, unless a recorded scope keeps it out", async () => {
    const test = setup([]);
    // DEC-2 is filed under another project; DEC-3 too, with a scope recorded for it that leaves this one ("app") out.
    // DEC-4 and DEC-5 are filed under it with a scope of paths only: DEC-4's takes in the changed file, so only the
    // project it is filed under keeps it out, as with DEC-2; DEC-5's does not.
    const scope = (projects: string[], paths: string[] = []) => ({ projects, repositoryIds: [], modules: [], layers: [], paths, excludedPaths: [], exceptions: [] });
    const scopes = [undefined, undefined, scope(["web"]), scope([], ["src"]), scope([], ["docs"])];
    const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: 5, skipped: 0 }], documents: (["app", "web", "web", "web", "web"] as const).map((project, index) => ({
      source: "summarize" as const, kind: "historical_decision" as const, id: `DEC-${index + 1}`, title: `请求超时 ${index + 1}`, project, status: "accepted", created: "2026-09-01", summary: "请求超时后必须释放资源", appliesWhen: null, caution: null,
      tags: [], supersedes: [], supersededBy: [], relativePath: `summarize/DEC-${index + 1}.md`, client: "codex", sessionId: null, body: "请求超时后取消实际调用", bodyStartLine: 1, contentHash: String(index).repeat(64),
      ...(scopes[index] ? { scope: scopes[index], scopeState: "current" as const } : {}),
    })) }) });
    const service = new PrReviewService({ searchDecisions: context.search.bind(context), createClient: async () => test.client, gateway: {
      listGenerationProfiles: test.gateway.listGenerationProfiles,
      generate: async (request, parse) => {
        const action = { action: "finish_review", summary: "已核对", findings: [] };
        return { requestId: request.requestId, attemptId: randomUUID(), profileId: "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
      },
    } });
    const view = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: "local", focus: "", depth: "deep" });
    const read = (lens: "bugs" | "rules") => report.history.filter((event) => event.lens === lens).flatMap((event) => event.decisions ?? [])
      .map((item) => `${item.id}${item.otherProject ? ` · ${item.otherProject}` : ""}`);
    expect(read("rules")).toEqual(["DEC-1", "DEC-2 · web", "DEC-4 · web"]);
    expect(read("bugs")).toEqual(["DEC-1"]);
  });

  it("keeps one reviewer per group unless asked", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    const report = await test.run();
    expect(test.requests.filter((request) => request.promptVersion === "pr-review-v10")).toHaveLength(1);
    expect(test.requests[0]!.systemPrompt).not.toContain("深度评审");
    expect(report.depth).toBeUndefined();
  });
});

describe("context around each hunk", () => {
  const source = ["import x from \"y\";", "", "export function run(value: number) {", ...Array.from({ length: 7 }, (_, i) => `  const v${i} = ${i};`),
    "  return compute(v0, v1);", "}", "", "export const other = 1;"].join("\n");
  const flowDiff = "diff --git a/src/flow.ts b/src/flow.ts\n--- a/src/flow.ts\n+++ b/src/flow.ts\n@@ -10,3 +10,3 @@\n   const v6 = 6;\n-  return old(v0);\n+  return compute(v0, v1);\n }\n";
  const onChange = { priority: "P2" as const, title: "compute 的参数顺序反了", body: "compute 期望 (b, a)。", path: "src/flow.ts", side: "new" as const, line: 11, decisionIndexes: [] };

  it("reads each hunk with the code around it, up to the function it sits in, and anchors findings on changed lines only", async () => {
    const test = setup([{ action: "finish_review", summary: "定位到上下文", findings: [{ ...onChange, line: 3 }] }, { action: "finish_review", summary: "已核对", findings: [onChange] }]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/flow.ts", status: "modified" }]);
    vi.mocked(test.client.diff).mockResolvedValue(flowDiff);
    vi.mocked(test.client.readFileContent).mockResolvedValue(source);
    const report = await test.run();
    expect(test.client.readFileContent).toHaveBeenCalledWith(pr, "src/flow.ts", "new", expect.any(AbortSignal));
    const lines = JSON.parse(test.requests[0]!.userPrompt.split("\n最近步骤")[0]!).currentDiff[0].lines as string[];
    expect(lines[0]).toBe("3/3  export function run(value: number) {");
    expect(lines).toContain("-/11 +  return compute(v0, v1);");
    // A context line is not part of the change: a finding there is sent back.
    expect(test.requests[1]!.userPrompt).toContain("问题必须定位到已读取");
    expect(report.findings).toEqual([onChange]);
    expect(report).toMatchObject({ status: "completed", readFiles: ["src/flow.ts"], reviewedFiles: ["src/flow.ts"] });
  });

  it("reviews the plain diff when a file cannot be read, and says so", async () => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    vi.mocked(test.client.readFileContent).mockRejectedValue(new PrPlatformError(404));
    const report = await test.run();
    expect(report.status).toBe("completed");
    expect(report.warnings).toContain("1 个文件没能读取源码，按原 diff 评审，没有补充上下文。");
    expect(report.warnings).toContain(`源码读取失败：src/request.ts：${new PrPlatformError(404).message}`);
    expect(vi.mocked(test.client.readFileContent).mock.calls.filter(([, path]) => path === "src/request.ts")).toHaveLength(1);
    expect(JSON.parse(test.requests[0]!.userPrompt.split("\n最近步骤")[0]!).currentDiff[0].lines).toEqual(["1/1  const timeout = 100;", "2/- -old();", "-/2 +changed();"]);
  });

  it.each([new PrPlatformError(503), new TypeError("fetch failed"), new DOMException("deadline", "TimeoutError"), new PrPlatformUnreachable("代码平台请求超时，请重试。")])("retries a transient source failure: %s", async (error) => {
    const test = setup([{ action: "finish_review", summary: "已核对", findings: [] }]);
    // The source file's first read fails; the guides read when the PR opens are not what is retried here.
    const read = vi.mocked(test.client.readFileContent).getMockImplementation()!;
    let failed = false;
    vi.mocked(test.client.readFileContent).mockImplementation(async (...args) => {
      if (args[1] === "src/request.ts" && !failed) { failed = true; throw error; }
      return read(...args);
    });
    const service = new PrReviewService({ gateway: test.gateway, searchDecisions: test.search, createClient: async () => test.client, retryAfterMs: 1 });
    const snapshot = await service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const report = await service.run({ snapshotId: snapshot.snapshotId, runId: randomUUID(), profileId: "local", focus: "" });
    expect(report.status).toBe("completed");
    expect(vi.mocked(test.client.readFileContent).mock.calls.filter(([, path]) => path === "src/request.ts")).toHaveLength(2);
    expect(report.warnings.some((warning) => warning.includes("源码"))).toBe(false);
  });

  it("lets a suggestion quote the code around a change, read for context", async () => {
    const test = setup([{ suggestions: [{ path: "src/flow.ts", line: 10, existingCode: "  const v6 = 6;\n  return compute(v0, v1);", improvedCode: "  const v6 = 6;\n  return compute(v1, v0);", title: "参数顺序", why: "compute 期望 (b, a)。", category: "正确性", importance: 8 }] },
      { scores: [{ id: 1, score: 9, reason: "修复了参数顺序。" }] }]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/flow.ts", status: "modified" }]);
    vi.mocked(test.client.diff).mockResolvedValue(flowDiff);
    vi.mocked(test.client.readFileContent).mockResolvedValue(source);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const result = await test.service.followUp({ runId: randomUUID(), profileId: "local", snapshot, excerpts: "", messages: [], question: "按代码建议格式回答", command: "improve" });
    expect(JSON.parse(test.requests[0]!.userPrompt).diff[0].lines[0]).toBe("3/3  export function run(value: number) {");
    expect(result.answer).toContain("`src/flow.ts:10` · 正确性 · 重要度 9/10（高）");
  });
});

describe("PR overview and suggestions", () => {
  const overviewOf = async (answers: unknown[], diff?: string, files?: Array<{ path: string; status: string }>, question = "按 PR 概览格式回答") => {
    const test = setup(answers);
    if (files) vi.mocked(test.client.files).mockResolvedValue(files);
    if (diff) vi.mocked(test.client.diff).mockResolvedValue(diff);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const result = await test.service.followUp({ runId: randomUUID(), profileId: "local", snapshot, excerpts: "", messages: [], question, command: "describe" });
    return { test, result };
  };

  it("writes the overview of a PR that fits in one call, with every file in its walkthrough", async () => {
    const { test, result } = await overviewOf([{ type: "缺陷修复", summary: "超时后取消底层请求。", walkthrough: [{ files: ["src/request.ts"], change: "改为可取消的调用" }], focus: ["src/request.ts：取消后是否清理计时器"] }],
      `${patch}diff --git a/docs/notes.md b/docs/notes.md\n--- a/docs/notes.md\n+++ b/docs/notes.md\n@@ -1 +1 @@\n-旧说明\n+新说明\n`,
      [{ path: "src/request.ts", status: "modified" }, { path: "docs/notes.md", status: "modified" }], "按 PR 概览格式回答\n补充要求：重点说明接口");
    expect(test.requests).toHaveLength(1);
    expect(JSON.parse(test.requests[0]!.userPrompt)).toMatchObject({ requirement: "重点说明接口", diffComplete: true });
    expect(result.answer).toContain("**类型**：缺陷修复");
    expect(result.answer).toContain("| `src/request.ts` | 改为可取消的调用 |");
    // The model left a file out; the table still lists it.
    expect(result.answer).toContain("| `docs/notes.md` | 未单独说明 |");
    expect(result.answer).toContain("- src/request.ts：取消后是否清理计时器");
  });

  it("describes a PR too large for one call chunk by chunk, then once over the chunks", async () => {
    const big = (path: string) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,120 @@\n${Array.from({ length: 120 }, (_, i) => `+export const value${i} = "${"x".repeat(60)}";`).join("\n")}\n`;
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const { test, result } = await overviewOf([
      ...paths.map((path) => ({ walkthrough: [{ files: [path], change: `${path} 新增常量` }], summary: `${path} 的常量` })),
      { type: "新功能", summary: "三个模块各加一组常量。", focus: [] },
    ], paths.map(big).join(""), paths.map((path) => ({ path, status: "added" })));
    expect(test.requests.map((request) => request.promptVersion)).toEqual(["pr-review-describe-chunk-v1", "pr-review-describe-chunk-v1", "pr-review-describe-chunk-v1", "pr-review-describe-final-v1"]);
    expect(test.requests.every((request) => request.userPrompt.length <= 19_000)).toBe(true);
    for (const path of paths) expect(result.answer).toContain(`| \`${path}\` | ${path} 新增常量 |`);
    expect(result.answer).toContain("**摘要**\n三个模块各加一组常量。");
  });

  it("suggests improvements that quote this change's own new code, scored and ranked", async () => {
    const test = setup([{ suggestions: [
      { path: "src/request.ts", line: 2, existingCode: "changed();", improvedCode: "changed(signal);", title: "把取消信号传下去", why: "超时后底层请求能真正停止。", category: "正确性", importance: 7 },
      { path: "src/request.ts", line: 5, existingCode: "invented();", improvedCode: "better();", title: "不存在的代码", why: "diff 里没有这一行。", category: "可读性", importance: 6 },
      { path: "src/request.ts", line: 1, existingCode: "const timeout = 100;", improvedCode: "const timeout = 200;", title: "改旧代码", why: "这一行没有改动。", category: "可维护性", importance: 6 },
    ] }, { scores: [{ id: 1, score: 8, reason: "修复了真实的泄漏。" }] }]);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const result = await test.service.followUp({ runId: randomUUID(), profileId: "local", snapshot, excerpts: "", messages: [], question: "按代码建议格式回答", command: "improve" });
    expect(test.requests.map((request) => request.promptVersion)).toEqual(["pr-review-improve-v1", "pr-review-reflect-v1"]);
    // Only the suggestion quoting this change's own code reaches the scoring.
    expect(JSON.parse(test.requests[1]!.userPrompt).suggestions).toHaveLength(1);
    expect(result.answer).toContain("### 1. 把取消信号传下去");
    expect(result.answer).toContain("`src/request.ts:2` · 正确性 · 重要度 8/10（中）");
    expect(result.answer).toContain("```diff\n-changed();\n+changed(signal);\n```");
    expect(result.usage).toEqual({ input: 0, output: 0, unreportedCalls: 2 });
  });

  it("leaves out suggestions scored under the bar", async () => {
    const test = setup([{ suggestions: [{ path: "src/request.ts", line: 2, existingCode: "changed();", improvedCode: "changed(); // 调用", title: "加注释", why: "说明用途。", category: "可读性", importance: 5 }] },
      { scores: [{ id: 1, score: 0, reason: "只加了注释。" }] }]);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const result = await test.service.followUp({ runId: randomUUID(), profileId: "local", snapshot, excerpts: "", messages: [], question: "按代码建议格式回答", command: "improve" });
    expect(result.answer).toBe("这次变更里没有找到值得提出的改进建议（1 条候选经复核打分不足 5 分）。");
  });

  it("keeps a question, and a re-evaluation, within the chosen model's prompt however large the PR", async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `+const value${i} = "${"x".repeat(40)}";`);
    const test = setup([{ answer: "已回答。" }, { verdict: "keep", reason: "成立。", replacement: null }]);
    test.get.mockResolvedValue({ ...pr, description: "描".repeat(20_000) });
    vi.mocked(test.client.diff).mockResolvedValue(`diff --git a/src/request.ts b/src/request.ts\n--- /dev/null\n+++ b/src/request.ts\n@@ -0,0 +1,2000 @@\n${lines.join("\n")}\n`);
    const snapshot = await test.service.load({ connectionId: "00000000-0000-4000-8000-000000000001", reference: "AI/app#1" });
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: "长".repeat(8_000) }));
    await test.service.followUp({ runId: randomUUID(), profileId: "local", snapshot, excerpts: "", messages, question: "这里为什么这样改？" });
    const asked = JSON.parse(test.requests[0]!.userPrompt);
    expect(test.requests[0]!.userPrompt.length).toBeLessThanOrEqual(19_000);
    expect(asked).toMatchObject({ contextTruncated: false, diffTruncated: true, earlierMessagesOmitted: 12 });
    // The PR's description is the start of it a local model's prompt takes, not 20,000 characters ahead of the review.
    expect(JSON.parse(asked.context).snapshot.description).toHaveLength(1_500);
    await test.service.reevaluate({ runId: randomUUID(), profileId: "local", snapshot, finding: { ...finding, priority: "P2" as const, side: "new" as const, line: 1, decisionIndexes: [] }, summary: "一处问题" });
    expect(test.requests[1]!.userPrompt.length).toBeLessThanOrEqual(19_000);
    expect(JSON.parse(test.requests[1]!.userPrompt)).toMatchObject({ fileDiffTruncated: true });
  });
});

describe("evidence past the cap", () => {
  const fileDiff = (path: string, prefix: string) => {
    const lines = Array.from({ length: 60 }, (_, index) => `+const ${prefix}${index} = "${"x".repeat(30)}";`);
    return `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,60 @@\n${lines.join("\n")}\n`;
  };

  it("keeps a finding whose cited decision falls past the 40-record cap, its reference removed and said so", async () => {
    const searches = (n: number) => ({ actions: Array.from({ length: 3 }, (_, index) => ({ action: "search_decisions", query: `问题 ${n}-${index}` })) });
    const onB = { priority: "P2", title: "b 文件的问题", body: "触发条件、影响与修复建议。", path: "src/b.ts", side: "new", line: 3, decisionIndexes: [1] };
    const test = setup([
      // Group 1 (src/a.ts): nine searches fill the evidence to the cap, then a clean conclusion.
      searches(1), searches(2), searches(3), { action: "finish_review", summary: "a 已核对", findings: [] },
      // Group 2 (src/b.ts): its only finding cites its own first record, which has no place left in the merged evidence.
      { action: "finish_review", summary: "b 有一处问题", findings: [onB] },
    ]);
    vi.mocked(test.client.files).mockResolvedValue([{ path: "src/a.ts", status: "added" }, { path: "src/b.ts", status: "added" }]);
    vi.mocked(test.client.diff).mockResolvedValue(fileDiff("src/a.ts", "a") + fileDiff("src/b.ts", "b"));
    const base = await test.search({ query: "请求超时", limit: 5, offset: 0, includeOutOfScope: false });
    const record = base.results[0]!;
    let counter = 0;
    // Every search answers with records never seen before: a rich journal, several searches per group.
    test.search.mockImplementation(async (query) => ({
      ...base, results: Array.from({ length: query.recordId ? 1 : query.limit }, () => ({ ...record, id: query.recordId ?? `DEC-${++counter}`, title: `决策 ${counter}` })),
    }));

    const report = await test.run();
    expect(report.groups).toBe(2);
    expect(report.evidence).toHaveLength(40);
    // Dropped whole, it was gone from a report whose summary still counted it.
    expect(report.findings).toEqual([{ ...onB, decisionIndexes: [] }]);
    expect(report.warnings).toContain("证据超过展示上限，部分问题的决策引用已去掉。");
    expect(report.status).toBe("incomplete");
    expect(report.summary).toContain("形成 1 条问题");
  });
});
