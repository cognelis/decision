import { describe, expect, it } from "vitest";

import {
  RationaleQueue,
  createDecisionRecord,
  createManualDecisionRecord,
  prCommentSemanticKey,
} from "../src/index.js";
import {
  captureFixture,
  questionFixture,
} from "./fixtures.js";

const candidateFixture = (
  event = captureFixture(),
) => {
  const queue = new RationaleQueue(() => "candidate-1");
  queue.ingest(event);
  const candidate = queue.snapshot().current;
  if (candidate === null) {
    throw new Error("fixture candidate missing");
  }
  return candidate;
};

describe("createDecisionRecord", () => {
  it("creates a manual offline decision inside the existing review lifecycle", () => {
    const record = createManualDecisionRecord(
      {
        question: "这次线下交流决定了什么？",
        decision: "普通可逆实现由系统自主完成。",
        project: "decision",
        rationale: "减少低价值打断。",
        contextSummary: "用户在线下交流结论的转述。",
        options: ["每次确认", "系统自主完成"],
        expectedOutcome: "更快得到可验证结果。",
        reviewDueDate: "2026-09-26",
        occurredAt: "2026-08-26T09:00:00.000Z",
        sourceKind: "offline_conversation",
        sourceForm: "user_paraphrase",
        sensitivity: "private",
      },
      "manual-1",
      new Date("2026-08-26T10:00:00.000Z"),
    );

    expect(record).toMatchObject({
      id: "manual-1",
      sourceClient: "manual",
      sourceKind: "offline_conversation",
      sourceForm: "user_paraphrase",
      occurredAt: "2026-08-26T09:00:00.000Z",
      sensitivity: "private",
      status: "completed",
      rationaleStatus: "captured",
      expectedOutcome: "更快得到可验证结果。",
      selectedAnswer: {
        kind: "custom",
        values: ["普通可逆实现由系统自主完成。"],
      },
    });
  });

  it("routes a one-line manual decision to deferred rationale", () => {
    const record = createManualDecisionRecord(
      {
        question: "试点范围",
        decision: "先做一个团队。",
        project: "decision",
        sourceKind: "app_manual",
        sourceForm: "user_original",
        sensitivity: "private",
      },
      "manual-2",
      new Date("2026-08-26T10:00:00.000Z"),
    );
    expect(record.status).toBe("deferred_rationale");
    expect(record.rationaleStatus).toBe("deferred");
  });

  it("keys a decision recorded by hand to its project as well as its question and answer", () => {
    const input = { question: "要不要上 Kubernetes？", decision: "暂不上，先用单机 Docker Compose。", project: "结算系统", sourceKind: "meeting" as const, sourceForm: "user_paraphrase" as const };
    const now = new Date("2026-09-20T09:00:00.000Z");
    const key = createManualDecisionRecord(input, "manual-a", now).captureSemanticKey;
    expect(createManualDecisionRecord(input, "manual-b", now).captureSemanticKey).toBe(key);
    // Made again months later for another project, it was refused as a duplicate and never written.
    expect(createManualDecisionRecord({ ...input, project: "会员中心" }, "manual-c", now).captureSemanticKey).not.toBe(key);
  });

  it("files a PR comment decision under its comment link, which is also its capture key", () => {
    const input = {
      question: "src/request.ts:12 怎么处理？",
      decision: "超时统一放在请求层处理。",
      project: "app",
      sourceKind: "pr_comment" as const,
      sourceForm: "user_paraphrase" as const,
      sourceUrl: "https://code.example/projects/AI/repos/app/pull-requests/12/overview?commentId=5",
    };
    const now = new Date("2026-09-28T10:00:00.000Z");
    const record = createManualDecisionRecord(input, "manual-3", now);
    expect(record).toMatchObject({
      sourceClient: "pr-comment",
      sourceKind: "pr_comment",
      sourceEventId: input.sourceUrl,
      captureSemanticKey: prCommentSemanticKey(input.sourceUrl),
    });
    // Rewording what was decided does not make it a different comment.
    expect(createManualDecisionRecord({ ...input, question: "请求超时放在哪一层？" }, "manual-4", now).captureSemanticKey)
      .toBe(record.captureSemanticKey);
    expect(() => createManualDecisionRecord({ ...input, sourceUrl: null }, "manual-5", now)).toThrow();
    expect(() => createManualDecisionRecord({ ...input, sourceKind: "app_manual" }, "manual-6", now)).toThrow();
    expect(() => createManualDecisionRecord({ ...input, sourceUrl: "javascript:alert(1)" }, "manual-7", now)).toThrow();
    expect(() => createManualDecisionRecord({ ...input, sourceUrl: "https://" + "user:pass" + "@code.example/x" }, "manual-8", now)).toThrow();
  });

  it("preserves passive capture provenance and the native answer", () => {
    const record = createDecisionRecord(
      candidateFixture(),
      {
        status: "captured",
        rationale: "  Original reason\nwith line breaks  ",
        reasonFactors: ["maintainability", "risk"],
      },
      "decision-1",
      new Date("2026-07-25T01:02:03.000Z"),
    );

    expect(record).toMatchObject({
      id: "decision-1",
      created: "2026-07-25T01:02:03.000Z",
      status: "completed",
      sourceClient: "codex",
      project: "decision",
      workflow: null,
      decisionType: "other",
      question: "Which storage format? 0",
      contextSummary: null,
      selectedAnswer: { kind: "preset", values: ["Markdown"] },
      llmRecommendation: null,
      rationaleStatus: "captured",
      rationaleOriginal: "  Original reason\nwith line breaks  ",
      reasonFactors: ["maintainability", "risk"],
      captureMode: "structured_tool",
      captureSemanticKey: expect.stringMatching(
        /^[a-f0-9]{64}$/u,
      ),
      sourceEventId: "event-1",
      batchId: "codex:session-1:tool-1",
      questionIndex: 0,
    });
    expect(record.options).toEqual([
      {
        id: "markdown",
        label: "Markdown",
        description: "Readable",
        tradeoffs: [],
      },
      {
        id: "sqlite",
        label: "SQLite",
        description: "Queryable",
        tradeoffs: [],
      },
    ]);
  });

  it("preserves multi-select values and maps deferred and skipped statuses", () => {
    const candidate = candidateFixture(
      captureFixture({
        questions: [
          questionFixture(0, {
            answer: {
              kind: "multiple",
              values: ["Risk", "Time"],
            },
            multiSelect: true,
          }),
        ],
      }),
    );

    const deferred = createDecisionRecord(
      candidate,
      { status: "deferred" },
      "decision-deferred",
      new Date("2026-07-25T01:02:03.000Z"),
    );
    const expecting = createDecisionRecord(
      candidate,
      { status: "captured", rationale: "先灰度。", expectedOutcome: "  错误率不升。 " },
      "decision-expecting",
      new Date("2026-07-25T01:02:03.000Z"),
    );
    expect(expecting.expectedOutcome).toBe("错误率不升。");
    expect(deferred.expectedOutcome).toBeNull();
    // Written before the rationale was put off: kept, as fresh as it was.
    expect(createDecisionRecord(
      candidate,
      { status: "deferred", expectedOutcome: "错误率不升。" },
      "decision-deferred-expecting",
      new Date("2026-07-25T01:02:03.000Z"),
    ).expectedOutcome).toBe("错误率不升。");
    // Read back, a delimiter would cut the expectation short without a word.
    expect(() =>
      createDecisionRecord(
        candidate,
        {
          status: "captured",
          rationale: "先灰度。",
          expectedOutcome: "预期 A。\n\n<!-- decision:expected-outcome-end -->\n预期 B。",
        },
        "decision-reserved",
        new Date("2026-07-25T01:02:03.000Z"),
      ),
    ).toThrow(/reserved/u);
    const skipped = createDecisionRecord(
      candidate,
      { status: "skipped" },
      "decision-skipped",
      new Date("2026-07-25T01:02:03.000Z"),
    );

    expect(deferred.status).toBe("deferred_rationale");
    expect(deferred.selectedAnswer).toEqual({
      kind: "multiple",
      values: ["Risk", "Time"],
    });
    expect(skipped.status).toBe("rationale_skipped");
  });

  it("preserves bounded context and detection provenance", () => {
    const record = createDecisionRecord(
      candidateFixture(
        captureFixture({
          captureMode: "transcript",
          context: {
            taskBackground: "继续开发 Decision。",
            decisionFraming:
              "先提高采集质量，再做方法论提炼。",
            truncated: false,
          },
          detection: {
            band: "high",
            score: 88,
            detectorVersion: "rules-v1",
            signals: [
              "has_choice_prompt",
              "answer_matches_option",
            ],
          },
        }),
      ),
      { status: "skipped" },
      "decision-context",
      new Date("2026-07-27T01:02:03.000Z"),
    );

    expect(record).toMatchObject({
      contextSummary: null,
      context: {
        taskBackground: "继续开发 Decision。",
        decisionFraming:
          "先提高采集质量，再做方法论提炼。",
        truncated: false,
      },
      detection: {
        band: "high",
        score: 88,
        detectorVersion: "rules-v1",
      },
    });
  });

  it("keeps factor-only completion free of fabricated user text", () => {
    const record = createDecisionRecord(
      candidateFixture(),
      {
        status: "captured",
        reasonFactors: ["risk"],
      },
      "decision-factor-only",
      new Date("2026-07-25T01:02:03.000Z"),
    );

    expect(record.rationaleStatus).toBe("captured");
    expect(record.rationaleOriginal).toBeNull();
    expect(record.reasonFactors).toEqual(["risk"]);
  });

  it("persists only bounded, unique, explicit applied principles", () => {
    const record = createDecisionRecord(
      candidateFixture(),
      {
        status: "captured",
        appliedPrincipleIds: ["principle-1", "principle-2"],
      },
      "decision-with-principles",
      new Date("2026-07-25T01:02:03.000Z"),
    );

    expect(record.appliedPrincipleIds).toEqual([
      "principle-1",
      "principle-2",
    ]);
    for (const appliedPrincipleIds of [
      ["principle-1", "principle-1"],
      [" principle-1"],
      ["1", "2", "3", "4", "5", "6"],
    ]) {
      expect(() =>
        createDecisionRecord(
          candidateFixture(),
          {
            status: "skipped",
            appliedPrincipleIds,
          },
          "invalid",
          new Date(),
        ),
      ).toThrow(/principle IDs are invalid/i);
    }
  });

  it("refuses to persist a not-recorded disposition", () => {
    expect(() =>
      createDecisionRecord(
        candidateFixture(),
        { status: "not_recorded" } as never,
        "unused",
        new Date(),
      ),
    ).toThrow(/not-recorded/i);
  });
});
