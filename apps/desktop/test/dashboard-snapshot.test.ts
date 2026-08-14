import type { IndexedDecision } from "@cognelis/decision-storage";
import { describe, expect, it, vi } from "vitest";

import { readDashboardSnapshot } from "../src/main/dashboard-snapshot.js";

const indexedDecision = (): IndexedDecision => ({
  id: "decision-1",
  created: "2026-07-30T08:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project: "decision",
  workflow: null,
  decisionType: "architecture",
  selectedAnswer: "Markdown",
  captureMode: "structured_tool",
  captureSemanticKey: "private-semantic-key",
  sourceEventId: "private-event",
  batchId: "private-batch",
  questionIndex: 0,
  rationaleStatus: "captured",
  filePath: "/private/vault/decision.md",
  contentHash: "private-hash",
  question: "事实源应该放在哪里？",
  rationale: "private rationale",
  context: "private context",
  outcome: null,
  outcomeVerdict: null,
  outcomeLesson: null,
  outcomeReviewedAt: null,
  reviewDueDate: null,
  appliedPrincipleIds: [],
});

describe("readDashboardSnapshot", () => {
  it("maps indexed decisions without exposing storage details", () => {
    const index = {
      count: vi.fn(() => 18),
      countSince: vi.fn(() => 4),
      countReviewAttention: vi.fn(() => 2),
      listRecent: vi.fn(() => [indexedDecision()]),
    };

    const snapshot = readDashboardSnapshot(
      index,
      new Date("2026-07-31T08:00:00.000Z"),
    );

    expect(index.countSince).toHaveBeenCalledWith(
      "2026-07-24T08:00:00.000Z",
    );
    expect(index.listRecent).toHaveBeenCalledWith(12);
    expect(snapshot).toEqual({
      totalDecisions: 18,
      recorded7d: 4,
      reviewAttention: 2,
      recentDecisions: [
        {
          id: "decision-1",
          created: "2026-07-30T08:00:00.000Z",
          sourceClient: "codex",
          project: "decision",
          question: "事实源应该放在哪里？",
          selectedAnswer: "Markdown",
          rationaleStatus: "captured",
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("/private/");
    expect(JSON.stringify(snapshot)).not.toContain("private rationale");
  });

  it("returns an empty read model when the rebuildable index fails", () => {
    const failure = new Error("index unavailable");
    const index = {
      count: () => {
        throw failure;
      },
      countSince: vi.fn(() => 0),
      countReviewAttention: vi.fn(() => 0),
      listRecent: vi.fn(() => []),
    };
    const onFailure = vi.fn();

    expect(
      readDashboardSnapshot(
        index,
        new Date("2026-07-31T08:00:00.000Z"),
        onFailure,
      ),
    ).toEqual({
      totalDecisions: 0,
      recorded7d: 0,
      reviewAttention: 0,
      recentDecisions: [],
    });
    expect(onFailure).toHaveBeenCalledWith(failure);
  });
});
