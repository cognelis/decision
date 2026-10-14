import type {
  DecisionContextQuery,
  DecisionContextResponse,
  DecisionContextResult,
  ModelProviderProfile,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";
import { DecisionAssistantService } from "../src/main/decision-assistant-service.js";

const LOCAL = { version: 1, profileId: "qwen", kind: "qwen", label: "Qwen", enabled: true, priority: 0, timeoutMs: 30_000 } as unknown as ModelProviderProfile;

// The repository's view now: the historical decision cited earlier has been replaced since.
const HISTORICAL: DecisionContextResult = {
  source: "summarize", kind: "historical_decision", id: "DEC-0042", title: "会话缓存放进程内存", project: "web",
  status: "accepted", current: false, lifecycleState: "superseded",
  summary: "会话缓存放进程内存。", appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: ["DEC-0101"],
  successors: [{ id: "DEC-0101", source: "decisions", title: "会话缓存统一用 Redis", status: "accepted", relativePath: "Decision Journal/decisions/DEC-0101.md" }],
  unresolvedSuccessorIds: [],
  sourceRef: { relativePath: "Decision Journal/summarize/会话缓存放进程内存.md", client: null, sessionId: null, excerpt: "会话缓存放进程内存。", excerptStartLine: 5, truncated: false },
  matchReason: "关键词命中", warnings: ["此记录已被替代或退役；核对后继记录后再判断当前约束，不以旧结论直接修改代码。"],
} as unknown as DecisionContextResult;

describe("a carried historical decision replaced since it was cited", () => {
  it.each([false, true])("is not handed to the follow-up as the current conclusion (重新核对 with it selected: %s)", async (selected) => {
    const queries: DecisionContextQuery[] = [];
    const generate = vi.fn(async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown) => ({
      requestId: request.requestId, attemptId: "a", profileId: "qwen", backend: "qwen" as const, provider: "qwen", model: "q",
      visibleOutput: "", parsedOutput: parse({ action: "answer", answer: "会话缓存放进程内存 [1]。", citedIndexes: [1] }),
      usage: { source: "reported" as const, inputTokens: 1, outputTokens: 1 }, providerDurationMs: 1,
    }));
    const assistant = new DecisionAssistantService({
      gateway: { listGenerationProfiles: async () => [LOCAL], generate: generate as never },
      searchDecisions: async (query) => {
        queries.push(query);
        return {
          contextVersion: 1, status: "matched", coverage: "complete", sources: [], results: [HISTORICAL], total: 1, nextOffset: null,
          guidance: "", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true },
        } as unknown as DecisionContextResponse;
      },
      searchNotes: async () => { throw new Error("not used"); },
      searchJournal: async () => ({ entries: [], diagnostics: [] }),
      readJournalEntry: async () => null,
      readDocument: async () => "会话缓存放进程内存。",
      noteExists: async () => true,
    });
    const cited = { index: 1, kind: "decision" as const, title: HISTORICAL.title, reference: HISTORICAL.sourceRef.relativePath, excerpt: "会话缓存放进程内存。", matchReason: "关键词命中", lifecycle: "current" as const };
    const result = await assistant.runTurn({
      scope: "decisions",
      ...(selected ? { selectedSources: [cited] } : {}),
      messages: [
        { role: "user", content: "会话缓存放哪里？" },
        {
          role: "assistant", content: "放进程内存 [1]。",
          // Cited while it stood: a historical decision carries no record id.
          citations: [cited],
        },
        { role: "user", content: "现在还是这样吗？" },
      ],
    });
    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    const prompt = generate.mock.calls[0]![0].userPrompt;
    // A recorded decision carried the same way is looked up and marked; this one is never looked up at all.
    expect(prompt).toContain("已被后续决策取代");
    expect(result.message.citations?.[0]?.lifecycle).toBe("superseded");
  });
});
