import type { DecisionContextResponse, ModelProviderProfile, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";
import { DecisionAssistantService } from "../src/main/decision-assistant-service.js";
import { ModelProviderError } from "../src/main/model/http-model-transport.js";

const REMOTE = {
  version: 1, profileId: "deepseek", kind: "openai-compatible", label: "DeepSeek", enabled: true, priority: 0, timeoutMs: 30_000,
  pricing: { currency: "¥", inputPerMillion: 2, outputPerMillion: 8 },
} as unknown as ModelProviderProfile;

describe("what a stopped turn says it spent", () => {
  it("does not present the total as exact when the call in flight at the stop is left out", async () => {
    const controller = new AbortController();
    let calls = 0;
    const assistant = new DecisionAssistantService({
      gateway: {
        listGenerationProfiles: async () => [REMOTE],
        generate: (async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown, signal?: AbortSignal) => {
          calls += 1;
          if (calls === 1) {
            return {
              requestId: request.requestId, attemptId: "a", profileId: "deepseek", backend: "openai-compatible", provider: "deepseek", model: "m",
              visibleOutput: "", parsedOutput: parse({ action: "search", query: "回滚" }),
              usage: { source: "provider_reported", inputTokens: 1_000, outputTokens: 20 }, providerDurationMs: 1,
            };
          }
          // The second call has been sent with its whole prompt; the reader presses 停止 while it runs.
          controller.abort();
          throw new ModelProviderError("cancelled", "Model call was cancelled");
          void signal;
        }) as never,
      },
      searchDecisions: async () => ({
        contextVersion: 1, status: "no_match", coverage: "complete", sources: [], results: [], total: 0, nextOffset: null,
        guidance: "", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true },
      } as unknown as DecisionContextResponse),
      searchNotes: async () => { throw new Error("not used"); },
      searchJournal: async () => ({ entries: [], diagnostics: [] }),
      readJournalEntry: async () => null,
      readDocument: async () => "",
    });
    const result = await assistant.runTurn({ messages: [{ role: "user", content: "发布前要注意什么？" }], scope: "decisions" }, controller.signal);
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") return;
    // Two calls went out; one reported. The panel prints "本轮 1.0k tokens … ≈ ¥0.0022" as if exact, where a failed
    // or unreported call makes it "本轮至少 … 1 步未报告用量".
    expect(result.tokens?.unreportedSteps).toBeGreaterThanOrEqual(1);
  });
});
