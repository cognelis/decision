import type { MethodologyRecord } from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";

import {
  buildMethodologyUsageSnapshot,
  buildMethodologyValidationInbox,
} from "../src/main/methodology-usage-service.js";

const decision = (
  id: string,
  overrides: Partial<IndexedDecision> = {},
): IndexedDecision => ({
  id,
  created: "2026-08-01T08:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project: "Decision",
  workflow: null,
  decisionType: "implementation",
  selectedAnswer: "先小步验证",
  captureMode: "text",
  captureSemanticKey: null,
  sourceEventId: null,
  batchId: null,
  questionIndex: null,
  rationaleStatus: "captured",
  filePath: `/vault/${id}.md`,
  contentHash: `hash-${id}`,
  question: `问题 ${id}`,
  rationale: "保留回退路径。",
  context: null,
  outcome: null,
  outcomeVerdict: null,
  outcomeLesson: null,
  outcomeReviewedAt: null,
  reviewDueDate: null,
  appliedPrincipleIds: ["principle-1"],
  ...overrides,
});

const methodology = (
  id: string,
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-01T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-01T09:00:00.000Z",
  title: `原则 ${id}`,
  principle: "先验证，再扩大。",
  appliesWhen: "仍有未知项时。",
  caution: "验证代价过高时重新评估。",
  evidenceSummary: "来自原始复盘证据。",
  sourceDecisionIds: ["source-evidence"],
  confidence: "medium",
  generation: {
    requestId: `methodology:${id}`,
    profileId: "builtin-qwen",
    provider: "Qwen",
    model: "qwen3.5",
  },
  ...overrides,
});

describe("methodology usage service", () => {
  it("summarizes only explicitly linked decisions and keeps review states separate", () => {
    const snapshot = buildMethodologyUsageSnapshot("principle-1", [
      decision("favorable", {
        created: "2026-08-03T08:00:00.000Z",
        outcome: "运行稳定。",
        outcomeVerdict: "as_expected",
        outcomeLesson: "边界合理。",
        outcomeReviewedAt: "2026-08-04T08:00:00.000Z",
      }),
      decision("attention", {
        created: "2026-08-02T08:00:00.000Z",
        outcome: "仍有偏差。",
        outcomeVerdict: "worse",
        outcomeReviewedAt: "2026-08-03T08:00:00.000Z",
      }),
      decision("pending", { created: "2026-08-01T08:00:00.000Z" }),
      decision("unlinked", { appliedPrincipleIds: ["principle-2"] }),
    ]);

    expect(snapshot).toMatchObject({
      principleId: "principle-1",
      linkedDecisionCount: 3,
      outcomeRecordedCount: 2,
      reviewedCount: 2,
      pendingOutcomeCount: 1,
      pendingReviewCount: 0,
      favorableCount: 1,
      mixedCount: 0,
      attentionCount: 1,
      unclearCount: 0,
    });
    expect(snapshot.decisions.map((item) => item.id)).toEqual([
      "favorable",
      "attention",
      "pending",
    ]);
    expect(snapshot.nextPendingDecision?.id).toBe("pending");
  });

  it("keeps exact pending counts and the next action outside the 50-row renderer window", () => {
    const reviewed = Array.from({ length: 50 }, (_, index) =>
      decision(`reviewed-${index}`, {
        created: `2026-08-02T08:00:${String(index).padStart(2, "0")}.000Z`,
        outcome: "已记录结果。",
        outcomeVerdict: "as_expected",
        outcomeReviewedAt: "2026-08-03T08:00:00.000Z",
      }),
    );
    const snapshot = buildMethodologyUsageSnapshot("principle-1", [
      ...reviewed,
      decision("older-pending", {
        created: "2026-08-01T08:00:00.000Z",
      }),
    ]);

    expect(snapshot.linkedDecisionCount).toBe(51);
    expect(snapshot.decisions).toHaveLength(50);
    expect(snapshot.decisions.some((item) => item.id === "older-pending")).toBe(
      false,
    );
    expect(snapshot.pendingOutcomeCount).toBe(1);
    expect(snapshot.pendingReviewCount).toBe(0);
    expect(snapshot.nextPendingDecision?.id).toBe("older-pending");
  });

  it("builds a bounded validation inbox only from newly reviewed explicit usage", () => {
    const accepted = methodology("principle-1", {
      usageValidation: {
        reviewedAt: "2026-08-04T08:00:00.000Z",
        decisionId: "reviewed-a",
        validatedAt: "2026-08-04T09:00:00.000Z",
      },
    });
    const revision = methodology("revision-1", {
      origin: "principle_revision",
      status: "candidate",
      confirmedAt: null,
      sourcePrincipleIds: [accepted.id],
    });
    const inbox = buildMethodologyValidationInbox(
      [accepted, revision, methodology("retired", { status: "retired" })],
      [
        decision("reviewed-a", {
          outcome: "早期结果",
          outcomeVerdict: "as_expected",
          outcomeReviewedAt: "2026-08-04T08:00:00.000Z",
        }),
        decision("reviewed-b", {
          outcome: "出现偏差",
          outcomeVerdict: "worse",
          outcomeLesson: "需要收窄适用边界。",
          outcomeReviewedAt: "2026-08-05T08:00:00.000Z",
        }),
        decision("reviewed-c", {
          outcome: "结果稳定",
          outcomeVerdict: "better",
          outcomeReviewedAt: "2026-08-06T08:00:00.000Z",
        }),
        decision("source-evidence", {
          outcome: "原始证据",
          outcomeVerdict: "as_expected",
          outcomeReviewedAt: "2026-08-07T08:00:00.000Z",
        }),
        decision("unlinked", {
          appliedPrincipleIds: ["another-principle"],
          outcome: "无关结果",
          outcomeVerdict: "worse",
          outcomeReviewedAt: "2026-08-08T08:00:00.000Z",
        }),
      ],
    );

    expect(inbox).toEqual([
      expect.objectContaining({
        principleId: "principle-1",
        newReviewedCount: 2,
        favorableCount: 1,
        attentionCount: 1,
        unclearCount: 0,
        newestReviewedAt: "2026-08-06T08:00:00.000Z",
        revisionDraftId: "revision-1",
        decisions: [
          expect.objectContaining({ id: "reviewed-c", verdict: "better" }),
          expect.objectContaining({ id: "reviewed-b", verdict: "worse" }),
        ],
      }),
    ]);
  });
});
