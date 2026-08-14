import type {
  MethodologyQualityAssessment,
  MethodologyQualityRelation,
} from "@cognelis/decision-core";
import { describe, expect, it } from "vitest";

import {
  allPairsConfirmedDuplicate,
  assessMergeCandidate,
  buildRelationReviewQueue,
  explicitRelationBetween,
  pendingRelationCount,
  qualityBadgeFor,
  relationPairKey,
} from "../src/renderer/components/pages/methodology/methodology-relation-model.js";
import type { MethodologyItem } from "../src/shared/renderer-api.js";

const quality = (
  relations: MethodologyQualityRelation[] = [],
): MethodologyQualityAssessment => ({
  recommendedConfidence: "low",
  confidenceReason: "test",
  evidenceCount: 1,
  missingEvidenceCount: 0,
  projectCount: 1,
  sourceCount: 1,
  favorableEvidenceCount: 1,
  attentionEvidenceCount: 0,
  unclearEvidenceCount: 0,
  flags: [],
  relations,
});

const item = (
  id: string,
  relations: MethodologyQualityRelation[] = [],
  status: MethodologyItem["status"] = "accepted",
): MethodologyItem => ({
  id,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  origin: "decision_evidence",
  status,
  confirmedAt: status === "accepted" ? "2026-08-01T10:00:00.000Z" : null,
  title: `原则 ${id}`,
  principle: `原则内容 ${id}`,
  appliesWhen: "测试时",
  caution: "注意边界",
  evidenceSummary: "测试证据",
  sourceDecisionIds: [],
  sourceDecisions: [],
  confidence: "low",
  quality: quality(relations),
  generation: {
    requestId: `request-${id}`,
    profileId: "test",
    provider: "test",
    model: "test",
  },
});

const relation = (
  target: MethodologyItem,
  overrides: Partial<MethodologyQualityRelation> = {},
): MethodologyQualityRelation => ({
  id: target.id,
  title: target.title,
  status: target.status,
  kind: "similar",
  score: 70,
  sharedEvidenceCount: 1,
  reason: "test relation",
  ...overrides,
});

describe("methodology relation model", () => {
  it("normalizes unordered pairs to one stable key", () => {
    expect(relationPairKey("principle-b", "principle-a")).toBe(
      relationPairKey("principle-a", "principle-b"),
    );
  });

  it("uses conflict, unrelated, then duplicate precedence across mirrored facts", () => {
    const baseB = item("b");
    const first = item("a", [
      relation(baseB, { resolution: "duplicate" }),
    ]);
    const second = item("b", [
      relation(first, { resolution: "unrelated" }),
      relation(first, { resolution: "conflict" }),
    ]);

    expect(explicitRelationBetween(first, second)).toBe("conflict");
  });

  it("requires every source pair to be a confirmed duplicate", () => {
    const thirdBase = item("c");
    const secondBase = item("b");
    const first = item("a", [
      relation(secondBase, { resolution: "duplicate" }),
      relation(thirdBase, { resolution: "duplicate" }),
    ]);
    const second = item("b", [
      relation(thirdBase, { resolution: "duplicate" }),
    ]);
    const third = item("c");

    expect(allPairsConfirmedDuplicate([first, second, third])).toBe(true);
    expect(
      allPairsConfirmedDuplicate([
        first,
        item("b", [relation(thirdBase, { resolution: "conflict" })]),
        third,
      ]),
    ).toBe(false);
  });

  it("deduplicates relation review pairs and prioritizes conflicts then score", () => {
    const secondBase = item("b");
    const thirdBase = item("c");
    const first = item("a", [
      relation(secondBase, { score: 92 }),
      relation(thirdBase, { kind: "potential_conflict", score: 40 }),
    ]);
    const second = item("b", [relation(first, { score: 92 })]);
    const third = item("c");

    const queue = buildRelationReviewQueue([first, second, third]);

    expect(queue).toHaveLength(2);
    expect(queue.map(({ left, right }) => [left.id, right.id])).toEqual([
      ["a", "c"],
      ["a", "b"],
    ]);
    expect(pendingRelationCount([first, second, third])).toBe(2);
  });

  it("assesses a merge candidate only when at least one duplicate is confirmed", () => {
    const candidateBase = item("candidate");
    const first = item("a", [
      relation(candidateBase, { resolution: "duplicate" }),
    ]);
    const second = item("b");
    const candidate = item("candidate");

    expect(assessMergeCandidate([first, second], candidate)).toMatchObject({
      item: candidate,
      confirmedPairCount: 1,
      missingSources: [second],
    });

    const blocked = item("candidate", [
      relation(second, { resolution: "conflict" }),
    ]);
    expect(assessMergeCandidate([first, second], blocked)).toBeNull();
  });

  it("derives badges with unresolved and conflict precedence", () => {
    const target = item("target");

    expect(
      qualityBadgeFor(
        item("source", [
          relation(target, { resolution: "duplicate" }),
          relation(target, { kind: "potential_conflict", resolution: null }),
        ]),
      ),
    ).toEqual({ label: "待核对冲突", tone: "conflict" });
    expect(
      qualityBadgeFor(
        item("source", [relation(target, { resolution: "conflict" })]),
      ),
    ).toEqual({ label: "已确认冲突", tone: "conflict" });
    expect(
      qualityBadgeFor(
        item("source", [relation(target, { resolution: "duplicate" })]),
      ),
    ).toEqual({ label: "已确认重复", tone: "resolved" });
  });
});
