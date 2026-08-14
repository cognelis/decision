import { describe, expect, it } from "vitest";

import {
  RationaleQueue,
  createDecisionRecord,
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
