import type {
  MethodologyRecord,
  PracticeAssetRecord,
} from "@cognelis/decision-core";
import {
  comparePracticeAssetSources,
  snapshotPracticeAssetSources,
} from "@cognelis/decision-core";
import { describe, expect, it } from "vitest";

const source = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-1",
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T08:00:00.000Z",
  title: "先验证再扩大",
  principle: "先验证关键假设。",
  appliesWhen: "仍有未知项时。",
  caution: "避免同时扩大多个变量。",
  evidenceSummary: "复盘支持。",
  sourceDecisionIds: ["decision-1"],
  confidence: "medium",
  generation: {
    requestId: "methodology:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

const asset = (
  sourceRecord: MethodologyRecord,
  overrides: Partial<PracticeAssetRecord> = {},
): PracticeAssetRecord => ({
  id: "skill-1",
  slug: "decision-reversible-change",
  kind: "skill",
  status: "accepted",
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
  acceptedAt: "2026-08-03T08:00:00.000Z",
  title: "可逆改动验证",
  summary: "先验证再扩大。",
  trigger: "仍有未知项时。",
  steps: ["明确假设。", "实施最小改动。"],
  checks: ["结果已记录。"],
  fallback: "失败时回退。",
  sourcePrincipleIds: [sourceRecord.id],
  sourceSnapshots: snapshotPracticeAssetSources([sourceRecord]),
  generation: {
    requestId: "skill:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

describe("comparePracticeAssetSources", () => {
  it("reports the exact changed fields against the generation snapshot", () => {
    const original = source();
    const current = source({
      updatedAt: "2026-08-04T08:00:00.000Z",
      principle: "先验证最新约束，再扩大范围。",
      confidence: "high",
    });

    expect(comparePracticeAssetSources(asset(original), [current])).toEqual([
      expect.objectContaining({
        id: original.id,
        state: "updated",
        fields: [
          {
            field: "principle",
            before: original.principle,
            after: current.principle,
          },
          { field: "confidence", before: "medium", after: "high" },
        ],
      }),
    ]);
  });

  it("distinguishes legacy assets without a baseline from unavailable sources", () => {
    const original = source();
    const { sourceSnapshots: _sourceSnapshots, ...legacyAsset } = asset(original);
    expect(
      comparePracticeAssetSources(
        legacyAsset,
        [original],
      )[0]?.state,
    ).toBe("baseline_missing");
    expect(comparePracticeAssetSources(asset(original), [])[0]).toMatchObject({
      state: "unavailable",
      title: original.title,
    });
  });
});
