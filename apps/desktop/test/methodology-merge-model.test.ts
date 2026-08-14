import { describe, expect, it } from "vitest";

import {
  mergeEvidence,
  mergeEvidenceSummary,
  sameIdSet,
  updateMergeSources,
  type MethodologyMergeDraftState,
} from "../src/renderer/components/pages/methodology/methodology-merge-model.js";
import type {
  DecisionLibraryItem,
  MethodologyItem,
} from "../src/shared/renderer-api.js";

const decision = (id: string): DecisionLibraryItem => ({
  id,
  created: "2026-08-01T10:00:00.000Z",
  sourceClient: "codex",
  project: "decision",
  question: `问题 ${id}`,
  selectedAnswer: `答案 ${id}`,
  rationaleStatus: "captured",
  rationale: "测试理由",
  context: null,
  outcome: "测试结果",
  outcomeReview: {
    verdict: "as_expected",
    lesson: "测试复盘",
    reviewedAt: "2026-08-02T10:00:00.000Z",
  },
  reviewDueDate: null,
  appliedPrincipleIds: [],
  appliedPrinciples: [],
});

const source = (
  id: string,
  evidence: DecisionLibraryItem[],
  evidenceSummary = `证据摘要 ${id}`,
): MethodologyItem => ({
  id,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-01T10:00:00.000Z",
  title: `原则 ${id}`,
  principle: `原则内容 ${id}`,
  appliesWhen: "测试时",
  caution: "注意边界",
  evidenceSummary,
  sourceDecisionIds: evidence.map(({ id: decisionId }) => decisionId),
  sourceDecisions: evidence,
  confidence: "low",
  quality: {
    recommendedConfidence: "low",
    confidenceReason: "test",
    evidenceCount: evidence.length,
    missingEvidenceCount: 0,
    projectCount: 1,
    sourceCount: 1,
    favorableEvidenceCount: evidence.length,
    attentionEvidenceCount: 0,
    unclearEvidenceCount: 0,
    flags: [],
    relations: [],
  },
  generation: {
    requestId: `request-${id}`,
    profileId: "test",
    provider: "test",
    model: "test",
  },
});

const draft = (
  sources: MethodologyItem[],
  sourceDecisionIds: string[],
  evidenceSummary: string,
): MethodologyMergeDraftState => ({
  sources,
  availablePrinciples: sources,
  availableEvidence: mergeEvidence(sources),
  autoEvidenceSummary: mergeEvidenceSummary(sources),
  input: {
    title: "合并原则",
    principle: "合并后的原则",
    appliesWhen: "共同边界成立时",
    caution: "边界不同时不要合并",
    sourceDecisionIds,
    evidenceSummary,
  },
});

describe("methodology merge model", () => {
  it("deduplicates evidence while preserving first source order", () => {
    const first = source("a", [decision("one"), decision("shared")]);
    const second = source("b", [decision("shared"), decision("two")]);

    expect(mergeEvidence([first, second]).map(({ id }) => id)).toEqual([
      "one",
      "shared",
      "two",
    ]);
  });

  it("labels source summaries and bounds the automatic summary", () => {
    const summary = mergeEvidenceSummary([
      source("a", [], "a".repeat(2_000)),
      source("b", [], "b".repeat(2_000)),
    ]);

    expect(summary.startsWith("来源原则 1：")).toBe(true);
    expect(summary).toHaveLength(3_000);
  });

  it("compares identifier sets without depending on order", () => {
    expect(sameIdSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameIdSet(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("retains valid manual evidence first and fills up to five records", () => {
    const originalSources = [
      source("old", [decision("one"), decision("two"), decision("removed")]),
    ];
    const current = draft(
      originalSources,
      ["two", "removed"],
      mergeEvidenceSummary(originalSources),
    );
    const nextSources = [
      source("a", [decision("one"), decision("two"), decision("three")]),
      source("b", [decision("four"), decision("five"), decision("six")]),
    ];

    const updated = updateMergeSources(current, nextSources);

    expect(updated.input.sourceDecisionIds).toEqual([
      "two",
      "one",
      "three",
      "four",
      "five",
    ]);
    expect(current.input.sourceDecisionIds).toEqual(["two", "removed"]);
    expect(updated.availableEvidence).toHaveLength(6);
  });

  it("updates an untouched automatic summary but preserves manual edits", () => {
    const oldSources = [source("old", [])];
    const nextSources = [source("next", [])];
    const automatic = draft(
      oldSources,
      [],
      mergeEvidenceSummary(oldSources),
    );
    const manual = draft(oldSources, [], "我手动整理的证据摘要");

    expect(
      updateMergeSources(automatic, nextSources).input.evidenceSummary,
    ).toBe(mergeEvidenceSummary(nextSources));
    expect(updateMergeSources(manual, nextSources).input.evidenceSummary).toBe(
      "我手动整理的证据摘要",
    );
  });
});
