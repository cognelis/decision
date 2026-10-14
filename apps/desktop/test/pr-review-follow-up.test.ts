import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { modelProviderProfileSchema, prReviewReportSchema, type StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { ModelProviderError } from "../src/main/model/http-model-transport.js";
import { PrPlatformError, type PrReviewClient } from "../src/main/pr-platform-client.js";
import { PrReviewService } from "../src/main/pr-review-service.js";
import type { AssistantGatewayLike } from "../src/main/decision-assistant-service.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const pr = { title: "请求超时", description: "为请求添加超时", source: { repository: "~author/app", commit: "a".repeat(40) }, destination: { repository: "AI/app", commit: "b".repeat(40) } };
const local = modelProviderProfileSchema.parse({ version: 1, profileId: "local", kind: "qwen", model: "qwen3.5-2b-q4-k-m", label: "本机", enabled: true, priority: 0, timeoutMs: 30_000 });
const remote = modelProviderProfileSchema.parse({ version: 1, profileId: "remote", kind: "openai-compatible", model: "test-model", label: "远端", enabled: true, priority: 1,
  baseUrl: "https://llm.example.com/v1", apiProtocol: "chat-completions", credentialRef: "remote-key", timeoutMs: 30_000 });
const GUIDE = /^(CLAUDE|AGENTS)\.md$/u;

/** The fake service of pr-review.test.ts: the model answers from a queue, the platform from a stub. */
function setup(actions: unknown[], files: Array<{ path: string; status: string }>, diff: string, retryAfterMs?: number) {
  const client: PrReviewClient = { get: vi.fn(), files: vi.fn(), diff: vi.fn(), readFileContent: vi.fn(), readFile: vi.fn() };
  vi.spyOn(client, "get").mockResolvedValue(pr);
  vi.spyOn(client, "files").mockResolvedValue(files);
  vi.spyOn(client, "diff").mockResolvedValue(diff);
  vi.spyOn(client, "readFile").mockResolvedValue("");
  vi.spyOn(client, "readFileContent").mockImplementation(async (_pr, path) => { if (GUIDE.test(path)) throw new PrPlatformError(404); return ""; });
  const requests: StructuredGenerationRequest[] = [];
  const gateway: AssistantGatewayLike = {
    listGenerationProfiles: async () => [local, remote],
    generate: async (request, parse, signal, profileId) => {
      signal?.throwIfAborted(); requests.push(request);
      const action = actions.shift();
      if (action instanceof Error || action === undefined) throw action ?? new Error("No actions");
      return { requestId: request.requestId, attemptId: randomUUID(), profileId: profileId ?? "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
    },
  };
  const service = new PrReviewService({ gateway, searchDecisions: async () => ({ results: [], issues: [] }) as never, createClient: async () => client, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  return { client, service, requests, gateway };
}

const addedFile = (path: string, lines: string[]) => `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
/** A PR of `count` ordinary files, each with a two-line change: nothing unusual about it. */
const ordinaryPr = (count: number) => {
  const paths = Array.from({ length: count }, (_, index) => `src/components/feature-area/module-${index % 7}/file-${index}.ts`);
  return { files: paths.map((path) => ({ path, status: "modified" })), diff: paths.map((path) => addedFile(path, ["export const enabled = true;", "export const retries = 3;"])).join("") };
};
const finding = { priority: "P2" as const, title: "请求仍未取消", body: "超时时底层请求仍在执行，会占用连接；应把 AbortSignal 传入 fetch。", path: "src/components/feature-area/module-1/file-1.ts", side: "new" as const, line: 2, decisionIndexes: [] };
const reportOf = (summary: string) => {
  const { history: _history, ...report } = prReviewReportSchema.parse({ status: "completed", summary, findings: [finding], evidence: [], readFiles: [], unreadFiles: [], warnings: [], steps: 1 });
  return report;
};

describe("follow-up context keeps the review the question is about", () => {
  // The context is cut as one JSON prefix to 40% of the prompt. With the snapshot first, carrying every file's path, hunk
  // sizes, batch counts and digests, past a few dozen files on a local model (a few hundred on a remote one) the report —
  // summary, findings — and the excerpts fell off the end.
  it.each([
    ["local", 60],
    ["remote", 220],
  ])("asks the %s model about a finding of a %i-file PR with the finding and the summary in the prompt", async (profileId, count) => {
    const { files, diff } = ordinaryPr(count);
    const test = setup([{ answer: "已回答。" }], files, diff);
    const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });
    const report = reportOf("本次评审发现 1 处问题：超时后未取消请求。");
    // As the page sends them: the last steps' messages and details, up to 12,000 characters.
    const excerpts = Array.from({ length: 12 }, (_, index) => `读取源码 src/components/feature-area/module-1/file-${index}.ts 第 1–80 行\n${"const value = compute();\n".repeat(40)}`).join("\n").slice(-12_000);
    await test.service.followUp({ runId: randomUUID(), profileId, connectionId, snapshot, report, excerpts, focus: "只看请求取消",
      messages: [], question: `关于「${finding.title}」（${finding.path}:${finding.line}）：为什么说没有取消？` });
    const asked = JSON.parse(test.requests[0]!.userPrompt) as { context: string; contextTruncated: boolean };
    // The model is asked to "继续当前评审对话" about this finding: its body and the review's summary must be in what it reads,
    // and so must what the review was asked to look at and which PR it is; the steps' excerpts give way first.
    expect(asked.context).toContain(finding.body);
    expect(asked.context).toContain("超时后未取消请求");
    expect(asked.context).toContain("只看请求取消");
    expect(asked.context).toContain('"title":"请求超时"');
    expect(asked.context.indexOf('"excerpts"')).toBeGreaterThan(asked.context.indexOf('"snapshot"'));
  });
});

describe("re-evaluation reads the finding's own lines", () => {
  // Cut from its start to fit the prompt, a file's whole diff ended hundreds of lines before a finding deep in it. The
  // verification pass excerpts around each candidate, and so does this now.
  it("shows the model the line a finding is on when the file's diff is longer than the prompt", async () => {
    const lines = Array.from({ length: 600 }, (_, index) => `const value${index} = compute("${"x".repeat(40)}", ${index});`);
    const test = setup([{ verdict: "keep", reason: "成立。", replacement: null }], [{ path: "src/request.ts", status: "modified" }], addedFile("src/request.ts", lines));
    const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });
    const deep = { ...finding, path: "src/request.ts", line: 580 };
    await test.service.reevaluate({ runId: randomUUID(), profileId: "local", connectionId, snapshot, finding: deep, summary: "一处问题" });
    const asked = JSON.parse(test.requests[0]!.userPrompt) as { fileDiff: string; fileDiffTruncated: boolean };
    expect(asked.fileDiff).toContain("-/580 +const value579 =");
  });

  it("shows the start of the diff, and says so, for a line the diff does not hold", async () => {
    const lines = Array.from({ length: 600 }, (_, index) => `const value${index} = compute("${"x".repeat(40)}", ${index});`);
    const test = setup([{ verdict: "keep", reason: "成立。", replacement: null }], [{ path: "src/request.ts", status: "modified" }], addedFile("src/request.ts", lines));
    const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });
    // Raised at an earlier commit, on a line the file no longer reaches: no lines around it to show.
    await test.service.reevaluate({ runId: randomUUID(), profileId: "local", connectionId, snapshot, finding: { ...finding, path: "src/request.ts", line: 900 }, summary: "一处问题" });
    const asked = JSON.parse(test.requests[0]!.userPrompt) as { fileDiff: string; findingLineNotInDiff?: boolean; fileDiffExcerpt?: string };
    expect(asked.fileDiff).toContain("-/1 +const value0 =");
    expect(asked).toMatchObject({ findingLineNotInDiff: true });
    expect(asked.fileDiffExcerpt).toBeUndefined();
  });
});

describe("re-evaluation retries a transient failure as answers do", () => {
  const limited = () => new ModelProviderError("rate_limited", "Model API returned HTTP 429");
  it("waits a rate limit out and judges the finding, instead of ending 全部复评 at the first 429", async () => {
    const { files, diff } = ordinaryPr(2);
    const test = setup([limited(), { answer: "已回答。" }, limited(), { verdict: "keep", reason: "成立。", replacement: null }], files, diff, 1);
    const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });
    // A question survives one refusal.
    await expect(test.service.followUp({ runId: randomUUID(), profileId: "local", connectionId, snapshot, excerpts: "", messages: [], question: "改了什么？" })).resolves.toMatchObject({ answer: "已回答。" });
    // A re-evaluation of a finding, one call of the same shape, does not.
    await expect(test.service.reevaluate({ runId: randomUUID(), profileId: "local", connectionId, snapshot, finding: { ...finding, path: files[1]!.path }, summary: "一处问题" })).resolves.toMatchObject({ verdict: "keep" });
  });
});

describe("a large PR's overview keeps the chunks that were written", () => {
  it("still delivers the walkthrough when only the final call over the chunks fails", async () => {
    const big = (path: string) => addedFile(path, Array.from({ length: 120 }, (_, index) => `export const value${index} = "${"x".repeat(60)}";`));
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const test = setup([
      ...paths.map((path) => ({ walkthrough: [{ files: [path], change: `${path} 新增常量` }], summary: `${path} 的常量` })),
      new ModelProviderError("invalid_output", "not JSON"),
    ], paths.map((path) => ({ path, status: "added" })), paths.map(big).join(""));
    const snapshot = await test.service.load({ connectionId, reference: "AI/app#1" });
    const result = await test.service.followUp({ runId: randomUUID(), profileId: "local", connectionId, snapshot, excerpts: "", messages: [], question: "按 PR 概览格式回答", command: "describe" });
    expect(test.requests).toHaveLength(4);
    for (const path of paths) expect(result.answer).toContain(`| \`${path}\` | ${path} 新增常量 |`);
  });
});
