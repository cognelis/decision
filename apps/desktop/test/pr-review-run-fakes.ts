import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { modelProviderProfileSchema, type StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { PrPlatformError, type PrReviewClient } from "../src/main/pr-platform-client.js";
import { PrReviewService, type PrReviewServiceOptions } from "../src/main/pr-review-service.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import type { AssistantGatewayLike } from "../src/main/decision-assistant-service.js";

export const connectionId = "00000000-0000-4000-8000-000000000001";
export const pr = { title: "请求超时", description: "为请求添加超时", source: { repository: "~author/app", commit: "a".repeat(40) }, destination: { repository: "AI/app", commit: "b".repeat(40) } };
export const local = modelProviderProfileSchema.parse({ version: 1, profileId: "local", kind: "qwen", model: "qwen3.5-2b-q4-k-m", label: "本机", enabled: true, priority: 0, timeoutMs: 30_000 });
export const remote = modelProviderProfileSchema.parse({ version: 1, profileId: "remote", kind: "openai-compatible", model: "test-model", label: "远端", enabled: true, priority: 1,
  baseUrl: "https://llm.example.com/v1", apiProtocol: "chat-completions", credentialRef: "remote-key", timeoutMs: 30_000 });
const GUIDE = /^(CLAUDE|AGENTS)\.md$/u;

export const added = (path: string, lines: number, prefix = "value") =>
  `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+export const ${prefix}${i} = "${"x".repeat(60)}";`).join("\n")}\n`;

export const confirm = (request: StructuredGenerationRequest) =>
  ({ verdicts: (JSON.parse(request.userPrompt).candidates as Array<{ id: number }>).map(({ id }) => ({ id, score: 90, reason: "成立。" })) });

/** A fake platform, a real decision search over one record, and a model answering through `answer`. */
export function harness(paths: string[], diff: string, answer: (request: StructuredGenerationRequest, signal?: AbortSignal) => unknown | Promise<unknown>, extra: Partial<PrReviewServiceOptions> = {}) {
  const client: PrReviewClient = { get: vi.fn(), files: vi.fn(), diff: vi.fn(), readFileContent: vi.fn(), readFile: vi.fn() };
  vi.mocked(client.get).mockResolvedValue(pr);
  vi.mocked(client.files).mockResolvedValue(paths.map((path) => ({ path, status: "added" })));
  vi.mocked(client.diff).mockResolvedValue(diff);
  vi.mocked(client.readFile).mockResolvedValue("");
  vi.mocked(client.readFileContent).mockImplementation(async (_pr, path) => { if (GUIDE.test(path)) throw new PrPlatformError(404); return ""; });
  const context = new DecisionContextService({ scan: async () => ({ sources: [{ source: "summarize", status: "ready", records: 1, skipped: 0 }], documents: [{
    source: "summarize", kind: "historical_decision", id: "DEC-1", title: "请求超时", project: "app", status: "accepted", created: "2026-09-01", summary: "请求超时后必须释放资源", appliesWhen: "请求取消", caution: "后台任务另议", tags: [], supersedes: [], supersededBy: [], relativePath: "summarize/DEC-1.md", client: "codex", sessionId: null, body: "请求超时后取消实际调用", bodyStartLine: 1, contentHash: "e".repeat(64),
  }] }) });
  const search = vi.fn(context.search.bind(context));
  const requests: StructuredGenerationRequest[] = [];
  const gateway: AssistantGatewayLike = {
    listGenerationProfiles: async () => [local, remote],
    generate: async (request, parse, signal, profileId) => {
      signal?.throwIfAborted(); requests.push(request);
      const action = await answer(request, signal);
      if (action instanceof Error) throw action;
      return { requestId: request.requestId, attemptId: randomUUID(), profileId: profileId ?? "local", backend: "qwen", provider: "local", model: "test", visibleOutput: JSON.stringify(action), parsedOutput: parse(action), usage: { source: "unavailable" }, providerDurationMs: 1 };
    },
  };
  const service = new PrReviewService({ gateway, searchDecisions: search, createClient: async () => client, retryAfterMs: 1, ...extra });
  const run = async (options: { profileId?: string; depth?: "deep" | "standard"; paths?: string[] } = {}) => {
    const view = await service.load({ connectionId, reference: "AI/app#1" });
    return service.run({ snapshotId: view.snapshotId, runId: randomUUID(), profileId: options.profileId ?? "local", focus: "", ...(options.depth ? { depth: options.depth } : {}), ...(options.paths ? { paths: options.paths } : {}) });
  };
  return { client, service, search, requests, gateway, run };
}

/** The first file of a group's currentDiff. */
export const groupOf = (request: StructuredGenerationRequest) => JSON.parse(request.userPrompt.split("\n最近步骤")[0]!).currentDiff[0].path as string;
