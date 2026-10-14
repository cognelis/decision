import type { ModelProviderProfile, RetrievalAnswerCitation, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";
import { DecisionAssistantService } from "../src/main/decision-assistant-service.js";

const LOCAL = { version: 1, profileId: "qwen", kind: "qwen", label: "Qwen", enabled: true, priority: 0, timeoutMs: 30_000 } as unknown as ModelProviderProfile;

const service = (readDocument: (path: string) => Promise<string>) => {
  const generate = vi.fn(async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown) => ({
    requestId: request.requestId, attemptId: "a", profileId: "qwen", backend: "qwen" as const, provider: "qwen", model: "q",
    visibleOutput: "", parsedOutput: parse({ action: "answer", answer: "仍适用 [1]。", citedIndexes: [1] }),
    usage: { source: "reported" as const, inputTokens: 1, outputTokens: 1 }, providerDurationMs: 1,
  }));
  return {
    generate,
    service: new DecisionAssistantService({
      gateway: { listGenerationProfiles: async () => [LOCAL], generate: generate as never },
      searchDecisions: async () => { throw new Error("not used"); },
      searchNotes: async () => { throw new Error("not used"); },
      searchJournal: async () => { throw new Error("not used"); },
      readJournalEntry: async () => null,
      readDocument,
      noteExists: async () => true,
    }),
  };
};

// Six notes an earlier answer cited, each an ordinary long note (a few thousand characters).
const cited: RetrievalAnswerCitation[] = Array.from({ length: 6 }, (_, position) => ({
  index: position + 1, kind: "note", title: `发布笔记 ${position + 1}`, reference: `notes/发布-${position + 1}.md`,
  excerpt: `摘录 ${position + 1}`, matchReason: "关键词命中",
}));

describe("selected material within the prompt budget", () => {
  it("answers a 重新核对 over six cited long notes: every one fits at least as an excerpt", async () => {
    const { service: assistant, generate } = service(async (path) => `# ${path}\n\n${"发布前先确认回滚路径和负责人。".repeat(400)}`);
    // The recheck draft the panel prefills: the old question and the old answer (well within 800 characters).
    const draft = `请根据指定来源的当前内容，核对这条历史回答是否仍适用；说明需要修正的地方，材料不足时明确说明。\n\n原问题：发布前要注意什么？\n\n历史回答：${"发布前先留回滚入口，并指定负责人 [1][2][3][4][5][6]。".repeat(20)}`;
    const result = await assistant.runTurn({ messages: [{ role: "user", content: draft }], scope: "all", selectedSources: cited });
    // All six excerpts plus three or four full texts would fit in 18,000 characters; the greedy full-text-first
    // allocation leaves no room for the oldest ones' excerpts and the whole turn is refused.
    expect(result).toMatchObject({ status: "answered" });
    expect(generate).toHaveBeenCalled();
    // The sources left at their excerpt are said to be so: told only "已读取原文", the model took what their bodies held
    // for unsupported.
    expect((generate.mock.calls[0]![0] as StructuredGenerationRequest).userPrompt).toContain("全文未能放入本轮，仅摘录开头");
  });
});
