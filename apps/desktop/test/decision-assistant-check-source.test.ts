import type {
  DecisionContextResponse,
  DecisionContextResult,
  ModelProviderProfile,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";
import { DecisionAssistantService } from "../src/main/decision-assistant-service.js";

const LOCAL = { version: 1, profileId: "qwen", kind: "qwen", label: "Qwen", enabled: true, priority: 0, timeoutMs: 30_000 } as unknown as ModelProviderProfile;

// An unchanged decision note whose 480-character excerpt ends inside a [[wikilink]] / [label](url).
const body = (link: string) => `${"发布前先确认回滚路径，并指定负责人。".repeat(26)}详见 ${link}，之后按清单执行。`;
const NOTE_PATH = "Decision Journal/decisions/DEC-7.md";

const service = (text: string) => {
  const result: DecisionContextResult = {
    source: "decisions", kind: "recorded_decision", id: "DEC-7", title: "发布前确认回滚路径", project: "web", status: "accepted",
    current: true, summary: "发布前确认回滚路径", appliesWhen: null, caution: null, tags: [], supersedes: [], supersededBy: [],
    successors: [], unresolvedSuccessorIds: [],
    sourceRef: { relativePath: NOTE_PATH, client: null, sessionId: null, excerpt: text, excerptStartLine: 5, truncated: false },
    matchReason: "关键词命中", warnings: [],
  } as unknown as DecisionContextResult;
  const steps = [{ action: "search", query: "回滚" }, { action: "answer", answer: "先确认回滚路径 [1]。", citedIndexes: [1] }];
  const generate = vi.fn(async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown) => ({
    requestId: request.requestId, attemptId: "a", profileId: "qwen", backend: "qwen" as const, provider: "qwen", model: "q",
    visibleOutput: "", parsedOutput: parse(steps.shift()), usage: { source: "reported" as const, inputTokens: 1, outputTokens: 1 }, providerDurationMs: 1,
  }));
  return new DecisionAssistantService({
    gateway: { listGenerationProfiles: async () => [LOCAL], generate: generate as never },
    searchDecisions: async () => ({
      contextVersion: 1, status: "matched", coverage: "complete", sources: [], results: [result], total: 1, nextOffset: null,
      guidance: "", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true },
    } as unknown as DecisionContextResponse),
    searchNotes: async () => { throw new Error("not used"); },
    searchJournal: async () => ({ entries: [], diagnostics: [] }),
    readJournalEntry: async () => null,
    // The note on disk, unchanged since the answer: frontmatter, heading and the same body.
    readDocument: async () => `---\nid: DEC-7\n---\n\n# 发布前确认回滚路径\n\n${text}\n`,
    noteExists: async () => true,
  });
};

describe("核对当前来源 on an unchanged decision", () => {
  it.each(["发布回滚清单与负责人轮值表（纯文本，对照）", "[[发布回滚清单与负责人轮值表]]", "[回滚清单](https://wiki.example.com/release/rollback-checklist)"])(
    "says the excerpt is still there when its cut falls inside %s", async (link) => {
      const text = body(link);
      const assistant = service(text);
      const turn = await assistant.runTurn({ messages: [{ role: "user", content: "发布前要注意什么？" }], scope: "decisions" });
      expect(turn.status).toBe("answered");
      if (turn.status !== "answered") return;
      const citation = turn.message.citations![0]!;
      // The excerpt is cut mid-link: plainText cannot strip a half link, the full note's link is stripped.
      expect(citation.excerpt.endsWith("…")).toBe(true);
      expect((await assistant.checkSource(citation)).status).toBe("matched");
    },
  );

  it("still sees a change after a bracket that is no link, in an excerpt the clip did not cut", async () => {
    const before = "超时区间取 [0, 30) 秒，超过即取消请求并释放连接。";
    const turn = await service(before).runTurn({ messages: [{ role: "user", content: "超时怎么处理？" }], scope: "decisions" });
    expect(turn.status).toBe("answered");
    if (turn.status !== "answered") return;
    // Read off as half a link, everything after "[" left the comparison and the edit read as matched.
    const after = service("超时区间取 [0, 30) 秒，超过即重试三次。");
    expect((await after.checkSource(turn.message.citations![0]!)).status).toBe("review");
  });
});
